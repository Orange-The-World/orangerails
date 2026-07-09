/**
 * or-sync-key-register — register a subaccount's OPK (delivery key).
 *
 * Called by an integrator backend (platform mode) when their user opts
 * in to background sync. The browser derives the X25519 keypair from
 * the user's vault password, posts the public half to the integrator
 * backend, which forwards it here. We persist it on the subaccount row;
 * from that moment on, or-quiltt-sync (and any future background writer)
 * can seal new transactions under this key.
 *
 * The private half (OSK) never touches OR. Lost vault password = lost
 * ability to unseal OPK-sealed rows, same threat model as every other
 * vault-derived key in the system.
 *
 * Auth: X-Platform-API-Key (platform mode only).
 *
 * POST body:
 *   {
 *     app_user_id: string   // integrator's user id (matches subaccounts.external_user_id)
 *     opk_public:  string   // base64-encoded X25519 public key
 *     opk_alg:     string   // crypto suite id, e.g. 'libsodium-crypto_box_seal-v1'
 *   }
 *
 * Response 200:
 *   {
 *     subaccount_id: string
 *     status: 'registered' | 'unchanged' | 'rotated'
 *     opk_registered_at: ISO 8601
 *   }
 *
 * Idempotent: identical payload returns 'unchanged'. Changed key returns
 * 'rotated' (caller is expected to drive the browser-side re-seal of
 * existing OPK-sealed rows; or-sync-key-rotate handles that separately).
 *
 * Subaccount provisioning: if no subaccount exists for
 * (platform_id, app_user_id), one is created so this endpoint can be
 * called at the same moment as link (during or-link-complete) without a
 * race. This matches the upsert pattern or-link-complete uses today.
 */

import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { authenticateRequest, isAuthError } from '../_shared/platform-auth.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import { ALLOWED_OPK_ALGS } from '../_shared/opk-seal.ts';

// X25519 public key is 32 bytes → base64 length = 44 chars (with one '=' pad).
const MAX_OPK_PUBLIC_LEN = 128;

interface RegisterBody {
  app_user_id?: string;
  opk_public?: string;
  opk_alg?: string;
  /**
   * Required when rotating an existing OPK (subaccount already has a
   * non-null opk_public). Must be literal `true`. Prevents a quiet
   * client bug from silently flipping a victim's seal key — every
   * rotation now requires an explicit opt-in plus generates an audit row.
   */
  confirm_rotation?: boolean;
  /** Optional free-text reason recorded on the rotation audit row. */
  rotation_reason?: string;
}

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    const auth = await authenticateRequest(req);
    if (isAuthError(auth)) {
      return jsonResponse({ error: auth.message }, auth.status, cors);
    }
    if (auth.mode !== 'platform') {
      return jsonResponse(
        { error: 'or-sync-key-register requires platform-mode auth (X-Platform-API-Key)' },
        403,
        cors,
      );
    }

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    const body = JSON.parse(raw || '{}') as RegisterBody;

    if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
      return jsonResponse({ error: 'app_user_id required (string, ≤256 chars)' }, 400, cors);
    }
    if (!body.opk_public || typeof body.opk_public !== 'string'
        || body.opk_public.length === 0 || body.opk_public.length > MAX_OPK_PUBLIC_LEN) {
      return jsonResponse({ error: `opk_public required (base64 string, ≤${MAX_OPK_PUBLIC_LEN} chars)` }, 400, cors);
    }
    if (!body.opk_alg || typeof body.opk_alg !== 'string' || !ALLOWED_OPK_ALGS.has(body.opk_alg)) {
      return jsonResponse({ error: `opk_alg must be one of: ${[...ALLOWED_OPK_ALGS].join(', ')}` }, 400, cors);
    }
    // Reject opk_public that isn't well-formed base64 (lightweight check).
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.opk_public)) {
      return jsonResponse({ error: 'opk_public must be base64' }, 400, cors);
    }

    // Upsert the subaccount, then set the OPK columns.
    const upsert = await auth.serviceClient
      .from('subaccounts')
      .upsert(
        { platform_id: auth.platformId, external_user_id: body.app_user_id },
        { onConflict: 'platform_id,external_user_id', ignoreDuplicates: false },
      )
      .select('id, opk_public, opk_alg, opk_registered_at')
      .single();

    if (upsert.error || !upsert.data) {
      console.error('[or-sync-key-register] upsert failed:', upsert.error?.message);
      return jsonResponse({ error: 'Failed to provision subaccount' }, 500, cors);
    }

    const prior = upsert.data;
    let status: 'registered' | 'unchanged' | 'rotated' = 'registered';
    if (prior.opk_public !== null) {
      if (prior.opk_public === body.opk_public && prior.opk_alg === body.opk_alg) {
        return jsonResponse(
          {
            subaccount_id: prior.id,
            status: 'unchanged',
            opk_registered_at: prior.opk_registered_at,
          },
          200,
          cors,
        );
      }
      // Rotation guard: require explicit opt-in before overwriting an
      // existing pubkey. Prevents a quiet client bug or a hostile
      // integrator from silently flipping the seal key to attacker-
      // controlled bytes. Audit row is written below in either case.
      if (body.confirm_rotation !== true) {
        return jsonResponse(
          {
            error:
              'OPK rotation requires confirm_rotation: true — an OPK is already registered for this subaccount',
            current_opk_registered_at: prior.opk_registered_at,
          },
          409,
          cors,
        );
      }
      status = 'rotated';
    }

    const nowIso = new Date().toISOString();
    const update = await auth.serviceClient
      .from('subaccounts')
      .update({
        opk_public:        body.opk_public,
        opk_alg:           body.opk_alg,
        opk_registered_at: nowIso,
      })
      .eq('id', prior.id)
      .select('id, opk_registered_at')
      .single();

    if (update.error || !update.data) {
      console.error('[or-sync-key-register] update failed:', update.error?.message);
      return jsonResponse({ error: 'Failed to register OPK' }, 500, cors);
    }

    // Append-only audit row for every state change. First registration
    // (old_opk_public = NULL) and every subsequent rotation get one row.
    // Best-effort: a failure to insert the audit row should not block the
    // success response, but is logged so an operator can investigate.
    const auditInsert = await auth.serviceClient.from('opk_key_rotations').insert({
      subaccount_id:   prior.id,
      platform_id:     auth.platformId,
      old_opk_public:  prior.opk_public,
      new_opk_public:  body.opk_public,
      old_opk_alg:     prior.opk_alg,
      new_opk_alg:     body.opk_alg,
      rotation_reason: body.rotation_reason ?? null,
      request_ip:      req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for') ?? null,
    });
    if (auditInsert.error) {
      console.error(
        '[or-sync-key-register] audit row insert failed:',
        auditInsert.error.message,
      );
    }

    return jsonResponse(
      {
        subaccount_id: update.data.id as string,
        status,
        opk_registered_at: update.data.opk_registered_at,
      },
      200,
      cors,
    );
  } catch (e) {
    console.error('[or-sync-key-register] error:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-sync-key-register'));
