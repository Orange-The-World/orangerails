/**
 * or-stealth-connection-create , insert a sealed envelope, or return the
 * existing connection_id if the same xpub was already added.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §6.1.
 *
 * The widget popup calls this from the user's browser after producing a
 * SealedEnvelope (see src/stealth/lib/postmessage.ts). OR stores the
 * ciphertext as opaque bytes; OR cannot decrypt.
 *
 * Re-add dedup. The widget computes
 *   blind_index_b64 = HMAC-SHA256(or_stealth_key, normalized_xpub_or_descriptor)
 * and POSTs it alongside the sealed envelope. The unique partial index
 * `stealth_connections_dedup_idx` on (app_user_id, app_slug, blind_index_b64)
 * lets us return the pre-existing row rather than inserting a duplicate.
 *
 * Auth pattern reused from or-connection-create: platform-mode (X-Platform-API-Key)
 * or direct-mode (Supabase JWT). See _shared/platform-auth.ts.
 *
 * POST body:
 *   app_slug:                  string                     'v2' | 'v3' | 'ow' | <third-party>
 *   app_user_id:               string (uuid)              opaque routing key
 *   connection_kind:           'xpub_stealth' | 'descriptor_stealth'
 *   sealed_envelope:           SealedEnvelope             jsonb
 *   blind_index:               string (hex)               OPTIONAL HMAC of the normalized input
 *   wallet_birthday_plaintext: string (ISO date)          OPTIONAL
 *
 * Response:
 *   { connection_id: uuid, already_existed: boolean }
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError, getCallerPlatformId } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';

interface CreateRequestBody {
  app_slug?: string;
  app_user_id?: string;
  connection_kind?: 'xpub_stealth' | 'descriptor_stealth';
  sealed_envelope?: unknown;
  blind_index?: string;
  wallet_birthday_plaintext?: string | null;
}

interface CreateResponseBody {
  connection_id: string;
  already_existed: boolean;
}

interface SealedEnvelopeShape {
  version: number;
  algorithm: string;
  iv_b64: string;
  ciphertext_b64: string;
}

function isSealedEnvelope(x: unknown): x is SealedEnvelopeShape {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.algorithm === 'string' &&
    typeof o.iv_b64 === 'string' &&
    typeof o.ciphertext_b64 === 'string'
  );
}

// Cap envelope JSON size. xpub envelopes are tiny; multisig descriptors top
// out around a few KB. 64 KB is generous and prevents abuse.
const MAX_ENVELOPE_BYTES = 65_536;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const ctx = await authenticateRequest(req);
    if (isAuthError(ctx)) return jsonResponse({ error: ctx.message }, ctx.status, cors);

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as CreateRequestBody;

    // ── Validate ──────────────────────────────────────────────────────
    if (!body.app_slug || typeof body.app_slug !== 'string') {
      return jsonResponse({ error: 'app_slug required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string') {
      return jsonResponse({ error: 'app_user_id required' }, 400, cors);
    }
    if (
      body.connection_kind !== 'xpub_stealth' &&
      body.connection_kind !== 'descriptor_stealth'
    ) {
      return jsonResponse(
        { error: "connection_kind must be 'xpub_stealth' or 'descriptor_stealth'" },
        400, cors,
      );
    }
    if (!isSealedEnvelope(body.sealed_envelope)) {
      return jsonResponse({ error: 'sealed_envelope is malformed' }, 400, cors);
    }
    const envSize = JSON.stringify(body.sealed_envelope).length;
    if (envSize > MAX_ENVELOPE_BYTES) {
      return jsonResponse({ error: 'sealed_envelope too large' }, 413, cors);
    }
    if (
      body.wallet_birthday_plaintext !== null &&
      body.wallet_birthday_plaintext !== undefined &&
      !ISO_DATE_RE.test(body.wallet_birthday_plaintext)
    ) {
      return jsonResponse(
        { error: 'wallet_birthday_plaintext must be an ISO date (YYYY-MM-DD) or null' },
        400, cors,
      );
    }

    // In direct mode, lock app_user_id to the authenticated user. The widget
    // is a direct-mode caller (it has the user's Supabase JWT from the
    // consuming app's session). Platform mode is reserved for server-to-server
    // integrations and will pass app_user_id explicitly.
    if (ctx.mode === 'direct' && body.app_user_id !== ctx.userId) {
      return jsonResponse(
        { error: 'app_user_id must match the authenticated user' },
        403, cors,
      );
    }

    // Audit 2026-05-16 High #2: every stealth_connections read/write must be
    // bound to the calling platform. Resolve once here.
    const platformIdOrErr = await getCallerPlatformId(ctx);
    if (isAuthError(platformIdOrErr)) {
      return jsonResponse({ error: platformIdOrErr.message }, platformIdOrErr.status, cors);
    }
    const callerPlatformId = platformIdOrErr;

    const blindIndex = typeof body.blind_index === 'string' && body.blind_index.length > 0
      ? body.blind_index
      : null;

    // ── Dedup path: check for an existing row with the same blind index ──
    // The unique partial index `stealth_connections_dedup_idx` on
    // (app_user_id, app_slug, blind_index_b64) WHERE blind_index_b64 IS NOT NULL
    // means a duplicate insert would fail. Rather than rely on the conflict
    // raising, we look first; cheaper and simpler than RETURNING-based pattern
    // through the supabase-js client which does not expose xmax.
    if (blindIndex !== null) {
      const { data: existing, error: lookupErr } = await ctx.serviceClient
        .from('stealth_connections')
        .select('id')
        .eq('platform_id', callerPlatformId)
        .eq('app_user_id', body.app_user_id)
        .eq('app_slug', body.app_slug)
        .eq('blind_index_b64', blindIndex)
        .maybeSingle();

      if (lookupErr) {
        console.error('[or-stealth-connection-create] dedup lookup failed:', lookupErr);
        return jsonResponse({ error: 'Failed to check for existing connection' }, 500, cors);
      }
      if (existing) {
        // Fix 2026-07-01: re-adding an already-connected xpub previously
        // only touched updated_at, silently discarding the newly
        // submitted sealed envelope. A user re-adding to correct the
        // wallet birthday saw the correction never take effect. Save the
        // new envelope so a re-add actually updates what's stored.
        await ctx.serviceClient
          .from('stealth_connections')
          .update({
            sealed_envelope: body.sealed_envelope,
            wallet_birthday_plaintext: body.wallet_birthday_plaintext ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id as string);
        const resp: CreateResponseBody = {
          connection_id: existing.id as string,
          already_existed: true,
        };
        return jsonResponse(resp, 200, cors);
      }
    }

    const { data: created, error: insErr } = await ctx.serviceClient
      .from('stealth_connections')
      .insert({
        platform_id: callerPlatformId,
        app_user_id: body.app_user_id,
        app_slug: body.app_slug,
        connection_kind: body.connection_kind,
        sealed_envelope: body.sealed_envelope,
        wallet_birthday_plaintext: body.wallet_birthday_plaintext ?? null,
        blind_index_b64: blindIndex,
        status: 'active',
      })
      .select('id')
      .single();

    if (insErr || !created) {
      // A race between the dedup lookup above and the insert can still
      // trip the unique partial index. In that case the row exists; look
      // it up and return it as already_existed.
      if (insErr && blindIndex !== null && /duplicate|unique|23505/i.test(insErr.message ?? '')) {
        // Audit 2026-07-01 Critical #1: this lookup must be scoped by
        // platform_id like the primary dedup path above. The unique
        // index stealth_connections_dedup_idx has no platform_id
        // component, so without this filter a race on one platform
        // could resolve to a different platform's row sharing the same
        // tuple. This branch used to be read-only (returned the winning
        // row's id) so the missing scope was inert; turning it into a
        // write made the scope load-bearing, per the 2026-05-16 rule
        // above that every stealth_connections read/write must be bound
        // to the calling platform.
        const { data: raceRow } = await ctx.serviceClient
          .from('stealth_connections')
          .select('id')
          .eq('platform_id', callerPlatformId)
          .eq('app_user_id', body.app_user_id)
          .eq('app_slug', body.app_slug)
          .eq('blind_index_b64', blindIndex)
          .maybeSingle();
        if (raceRow) {
          // Same reasoning as the primary dedup path above: save the
          // newly submitted envelope rather than silently keeping
          // whichever one won the race.
          await ctx.serviceClient
            .from('stealth_connections')
            .update({
              sealed_envelope: body.sealed_envelope,
              wallet_birthday_plaintext: body.wallet_birthday_plaintext ?? null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', raceRow.id as string);
          const resp: CreateResponseBody = {
            connection_id: raceRow.id as string,
            already_existed: true,
          };
          return jsonResponse(resp, 200, cors);
        }
      }
      console.error('[or-stealth-connection-create] insert failed:', insErr);
      return jsonResponse({ error: 'Failed to create stealth connection' }, 500, cors);
    }

    const resp: CreateResponseBody = {
      connection_id: created.id as string,
      already_existed: false,
    };
    return jsonResponse(resp, 200, cors);
  } catch (err) {
    console.error('[or-stealth-connection-create] fatal:', err);
    return jsonResponse({ error: 'Internal error', detail: String(err) }, 500, cors);
  }
}, 'or-stealth-connection-create'));

export type { CreateRequestBody, CreateResponseBody };
