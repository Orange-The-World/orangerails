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
 *      Response: { synced: number, connections: [{ connection_id, synced?, next_cursor, partial?, denied_sources?, error? }] }
 *      HTTP: 200 all succeeded, 207 mixed, 422 all non-success (error or skip).
 *
 *   2. Protocol-driven sink mode (V2 today, V3 future):
 *        { subaccount_id?, connection_ids?, credentials_key, format }
 *      OR fetches transactions, runs the registered SinkAdapter for `format`,
 *      returns app-shaped rows in the response body. No encrypted_transactions
 *      storage. transactions_key is NOT required.
 *      Response: {
 *        synced: number,
 *        connections: [{ connection_id, synced?, next_cursor, partial?, denied_sources?, error? }],
 *      HTTP: 200 all succeeded, 207 mixed, 422 all non-success (error or skip).
 *        rows: { <table-name>: [...rows] },
 *        metadata: { format, requires_encryption: string[] }
 *      }
 *
 * connection_ids miss behaviour (both modes, DL-1033 + DL-1105):
 *   Total miss (zero ids resolve): 404 if unknown, 400 if stealth (DL-1033).
 *   Partial miss (some ids resolve, some do not): the entire request fails with
 *   the same non-2xx shape. When unresolved ids are a mix of stealth and unknown,
 *   400 wins (stealth is the caller-fixable condition). Body lists both sets
 *   separately: 400 { error, stealth_ids, unknown_ids }. All-unknown: 404 { error, unresolved_ids }.
 *   Callers must not assume a 200 covers all requested ids -- silent-drop is gone.
 *
 * Mode is selected by presence of `format`. See OrangeRails-Protocol.html §8
 * for the protocol contract; see _shared/sinks/dispatch.ts for the sink
 * registry; see _shared/providers/dispatch.ts for the source adapter registry.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, resolveSubaccount, isAuthError } from '../_shared/platform-auth.ts';
import { getPlatformSinkFormat } from '../_shared/quiltt-config.ts';
import { lookupErrorCopy } from '../_shared/error-catalog.ts';
import { classifyUpstreamError, errorClassName } from '../_shared/upstream-errors.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import { buildSyncCompletedPayload } from '../_shared/webhook-events.ts';
import {
  getSinkAdapter,
  listSinkFormats,
  mergeSinkOutputs,
  ensureProfileForFormat,
} from '../_shared/sinks/dispatch.ts';
import type { SinkOutput } from '../_shared/sinks/dispatch.ts';
import { getProvider, parseCredentials } from '../_shared/providers/dispatch.ts';
import type { NormalizedTransaction } from '../_shared/providers/dispatch.ts';
import { drainStrikeQueue } from '../_shared/providers/strike/queue.ts';
import { computeWalletFingerprint } from '../_shared/account-fingerprint.ts';
import { toByteaHex } from '../_shared/bytea.ts';
import { readSyncCompleteness } from './_connection-result.ts';

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
//
// classifyUpstreamError and errorClassName moved to _shared/upstream-errors.ts
// (DL-0421). They were unreachable from a test while they lived here, because
// this module calls Deno.serve() at import time. The sanitization boundary is
// unchanged: `raw` is still inspected in memory and never emitted.

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

// ─── Human-readable redacted detail for UPSTREAM_OTHER (DL-1292) ──────────
// Amends audit 2026-05-16 finding #1. An unclassified upstream failure
// (UPSTREAM_OTHER) leaves an operator with only a code and a hash, which is
// not enough to explain the failure to an integrator. This produces a
// redacted, human-readable first line of the upstream error for the EDGE LOG
// ONLY.
//
// The hard rule: never emit a shape the fingerprint hash path
// (errorFingerprint) would have scrubbed. So it removes the SAME UUIDs and
// base64/token blobs that path removes, PLUS email addresses, provider ids
// (foo_ab12cd), and 4+ digit runs. Every redaction runs on the FULL first line and the 300-char
// limit is applied LAST, so truncation can only ever cut text that is already
// safe. Nothing here reaches the HTTP response body or encrypted_last_error.
export function redactedUpstreamDetail(raw: string): string {
  const firstLine = raw.split('\n')[0] ?? raw;
  return firstLine
    .replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b([a-z]{1,8})_[A-Za-z0-9]{6,}\b/gi, '$1_[redacted]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '<token>')
    .replace(/\b\d{4,}\b/g, '[redacted]')
    .slice(0, 300);
}

// The ` detail=...` suffix appended to the edge log line: present ONLY on the
// UPSTREAM_OTHER path, empty on every other code. JSON.stringify keeps it a
// single grep-safe token. Split out so the UPSTREAM_OTHER-only gating is
// unit-testable without stubbing console.
export function upstreamDetailSuffix(code: string, raw: string): string {
  return code === 'UPSTREAM_OTHER' ? ` detail=${JSON.stringify(redactedUpstreamDetail(raw))}` : '';
}

/**
 * Determine the HTTP status for a batch sync response.
 *   200 -- every connection succeeded (or the batch was empty).
 *   207 -- some connections succeeded; at least one failed or was skipped.
 *   422 -- every connection in the batch failed or was skipped (e.g. no_quiltt_profile_map).
 *
 * Exported so the pure logic can be unit-tested without a Deno.serve mock.
 */
export function batchHttpStatus(results: Array<{ synced?: number; error?: string; skip_reason?: string }>): number {
  if (results.length === 0) return 200;
  // Count both hard errors and soft skips (e.g. no_quiltt_profile_map) as
  // non-success so the HTTP status is honest. A skip is not a clean sync.
  const errCount = results.filter(r => r.error != null || r.skip_reason != null).length;
  if (errCount === 0) return 200;
  if (errCount === results.length) return 422;
  return 207;
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

    // Resolve sink format. platforms.sink_format is intended to win over
    // body.format so a caller cannot request a sink shape that isn't theirs,
    // with body.format kept as a backwards-compat fallback for callers (V2)
    // that pre-date the multi-tenant column.
    //
    // Rolled out dark. The flag OR_SYNC_SINK_FORMAT_ENFORCE is OFF by default,
    // so behavior is unchanged here: body.format is used. We still run the
    // resolution and log, per platform, when the server-resolved format WOULD
    // differ from the body.format actually sent. That turns an otherwise
    // unmeasurable question (no store records the body.format each platform
    // sends) into an observed fact, with zero behavior change, before the flag
    // is turned on later (a separate, prod, two-party change).
    //
    // platformId only exists on a platform-mode context, so the resolution is
    // guarded to that mode. Direct-mode callers keep the body.format fallback.
    const enforceSinkFormat = Deno.env.get('OR_SYNC_SINK_FORMAT_ENFORCE') === '1';
    const requestedFormat: string | null = bodyFormat ?? null;
    let resolvedFormat: string | null = requestedFormat;
    if (ctx.mode === 'platform') {
      try {
        const platformSinkFormat = await getPlatformSinkFormat(ctx.serviceClient, ctx.platformId);
        // Case 1: sink_format is NULL. No-op, requestedFormat stands, always.
        if (platformSinkFormat !== null) {
          const mismatched = requestedFormat !== null && requestedFormat !== platformSinkFormat;
          if (mismatched) {
            if (enforceSinkFormat) {
              // Case 3: populated and different. Refuse instead of silently
              // rewriting the request to a sink the caller did not ask for.
              return jsonResponse(
                {
                  error: 'Requested sink format does not match this platform\'s configured sink_format',
                  requested_format: requestedFormat,
                  platform_format: platformSinkFormat,
                },
                409,
                cors,
              );
            }
            // Dark rollout: still just observe. Format names and the
            // platform id only. No user data, no secrets.
            console.log(
              `[or-sync] sink_format-observe platform=${ctx.platformId} ` +
              `would_reject=1 body_format=${requestedFormat} ` +
              `server_format=${platformSinkFormat} enforced=0`,
            );
          }
          // Case 4 (OR-T1183 guard): enforcement may only ever override a
          // format the caller actually sent. A populated sink_format must
          // never turn sink mode on for a caller that sent none, because
          // sinkMode below is derived from resolvedFormat being a non-empty
          // string, and that would be a mode change, not a narrowing.
          if (enforceSinkFormat && requestedFormat !== null) {
            // Case 2 (equal) is a no-op here too: platformSinkFormat already
            // equals requestedFormat, so this assignment changes nothing.
            resolvedFormat = platformSinkFormat;
          }
        }
      } catch (resolveErr) {
        // Log the error CLASS only, never the error object. This catch can
        // receive a Postgres error whose message may embed row values, which
        // must never reach the edge log in plaintext, the same control the
        // sync error path upstream applies.
        console.error(
          '[or-sync] sink_format resolve failed, class=' + errorClassName(resolveErr),
        );
        // Fall back to body.format on resolution failure rather than break.
        resolvedFormat = requestedFormat;
      }
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
      // When the caller requested specific IDs and none resolved to a regular
      // connection, this is a miss, not an empty batch. Fall through to the
      // stealth store with the same ownership scope or-connection-delete uses:
      // (id, platform_id, app_user_id). A foreign-subaccount stealth id and a
      // genuinely unknown id both resolve to 404; a stealth id that belongs to
      // this subaccount gets a 400 explaining the right endpoint to use.
      if (connection_ids?.length) {
        const { data: subRow, error: subErr } = await ctx.serviceClient
          .from('subaccounts')
          .select('platform_id, external_user_id')
          .eq('id', subaccountId)
          .maybeSingle();

        if (!subErr && subRow) {
          const { count: stealthCount, error: stealthErr } = await ctx.serviceClient
            .from('stealth_connections')
            .select('id', { count: 'exact', head: true })
            .in('id', connection_ids)
            .eq('platform_id', subRow.platform_id)
            .eq('app_user_id', subRow.external_user_id);

          if (!stealthErr && (stealthCount ?? 0) > 0) {
            return jsonResponse(
              { error: 'Stealth connections cannot be synced via this endpoint' },
              400,
              cors,
            );
          }
        }
        // The main query excludes status='disconnected'. A disconnected id resolves
        // to nothing in that query but is not "not found". Return 422 so callers
        // can distinguish it from a genuinely unknown id (consistent with the
        // partial-miss disconnected branch, DL-1105).
        const { data: disconnectedRows } = await ctx.serviceClient
          .from('connections')
          .select('id')
          .in('id', connection_ids)
          .eq('subaccount_id', subaccountId)
          .eq('status', 'disconnected');

        if (disconnectedRows?.length) {
          const disconnectedIds = disconnectedRows.map((r) => r.id);
          const disconnectedSet = new Set(disconnectedIds);
          const unknownIds = connection_ids.filter((id) => !disconnectedSet.has(id));
          return jsonResponse(
            {
              error: 'Connection is disconnected and cannot be synced',
              disconnected_ids: disconnectedIds,
              unknown_ids: unknownIds,
            },
            422,
            cors,
          );
        }
        // Not found in connections, stealth, or disconnected for this subaccount.
        return jsonResponse({ error: 'Connection not found in this subaccount' }, 404, cors);
      }

      // Empty-result early-exit (no connection_ids filter) must still match the
      // response shape the caller's mode expects. Sink-mode consumers (V2)
      // parse `rows` + `metadata` strictly, so skipping those fields blows up
      // the client.
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

    // Partial-miss guard (DL-1105): derive unresolved ids via set difference
    // over the deduplicated request list. Count comparison is wrong: repeated
    // ids in the caller's array (e.g. ["a","a"]) trigger count < length even
    // when every unique id resolved, producing a spurious 404 with
    // unresolved_ids: []. The main query also excludes status='disconnected';
    // a disconnected id is real and must not be conflated with "not found".
    if (connection_ids?.length) {
      const resolvedSet = new Set(connections!.map((c) => c.id));
      const unresolvedIds = [...new Set(connection_ids)].filter(
        (id) => !resolvedSet.has(id),
      );

      if (unresolvedIds.length > 0) {
        const { data: subRow, error: subErr } = await ctx.serviceClient
          .from('subaccounts')
          .select('platform_id, external_user_id')
          .eq('id', subaccountId)
          .maybeSingle();

        if (!subErr && subRow) {
          const { data: stealthRows, error: stealthErr } = await ctx.serviceClient
            .from('stealth_connections')
            .select('id')
            .in('id', unresolvedIds)
            .eq('platform_id', subRow.platform_id)
            .eq('app_user_id', subRow.external_user_id);

          if (!stealthErr && stealthRows && stealthRows.length > 0) {
            const stealthIds = stealthRows.map((r) => r.id);
            const stealthSet = new Set(stealthIds);
            const unknownIds = unresolvedIds.filter((id) => !stealthSet.has(id));
            return jsonResponse(
              {
                error: 'Stealth connections cannot be synced via this endpoint',
                stealth_ids: stealthIds,
                unknown_ids: unknownIds,
              },
              400,
              cors,
            );
          }
        }

        // The main query excludes status='disconnected'. A disconnected id
        // resolves to nothing in that query but is not "not found"; return 422
        // so callers can differentiate it from a genuinely unknown id.
        const { data: disconnectedRows } = await ctx.serviceClient
          .from('connections')
          .select('id')
          .in('id', unresolvedIds)
          .eq('subaccount_id', subaccountId)
          .eq('status', 'disconnected');

        if (disconnectedRows?.length) {
          const disconnectedIds = disconnectedRows.map((r) => r.id);
          const disconnectedSet = new Set(disconnectedIds);
          const unknownIds = unresolvedIds.filter(
            (id) => !disconnectedSet.has(id),
          );
          return jsonResponse(
            {
              error: 'Connection is disconnected and cannot be synced',
              disconnected_ids: disconnectedIds,
              unknown_ids: unknownIds,
            },
            422,
            cors,
          );
        }

        return jsonResponse(
          {
            error: 'Connection not found in this subaccount',
            unresolved_ids: unresolvedIds,
          },
          404,
          cors,
        );
      }
    }

    const results: Array<{
      connection_id: string;
      synced?: number;
      next_cursor: string | null;
      error?: string;
      correlation_id?: string;
      message?: string;
      detail?: string;
      action?: string;
      help_url?: string | null;
      skip_reason?: string;
      partial?: boolean;
      denied_sources?: string[];
    }> = [];
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
              console.log(`[or-sync] quiltt no-map-row skip (sink) subaccount=${subaccountId}`);
              results.push({ connection_id: conn.id, synced: 0, next_cursor: null, skip_reason: 'no_quiltt_profile_map' });
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

              // DL-0741: Quiltt's TransactionFilter accepts accountIds ([ID!]) but not
              // connectionId. Pre-fetch account ids for the connection once before paging.
              const acctRespSink = await fetch('https://api.quiltt.io/v1/graphql', {
                method: 'POST',
                headers: {
                  'Authorization': `Basic ${basicSink}`,
                  'Content-Type':  'application/json',
                },
                body: JSON.stringify({
                  query: `query GetAccounts($connId: ID!) {
                    connection(id: $connId) {
                      accounts { id }
                    }
                  }`,
                  variables: { connId: quilttConnIdSink },
                }),
              });
              if (!acctRespSink.ok) throw new Error(`Quiltt accounts fetch ${acctRespSink.status}`);
              const acctJsonSink = await acctRespSink.json();
              if (Array.isArray(acctJsonSink?.errors) && acctJsonSink.errors.length > 0) {
                const msgs = (acctJsonSink.errors as Array<any>)
                  .map((e: any) => (typeof e?.message === 'string' ? e.message : ''))
                  .filter((m: string) => m.length > 0)
                  .join('; ');
                throw new Error(`Quiltt accounts fetch errors: ${msgs}`);
              }
              const filterAccountIdsSink: string[] = (
                (acctJsonSink?.data?.connection?.accounts ?? []) as Array<{ id: string }>
              ).map((a) => a.id);

              if (filterAccountIdsSink.length === 0) {
                // No accounts on this connection: nothing to sync. Mark processed and move on.
                await ctx.serviceClient
                  .from('quiltt_webhook_inbox')
                  .update({ processed_at: new Date().toISOString() })
                  .eq('event_id', ev.event_id);
                continue;
              }

              let afterSink: string | null = null;
              let pagesSink = 0;

              while (pagesSink < QUILTT_SINK_MAX_PAGES) {
                const query = `
                  query Q($accountIds: [ID!]!, $first: Int!, $after: String) {
                    transactions(filter: { accountIds: $accountIds }, first: $first, after: $after) {
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
                    variables: { accountIds: filterAccountIdsSink, first: QUILTT_SINK_TX_PAGE_SIZE, after: afterSink },
                  }),
                });
                if (!resp.ok) {
                  throw new Error(`Quiltt GraphQL ${resp.status}`);
                }
                const json = await resp.json();
                if (Array.isArray(json?.errors) && json.errors.length > 0) {
                  const msgs = (json.errors as Array<any>)
                    .map((e: any) => (typeof e?.message === 'string' ? e.message : ''))
                    .filter((m: string) => m.length > 0)
                    .join('; ');
                  throw new Error(`Quiltt transactions fetch errors: ${msgs}`);
                }
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
              .update({ last_sync_at: new Date().toISOString(), status: (pendingSink?.length ?? 0) > 0 && quilttSinkSynced === 0 ? 'partial' : 'active' })
              .eq('id', conn.id);

            results.push({ connection_id: conn.id, synced: quilttSinkSynced, next_cursor: null });

            if (webhookEnabled && webhookPlatformId && quilttSinkSynced > 0) {
              try {
                await ctx.serviceClient.from('webhook_delivery').insert({
                  platform_id:   webhookPlatformId,
                  subaccount_id: subaccountId,
                  event_type:    'sync.completed',
                  payload: buildSyncCompletedPayload({
                    subaccountId,
                    connectionId: conn.id,
                    syncedCount:  quilttSinkSynced,
                    provider:     'quiltt',
                  }),
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
            // Link was never completed for this subaccount. Log the skip so
            // it is visible in edge logs and surface a reason field so callers
            // can distinguish a genuine zero-sync from a missing-profile bail.
            console.log(`[or-sync] quiltt no-map-row skip (legacy) subaccount=${subaccountId}`);
            results.push({ connection_id: conn.id, synced: 0, next_cursor: null, skip_reason: 'no_quiltt_profile_map' });
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

            // DL-0741: Quiltt's TransactionFilter accepts accountIds ([ID!]) but not
            // connectionId. Pre-fetch account ids for the connection once before paging.
            const acctRespMain = await fetch('https://api.quiltt.io/v1/graphql', {
              method: 'POST',
              headers: {
                'Authorization': `Basic ${basic}`,
                'Content-Type':  'application/json',
              },
              body: JSON.stringify({
                query: `query GetAccounts($connId: ID!) {
                  connection(id: $connId) {
                    accounts { id }
                  }
                }`,
                variables: { connId: quilttConnId },
              }),
            });
            if (!acctRespMain.ok) throw new Error(`Quiltt accounts fetch ${acctRespMain.status}`);
            const acctJsonMain = await acctRespMain.json();
            if (Array.isArray(acctJsonMain?.errors) && acctJsonMain.errors.length > 0) {
              const msgs = (acctJsonMain.errors as Array<any>)
                .map((e: any) => (typeof e?.message === 'string' ? e.message : ''))
                .filter((m: string) => m.length > 0)
                .join('; ');
              throw new Error(`Quiltt accounts fetch errors: ${msgs}`);
            }
            const filterAccountIdsMain: string[] = (
              (acctJsonMain?.data?.connection?.accounts ?? []) as Array<{ id: string }>
            ).map((a) => a.id);

            if (filterAccountIdsMain.length === 0) {
              // No accounts on this connection: nothing to sync. Mark processed and move on.
              await ctx.serviceClient
                .from('quiltt_webhook_inbox')
                .update({ processed_at: new Date().toISOString() })
                .eq('event_id', ev.event_id);
              continue;
            }

            let after: string | null = null;
            let pages = 0;
            const rowsToInsert: Array<{ connection_id: string; external_id: string; encrypted_payload: string; payload_key_version: number; occurred_at: string | null }> = [];

            while (pages < QUILTT_MAX_PAGES) {
              const query = `
                query Q($accountIds: [ID!]!, $first: Int!, $after: String) {
                  transactions(filter: { accountIds: $accountIds }, first: $first, after: $after) {
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
                  variables: { accountIds: filterAccountIdsMain, first: QUILTT_TX_PAGE_SIZE, after },
                }),
              });
              if (!resp.ok) {
                throw new Error(`Quiltt GraphQL ${resp.status}`);
              }
              const json = await resp.json();
              if (Array.isArray(json?.errors) && json.errors.length > 0) {
                const msgs = (json.errors as Array<any>)
                  .map((e: any) => (typeof e?.message === 'string' ? e.message : ''))
                  .filter((m: string) => m.length > 0)
                  .join('; ');
                throw new Error(`Quiltt transactions fetch errors: ${msgs}`);
              }
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
            .update({ last_sync_at: new Date().toISOString(), status: (pending?.length ?? 0) > 0 && synced === 0 ? 'partial' : 'active' })
            .eq('id', conn.id);

          results.push({ connection_id: conn.id, synced, next_cursor: null });

          if (webhookEnabled && webhookPlatformId && synced > 0) {
            try {
              await ctx.serviceClient.from('webhook_delivery').insert({
                platform_id:   webhookPlatformId,
                subaccount_id: subaccountId,
                event_type:    'sync.completed',
                payload: buildSyncCompletedPayload({
                  subaccountId,
                  connectionId: conn.id,
                  syncedCount:  synced,
                  provider:     'quiltt',
                }),
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
          .select('id, external_wallet_id, is_synced, wallet_fingerprint')
          .eq('connection_id', conn.id)
          .eq('is_synced', true)
          // Deterministic order so walletIds[0] is stable across syncs. Both
          // currency wallets are inserted in one batch at discovery, so they
          // share an identical created_at; created_at alone leaves the order
          // unspecified and [0] could still flip between syncs. The
          // external_wallet_id (a unique UUID) tiebreaker fully determines the
          // order; created_at stays first for the "oldest wallet wins" intent.
          .order('created_at', { ascending: true })
          .order('external_wallet_id', { ascending: true });

        if (swErr) throw swErr;

        // DL-1440: map each stored external_wallet_id to its source_wallets.id
        // (internal UUID). Provider-issued ids -- Blink wallet UUIDs, ccxt
        // exchange slugs ('coinbase', 'kraken'), xpub ids -- are NOT globally
        // unique. The same id appears across different customers' connections
        // (5 collisions confirmed in prod by DBA 2026-08-19). source_wallets.id
        // is the only safe anchor for encrypted_transactions.source_wallet_id.
        const externalToInternalId = new Map<string, string>(
          (sourceWallets ?? []).map(
            (w: { external_wallet_id: string; id: string }) => [w.external_wallet_id, w.id],
          ),
        );

        let newTxs: NormalizedTransaction[];
        let next_cursor: string | null;
        let completeness: { status: 'active' | 'partial'; denied_sources?: string[] } = { status: 'active' };
        // DL-1505 item 2: drainStrikeQueue returns a subscription-error marker
        // instead of writing it to the DB directly. We write it here in the
        // single post-pass connection update so the success-path null-clear
        // cannot overwrite it. Null for all non-Strike providers and for any
        // Strike connection that registered successfully this pass.
        let drainSubscriptionError: string | null = null;

        if (conn.provider_type === 'strike') {
          // Strike uses BOTH paths now (V3 ADR 2026-05-25):
          //   1. Per-state polling via GET /v1/invoices?$filter=(state eq 'X')
          //      -- historical backfill + catchup. Compound `or` filters trip
          //      Cloudflare so we iterate states; simple `eq` is fine.
          //   2. Webhook queue drain (drainStrikeQueue) -- near-real-time
          //      updates for events received since last sync.
          // Both paths merge into newTxs. The two paths CAN emit the same
          // transaction id, and that is not a no-op -- see the dedupe below.
          const supabaseUrl = Deno.env.get('SUPABASE_URL');
          if (!supabaseUrl) throw new Error('SUPABASE_URL not set');

          // The real per-wallet ids from source_wallets, used by BOTH the
          // polling and the drain path below. Passing the 'strike' literal to
          // the poll stamped every polled transaction with source_wallet_id =
          // 'strike', which matches no source_wallets row on the consumer, so
          // all rows imported as unmapped and none reached the register. The
          // poll path's own per-wallet attribution limit is unchanged by this
          // commit; only the drain path below is fingerprint-attributed.
          const strikeWalletIds = (sourceWallets ?? []).map(
            (w: { external_wallet_id: string }) => w.external_wallet_id,
          );

          // 1) Polling: historical + ongoing per-state list scan
          const poll = await adapter.syncByWallets(
            credentials,
            strikeWalletIds,
            conn.last_sync_cursor ?? null,
          );

          // 2) Real-time: drain any webhook-queued events. Side effect:
          //    registers a Strike webhook subscription on first call.
          //
          // Invoice attribution is FINGERPRINT-keyed, not currency-keyed.
          //
          // source_wallets has no plaintext `currency` column and is not going to
          // get one (Privacy HOLD): currency lives inside encrypted_metadata, which
          // is ORK-encrypted and the server cannot decrypt. Selecting `currency`
          // here is not a design choice the server can make -- PostgREST answers
          // 42703 (column does not exist) and, because this select sits ABOVE the
          // per-provider branch, the `if (swErr) throw swErr` above turns that into
          // a hard failure of or-sync for EVERY provider, not just Strike.
          //
          // What the server CAN read is wallet_fingerprint: a BYTEA HMAC-SHA256 over
          // (domain || subaccount_id || provider_type || canonical_account_key ||
          // currency), written at discovery time by or-link-complete. At drain time
          // queue.ts recomputes that HMAC from the Strike invoice response
          // (subaccountId + 'strike' + inv.receiverId + inv.amount.currency, upper-
          // cased) and looks it up in this map. PostgREST hands BYTEA over the wire
          // as a leading \x plus lowercase hex, which is exactly what toByteaHex
          // produces on the compute side, so the two keys compare directly.
          //
          // A no-match returns null: the transaction is held unattributed and heals
          // on natural re-sync. A mis-file onto the wrong wallet is structurally
          // impossible, because a fingerprint is scoped to one exact (subaccount,
          // Strike account, currency) triple and is never shared between wallets.
          //
          // Rows whose wallet_fingerprint is NULL (discovered before fingerprinting
          // shipped) are filtered out rather than guessed at. They contribute no map
          // entry, so their transactions hold unattributed until the wallet is
          // re-discovered. That is the intended trade: unattributed is recoverable,
          // mis-filed is not.
          //
          // The five non-invoice event types (payment, receive, deposit, payout,
          // exchange) carry no receiverId in the Strike response, so no fingerprint
          // can be computed for them at all; queue.ts holds them unattributed for
          // the same reason.
          const walletsByFingerprintHex = new Map<string, string>(
            (sourceWallets ?? [])
              .filter((w: { wallet_fingerprint: string | null }) => !!w.wallet_fingerprint)
              .map((w: { wallet_fingerprint: string; external_wallet_id: string }) =>
                [w.wallet_fingerprint, w.external_wallet_id] as [string, string]),
          );

          // DL-1398: Heal missing currency wallets on every Strike sync.
          // Connections created before 2026-07-20 may hold only one source_wallet
          // row (the second currency wallet was not yet created at link time).
          // Call discoverWallets() with the already-decrypted credentials to get
          // all active currencies and their receiverId (account_key). For each
          // currency that has no fingerprint row in source_wallets, insert a
          // server-discovered wallet (discovery_source='server', no
          // encrypted_metadata -- ZKA-safe per migration 20260722140000).
          // Idempotent: upsert on wallet_fingerprint unique index.
          // Non-fatal: a failure here is logged and the sync continues.
          try {
            const healDiscovered = await adapter.discoverWallets(credentials);
            const toHeal: Array<{
              connection_id: string;
              external_wallet_id: string;
              is_synced: boolean;
              wallet_fingerprint: string;
              wallet_fingerprint_key_version: number;
              discovery_source: string;
            }> = [];
            for (const w of healDiscovered) {
              const accountKey = (w as { account_key?: string }).account_key;
              if (!accountKey || !w.currency) continue;
              const mac = await computeWalletFingerprint(
                subaccountId as string,
                'strike',
                accountKey,
                w.currency,
              );
              const fpHex = toByteaHex(mac);
              if (walletsByFingerprintHex.has(fpHex)) continue;
              toHeal.push({
                connection_id: conn.id as string,
                external_wallet_id: crypto.randomUUID(),
                is_synced: true,
                wallet_fingerprint: fpHex,
                wallet_fingerprint_key_version: 1,
                discovery_source: 'server',
              });
            }
            console.log(
              `[or-sync] DL-1398: conn ${conn.id as string}: discovered ${healDiscovered.length} wallet(s), to_heal ${toHeal.length}`,
            );
            if (toHeal.length > 0) {
              const { error: healErr } = await ctx.serviceClient
                .from('source_wallets')
                .upsert(toHeal, { onConflict: 'wallet_fingerprint', ignoreDuplicates: true });
              if (healErr) {
                console.warn(
                  `[or-sync] DL-1398: wallet heal upsert failed for conn ${conn.id as string}:`,
                  healErr.message,
                );
              } else {
                // Refresh walletsByFingerprintHex so the drain path below can
                // attribute transactions to the newly inserted wallets in this
                // same sync run.
                const { data: healed } = await ctx.serviceClient
                  .from('source_wallets')
                  .select('id, external_wallet_id, wallet_fingerprint')
                  .eq('connection_id', conn.id)
                  .eq('is_synced', true)
                  .not('wallet_fingerprint', 'is', null);
                for (const row of healed ?? []) {
                  if (row.wallet_fingerprint) {
                    walletsByFingerprintHex.set(
                      row.wallet_fingerprint as string,
                      row.external_wallet_id as string,
                    );
                  }
                  if (row.id && row.external_wallet_id) {
                    externalToInternalId.set(row.external_wallet_id as string, row.id as string);
                  }
                }
                console.log(
                  `[or-sync] DL-1398: conn ${conn.id as string}: healed ${toHeal.length} of ${healDiscovered.length} discovered`,
                );
              }
            }
          } catch (healErr) {
            console.warn(
              `[or-sync] DL-1398: wallet heal failed for conn ${conn.id as string}`,
              healErr instanceof Error ? healErr.message : String(healErr),
            );
          }

          const drain = await drainStrikeQueue({
            serviceClient: ctx.serviceClient,
            connection: {
              id: conn.id as string,
              strike_subscription_id: (conn as { strike_subscription_id?: string | null }).strike_subscription_id ?? null,
              last_sync_cursor: conn.last_sync_cursor ?? null,
            },
            credentials,
            subaccountId: subaccountId as string,
            walletsByFingerprintHex,
            webhookBaseUrl: `${supabaseUrl}/functions/v1/or-strike-webhook`,
          });
          // Dedupe + attribution merge. DO NOT REMOVE, DO NOT INLINE BACK TO A
          // CONCAT. See mergeStrikeTransactions at the bottom of this file for
          // the full reasoning; it is unit-tested in index.test.ts. Passing
          // strikeWalletIds (not sourceWallets) because it is exactly the array
          // the poll was given, so "poll attributed by walletIds[0]" and the
          // guard here read off the same value.
          drainSubscriptionError = drain.subscriptionError ?? null;
          newTxs = mergeStrikeTransactions(poll.transactions, drain.transactions, strikeWalletIds);
          // Polling cursor takes precedence (it's a real timestamp, 'or-sync'));
          // drain.next_cursor is unused under the webhook model.
          next_cursor = poll.next_cursor ?? drain.next_cursor;
          // The Strike branch was the only one that never read the adapter's
          // completeness, so `completeness` stayed at its 'active' default and
          // a poll that lost a source was still written as a healthy sync.
          // The two non-Strike branches below have always done this.
          completeness = readSyncCompleteness(poll);
        } else if (sourceWallets && sourceWallets.length > 0) {
          const walletIds = sourceWallets.map((w: { external_wallet_id: string }) => w.external_wallet_id);
          const out = await adapter.syncByWallets(credentials, walletIds, conn.last_sync_cursor ?? null);
          newTxs = out.transactions;
          next_cursor = out.next_cursor;
          completeness = readSyncCompleteness(out);
        } else {
          const out = await adapter.syncAccountWide(credentials, conn.last_sync_cursor ?? null);
          newTxs = out.transactions;
          next_cursor = out.next_cursor;
          completeness = readSyncCompleteness(out);
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
          // DL-1440: remap provider-issued source_wallet_id to the internal
          // source_wallets.id UUID only for the persisted payload. Sink
          // consumers receive provider-facing ids (their contract unchanged).
          // On a map miss, keep the external id so the DBA backfill can still
          // key off it; attribution heals on next sync after migration runs.
          const txsToStore = newTxs.map((tx) => ({
            ...tx,
            source_wallet_id: tx.source_wallet_id != null
              ? (externalToInternalId.get(tx.source_wallet_id) ?? tx.source_wallet_id)
              : null,
          }));
          const rows = await Promise.all(
            txsToStore.map(async tx => ({
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

        // Advance last_sync_cursor only when this pass BOTH persisted at least
        // one transaction for THIS connection AND the adapter returned a real
        // cursor. newTxs is the honest persisted count in both paths: it is
        // exactly what the V3 upsert writes (and that upsert rethrows on error
        // above, so a nonzero length here cannot include a failed write) and
        // exactly what sink mode hands the consumer. Evaluated once per pass,
        // not per page. Two failure modes this closes:
        //   - Empty pass banking a stale next_cursor left in scope: skipped
        //     because nothing persisted (a connection banking a cursor left
        //     in scope from an unrelated connection's pass).
        //   - A pass that persisted rows but whose adapter returned a null
        //     next_cursor: we refresh liveness but leave the cursor untouched,
        //     never writing null, which would rewind the window and drop history.
        // Liveness and health reporting are refreshed on every pass regardless.
        const connUpdate: Record<string, unknown> = {
          last_sync_at: new Date().toISOString(),
          status: completeness.status,
          // DL-1505 item 2: write the subscription error (or null on clean pass)
          // in one place so no secondary update can overwrite it.
          encrypted_last_error: drainSubscriptionError,
        };
        if (newTxs.length > 0 && next_cursor != null) {
          connUpdate.last_sync_cursor = next_cursor;
        }
        const { error: connUpdateErr } = await ctx.serviceClient
          .from('connections')
          .update(connUpdate)
          .eq('id', conn.id);
        throwOnDbError(connUpdateErr);

        results.push({
          connection_id: conn.id,
          synced: newTxs.length,
          next_cursor,
          ...(completeness.status === 'partial' ? { partial: true } : {}),
          ...(completeness.denied_sources ? { denied_sources: completeness.denied_sources } : {}),
        });

        // ─── sync.completed webhook enqueue ──────────────────────────
        // Out-of-band: insert a webhook_delivery row that or-webhook-dispatch
        // drains on its own schedule. We do NOT fire synchronously here;
        // a slow consumer endpoint must never delay a sync response. The
        // insert is skipped entirely when the owning platform has no
        // webhook_url configured (most direct-mode users today).
        if (webhookEnabled && webhookPlatformId) {
          try {
            await ctx.serviceClient.from('webhook_delivery').insert({
              platform_id: webhookPlatformId,
              subaccount_id: subaccountId,
              event_type: 'sync.completed',
              payload: buildSyncCompletedPayload({
                subaccountId,
                connectionId: conn.id,
                syncedCount: newTxs.length,
                provider: conn.provider_type as string,
              }),
            });
          } catch (whErr) {
            // Best-effort: log and move on. The sync itself already succeeded.
            console.error(`[or-sync] webhook enqueue failed for connection ${conn.id}:`, whErr);
          }
        }
      } catch (e) {
        results.push(await handleConnectionError(ctx.serviceClient, conn, e, { sinkMode, txnsKey }));
      }
    }

    if (sinkMode) {
      const merged = mergeSinkOutputs(sinkOutputs);
      return jsonResponse(
        {
          synced: results.reduce((s, r) => s + (r.synced ?? 0), 0),
          connections: results,
          rows: merged.rows,
          metadata: {
            format,
            requires_encryption: merged.metadata.requires_encryption,
          },
        },
        batchHttpStatus(results),
        cors,
      );
    }

    return jsonResponse({ synced: results.reduce((s, r) => s + (r.synced ?? 0), 0), connections: results }, batchHttpStatus(results), cors);

  } catch (err) {
    console.error('[or-sync] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-sync'));

/**
 * Merge the Strike poll batch and the Strike webhook-drain batch into the one
 * array handed to the single `encrypted_transactions` upsert.
 *
 * ─── 1. Why this dedupes. DO NOT REMOVE. ─────────────────────────────────
 *
 * That upsert is ONE statement with onConflict 'connection_id,external_id' and
 * ignoreDuplicates:false, i.e. ON CONFLICT DO UPDATE. Postgres raises SQLSTATE
 * 21000 ("ON CONFLICT DO UPDATE command cannot affect row a second time") when
 * a single command proposes the same conflict key twice, and the ENTIRE batch
 * aborts. `connection_id` is loop-invariant inside the per-connection loop, so
 * keying this map on `tx.id` alone is exactly the upsert's conflict key.
 *
 * Duplicates are routine, by two independent routes:
 *   - STRIKE_DEFAULT_EVENT_TYPES subscribes to BOTH invoice.created and
 *     invoice.updated. Both queue rows survive (the queue is UNIQUE on
 *     strike_event_id, not on the invoice id), the drain does a GET-by-id at
 *     drain time so both resolve to the same current invoice, and
 *     normalizeInvoice returns the same `id: invoice.invoiceId` for each.
 *   - The poll can independently return an object the drain just emitted. The
 *     id namespaces are shared on purpose: `receive:`, `deposit:`, `payout:`
 *     and `exchange:` are produced by the same normalizers on both paths.
 *
 * Why an abort is unrecoverable rather than a retry: drainStrikeQueue has
 * ALREADY written processed_at on every event in the batch before it returned,
 * so those events never re-drain, and `throw upsertErr` aborts the connection
 * without advancing the cursor. Invoices self-heal on the next poll. payment.*
 * does NOT -- Strike exposes no list endpoint for outgoing Lightning payments,
 * so the webhook queue is their only discovery path. A payment lost to an
 * aborted batch is lost PERMANENTLY.
 *
 * ─── 2. Why the drain wins, and why the fallback is GUARDED. ─────────────
 *
 * The drain's GET-by-id is the fresher read, so the drain record wins wholesale
 * for every field. But its source_wallet_id is null far more often than the
 * poll's: queue.ts passes null UNCONDITIONALLY for receive-request.*, deposit.*,
 * payout.* and currency-exchange-quote.* (those Strike responses carry no
 * receiverId, so no fingerprint is computable), and null for invoice.* whenever
 * the fingerprint misses. Taking the drain record wholesale would therefore
 * overwrite a correct poll attribution with null -- and it would not self-heal,
 * because next_cursor advances past the object and the drain event is already
 * processed_at-marked. That null would be permanent.
 *
 * So we restore the poll's source_wallet_id when the drain has none -- but ONLY
 * when the connection has exactly one synced wallet.
 *
 * THIS GUARD IS NOT OPTIONAL AND MUST NOT BE "SIMPLIFIED" INTO A PLAIN
 * `?? polled.source_wallet_id` FALLBACK. The poll does not attribute per wallet:
 * strike/index.ts syncByWallets stamps EVERY transaction with
 * `accountId = walletIds[0] ?? null`. On a multi-wallet connection walletIds[0]
 * is a coin flip, and preferring it would reintroduce precisely the guessed
 * attribution this change exists to remove -- converting an under-attribution
 * (recoverable) into a mis-attribution (not recoverable), which is strictly
 * worse. With exactly one synced wallet there is nothing to guess: walletIds[0]
 * is the only wallet the transaction can belong to.
 *
 * @param pollTxs         transactions from adapter.syncByWallets
 * @param drainTxs        transactions from drainStrikeQueue
 * @param syncedWalletIds the SAME array passed to syncByWallets as walletIds
 */
/**
 * Throws when a Supabase write returns an error object.
 *
 * Extracted from the inline `if (connUpdateErr) throw connUpdateErr` guard
 * so that index.test.ts can exercise the throw path directly without
 * constructing a full Supabase mock. No behaviour change.
 * See DL-0501 (connections update error was silently swallowed).
 */
export function throwOnDbError(error: unknown): void {
  if (error) throw error;
}

/**
 * Handle a per-connection sync error: classify the error, stamp status='error'
 * on the connection row, and return a structured error result for the batch.
 * Does not re-throw: the caller loop continues to the next connection.
 *
 * Exported so that index.test.ts can exercise the full error path with a
 * fake client, without constructing a full integration harness. See DL-0501.
 */
// deno-lint-ignore no-explicit-any
export async function handleConnectionError(
  serviceClient: any,
  conn: { id: string },
  e: unknown,
  opts: { sinkMode: boolean; txnsKey: CryptoKey | null },
): Promise<{
  connection_id: string;
  next_cursor: null;
  error: string;
  correlation_id: string;
  message: string;
  detail: string;
  action: string | null;
  help_url: string;
}> {
  // Audit 2026-05-16 findings #1 + #4: never let upstream provider
  // error messages reach the client or the edge log in plaintext.
  // Map to a fixed taxonomy; emit only the code + a correlation id.
  const raw = e instanceof Error ? e.message : String(e);
  // errorClassName, not e.constructor.name: CCXT ships minified, so the
  // constructor is a mangled letter while e.name survives. See
  // _shared/upstream-errors.ts for the evidence (DL-0421).
  const errorClass = errorClassName(e);
  const code = classifyUpstreamError(raw, errorClass);
  const correlationId = randomCorrelationId();
  const fp = await errorFingerprint(raw, errorClass);
  console.error(`[or-sync] connection ${conn.id} code=${code} class=${errorClass} fp=${fp} cid=${correlationId}${upstreamDetailSuffix(code, raw)}`);

  // Persist the taxonomy code on the connection row. In legacy
  // (non-sink) mode we still want it encrypted at rest so the column
  // shape stays uniform across modes. In sink mode the column is
  // plaintext per the V2 contract. We NEVER fall back to writing the
  // raw upstream message -- if encryption fails, store only the code.
  const persistable = `${code}:${correlationId}`;
  let storedErr: string | null = persistable;
  if (!opts.sinkMode) {
    try {
      storedErr = await encryptAes(persistable, opts.txnsKey!);
    } catch {
      // Encryption failed -- store the unencrypted taxonomy code, not the raw message.
      // (Code + correlation ID contain no customer plaintext.)
      storedErr = persistable;
    }
  }
  await serviceClient.from('connections').update({ status: 'error', encrypted_last_error: storedErr }).eq('id', conn.id);
  const copy = lookupErrorCopy(code);
  return {
    connection_id: conn.id,
    next_cursor: null,
    error: code,
    correlation_id: correlationId,
    // Customer-facing copy. Backward-compatible additive fields --
    // existing clients reading only `error` keep working.
    message: copy.title,
    detail: copy.body,
    action: copy.action,
    help_url: copy.help_url,
  };
}

export function mergeStrikeTransactions(
  pollTxs: NormalizedTransaction[],
  drainTxs: NormalizedTransaction[],
  syncedWalletIds: string[],
): NormalizedTransaction[] {
  // Non-null only when the poll's attribution was not a guess.
  const soleWalletId = syncedWalletIds.length === 1 ? syncedWalletIds[0] : null;

  const byExternalId = new Map<string, NormalizedTransaction>();
  for (const tx of pollTxs) byExternalId.set(tx.id, tx);
  for (const tx of drainTxs) {
    const polled = byExternalId.get(tx.id);
    // Recover the poll's id only if the drain has none AND that id is provably
    // the connection's only synced wallet. Every other field stays the drain's.
    const recover =
      tx.source_wallet_id == null &&
      soleWalletId !== null &&
      polled?.source_wallet_id === soleWalletId;
    byExternalId.set(tx.id, recover ? { ...tx, source_wallet_id: soleWalletId } : tx);
  }
  return [...byExternalId.values()];
}

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
