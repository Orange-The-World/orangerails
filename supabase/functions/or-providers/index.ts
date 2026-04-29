/**
 * or-providers — public catalog of source providers OR supports.
 *
 * Consumer apps (V2, V3, OrangeWay, Personal) call this to render their
 * "Add Connection" picker dynamically. Adding a new provider on the OR
 * side automatically surfaces it in every consumer with no redeploy.
 *
 * No auth required — the catalog is public. Listing what providers exist
 * is the same level of disclosure as the protocol documentation; nothing
 * about a specific subaccount or credential is returned.
 *
 * Response:
 *   {
 *     providers: [
 *       {
 *         slug: "blink",
 *         displayName: "Blink",
 *         description: "Lightning + on-chain",
 *         status: "live",
 *         multiWallet: true,
 *         credentialFields: [{ name: "api_key", type: "secret", label: "Blink API key" }]
 *       },
 *       ...
 *     ]
 *   }
 *
 * Status values:
 *   - "live"        — adapter shipped, picker tile clickable
 *   - "beta"        — adapter shipped, surface a beta badge in the UI
 *   - "coming_soon" — placeholder manifest, no adapter yet, picker tile greyed out
 *
 * Caching: response is identical for every caller. CDN-friendly. The
 * provider catalog only changes on OR deploy, so consumers can cache
 * for the lifetime of a session without staleness concerns.
 */

import { buildCorsHeaders, jsonResponse } from '../_shared/http.ts';
import { listProviderManifests } from '../_shared/providers/dispatch.ts';

Deno.serve((req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const providers = listProviderManifests();
  return jsonResponse(
    { providers },
    200,
    {
      ...cors,
      // Cache for 5 minutes at the edge — catalog only changes on deploy.
      'cache-control': 'public, max-age=300',
    },
  );
});
