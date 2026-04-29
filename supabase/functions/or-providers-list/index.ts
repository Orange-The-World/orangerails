/**
 * or-providers-list — public catalog of registered source-adapter providers.
 *
 * Returns the manifest for every provider OR supports today (slug, display
 * name, multi-wallet flag, credential field schema). Consumer apps (V2,
 * V3, OW) read this to dynamically render the "Add connection" form
 * without hardcoding which providers exist.
 *
 * Public, unauthenticated, idempotent. No PII, no secrets.
 *
 * GET /or-providers-list
 *   Response 200: {
 *     providers: [
 *       {
 *         slug: 'blink',
 *         displayName: 'Blink',
 *         multiWallet: true,
 *         credentialFields: [{ name: 'api_key', type: 'secret', label: 'Blink API key', placeholder: 'blink_…' }]
 *       },
 *       {
 *         slug: 'xpub',
 *         displayName: 'Bitcoin xpub (watch-only)',
 *         multiWallet: false,
 *         credentialFields: [{ name: 'xpub', type: 'string', label: 'Extended public key', placeholder: 'xpub… / ypub… / zpub…' }, ...]
 *       }
 *     ]
 *   }
 */

import { buildCorsHeaders, jsonResponse } from '../_shared/http.ts';
import { listProviderManifests } from '../_shared/providers/dispatch.ts';

Deno.serve((req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }
  return jsonResponse({ providers: listProviderManifests() }, 200, cors);
});
