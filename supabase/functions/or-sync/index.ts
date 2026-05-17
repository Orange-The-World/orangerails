/**
 * or-sync — server-side ZKA sync, subaccount-scoped.
 *
 * Replaces the previous user_app_grants token approach with the
 * platform/subaccount model from OrangeRails-Platform-Design.md.
 *
 * Auth (one of):
 *   - X-Platform-API-Key: <hex>   → platform mode (BitBooks V3 etc.)
 *     Body MUST include subaccount_id (validated to belong to platform)
 *   - Authorization: Bearer <jwt> → direct mode (orangerails.com/app)
 *     Subaccount auto-resolved to the user's direct subaccount
 *
 * POST body — TWO MODES:
 *
 *   1. Encrypted-payload mode (legacy, V3 today):
 *        { subaccount_id?, connection_ids?, credentials_key, transactions_key }
 *      OR fetches transactions, encrypts each with transactions_key, stores
 *      ciphertext in encrypted_transactions. Caller fetches via
 *      or-transactions-list and decrypts in-browser.
 *      Response: { synced: number, connections: [{ connection_id, synced, next_cursor, error? }] }
 *
 *   2. Protocol-driven sink mode (V2 today, V3 future):
 *        { subaccount_id?, connection_ids?, credentials_key, format }
 *      OR fetches transactions, runs the registered SinkAdapter for `format`,
 *      returns app-shaped rows in the response body. No encrypted_transactions
 *      storage. transactions_key is NOT required.
 *      Response: {
 *        synced: number,
 *        connections: [{ connection_id, synced, next_cursor, error? }],
 *        rows: { <table-name>: [...rows] },
 *        metadata: { format, requires_encryption: string[] }
 *      }
 *
 * Mode is selected by presence of `format`. See OrangeRails-Protocol.html §8
 * for the protocol contract; see _shared/sinks/dispatch.ts for the sink
 * registry; see _shared/providers/dispatch.ts for the source adapter registry.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import {
  getSinkAdapter,
  listSinkFormats,
  mergeSinkOutputs,
  ensureProfileForFormat,
} from '../_shared/sinks/dispatch.ts';
import type { SinkOutput } from '../_shared/sinks/dispatch.ts';
import { getProvider, parseCredentials } from '../_shared/providers/dispatch.ts';
import type { NormalizedTransaction } from '../_shared/providers/dispatch.ts';

// ─── Error sanitization (audit 2026-05-16, findings #1 + #4) ──────────────
//
// Upstream provider error messages can contain credential fragments, API
// response bodies, or other plaintext that must never leak to:
//   - The HTTP response body (caller-side)
//   - The edge function console (operator-side, persisted ~7 days)
//   - The encrypted_last_error column when encryption fails
//
// All upstream errors are mapped to a small fixed taxonomy. The full message
// is dropped on the floor. Callers get a code; operators get the code plus
// an opaque correlation ID for support purposes.

type UpstreamErrorCode =
  | 'UPSTREAM_AUTH_FAILED'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_BAD_REQUEST'
  | 'UPSTREAM_OTHER';

function classifyUpstreamError(raw: string): UpstreamErrorCode {
  const m = raw.toLowerCase();
  if (/(\b401\b|\b403\b|unauthorized|forbidden|invalid.*(api.?key|token|credential)|signature.*(invalid|mismatch))/.test(m)) {
    return 'UPSTREAM_AUTH_FAILED';
  }
  if (/(\b429\b|rate.?limit|too.?many.?requests|quota.*exceeded)/.test(m)) {
    return 'UPSTREAM_RATE_LIMITED';
  }
  if (/(\b5\d\d\b|timeout|timed.?out|econn(refused|reset|aborted)|network|unreachable|service.*unavailable)/.test(m)) {
    return 'UPSTREAM_UNAVAILABLE';
  }
  if (/(\b400\b|\b404\b|\b422\b|bad.?request|not.?found|unprocessable)/.test(m)) {
    return 'UPSTREAM_BAD_REQUEST';
  }
  return 'UPSTREAM_OTHER';
}

function randomCorrelationId(): string {
  // Opaque short ID for cross-referencing client error → ops investigation.
  // Not security-sensitive; collision resistance just has to be high enough
  // to grep edge logs.
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}


// ─── AES-256-GCM helpers ─────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function decryptAes(ciphertextB64: string, key: CryptoKey): Promise<string> {
  const data = base64ToBytes(ciphertextB64);
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

async function encryptAes(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(12 + cipher.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipher), 12);
  return bytesToBase64(combined);
}

// ─── Main handler ────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw) as {
      subaccount_id?: string;
      connection_ids?: string[];
      credentials_key: string;
      /** Required in encrypted-payload mode, ignored in sink mode. */
      transactions_key?: string;
      /**
       * When set, run the registered SinkAdapter and return app-shaped rows
       * in the response body instead of storing encrypted_payload rows.
       * See _shared/sinks/dispatch.ts for valid values.
       */
      format?: string;
    };

    const { credentials_key, transactions_key, connection_ids, format } = body ?? {};
    if (!credentials_key) {
      return jsonResponse({ error: 'credentials_key required' }, 400, cors);
    }

    // Mode selection — `format` flips into protocol-driven sink mode.
    const sinkMode = typeof format === 'string' && format.length > 0;
    let sinkAdapter: ReturnType<typeof getSinkAdapter> = null;
    if (sinkMode) {
      sinkAdapter = getSinkAdapter(format!);
      if (!sinkAdapter) {
        return jsonResponse(
          {
            error: `Unknown format: ${format}`,
            valid_formats: listSinkFormats(),
          },
          400,
          cors,
        );
      }
      // Ensure the YAML profile (if any) is loaded + validated before we hit
      // the per-transaction loop. Cached after first call. Profile load
      // failures surface here as 500 with a clear message rather than mid-loop.
      try {
        await ensureProfileForFormat(format!);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return jsonResponse({ error: `Profile load failed for format=${format}: ${msg}` }, 500, cors);
      }
    } else {
      // Legacy mode requires the encryption key for the encrypted_transactions store.
      if (!transactions_key) {
        return jsonResponse({ error: 'transactions_key required (or pass `format` for sink mode)' }, 400, cors);
      }
    }

    const subaccountId = await resolveSubaccount(ctx, body.subaccount_id);
    if (isAuthError(subaccountId)) return jsonResponse({ error: subaccountId.message }, subaccountId.status, cors);

    const credsKey = await importAesKey(credentials_key);
    // Only imported in legacy mode — sink mode never encrypts payloads.
    const txnsKey: CryptoKey | null = sinkMode ? null : await importAesKey(transactions_key!);

    let connQuery = ctx.serviceClient
      .from('connections')
      .select('id, provider_type, encrypted_credentials, last_sync_cursor, created_at')
      .eq('subaccount_id', subaccountId)
      .neq('status', 'disconnected');
    if (connection_ids?.length) connQuery = connQuery.in('id', connection_ids);

    const { data: connections, error: connErr } = await connQuery;
    if (connErr) throw connErr;
    if (!connections?.length) {
      // Empty-result early-exit must still match the response shape the
      // caller's mode expects. Sink-mode consumers (V2) parse `rows` +
      // `metadata` strictly, so skipping those fields blows up the client.
      if (sinkMode) {
        return jsonResponse(
          {
            synced: 0,
            connections: [],
            rows: {},
            metadata: { format, requires_encryption: [] },
          },
          200,
          cors,
        );
      }
      return jsonResponse({ synced: 0, connections: [] }, 200, cors);
    }

    const results: Array<{ connection_id: string; synced: number; next_cursor: string | null; error?: string }> = [];
    // Sink-mode-only: collect per-connection sink outputs to merge into
    // a single `rows` map at the end. Empty in legacy mode.
    const sinkOutputs: SinkOutput[] = [];

    for (const conn of connections) {
      try {
        const adapter = getProvider(conn.provider_type as string);
        if (!adapter) throw new Error(`Unknown provider: ${conn.provider_type}`);

        let credsJson: string;
        try {
          credsJson = await decryptAes(conn.encrypted_credentials, credsKey);
        } catch (decErr) {
          // Decryption failure here means the credentials_key the caller
          // sent does not match the one used at or-link-complete time.
          // Most common causes for integrators:
          //   1. The widget locked with a fallback test password because
          //      cred_key was missing or malformed in the URL hash.
          //   2. The user's vault password changed between connect and sync.
          //   3. A vault reset created a new salt; old connection still
          //      has ciphertext locked to the old MEK.
          // Surface enough info to disambiguate without leaking secrets.
          const createdAt = (conn.created_at as string | null) ?? null;
          const ageStr = createdAt
            ? `${Math.round((Date.now() - new Date(createdAt).getTime()) / 1000)}s`
            : 'unknown';
          const baseMsg = decErr instanceof Error ? decErr.message : String(decErr);
          throw new Error(
            `credential decryption failed for connection ${conn.id} ` +
              `(created ${ageStr} ago, provider=${conn.provider_type}). ` +
              `The credentials_key sent does not match the key used to lock ` +
              `this connection. Likely cause: vault password changed since ` +
              `connect, or the widget locked with a test-password fallback. ` +
              `See Consumer-Integration-Guide.md "Wire-format gotchas". ` +
              `Inner: ${baseMsg}`,
          );
        }
        const credentials = parseCredentials(adapter, credsJson);

        // Look up the user's source-wallet selection. If any rows exist with
        // is_synced=true we go wallet-scoped; otherwise we fall back to the
        // legacy account-wide path. We deliberately do NOT auto-backfill
        // source_wallets here — legacy connections continue working untouched
        // until the user opts in by re-running discovery from the UI.
        const { data: sourceWallets, error: swErr } = await ctx.serviceClient
          .from('source_wallets')
          .select('external_wallet_id, is_synced')
          .eq('connection_id', conn.id)
          .eq('is_synced', true);

        if (swErr) throw swErr;

        let newTxs: NormalizedTransaction[];
        let next_cursor: string | null;

        if (sourceWallets && sourceWallets.length > 0) {
          const walletIds = sourceWallets.map((w: { external_wallet_id: string }) => w.external_wallet_id);
          const out = await adapter.syncByWallets(credentials, walletIds, conn.last_sync_cursor ?? null);
          newTxs = out.transactions;
          next_cursor = out.next_cursor;
        } else {
          const out = await adapter.syncAccountWide(credentials, conn.last_sync_cursor ?? null);
          newTxs = out.transactions;
          next_cursor = out.next_cursor;
        }

        if (sinkMode) {
          // Protocol-driven path: run the sink adapter per transaction,
          // collect outputs for response merging. NO encrypted_transactions
          // storage. Consumer inserts what we return.
          for (const tx of newTxs) {
            const out = sinkAdapter!.toAppShape({
              transaction: tx,
              or_connection_id: conn.id,
              or_subaccount_id: subaccountId,
              external_user_id:
                ctx.mode === 'direct'
                  ? ctx.userId
                  : await resolveExternalUserId(ctx.serviceClient, subaccountId),
            });
            sinkOutputs.push(out);
          }
        } else if (newTxs.length > 0) {
          // Legacy encrypted-payload path (V3 today).
          const rows = await Promise.all(
            newTxs.map(async tx => ({
              connection_id: conn.id,
              external_id: tx.id,
              encrypted_payload: await encryptAes(JSON.stringify(tx), txnsKey!),
              payload_key_version: 1,
              occurred_at: tx.timestamp,
            })),
          );
          // Update on conflict (don't skip): re-syncing a connection after a
          // user adds source_wallets — or after any adapter improvement — must
          // re-encrypt and overwrite the existing payload so newer fields
          // (e.g. source_wallet_id) backfill onto pre-existing rows.
          const { error: upsertErr } = await ctx.serviceClient
            .from('encrypted_transactions')
            .upsert(rows, { onConflict: 'connection_id,external_id', ignoreDuplicates: false });
          if (upsertErr) throw upsertErr;
        }

        await ctx.serviceClient
          .from('connections')
          .update({ last_sync_at: new Date().toISOString(), last_sync_cursor: next_cursor, status: 'active', encrypted_last_error: null })
          .eq('id', conn.id);

        results.push({ connection_id: conn.id, synced: newTxs.length, next_cursor });
      } catch (e) {
        // Audit 2026-05-16 findings #1 + #4: never let upstream provider
        // error messages reach the client or the edge log in plaintext.
        // Map to a fixed taxonomy; emit only the code + a correlation id.
        const raw = e instanceof Error ? e.message : String(e);
        const code = classifyUpstreamError(raw);
        const correlationId = randomCorrelationId();
        console.error(`[or-sync] connection ${conn.id} code=${code} cid=${correlationId}`);

        // Persist the taxonomy code on the connection row. In legacy
        // (non-sink) mode we still want it encrypted at rest so the column
        // shape stays uniform across modes. In sink mode the column is
        // plaintext per the V2 contract. We NEVER fall back to writing the
        // raw upstream message — if encryption fails, store only the code.
        const persistable = `${code}:${correlationId}`;
        let storedErr: string | null = persistable;
        if (!sinkMode) {
          try {
            storedErr = await encryptAes(persistable, txnsKey!);
          } catch {
            // Encryption failed — store the unencrypted taxonomy code, not the raw message.
            // (Code + correlation ID contain no customer plaintext.)
            storedErr = persistable;
          }
        }
        await ctx.serviceClient.from('connections').update({ status: 'error', encrypted_last_error: storedErr }).eq('id', conn.id);
        results.push({ connection_id: conn.id, synced: 0, next_cursor: null, error: code, correlation_id: correlationId });
      }
    }

    if (sinkMode) {
      const merged = mergeSinkOutputs(sinkOutputs);
      return jsonResponse(
        {
          synced: results.reduce((s, r) => s + r.synced, 0),
          connections: results,
          rows: merged.rows,
          metadata: {
            format,
            requires_encryption: merged.metadata.requires_encryption,
          },
        },
        200,
        cors,
      );
    }

    return jsonResponse({ synced: results.reduce((s, r) => s + r.synced, 0), connections: results }, 200, cors);

  } catch (err) {
    console.error('[or-sync] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
});

/**
 * Resolve a subaccount's `external_user_id` for sink-mode dispatch. In
 * platform mode the subaccount row holds the platform's chosen identifier
 * (typically the platform's organizationId). Sink adapters use this as
 * their consumer-side row owner key.
 */
async function resolveExternalUserId(
  serviceClient: ReturnType<typeof Object>,
  subaccountId: string,
): Promise<string> {
  // deno-lint-ignore no-explicit-any
  const sb = serviceClient as any;
  const { data, error } = await sb
    .from('subaccounts')
    .select('external_user_id')
    .eq('id', subaccountId)
    .maybeSingle();
  if (error || !data?.external_user_id) {
    throw new Error(`Could not resolve external_user_id for subaccount ${subaccountId}`);
  }
  return data.external_user_id as string;
}
