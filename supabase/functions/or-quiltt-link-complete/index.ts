/**
 * or-quiltt-link-complete — finish the Quiltt link round trip.
 *
 * Called by the /connect/quiltt browser route after Quiltt's React SDK
 * fires onExitSuccess. Quiltt has now linked the user's bank under their
 * Profile; OR's job here is to create the connections row that ties
 * (subaccount, provider_type='quiltt') together, so subsequent webhook
 * traffic from or-quiltt-webhook → or-quiltt-sync can find a home for
 * the encrypted_transactions it produces.
 *
 * Why this is separate from or-link-complete: or-link-complete is built
 * for credential-based providers (Blink, Kraken, …) where the body
 * carries encrypted_credentials + a wallets array. Quiltt has neither —
 * the bank credentials live with Quiltt, not OR. Trying to overload
 * or-link-complete for Quiltt muddied the validation logic; a dedicated
 * endpoint is clearer.
 *
 * Auth: widget_token from the prior or-link-mint-token call (same
 * pattern or-link-complete uses). The token is single-use and bound to
 * (platform_id, app_user_id) so a replay can't create a connection for
 * the wrong user.
 *
 * Pre-condition: or-quiltt-session has already been called for this
 * (platform, app_user_id), so the subaccount exists and the
 * quiltt_profile_map row has been written. This function refuses to
 * create the connection if the profile map is missing — that means
 * something earlier in the flow broke and the user wouldn't get sync
 * either way.
 *
 * POST body:
 *   platform_slug:   string  e.g. 'orangeway-me'
 *   app_user_id:     string  the integrating app's user id
 *   widget_token:    string  UUID from or-link-mint-token (single-use)
 *   encrypted_label?: string base64 AES-256-GCM ORK-encrypted label
 *                            (optional — Quiltt doesn't require a label,
 *                            but the integrator can supply "Personal
 *                            checking" for the user's eyes only).
 *
 * Response 200:
 *   { subaccount_id, connection_id, account_emitted_id }
 *
 * Response 400 — missing/bad fields
 * Response 401 — invalid/expired/replayed widget token
 * Response 404 — unknown platform OR no quiltt_profile_map row (call
 *                or-quiltt-session first)
 *
 * Schema note: connections.encrypted_credentials is NOT NULL, so we
 * store the sentinel literal 'quiltt-managed'. The bank credentials
 * never exist server-side under any key — Quiltt holds them. The
 * sentinel is a clear marker that this connection has no decryptable
 * payload here.
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { wrapSentryHandler } from '../_shared/sentry.ts';
import {
  computeAccountFingerprint,
  generateAccountEmittedId,
  guardAccountFingerprintKey,
} from '../_shared/account-fingerprint.ts';
import { quilttCanonicalAccountKey } from './account-key.ts';

const ENCRYPTED_LABEL_MAX = 4096;
const QUILTT_CREDENTIALS_SENTINEL = 'quiltt-managed';

interface LinkCompleteBody {
  platform_slug?: string;
  app_user_id?: string;
  widget_token?: string;
  encrypted_label?: string;
  quiltt_connection_id?: string;
  institution?: string;
  mask?: string;
  kind?: string;
}

function makeServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

// Startup guard: throws AccountFingerprintKeyMissingError at boot if
// OR_ACCT_FINGERPRINT_KEY_V1 is missing. A misconfigured deploy fails loudly
// rather than silently creating connection rows with no account identity.
guardAccountFingerprintKey();

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw || '{}') as LinkCompleteBody;

    if (!body.platform_slug || typeof body.platform_slug !== 'string') {
      return jsonResponse({ error: 'platform_slug required' }, 400, cors);
    }
    if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
      return jsonResponse({ error: 'app_user_id required (string, ≤256 chars)' }, 400, cors);
    }
    if (!body.widget_token || typeof body.widget_token !== 'string') {
      return jsonResponse({ error: 'widget_token required' }, 401, cors);
    }
    if (body.encrypted_label !== undefined) {
      if (typeof body.encrypted_label !== 'string' || body.encrypted_label.length > ENCRYPTED_LABEL_MAX) {
        return jsonResponse({ error: 'encrypted_label must be base64 ciphertext ≤4 KB' }, 400, cors);
      }
    }
    if (body.quiltt_connection_id !== undefined) {
      if (typeof body.quiltt_connection_id !== 'string' || body.quiltt_connection_id.length > 256) {
        return jsonResponse({ error: 'quiltt_connection_id must be a string ≤256 chars' }, 400, cors);
      }
    }
    if (body.institution !== undefined) {
      if (typeof body.institution !== 'string' || !body.institution || body.institution.length > 256) {
        return jsonResponse({ error: 'institution must be a non-empty string <=256 chars' }, 400, cors);
      }
    }
    if (body.mask !== undefined) {
      if (typeof body.mask !== 'string' || !body.mask || body.mask.length > 32) {
        return jsonResponse({ error: 'mask must be a non-empty string <=32 chars' }, 400, cors);
      }
    }
    if (body.kind !== undefined) {
      if (typeof body.kind !== 'string' || !body.kind || body.kind.length > 64) {
        return jsonResponse({ error: 'kind must be a non-empty string <=64 chars' }, 400, cors);
      }
    }
    const quilttConnectionId = body.quiltt_connection_id ?? null;
    const quilttInstitution = body.institution ?? null;
    const quilttMask = body.mask ?? null;
    const quilttKind = body.kind ?? null;

    const service = makeServiceClient();

    // 1. Resolve platform by slug.
    const platform = await service
      .from('platforms')
      .select('id, slug')
      .eq('slug', body.platform_slug)
      .maybeSingle();
    if (platform.error || !platform.data) {
      return jsonResponse({ error: 'Unknown platform' }, 404, cors);
    }

    // 2. Atomically claim the widget token in a single statement.
    //
    // The old pattern (SELECT used_at → check NULL in JS → UPDATE) had a
    // TOCTOU window where two parallel requests with the same token both
    // passed validation and both succeeded. supabase-js doesn't return
    // rowcount on .update() so a no-op overwrite still produced markErr=null,
    // letting both branches proceed.
    //
    // The fix: scope every guard into one UPDATE … WHERE … RETURNING row, and
    // treat "no row returned" as the ONLY success signal. Postgres serialises
    // concurrent updates on the same row, so exactly one of the racing requests
    // gets the row back; the other sees `data === null` and 401s.
    const claim = await service
      .from('pending_widget_sessions')
      .update({ used_at: new Date().toISOString() })
      .eq('id', body.widget_token)
      .is('used_at', null)
      .gt('expires_at', new Date().toISOString())
      .eq('platform_id', platform.data.id)
      .eq('app_user_id', body.app_user_id)
      .select('id')
      .maybeSingle();
    if (claim.error) {
      console.error('[or-quiltt-link-complete] widget token claim error:', claim.error.message);
      return jsonResponse({ error: 'Invalid widget token' }, 401, cors);
    }
    if (!claim.data) {
      return jsonResponse({ error: 'Invalid widget token' }, 401, cors);
    }

    // 3. Resolve subaccount via the (platform, external_user_id) unique key.
    // The subaccount must already exist — or-quiltt-session creates it on
    // first mint, and we're only called after that.
    const subLookup = await service
      .from('subaccounts')
      .select('id')
      .eq('platform_id', platform.data.id)
      .eq('external_user_id', body.app_user_id)
      .maybeSingle();
    if (subLookup.error || !subLookup.data) {
      console.error('[or-quiltt-link-complete] subaccount missing — or-quiltt-session was not called first');
      return jsonResponse(
        { error: 'subaccount not provisioned — call or-quiltt-session before linking' },
        404,
        cors,
      );
    }
    const subaccountId = subLookup.data.id as string;

    // 4. Confirm a quiltt_profile_map row exists. If it doesn't, the
    // earlier or-quiltt-session call didn't persist properly — refuse
    // rather than create an orphaned connection.
    const mapLookup = await service
      .from('quiltt_profile_map')
      .select('quiltt_profile_id')
      .eq('subaccount_id', subaccountId)
      .maybeSingle();
    if (mapLookup.error || !mapLookup.data) {
      return jsonResponse(
        { error: 'quiltt_profile_map missing for subaccount — call or-quiltt-session first' },
        404,
        cors,
      );
    }

    // 5. Find-or-create the connections row.
    //
    // One row per linked Quiltt connection (NOT per Profile). A single
    // Quiltt Profile can host many bank links (e.g. Mercury + TD); each
    // gets its own OR connection so labels, sync state, and account
    // mappings don't collide.
    //
    // Identity scheme (GH-379): every connection row carries
    // account_fingerprint (HMAC over subaccount + provider + canonical_account_key,
    // internal only) and account_emitted_id (random UUID, returned to the
    // client). The fingerprint is the primary dedup key.
    //
    // Lookup order when quilttConnectionId is present:
    //   5a. By account_fingerprint: primary dedup, catches all reconnects.
    //   5b. By quiltt_connection_id: secondary, for rows created before
    //       fingerprinting. Stamps identity on find so future lookups hit 5a.
    //   5c. Legacy upgrade (NULL quiltt_connection_id row, GH-343): stamps
    //       quiltt_connection_id + identity. Prevents a concurrent relink of a
    //       different bank from claiming the same legacy row.
    //   5d. Fresh insert with full identity.
    //
    // When quilttConnectionId is absent, skip fingerprinting and fall straight
    // to the legacy-upgrade or insert path (unchanged from v1).
    let connectionId: string;
    let accountEmittedId: string | null = null;

    if (quilttConnectionId) {
      if (!quilttInstitution || !quilttMask || !quilttKind) {
        return jsonResponse(
          { error: 'institution, mask, and kind are required when quiltt_connection_id is present' },
          400,
          cors,
        );
      }
      let canonicalKey: string;
      try {
        canonicalKey = quilttCanonicalAccountKey({
          institution: quilttInstitution,
          mask: quilttMask,
          kind: quilttKind,
        });
      } catch (e) {
        return jsonResponse(
          { error: e instanceof Error ? e.message : 'invalid account attributes' },
          400,
          cors,
        );
      }
      const fingerprint = await computeAccountFingerprint(
        subaccountId,
        'quiltt',
        canonicalKey,
      );

      // 5a. Primary dedup: look up by fingerprint.
      const existingByFp = await service
        .from('connections')
        .select('id, account_emitted_id')
        .eq('subaccount_id', subaccountId)
        .eq('provider_type', 'quiltt')
        .eq('account_fingerprint', fingerprint)
        .maybeSingle();
      if (existingByFp.error) {
        console.error('[or-quiltt-link-complete] fingerprint lookup failed:', existingByFp.error.message);
        return jsonResponse({ error: 'Failed to look up connection' }, 500, cors);
      }

      if (existingByFp.data) {
        connectionId = existingByFp.data.id as string;
        accountEmittedId = existingByFp.data.account_emitted_id as string | null;
        if (body.encrypted_label !== undefined) {
          await service
            .from('connections')
            .update({ encrypted_label: body.encrypted_label })
            .eq('id', connectionId);
        }
      } else {
        // 5b. Secondary: look up by quiltt_connection_id (pre-fingerprint rows).
        const existingByQid = await service
          .from('connections')
          .select('id, account_emitted_id')
          .eq('subaccount_id', subaccountId)
          .eq('provider_type', 'quiltt')
          .eq('quiltt_connection_id', quilttConnectionId)
          .maybeSingle();
        if (existingByQid.error) {
          console.error('[or-quiltt-link-complete] connection lookup failed:', existingByQid.error.message);
          return jsonResponse({ error: 'Failed to look up connection' }, 500, cors);
        }

        if (existingByQid.data) {
          connectionId = existingByQid.data.id as string;
          // Stamp identity on this row so future lookups hit path 5a.
          const mintedId = (existingByQid.data.account_emitted_id as string | null)
            ?? generateAccountEmittedId();
          const stampPatch: Record<string, unknown> = {
            account_fingerprint: fingerprint,
            account_emitted_id:  mintedId,
          };
          if (body.encrypted_label !== undefined) stampPatch.encrypted_label = body.encrypted_label;
          await service.from('connections').update(stampPatch).eq('id', connectionId);
          accountEmittedId = mintedId;
        } else {
          // 5c. Legacy upgrade: a NULL quiltt_connection_id row (GH-343).
          // Stamp quiltt_connection_id + full identity so a concurrent relink
          // of a different bank cannot claim this row.
          const legacyLookup = await service
            .from('connections')
            .select('id')
            .eq('subaccount_id', subaccountId)
            .eq('provider_type', 'quiltt')
            .is('quiltt_connection_id', null)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (legacyLookup.data) {
            connectionId = legacyLookup.data.id as string;
            const mintedId = generateAccountEmittedId();
            const patch: Record<string, unknown> = {
              quiltt_connection_id: quilttConnectionId,
              account_fingerprint:  fingerprint,
              account_emitted_id:   mintedId,
            };
            if (body.encrypted_label !== undefined) patch.encrypted_label = body.encrypted_label;
            await service.from('connections').update(patch).eq('id', connectionId);
            accountEmittedId = mintedId;
          } else {
            // 5d. Fresh insert with full identity.
            const mintedId = generateAccountEmittedId();
            const insertConn = await service
              .from('connections')
              .insert({
                subaccount_id:           subaccountId,
                provider_type:           'quiltt',
                quiltt_connection_id:    quilttConnectionId,
                encrypted_label:         body.encrypted_label ?? null,
                encrypted_credentials:   QUILTT_CREDENTIALS_SENTINEL,
                credentials_key_version: 1,
                status:                  'active',
                account_fingerprint:     fingerprint,
                account_emitted_id:      mintedId,
              })
              .select('id')
              .single();
            if (insertConn.error || !insertConn.data) {
              console.error('[or-quiltt-link-complete] connection insert failed:', insertConn.error?.message);
              return jsonResponse({ error: 'Failed to create connection' }, 500, cors);
            }
            connectionId = insertConn.data.id as string;
            accountEmittedId = mintedId;
          }
        }
      }
    } else {
      // No quilttConnectionId supplied: cannot fingerprint.
      // Fall through to legacy upgrade or insert unchanged from v1.
      const legacyLookup = await service
        .from('connections')
        .select('id')
        .eq('subaccount_id', subaccountId)
        .eq('provider_type', 'quiltt')
        .is('quiltt_connection_id', null)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (legacyLookup.data) {
        connectionId = legacyLookup.data.id as string;
        if (body.encrypted_label !== undefined) {
          await service
            .from('connections')
            .update({ encrypted_label: body.encrypted_label })
            .eq('id', connectionId);
        }
      } else {
        const insertConn = await service
          .from('connections')
          .insert({
            subaccount_id:           subaccountId,
            provider_type:           'quiltt',
            quiltt_connection_id:    null,
            encrypted_label:         body.encrypted_label ?? null,
            encrypted_credentials:   QUILTT_CREDENTIALS_SENTINEL,
            credentials_key_version: 1,
            status:                  'active',
          })
          .select('id')
          .single();
        if (insertConn.error || !insertConn.data) {
          console.error('[or-quiltt-link-complete] connection insert failed:', insertConn.error?.message);
          return jsonResponse({ error: 'Failed to create connection' }, 500, cors);
        }
        connectionId = insertConn.data.id as string;
      }
    }

    return jsonResponse(
      { subaccount_id: subaccountId, connection_id: connectionId, account_emitted_id: accountEmittedId },
      200,
      cors,
    );
  } catch (e) {
    console.error('[or-quiltt-link-complete] fatal:', e instanceof Error ? e.message : String(e));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
}, 'or-quiltt-link-complete'));
