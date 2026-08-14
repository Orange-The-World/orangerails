/**
 * or-connection-list , list a subaccount's connections.
 *
 * Returns encrypted blobs as-is. The caller's browser decrypts with ORK.
 *
 * Each connection also includes its source_wallets (if any) so the UI can
 * render per-wallet badges without a second roundtrip. Connections that
 * predate the wallet-discovery feature have an empty source_wallets array
 * and use the legacy account-wide sync path.
 *
 * POST body:
 *   subaccount_id?: uuid  required in platform mode
 *
 * Response:
 *   { connections: [{
 *       id, provider_type, is_stealth, encrypted_label, encrypted_credentials,
 *       status, last_sync_at, last_sync_cursor, encrypted_last_error,
 *       credentials_key_version, created_at,
 *       source_wallets: [{ id, external_wallet_id, is_synced, encrypted_metadata }]
 *     }],
 *     stealth_unavailable: boolean }
 *
 * `stealth_unavailable` is true when the stealth store could not be read, so
 * the list may be short. It is about the READ, not the result: a user with no
 * stealth connections gets false. Always present, never omitted on success,
 * because a key that only appears on failure is a key clients forget to
 * check.
 *
 * The contract, stated as an outcome: this returns every connection the user
 * completed, in one shape, regardless of provider family. Stealth Sync
 * connections live in a separate store and are unioned in here. Branch on
 * `is_stealth`, which is a boolean on every row, never on a provider list.
 * See ./stealth-union.ts for the field-by-field reasoning and for what is
 * deliberately never surfaced.
 *
 * Newest-first across both families, so a stealth connection made minutes
 * ago does not render below a bank connection from July.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import {
  buildListResponse,
  isUnmappedStealthStatus,
  mergeConnections,
  STEALTH_UNAVAILABLE_ALARM,
  stealthRowToConnection,
  tagRegularConnection,
} from './stealth-union.ts';
import type { StealthConnectionRow, UnifiedConnection } from './stealth-union.ts';

interface SourceWalletRow {
  id: string;
  connection_id: string;
  external_wallet_id: string;
  is_synced: boolean;
  encrypted_metadata: string;
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    const body = JSON.parse(raw || '{}') as { subaccount_id?: string };

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    const { data: rows, error } = await ctx.serviceClient
      .from('connections')
      .select('id, provider_type, encrypted_label, encrypted_credentials, credentials_key_version, status, last_sync_at, last_sync_cursor, encrypted_last_error, created_at')
      .eq('subaccount_id', subaccountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[or-connection-list] query failed:', error);
      return jsonResponse({ error: 'Failed to list connections' }, 500, cors);
    }

    const connections = rows ?? [];

    // Bulk-load source_wallets for all returned connections in one round trip
    // (avoids N+1) and group them client-side. RLS already enforced
    // ownership on the connections lookup; source_wallets fetched via the
    // service-role client are filtered by connection_id IN (...) which is
    // safe because that ID set was just authorized above.
    let walletsByConn = new Map<string, SourceWalletRow[]>();
    if (connections.length > 0) {
      const connIds = connections.map(c => (c as { id: string }).id);
      const { data: walletRows, error: walletErr } = await ctx.serviceClient
        .from('source_wallets')
        .select('id, connection_id, external_wallet_id, is_synced, encrypted_metadata')
        .in('connection_id', connIds);

      if (walletErr) {
        console.error('[or-connection-list] source_wallets query failed:', walletErr);
        // Non-fatal: surface connections without wallet badges rather than
        // blocking the whole list. UI degrades to "Default account" rendering.
      } else {
        walletsByConn = new Map();
        for (const w of (walletRows ?? []) as SourceWalletRow[]) {
          const arr = walletsByConn.get(w.connection_id) ?? [];
          arr.push(w);
          walletsByConn.set(w.connection_id, arr);
        }
      }
    }

    const enriched = connections.map(c => {
      const conn = c as { id: string };
      const walletsForConn = (walletsByConn.get(conn.id) ?? []).map(w => ({
        id: w.id,
        external_wallet_id: w.external_wallet_id,
        is_synced: w.is_synced,
        encrypted_metadata: w.encrypted_metadata,
      }));
      return tagRegularConnection({ ...c, source_wallets: walletsForConn });
    }) as unknown as UnifiedConnection[];

    // Union in the stealth store. See ./stealth-union.ts for why the two
    // stores are disjoint and what this deliberately does not surface.
    //
    // The join needs no migration and no new column. `connections` is scoped
    // by subaccount_id; `stealth_connections` by (platform_id, app_user_id)
    // and has no subaccount_id. The subaccount row already carries both
    // halves: ow-or-proxy provisions with external_user_id = the host app's
    // user id, and the connect widget is handed that same id as app_user_id.
    //
    // Reading the pair off the subaccount row rather than off `ctx` covers
    // platform and direct mode with one code path, and keeps the lookup
    // anchored to the subaccount the caller was already authorized for.
    const { data: subaccountRow, error: subErr } = await ctx.serviceClient
      .from('subaccounts')
      .select('platform_id, external_user_id')
      .eq('id', subaccountId)
      .maybeSingle();

    let stealthConnections: UnifiedConnection[] = [];
    // Tracks whether the stealth store could be READ, not whether it returned
    // rows. A user with no stealth connections is a successful read of an
    // empty set and must not raise this.
    let stealthUnavailable = false;

    if (subErr || !subaccountRow) {
      // Non-fatal, and loud. resolveSubaccount already proved this row
      // exists, so reaching here means the second read failed rather than
      // the caller being unauthorized.
      stealthUnavailable = true;
      console.error(
        `[or-connection-list] ${STEALTH_UNAVAILABLE_ALARM} subaccount reread failed:`,
        subErr,
      );
    } else {
      const { data: stealthRows, error: stealthErr } = await ctx.serviceClient
        .from('stealth_connections')
        .select('id, connection_kind, status, last_sync_at, created_at')
        .eq('platform_id', subaccountRow.platform_id)
        .eq('app_user_id', subaccountRow.external_user_id)
        .order('created_at', { ascending: false });

      if (stealthErr) {
        // Non-fatal on purpose: a stealth read failure must not blank out a
        // user's working bank connections. It is logged at error level, with
        // the alarm token, and reported to the client on the response,
        // because the visible symptom, a missing connection, is exactly the
        // bug this union exists to fix and must not pass unnoticed.
        stealthUnavailable = true;
        console.error(
          `[or-connection-list] ${STEALTH_UNAVAILABLE_ALARM} stealth_connections query failed:`,
          stealthErr,
        );
      } else {
        const rows = (stealthRows ?? []) as StealthConnectionRow[];
        for (const r of rows) {
          if (isUnmappedStealthStatus(r.status)) {
            console.error(
              `[or-connection-list] unmapped stealth status "${r.status}" on connection ${r.id}, reported as error`,
            );
          }
        }
        stealthConnections = rows.map(stealthRowToConnection);
      }
    }

    return jsonResponse(
      buildListResponse(mergeConnections(enriched, stealthConnections), stealthUnavailable),
      200,
      cors,
    );
  } catch (err) {
    console.error('[or-connection-list] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-connection-list'));
