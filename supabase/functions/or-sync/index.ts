/**
 * or-sync -- server-side ZKA sync, subaccount-scoped.
 *
 * Replaces the previous user_app_grants token approach with the
 * platform/subaccount model from OrangeRails-Platform-Design.md.
 *
 * Auth (one of):
 *   - X-Platform-API-Key: <hex>   → platform mode (multi-tenant integrators)
 *     Body MUST include subaccount_id (validated to belong to platform)
 *   - Authorization: Bearer <jwt> → direct mode (orangerails.com/app)
 *     Subaccount auto-resolved to the user's direct subaccount
 *
 * POST body -- TWO MODES:
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
import { resolveSinkFormatForPlatform } from '../_shared/quiltt-config.ts';
import { lookupErrorCopy } from '../_shared/error-catalog.ts';
import {
import { wrapSentryHandler } from '../_shared/sentry.ts';
  getSinkAdapter,
  listSinkFormats,
  mergeSinkOutputs,
  ensureProfileForFormat,
} from '../_shared/sinks/dispatch.ts';
import type { SinkOutput } from '../_shared/sinks/dispatch.ts';
import { getProvider, parseCredentials } from '../_shared/providers/dispatch.ts';
import type { NormalizedTransaction } from '../_shared/providers/dispatch.ts';
import { drainStrikeQueue } from '../_shared/providers/strike/queue.ts';

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
  | 'UPSTREAM_PARSE_FAILED'
  | 'ADAPTER_CONFIG_ERROR'
  | 'UPSTREAM_OTHER';

function classifyUpstreamError(raw: string): UpstreamErrorCode {
  const m = raw.toLowerCase();
  if (/(\b401\b|\b403\b|unauthorized|forbidden|invalid.*(api.?key|token|credential)|signature.*(invalid|mismatch))/.test(m)) {
    return 'UPSTREAM_AUTH_FAILED';
  }
  if (/(\b429\b|rate.?limit|too.?many.?requests|quota.*exceeded)/.test(m)) {
    return 'UPSTREAM_RATE_LIMITED';
  }
  // Network / connectivity errors (expanded for Deno fetch + Node-style messages)
  if (/(\b5\d\d\b|timeout|timed.?out|econn(refused|reset|aborted)|network|unreachable|service.*unavailable|error sending request|fetch failed|connection (closed|reset|refused)|dns error|tls handshake|tls error)/.test(m)) {
    return 'UPSTREAM_UNAVAILABLE';
  }
  if (/(\b400\b|\b404\b|\b422\b|bad.?request|not.?found|unprocessable)/.test(m)) {
    return 'UPSTREAM_BAD_REQUEST';
  }
  // Response body parse failures (upstream returned non-JSON when JSON expected)
  if (/(syntaxerror|unexpected (token|end of json)|json[. ]*parse|invalid json)/.test(m)) {
    return 'UPSTREAM_PARSE_FAILED';
  }
  // OR's own bug -- adapter received malformed credentials/config (NOT upstream's fault).
  // Pattern matches "[provider] credentials.field required|missing|invalid".
  if (/(\[\w+\] )?credentials\.\w+ (required|missing|invalid)|credentials must be|credentials json/.test(m)) {
    return 'ADAPTER_CONFIG_ERROR';
  }
  // OR's own config gap -- missing env var on the Supabase project. We hit
  // this 2026-06-19 when a new OR DEV ref was provisioned without QUILTT_API_KEY
  // and the symptom surfaced as UPSTREAM_OTHER, hiding the real cause from ops.
  if (/not set on this supabase project|not configured|is required|missing env/.test(m)) {
    return 'ADAPTER_CONFIG_ERROR';
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

// Safe error fingerprint: SHA-256 of redacted first line.
// UUIDs, long hex strings, base64 blobs replaced before hashing so that the
// fingerprint is stable across different requests with the same root cause
// (e.g. same Strike error returns the same fp regardless of correlation IDs
// in the upstream body). Audit 2026-05-16 finding #1: no plaintext content
// in logs -- only a deterministic hash. Operator greps to correlate.
async function errorFingerprint(raw: string, errorClass: string): Promise<string> {
  const firstLine = raw.split('\n')[0] ?? raw;
  const redacted = firstLine
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '<token>')
    .replace(/\b\d{10,}\b/g, '<num>');
  const bytes = new TextEncoder().encode(`${errorClass}|${redacted}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
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

Deno.serve(wrapSentryHandler(async (req: Request) => {
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

    const { credentials_key, transactions_key, connection_ids, format: bodyFormat } = body ?? {};
    if (!credentials_key) {
      return jsonResponse({ error: 'credentials_key required' }, 400, cors);
    }

    // Resolve sink format: platforms.sink_format wins over body.format.
    // Server-side resolution defends against a buggy or malicious caller
    // asking for a sink shape that isn't theirs. body.format kept as a
    // backwards-compat fallback for callers (V2) that pre-date the
    // multi-tenant column. Once every platform row has sink_format
    // populated, the body field can be deprecated.
    let resolvedFormat: string | null = null;
    try {
      resolvedFormat = await resolveSinkFormatForPlatform(
        auth.serviceClient,
        auth.platformId,
        bodyFormat ?? null,
      );
    } catch (resolveErr) {
      console.error('[or-sync] sink_format resolve failed:', resolveErr);
      // Fall back to body.format on resolution failure rather than break.
      resolvedFormat = bodyFormat ?? null;
    }
    const format = resolvedFormat;

    // Mode selection -- `format` flips into protocol-driven sink mode.
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

    // Resolve the owning platform once. Used to enqueue sync.completed
    // webhook deliveries at the bottom of each successful per-connection
    // loop iteration. Looked up via subaccounts.platform_id so platform
    // mode and direct mode share the same code path. If the platform has
    // no webhook_url configured we skip the insert entirely (see below).
    let webhookPlatformId: string | null = null;
    let webhookEnabled = false;
    try {
      const { data: subRow } = await ctx.serviceClient
        .from('subaccounts')
        .select('platform_id, platforms:platform_id(webhook_url)')
        .eq('id', subaccountId)
        .maybeSingle();
      // deno-lint-ignore no-explicit-any
      const subAny = subRow as any;
      if (subAny?.platform_id) {
        webhookPlatformId = subAny.platform_id as string;
        const platRel = subAny.platforms;
        const url = Array.isArray(platRel) ? platRel[0]?.webhook_url : platRel?.webhook_url;
        webhookEnabled = typeof url === 'string' && url.length > 0;
      }
    } catch (e) {
      // Webhook enqueue is best-effort. Failure to resolve the platform
      // must not block the sync response.
      console.error('[or-sync] webhook platform lookup failed:', e);
    }

    const credsKey = await importAesKey(credentials_key);
    // Only imported in legacy mode -- sink mode never encrypts payloads.
    const txnsKey: CryptoKey | null = sinkMode ? null : await importAesKey(transactions_key!);

    let connQuery = ctx.serviceClient
      .from('connections')
      .select('id, provider_type, encrypted_credentials, last_sync_cursor, created_at, strike_subscription_id')
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
        // ─── Quiltt: user-session inbox drain ─────────────────────────
        // Quiltt connections don't go through the server adapter dispatch
        // (Quiltt is a client-side manifest, not in getProvider). The
        // background worker or-quiltt-sync handles OPK-opted-in users;
        // here we handle the non-opted-in path so an active user gets
        // their Quiltt webhook data on next sync without OPK setup.
        if (conn.provider_type === 'quiltt') {
          if (sinkMode) {
            // ── Quiltt sink mode (V2) ─────────────────────────────────
            // Same fetch logic as the legacy (encrypted-payload) path below,
            // but instead of encrypting + storing in encrypted_transactions
            // we normalise each Quiltt transaction into NormalizedTransaction
            // and run it through the registered sink adapter. The consumer
            // (V2) gets app-shaped rows in the response body.

            const quilttApiKeySink = Deno.env.get('QUILTT_API_KEY');
            if (!quilttApiKeySink) {
              throw new Error('QUILTT_API_KEY not set on this Supabase project');
            }

            const { data: mapRowSink, error: mapErrSink } = await ctx.serviceClient
              .from('quiltt_profile_map')
              .select('quiltt_profile_id')
              .eq('subaccount_id', subaccountId)
              .maybeSingle();
            if (mapErrSink) throw mapErrSink;
            if (!mapRowSink) {
              results.push({ connection_id: conn.id, synced: 0, next_cursor: null });
              continue;
            }

            const QUILTT_SINK_INBOX_BATCH = 10;
            const QUILTT_SINK_TX_PAGE_SIZE = 100;
            const QUILTT_SINK_MAX_PAGES = 3;

            const { data: pendingSink, error: pendErrSink } = await ctx.serviceClient
              .from('quiltt_webhook_inbox')
              .select('event_id, event_type, payload, attempts')
              .eq('subaccount_id', subaccountId)
              .is('processed_at', null)
              .order('received_at', { ascending: true })
              .limit(QUILTT_SINK_INBOX_BATCH);
            if (pendErrSink) throw pendErrSink;

            const basicSink = btoa(`${mapRowSink.quiltt_profile_id}:${quilttApiKeySink}`);
            let quilttSinkSynced = 0;

            for (const ev of (pendingSink ?? []) as Array<{
              event_id: string; event_type: string; payload: { record?: { id?: string } };
            }>) {
              if (!ev.event_type.startsWith('connection.synced.successful')) {
                await ctx.serviceClient
                  .from('quiltt_webhook_inbox')
                  .update({ processed_at: new Date().toISOString() })
                  .eq('event_id', ev.event_id);
                continue;
              }
              const quilttConnIdSink = typeof ev.payload?.record?.id === 'string' ? ev.payload.record.id : null;
              if (!quilttConnIdSink) {
                await ctx.serviceClient
                  .from('quiltt_webhook_inbox')
                  .update({ processed_at: new Date().toISOString(), last_error: 'event missing record.id' })
                  .eq('event_id', ev.event_id);
                continue;
              }

              let afterSink: string | null = null;
              let pagesSink = 0;

              while (pagesSink < QUILTT_SINK_MAX_PAGES) {
                const query = `
                  query Q($connId: ID!, $first: Int!, $after: String) {
                    transactions(filter: { connectionId: $connId }, first: $first, after: $after) {
                      pageInfo { hasNextPage endCursor }
                      nodes {
                        id amount currencyCode date description entryType status
                        account { id }
                      }
                    }
                  }
                `;
                const resp = await fetch('https://api.quiltt.io/v1/graphql', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Basic ${basicSink}`,
                    'Content-Type':  'application/json',
                  },
                  body: JSON.stringify({
                    query,
                    variables: { connId: quilttConnIdSink, first: QUILTT_SINK_TX_PAGE_SIZE, after: afterSink },
                  }),
                });
                if (!resp.ok) {
                  throw new Error(`Quiltt GraphQL ${resp.status}`);
                }
                const json = await resp.json();
                const txs = (json?.data?.transactions?.nodes ?? []) as Array<{
                  id: string; amount: number; currencyCode: string; date: string;
                  description: string; entryType: string; status: string;
                  account?: { id?: string };
                }>;
                const pageInfo = json?.data?.transactions?.pageInfo;

                for (const tx of txs) {
                  // Map Quiltt transaction to NormalizedTransaction for the sink adapter.
                  const direction: 'in' | 'out' = tx.entryType === 'credit' ? 'in' : 'out';
                  const normalized: NormalizedTransaction = {
                    id:              tx.id,
                    adapter:         'quiltt',
                    direction,
                    type:            direction === 'in' ? 'deposit' : 'withdrawal',
                    amount:          Math.abs(tx.amount),
                    currency:        tx.currencyCode ?? 'USD',
                    description:     tx.description ?? null,
                    counterparty:    null,
                    status:          tx.status ?? 'posted',
                    timestamp:       tx.date,
                    source_wallet_id: tx.account?.id ?? null,
                  };
                  const out = sinkAdapter!.toAppShape({
                    transaction:      normalized,
                    or_connection_id: conn.id,
                    or_subaccount_id: subaccountId,
                    external_user_id:
                      ctx.mode === 'direct'
                        ? ctx.userId
                        : await resolveExternalUserId(ctx.serviceClient, subaccountId),
                  });
                  sinkOutputs.push(out);
                  quilttSinkSynced++;
                }
                if (!pageInfo?.hasNextPage) break;
                afterSink = pageInfo.endCursor ?? null;
                pagesSink++;
              }

              await ctx.serviceClient
                .from('quiltt_webhook_inbox')
                .update({ processed_at: new Date().toISOString() })
                .eq('event_id', ev.event_id);
            }

            // ── Direct profile-wide fallback ──────────────────────────
            // The webhook inbox is best-effort: a freshly linked bank may
            // have transactions on Quiltt before any connection.synced
            // webhook lands (or webhooks may be unconfigured). When the
            // inbox yielded nothing, query the profile's transactions
            // directly -- same pattern or-quiltt-accounts uses for
            // accounts. The sink consumer dedupes by transaction id, so
            // this is idempotent with the webhook path.
            if (quilttSinkSynced === 0) {
              let afterDirect: string | null = null;
              let pagesDirect = 0;
              while (pagesDirect < QUILTT_SINK_MAX_PAGES) {
                const queryDirect = `
                  query Q($first: Int!, $after: String) {
                    transactions(first: $first, after: $after) {
                      pageInfo { hasNextPage endCursor }
                      nodes {
                        id amount currencyCode date description entryType status
                        account { id }
                      }
                    }
                  }
                `;
                const respDirect = await fetch('https://api.quiltt.io/v1/graphql', {
                  method: 'POST',
                  headers: { 'Authorization': `Basic ${basicSink}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ query: queryDirect, variables: { first: QUILTT_SINK_TX_PAGE_SIZE, after: afterDirect } }),
                });
                if (!respDirect.ok) {
                  console.error(`[or-sync] Quiltt direct query ${respDirect.status}`);
                  break;
                }
                const jsonDirect = await respDirect.json();
                if (jsonDirect?.errors) {
                  console.error('[or-sync] Quiltt direct GraphQL errors:', JSON.stringify(jsonDirect.errors).slice(0, 300));
                  break;
                }
                const txsDirect = (jsonDirect?.data?.transactions?.nodes ?? []) as Array<{
                  id: string; amount: number; currencyCode: string; date: string;
                  description: string; entryType: string; status: string; account?: { id?: string };
                }>;
                for (const tx of txsDirect) {
                  const direction: 'in' | 'out' = tx.entryType?.toUpperCase() === 'CREDIT' ? 'in' : 'out';
                  const normalized: NormalizedTransaction = {
                    id:               tx.id,
                    adapter:          'quiltt',
                    direction,
                    type:             direction === 'in' ? 'deposit' : 'withdrawal',
                    amount:           Math.abs(tx.amount),
                    currency:         tx.currencyCode ?? 'USD',
                    description:      tx.description ?? null,
                    counterparty:     null,
                    status:           tx.status ?? 'posted',
                    timestamp:        tx.date,
                    source_wallet_id: tx.account?.id ?? null,
                  };
                  const out = sinkAdapter!.toAppShape({
                    transaction:      normalized,
                    or_connection_id: conn.id,
                    or_subaccount_id: subaccountId,
                    external_user_id:
                      ctx.mode === 'direct'
                        ? ctx.userId
                        : await resolveExternalUserId(ctx.serviceClient, subaccountId),
                  });
                  sinkOutputs.push(out);
                  quilttSinkSynced++;
                }
                const pageInfoDirect = jsonDirect?.data?.transactions?.pageInfo;
                if (!pageInfoDirect?.hasNextPage) break;
                afterDirect = pageInfoDirect.endCursor ?? null;
                pagesDirect++;
              }
            }

            await ctx.serviceClient
              .from('connections')
              .update({ last_sync_at: new Date().toISOString(), status: 'active' })
              .eq('id', conn.id);

            results.push({ connection_id: conn.id, synced: quilttSinkSynced, next_cursor: null });

            if (webhookEnabled && webhookPlatformId && quilttSinkSynced > 0) {
              try {
                await ctx.serviceClient.from('webhook_delivery').insert({
                  platform_id:   webhookPlatformId,
                  subaccount_id: subaccountId,
                  event_type:    'sync.completed',
                  payload: {
                    event:         'sync.completed',
                    provider:      'quiltt',
                    subaccount_id: subaccountId,
                    connection_id: conn.id,
                    synced_count:  quilttSinkSynced,
                    ts:            new Date().toISOString(),
                  },
                });
              } catch (whErr) {
                console.error(`[or-sync] webhook enqueue failed for quiltt sink conn ${conn.id}:`, whErr);
              }
            }

            continue;
          }
          const quilttApiKey = Deno.env.get('QUILTT_API_KEY');
          if (!quilttApiKey) {
            throw new Error('QUILTT_API_KEY not set on this Supabase project');
          }

          const { data: mapRow, error: mapErr } = await ctx.serviceClient
            .from('quiltt_profile_map')
            .select('quiltt_profile_id')
            .eq('subaccount_id', subaccountId)
            .maybeSingle();
          if (mapErr) throw mapErr;
          if (!mapRow) {
            // Link was never completed for this subaccount. Surface a
            // structured no-op result; integrator's UI explains.
            results.push({ connection_id: conn.id, synced: 0, next_cursor: null });
            continue;
          }

          // Drain pending inbox events for this subaccount. Limit so a
          // single user-session sync stays under the function deadline.
          const QUILTT_INBOX_BATCH = 10;
          const QUILTT_TX_PAGE_SIZE = 100;
          const QUILTT_MAX_PAGES = 3;
          const { data: pending, error: pendErr } = await ctx.serviceClient
            .from('quiltt_webhook_inbox')
            .select('event_id, event_type, payload, attempts')
            .eq('subaccount_id', subaccountId)
            .is('processed_at', null)
            .order('received_at', { ascending: true })
            .limit(QUILTT_INBOX_BATCH);
          if (pendErr) throw pendErr;

          const basic = btoa(`${mapRow.quiltt_profile_id}:${quilttApiKey}`);
          let synced = 0;

          for (const ev of (pending ?? []) as Array<{
            event_id: string; event_type: string; payload: { record?: { id?: string } };
          }>) {
            if (!ev.event_type.startsWith('connection.synced.successful')) {
              await ctx.serviceClient
                .from('quiltt_webhook_inbox')
                .update({ processed_at: new Date().toISOString() })
                .eq('event_id', ev.event_id);
              continue;
            }
            const quilttConnId = typeof ev.payload?.record?.id === 'string' ? ev.payload.record.id : null;
            if (!quilttConnId) {
              await ctx.serviceClient
                .from('quiltt_webhook_inbox')
                .update({ processed_at: new Date().toISOString(), last_error: 'event missing record.id' })
                .eq('event_id', ev.event_id);
              continue;
            }

            let after: string | null = null;
            let pages = 0;
            const rowsToInsert: Array<{ connection_id: string; external_id: string; encrypted_payload: string; payload_key_version: number; occurred_at: string | null }> = [];

            while (pages < QUILTT_MAX_PAGES) {
              const query = `
                query Q($connId: ID!, $first: Int!, $after: String) {
                  transactions(filter: { connectionId: $connId }, first: $first, after: $after) {
                    pageInfo { hasNextPage endCursor }
                    nodes {
                      id amount currencyCode date description entryType status
                      account { id }
                    }
                  }
                }
              `;
              const resp = await fetch('https://api.quiltt.io/v1/graphql', {
                method: 'POST',
                headers: {
                  'Authorization': `Basic ${basic}`,
                  'Content-Type':  'application/json',
                },
                body: JSON.stringify({
                  query,
                  variables: { connId: quilttConnId, first: QUILTT_TX_PAGE_SIZE, after },
                }),
              });
              if (!resp.ok) {
                throw new Error(`Quiltt GraphQL ${resp.status}`);
              }
              const json = await resp.json();
              const txs = (json?.data?.transactions?.nodes ?? []) as Array<{
                id: string; amount: number; currencyCode: string; date: string;
                description: string; entryType: string; status: string;
                account?: { id?: string };
              }>;
              const pageInfo = json?.data?.transactions?.pageInfo;

              for (const tx of txs) {
                const cleartext = JSON.stringify({
                  amount:          tx.amount,
                  currency:        tx.currencyCode,
                  description:     tx.description,
                  entry_type:      tx.entryType,
                  upstream_status: tx.status,
                  account_id:      tx.account?.id,
                });
                rowsToInsert.push({
                  connection_id:       conn.id,
                  external_id:         tx.id,
                  encrypted_payload:   await encryptAes(cleartext, txnsKey!),
                  payload_key_version: 1,
                  occurred_at:         tx.date,
                });
              }
              if (!pageInfo?.hasNextPage) break;
              after = pageInfo.endCursor ?? null;
              pages++;
            }

            if (rowsToInsert.length > 0) {
              const { error: upsertErr } = await ctx.serviceClient
                .from('encrypted_transactions')
                .upsert(rowsToInsert, { onConflict: 'connection_id,external_id', ignoreDuplicates: true });
              if (upsertErr) throw upsertErr;
              synced += rowsToInsert.length;
            }

            await ctx.serviceClient
              .from('quiltt_webhook_inbox')
              .update({ processed_at: new Date().toISOString() })
              .eq('event_id', ev.event_id);
          }

          await ctx.serviceClient
            .from('connections')
            .update({ last_sync_at: new Date().toISOString(), status: 'active' })
            .eq('id', conn.id);

          results.push({ connection_id: conn.id, synced, next_cursor: null });

          if (webhookEnabled && webhookPlatformId && synced > 0) {
            try {
              await ctx.serviceClient.from('webhook_delivery').insert({
                platform_id:   webhookPlatformId,
                subaccount_id: subaccountId,
                event_type:    'sync.completed',
                payload: {
                  event:         'sync.completed',
                  provider:      'quiltt',
                  subaccount_id: subaccountId,
                  connection_id: conn.id,
                  synced_count:  synced,
                  ts:            new Date().toISOString(),
                },
              });
            } catch (whErr) {
              console.error(`[or-sync] webhook enqueue failed for quiltt conn ${conn.id}:`, whErr);
            }
          }

          continue;
        }

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
        // source_wallets here -- legacy connections continue working untouched
        // until the user opts in by re-running discovery from the UI.
        const { data: sourceWallets, error: swErr } = await ctx.serviceClient
          .from('source_wallets')
          .select('external_wallet_id, is_synced')
          .eq('connection_id', conn.id)
          .eq('is_synced', true);

        if (swErr) throw swErr;

        let newTxs: NormalizedTransaction[];
        let next_cursor: string | null;

        if (conn.provider_type === 'strike') {
          // Strike uses BOTH paths now (V3 ADR 2026-05-25):
          //   1. Per-state polling via GET /v1/invoices?$filter=(state eq 'X')
          //      -- historical backfill + catchup. Compound `or` filters trip
          //      Cloudflare so we iterate states; simple `eq` is fine.
          //   2. Webhook queue drain (drainStrikeQueue) -- near-real-time
          //      updates for events received since last sync.
          // Both paths merge into newTxs. Idempotent on the consumer side
          // via UNIQUE (connection_id, external_id) so duplicates are no-ops.
          const supabaseUrl = Deno.env.get('SUPABASE_URL');
          if (!supabaseUrl) throw new Error('SUPABASE_URL not set');

          // 1) Polling: historical + ongoing per-state list scan
          const poll = await adapter.syncByWallets(
            credentials,
            ['strike'],
            conn.last_sync_cursor ?? null,
          );

          // 2) Real-time: drain any webhook-queued events. Side effect:
          //    registers a Strike webhook subscription on first call.
          const drain = await drainStrikeQueue({
            serviceClient: ctx.serviceClient,
            connection: {
              id: conn.id as string,
              strike_subscription_id: (conn as { strike_subscription_id?: string | null }).strike_subscription_id ?? null,
              last_sync_cursor: conn.last_sync_cursor ?? null,
            },
            credentials,
            webhookBaseUrl: `${supabaseUrl}/functions/v1/or-strike-webhook`,
          });

          newTxs = [...poll.transactions, ...drain.transactions];
          // Polling cursor takes precedence (it's a real timestamp, 'or-sync'));
          // drain.next_cursor is unused under the webhook model.
          next_cursor = poll.next_cursor ?? drain.next_cursor;
        } else if (sourceWallets && sourceWallets.length > 0) {
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
          // user adds source_wallets -- or after any adapter improvement -- must
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

        // ─── sync.completed webhook enqueue ──────────────────────────
        // Out-of-band: insert a webhook_delivery row that or-webhook-dispatch
        // drains on its own schedule. We do NOT fire synchronously here;
        // a slow consumer endpoint must never delay a sync response. The
        // insert is skipped entirely when the owning platform has no
        // webhook_url configured (most direct-mode users today).
        if (webhookEnabled && webhookPlatformId) {
          try {
            // Dual-shape payload -- emitted in parallel during the SDK
            // transition window (May 2026 → ~end Q3 2026).
            //
            // - Top-level `event` + flat fields preserves the legacy
            //   wire format that hand-rolled receivers (V2 pre-SDK, OW
            //   pre-SDK) read. Removing it would break them mid-flight.
            // - Top-level `type` + nested `data` matches the shape
            //   `@orangerails/webhooks` (and the broader industry
            //   convention: Stripe, Linear, Shopify) expect.
            //
            // Once every known consumer is on the SDK, drop the flat
            // fields and keep only { type, data }. Tracked in OR's
            // webhook architecture doc on maintainer-only.
            const ts = new Date().toISOString();
            const data = {
              subaccount_id: subaccountId,
              connection_id: conn.id,
              synced_count: newTxs.length,
              ts,
            };
            await ctx.serviceClient.from('webhook_delivery').insert({
              platform_id: webhookPlatformId,
              subaccount_id: subaccountId,
              event_type: 'sync.completed',
              payload: {
                // legacy flat shape
                event: 'sync.completed',
                ...data,
                // canonical shape consumed by @orangerails/webhooks
                type: 'sync.completed',
                data,
              },
            });
          } catch (whErr) {
            // Best-effort: log and move on. The sync itself already succeeded.
            console.error(`[or-sync] webhook enqueue failed for connection ${conn.id}:`, whErr);
          }
        }
      } catch (e) {
        // Audit 2026-05-16 findings #1 + #4: never let upstream provider
        // error messages reach the client or the edge log in plaintext.
        // Map to a fixed taxonomy; emit only the code + a correlation id.
        const raw = e instanceof Error ? e.message : String(e);
        const errorClass = e instanceof Error ? e.constructor.name : typeof e;
        const code = classifyUpstreamError(raw);
        const correlationId = randomCorrelationId();
        const fp = await errorFingerprint(raw, errorClass);
        console.error(`[or-sync] connection ${conn.id} code=${code} class=${errorClass} fp=${fp} cid=${correlationId}`);

        // Persist the taxonomy code on the connection row. In legacy
        // (non-sink) mode we still want it encrypted at rest so the column
        // shape stays uniform across modes. In sink mode the column is
        // plaintext per the V2 contract. We NEVER fall back to writing the
        // raw upstream message -- if encryption fails, store only the code.
        const persistable = `${code}:${correlationId}`;
        let storedErr: string | null = persistable;
        if (!sinkMode) {
          try {
            storedErr = await encryptAes(persistable, txnsKey!);
          } catch {
            // Encryption failed -- store the unencrypted taxonomy code, not the raw message.
            // (Code + correlation ID contain no customer plaintext.)
            storedErr = persistable;
          }
        }
        await ctx.serviceClient.from('connections').update({ status: 'error', encrypted_last_error: storedErr }).eq('id', conn.id);
        const copy = lookupErrorCopy(code);
        results.push({
          connection_id: conn.id,
          synced: 0,
          next_cursor: null,
          error: code,
          correlation_id: correlationId,
          // Customer-facing copy. Backward-compatible additive fields --
          // existing clients reading only `error` keep working.
          message: copy.title,
          detail: copy.body,
          action: copy.action,
          help_url: copy.help_url,
        });
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
// Memo cache -- resolveExternalUserId is called once per transaction inside
// the sink loops; without caching that is N identical DB round-trips per
// sync (114 lookups for a 114-tx Mercury sync, ~10s wasted under load).
// Cache per subaccount for the lifetime of the function invocation.
const _externalUserIdCache = new Map<string, string>();
async function resolveExternalUserId(
  serviceClient: ReturnType<typeof Object>,
  subaccountId: string,
): Promise<string> {
  const cached = _externalUserIdCache.get(subaccountId);
  if (cached !== undefined) return cached;
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
  const val = data.external_user_id as string;
  _externalUserIdCache.set(subaccountId, val);
  return val;
}
