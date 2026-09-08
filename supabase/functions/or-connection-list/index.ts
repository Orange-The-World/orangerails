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
 *       status, last_sync_at, last_sync_cursor, last_block_scanned,
 *       encrypted_last_error, credentials_key_version, created_at,
 *       sync_freshness, hours_since_sync, stale_after_hours,
 *       source_wallets: [{ id, external_wallet_id, is_synced, encrypted_metadata }],
 *
 *       // DL-1490, present ONLY on a failed connection on a sink-mode
 *       // platform. Absent entirely otherwise: absent means "no readable
 *       // cause", never "no failure". Read `status` for whether it failed.
 *       error, correlation_id, message, detail, action, help_url
 *     }],
 *     stealth_unavailable: boolean }
 *
 * The six DL-1490 fields, in detail, because this is the contract other teams
 * build against:
 *
 *   `error`           the machine-readable code, e.g. UPSTREAM_AUTH_FAILED.
 *                     THIS IS PER CONNECTION. It is not the top-level `error`
 *                     key, which only ever appears on an endpoint failure and
 *                     never alongside `connections`. Do not conflate them.
 *   `correlation_id`  opaque id for cross-referencing our edge logs. Show it
 *                     to support, not to a customer as an explanation.
 *   `message`         one-line customer-facing title.
 *   `detail`          customer-facing body.
 *   `action`          suggested next step, or null when there is nothing the
 *                     customer can do. Null is meaningful: render no button.
 *   `help_url`        EMPTY STRING for every code today, because the help
 *                     articles are not published. Do NOT render a link from
 *                     it until it is non-empty; guard on length, not presence.
 *
 * These are resolved from the same _shared/error-catalog.ts that or-sync uses,
 * so the two surfaces cannot drift. They are additive: every field that was
 * here before is still here, `encrypted_last_error` included, so a consumer
 * reading only the raw column keeps working untouched.
 *
 * Sync progress is two fields, never one coerced into the other:
 * `last_sync_cursor` (text, regular rows) and `last_block_scanned` (integer,
 * stealth rows), each null on the row kind that does not carry it.
 *
 * DL-1737, sync freshness. Three additive fields on every row, regular and
 * stealth alike:
 *
 *   `sync_freshness`     `never` (no usable last_sync_at), `fresh` (synced
 *                        within `stale_after_hours`) or `stale`.
 *   `hours_since_sync`   hours since `last_sync_at`, two decimal places, or
 *                        null when there is no usable stamp.
 *   `stale_after_hours`  the threshold this response was computed against.
 *                        Read it rather than hardcoding 72, so the number can
 *                        be tuned without a client release.
 *
 * They exist because a connection silent for 28 days and one synced an hour
 * ago were previously indistinguishable here: both report `status` active and
 * `encrypted_last_error` null. `status` is deliberately UNCHANGED, with no new
 * value added to it, because consumers switch on it and a new value breaks
 * every one that has no branch for it.
 *
 * Computed at read time from one clock read per response. See
 * ../_shared/sync-freshness.ts for why it is not stored, and for the one case
 * where the underlying `last_sync_at` is currently not written by the code
 * that feeds the connection.
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
import { withErrorCopy } from './error-copy.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import {
  buildListResponse,
  isUnmappedStealthStatus,
  mergeConnections,
  SOURCE_WALLETS_UNAVAILABLE_ALARM,
  STEALTH_UNAVAILABLE_ALARM,
  stealthRowToConnection,
  tagRegularConnection,
  withSyncFreshness,
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
    // Tracks whether the source_wallets bulk read could be READ, not
    // whether it returned rows. A connection with no wallets set up is a
    // successful read of an empty set and must not raise this. Mirrors
    // stealthUnavailable below: same non-fatal contract, different store.
    let sourceWalletsUnavailable = false;
    if (connections.length > 0) {
      const connIds = connections.map(c => (c as { id: string }).id);
      const { data: walletRows, error: walletErr } = await ctx.serviceClient
        .from('source_wallets')
        .select('id, connection_id, external_wallet_id, is_synced, encrypted_metadata')
        .in('connection_id', connIds);

      if (walletErr) {
        // Non-fatal: surface connections without wallet badges rather than
        // blocking the whole list. UI degrades to "Default account" rendering.
        // Loud on purpose (DL-1038): the visible symptom is indistinguishable
        // from "no wallets", so the degradation must not be silent.
        sourceWalletsUnavailable = true;
        console.error(
          `[or-connection-list] ${SOURCE_WALLETS_UNAVAILABLE_ALARM} source_wallets query failed:`,
          walletErr,
        );
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
        .select('id, connection_kind, status, last_sync_at, last_block_scanned, created_at')
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

    // DL-1490: resolve the stored error code into customer-facing copy, using
    // the same catalog or-sync uses so the two surfaces cannot drift.
    //
    // Sink mode only. On a non-sink platform encrypted_last_error is
    // ciphertext and is not ours to interpret here. The platform is read from
    // the subaccount row that was already fetched above, so this costs one
    // extra lookup and only when that read succeeded. If it did not, we simply
    // do not decorate: the response keeps exactly the shape it has today.
    let sinkMode = false;
    if (subaccountRow) {
      const { data: platRow, error: platErr } = await ctx.serviceClient
        .from('platforms')
        .select('sink_format')
        .eq('id', subaccountRow.platform_id)
        .maybeSingle();
      if (platErr) {
        // Loud but non-fatal, for the same reason the stealth read is: a
        // failure to enrich must never blank out a user's connections.
        console.error('[or-connection-list] platforms lookup failed, returning without error copy:', platErr);
      }
      sinkMode = typeof platRow?.sink_format === 'string' && platRow.sink_format.length > 0;
    }

    const decorated = enriched.map(
      c => withErrorCopy(c as unknown as Record<string, unknown>, sinkMode),
    ) as unknown as UnifiedConnection[];

    // DL-1737: the clock is read ONCE here and threaded down, so every row in
    // this response is measured against a single instant. Read per row, two
    // connections stamped at the same moment could land on opposite sides of
    // the staleness threshold in the same payload.
    const merged = withSyncFreshness(
      mergeConnections(decorated, stealthConnections),
      new Date(),
    );

    return jsonResponse(
      buildListResponse(merged, stealthUnavailable, sourceWalletsUnavailable),
      200,
      cors,
    );
  } catch (err) {
    console.error('[or-connection-list] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-connection-list'));
