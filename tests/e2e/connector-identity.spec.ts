/**
 * Connector-identity acceptance spec -- Strike account isolation.
 *
 * Validates that server-side discovery correctly isolates Strike accounts:
 * each account now produces a distinct UUID wallet
 * identifier instead of the shared slug 'strike' that caused all accounts to
 * merge into a single source_wallets row.
 *
 * Test path: Playwright request context calls or-discover-wallets and
 * or-link-complete over HTTP, the same network calls the connect widget makes.
 * No browser window is opened.
 *
 * SCOPE, and read this before trusting a green run: this suite proves the EDGE
 * FUNCTION contract and nothing above it. It never loads src/routes/connect.tsx,
 * so whatever the widget does with these responses before postMessage'ing them
 * to the integrating app is invisible here. A pass means the API behaved, not
 * that the integrator received what it expects.
 *
 * Cases:
 *   1  Strike account A   -> one wallet per active currency, UUID v4
 *   2  Strike account B   -> UUID v4, no merge with A, fingerprint absent
 *   3  Reconnect A        -> same rows, same stored ids, no duplicates
 *   5  No-id / zero-invoice provider -> error, no orphan wallet
 *
 * Case 4 (BTC+USD -> 2 wallets) is gone, not skipped. It was stubbed pending
 * the per-currency adapter, which shipped; Case 1 now asserts exactly what it
 * would have, against the account that actually holds both currencies. A
 * permanently skipped test reports nothing while looking like coverage.
 *
 * Required env vars (all optional at call time; suite skips when absent):
 *   ACCOUNT_A                   Strike API key for account A
 *   ACCOUNT_B                   Strike API key for account B
 *   OR_TEST_PLATFORM_API_KEY    X-Platform-API-Key for minting widget tokens on dev
 *   OR_TEST_PLATFORM_SLUG       Platform slug matching platforms.slug in dev Supabase
 *   OR_API_BASE_URL             Supabase project URL (required; no default)
 *   OR_TEST_APP_USER_ID         App user ID for the test session (default: e2e-identity-test)
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import { createCipheriv, randomBytes } from 'node:crypto';

// --- Environment -------------------------------------------------------------

const OR_API = process.env.OR_API_BASE_URL ?? '';
const FN = `${OR_API}/functions/v1`;

const STRIKE_KEY_A      = process.env.ACCOUNT_A ?? '';
const STRIKE_KEY_B      = process.env.ACCOUNT_B ?? '';
const PLATFORM_API_KEY  = process.env.OR_TEST_PLATFORM_API_KEY ?? '';
const PLATFORM_SLUG     = process.env.OR_TEST_PLATFORM_SLUG ?? '';
const APP_USER_ID       = process.env.OR_TEST_APP_USER_ID ?? 'e2e-identity-test';

/** UUID v4 regex -- what every external_wallet_id should look like post-fix. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// --- Helpers -----------------------------------------------------------------

/**
 * AES-256-GCM encrypt a plaintext string. Returns:
 *   ciphertextB64: base64( iv[12] || ciphertext || gcm_tag[16] )
 *   keyB64:        base64 of the raw 32-byte AES key
 *
 * This is the exact format or-discover-wallets decryptAes() expects:
 *   const iv     = data.slice(0, 12)
 *   const cipher = data.slice(12)   // ciphertext + GCM tag
 *   crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher)
 *
 * Node.js crypto.createCipheriv('aes-256-gcm') emits the auth tag
 * separately via getAuthTag(); we append it manually to match the
 * Web Crypto layout the Deno edge function expects.
 */
function aesEncrypt(plaintext: string): { ciphertextB64: string; keyB64: string } {
  const key = randomBytes(32);
  const iv  = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(), // empty for GCM, included for clarity
  ]);
  const tag = cipher.getAuthTag(); // 16 bytes
  return {
    ciphertextB64: Buffer.concat([iv, encrypted, tag]).toString('base64'),
    keyB64: key.toString('base64'),
  };
}

/**
 * Mint a short-lived widget token via or-link-mint-token.
 *
 * or-discover-wallets in raw-credentials mode validates the token
 * READ-ONLY (does not set used_at), so the same token can authenticate
 * multiple discover calls. Single-use enforcement lives in or-link-complete
 * only.
 */
async function mintToken(request: APIRequestContext): Promise<string> {
  const resp = await request.post(`${FN}/or-link-mint-token`, {
    headers: {
      'X-Platform-API-Key': PLATFORM_API_KEY,
      'Content-Type': 'application/json',
    },
    data: { app_user_id: APP_USER_ID },
  });
  expect(
    resp.ok(),
    `or-link-mint-token failed (${resp.status()}). ` +
    'Ensure OR_TEST_PLATFORM_API_KEY and OR_TEST_PLATFORM_SLUG are set correctly.',
  ).toBe(true);
  const body = await resp.json() as { widget_token?: string; error?: string };
  expect(typeof body.widget_token, 'widget_token must be a string').toBe('string');
  return body.widget_token!;
}

/**
 * Call or-discover-wallets in raw-credentials mode for a Strike API key.
 * Encrypts the credential in memory; nothing is persisted.
 */
async function callDiscover(
  request: APIRequestContext,
  strikeApiKey: string,
  widgetToken: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { ciphertextB64, keyB64 } = aesEncrypt(JSON.stringify({ api_key: strikeApiKey }));
  const resp = await request.post(`${FN}/or-discover-wallets`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      platform_slug:          PLATFORM_SLUG,
      app_user_id:            APP_USER_ID,
      provider_type:          'strike',
      encrypted_credentials:  ciphertextB64,
      credentials_key:        keyB64,
      widget_token:           widgetToken,
    },
  });
  let body: Record<string, unknown> = {};
  try { body = await resp.json(); } catch { /* ignore parse errors on error responses */ }
  return { status: resp.status(), body };
}

/** One wallet as or-link-complete returns it. */
type LinkedWallet = { id: string; external_wallet_id: string };

/**
 * Call or-link-complete with the wallets a discover call just produced.
 *
 * The widget_token MUST be the same one passed to the discover call that
 * produced these wallets: or-link-complete reads the account key back from
 * discovery_sessions keyed on that token, and without a matching row it cannot
 * fingerprint the wallets and silently skips dedup. A token is single-use here
 * (unlike discover), so each link-complete needs its own freshly minted one.
 *
 * encrypted_metadata / encrypted_label / encrypted_credentials are stored
 * opaquely and never decrypted server-side, so any well-formed ciphertext is
 * accepted. We send real AES-GCM output rather than a literal to keep the
 * request shaped exactly like the widget's.
 */
async function callLinkComplete(
  request: APIRequestContext,
  wallets: Array<{ external_wallet_id: string }>,
  widgetToken: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resp = await request.post(`${FN}/or-link-complete`, {
    headers: { 'Content-Type': 'application/json' },
    data: {
      platform_slug:         PLATFORM_SLUG,
      app_user_id:           APP_USER_ID,
      provider_type:         'strike',
      encrypted_label:       aesEncrypt('e2e connection').ciphertextB64,
      encrypted_credentials: aesEncrypt(JSON.stringify({ api_key: STRIKE_KEY_A })).ciphertextB64,
      wallets: wallets.map((w) => ({
        external_wallet_id: w.external_wallet_id,
        encrypted_metadata: aesEncrypt(JSON.stringify({ currency: 'BTC' })).ciphertextB64,
      })),
      widget_token: widgetToken,
    },
  });
  let body: Record<string, unknown> = {};
  try { body = await resp.json(); } catch { /* ignore parse errors on error responses */ }
  return { status: resp.status(), body };
}

/** Discover with key A, then link those wallets. Returns the persisted rows. */
async function discoverAndLink(
  request: APIRequestContext,
  strikeApiKey: string,
): Promise<LinkedWallet[]> {
  const token = await mintToken(request);
  const { status: dStatus, body: dBody } = await callDiscover(request, strikeApiKey, token);
  expect(dStatus, 'discover must return 200 before linking').toBe(200);
  const discovered = dBody.discovered_wallets as Array<{ external_wallet_id: string }>;
  expect(Array.isArray(discovered), 'discover must return an array').toBe(true);
  expect(discovered.length, 'discover must return at least one wallet to link').toBeGreaterThan(0);

  const { status: lStatus, body: lBody } = await callLinkComplete(request, discovered, token);
  expect(lStatus, `or-link-complete must return 200, got ${lStatus}`).toBe(200);
  const linked = lBody.source_wallets as LinkedWallet[];
  expect(Array.isArray(linked), 'source_wallets must be an array').toBe(true);
  return linked;
}

// --- Suite -------------------------------------------------------------------

test.describe('Connector identity -- Strike account isolation', () => {
  // Skip the entire suite when required secrets are not present.
  // In CI these are repository secrets; locally set them in .env.test.
  test.skip(
    !OR_API || !STRIKE_KEY_A || !STRIKE_KEY_B || !PLATFORM_API_KEY || !PLATFORM_SLUG,
    'Requires OR_API_BASE_URL, ACCOUNT_A, ACCOUNT_B, ' +
    'OR_TEST_PLATFORM_API_KEY, OR_TEST_PLATFORM_SLUG env vars.',
  );

  // Allow 60 s per test: Strike live API + Supabase edge function cold start.
  test.setTimeout(60_000);

  // Shared widget token minted once for Cases 1 and 2.
  // or-discover-wallets does NOT consume tokens (used_at stays null),
  // so the same token is valid across multiple discover calls.
  let sharedToken: string;

  test.beforeAll(async ({ request }) => {
    sharedToken = await mintToken(request);
  });

  // -- Case 1 -----------------------------------------------------------------
  test(
    'Case 1: Strike account A -> one wallet per active currency, UUID v4 format',
    async ({ request }) => {
      const { status, body } = await callDiscover(request, STRIKE_KEY_A, sharedToken);
      console.log(`[e2e:case1] status=${status}`, JSON.stringify(body));

      expect(status, 'discover must return HTTP 200 for a valid key').toBe(200);

      const wallets = body.discovered_wallets as Array<{
        external_wallet_id: string;
        currency: string;
        label?: string;
      }> | undefined;
      expect(Array.isArray(wallets), 'discovered_wallets must be an array').toBe(true);

      // The adapter emits one wallet per ACTIVE currency (non-zero balance OR
      // transaction history), so a Strike account is not "one account, one
      // wallet". The earlier toBe(1) here predates that and asserted the
      // pre-per-currency shape: it went red against correct code the first time
      // the suite genuinely ran, which is the only reason we know it was stale.
      //
      // Account A holds both BTC and USD, so both must come back. This is
      // deliberately not an exact-set assertion: a currency the account starts
      // using later is correct behaviour and must not turn this red. What must
      // never happen is collapsing back to a single wallet, which is the bug
      // this case exists to catch.
      const currencies = wallets!.map((w) => w.currency);
      expect(currencies, 'account A must yield a BTC wallet').toContain('BTC');
      expect(currencies, 'account A must yield a USD wallet').toContain('USD');
      expect(
        new Set(currencies).size,
        'each active currency must map to exactly one wallet, never two',
      ).toBe(currencies.length);

      for (const w of wallets!) {
        // Server-side discovery changed external_wallet_id from the shared slug
        // ('strike') to a per-call UUID v4. Assert the UUID shape.
        expect(
          w.external_wallet_id,
          `external_wallet_id for ${w.currency} must be a UUID v4 (not the old slug)`,
        ).toMatch(UUID_V4);

        // wallet_fingerprint is the INTERNAL HMAC of the Strike receiverId.
        // It must never appear in an API response (Auditor gate 4).
        expect(
          (w as Record<string, unknown>).wallet_fingerprint,
          'wallet_fingerprint must not leak into the discover response',
        ).toBeUndefined();
      }
    },
  );

  // -- Case 2 -----------------------------------------------------------------
  test(
    'Case 2: Strike account B -> 1 wallet, UUID v4, no merge with A',
    async ({ request }) => {
      const { status, body } = await callDiscover(request, STRIKE_KEY_B, sharedToken);
      console.log(`[e2e:case2] status=${status}`, JSON.stringify(body));

      expect(status, 'discover must return HTTP 200 for a valid key').toBe(200);

      const wallets = body.discovered_wallets as Array<{
        external_wallet_id: string;
        currency: string;
      }> | undefined;
      expect(Array.isArray(wallets)).toBe(true);
      expect(
        wallets!.length,
        'Strike account B must yield exactly 1 wallet',
      ).toBe(1);

      const extId = wallets![0].external_wallet_id;
      expect(
        extId,
        'external_wallet_id must be a UUID v4 (not the old "strike" slug)',
      ).toMatch(UUID_V4);

      // The old broken value that collapsed every Strike account into one
      // source_wallet. If this appears, syntheticDiscovery is still the
      // default path and the server-side discovery wiring did not take effect.
      expect(extId, 'must not be the legacy slug that caused account merging').not.toBe('strike');

      // wallet_fingerprint is the INTERNAL identity key; must not leak.
      expect(
        (wallets![0] as Record<string, unknown>).wallet_fingerprint,
        'wallet_fingerprint must not leak into the discover response',
      ).toBeUndefined();

      // NOTE: external_wallet_id is a fresh random UUID on EVERY discoverWallets()
      // call (minted, not stored). The "no merge" guarantee lives one layer deeper:
      // or-source-wallets-set uses the HMAC wallet_fingerprint to dedup rows.
      // Two different Strike accounts have different receiverIds -> different
      // fingerprints -> distinct source_wallet rows on save.
    },
  );

  // -- Case 3 -----------------------------------------------------------------
  //
  // The reconnect dedup is the one behaviour with no live evidence behind it.
  // Cases 1, 2, 4 and 5 exercise or-discover-wallets, but dedup does not live
  // there: it lives in or-link-complete, which nothing in this suite called
  // until now. The previous stub named or-source-wallets-set, which does not
  // own this logic, so enabling it as written would have proved nothing.
  //
  // What makes reconnect a real test rather than a repeat of Case 1: Strike
  // mints a fresh random external_wallet_id on EVERY discover call, so the
  // second connect arrives carrying ids the database has never seen. Only the
  // wallet_fingerprint (equal across both calls, since it is an HMAC over the
  // stable receiverId and currency) can match them to the existing rows. If
  // dedup is broken, the second connect inserts a duplicate set and the row
  // count doubles.
  //
  // HONEST LIMIT, so a green tick here is not over-read: this asserts the API
  // contract only. The suite drives the edge functions over HTTP and never
  // loads the widget, so anything the browser does with this response is
  // outside what this case can see.
  test(
    'Case 3: reconnect Strike account A -> same rows, no duplicates',
    async ({ request }) => {
      const first = await discoverAndLink(request, STRIKE_KEY_A);
      console.log('[e2e:case3] first connect', JSON.stringify(first));
      expect(first.length, 'first connect must persist at least one wallet').toBeGreaterThan(0);

      // Reconnect: a fresh token, a fresh discover, therefore brand new
      // external_wallet_ids on the wire for wallets we already hold.
      const second = await discoverAndLink(request, STRIKE_KEY_A);
      console.log('[e2e:case3] reconnect', JSON.stringify(second));

      expect(
        second.length,
        'reconnect must return the same number of wallets, not a duplicated set',
      ).toBe(first.length);

      // Assertion 1: the same source_wallets rows. This is the anchor the
      // integrating app stores, so a new id here means a duplicate wallet
      // appearing in the customer's books, which is the original bug.
      expect(
        [...second.map((w) => w.id)].sort(),
        'reconnect must return the SAME source_wallets row ids (dedup by fingerprint)',
      ).toEqual([...first.map((w) => w.id)].sort());

      // Assertion 2: the same external_wallet_ids. or-link-complete returns the
      // STORED id on a fingerprint match, never the ephemeral one just minted.
      // Without this, a future change could start handing back the fresh id and
      // every reconnect would look new to the integrator, with nothing red.
      expect(
        [...second.map((w) => w.external_wallet_id)].sort(),
        'reconnect must return the STORED external_wallet_id, not the freshly minted one',
      ).toEqual([...first.map((w) => w.external_wallet_id)].sort());
    },
  );

  // Case 4 (BTC+USD -> 2 wallets) was removed rather than enabled: it targeted
  // account B, which holds only BTC, and Case 1 now makes its assertion against
  // account A, which holds both. See the module header.

  // -- Case 5 -----------------------------------------------------------------
  test(
    'Case 5: no-id / invalid Strike key -> error response, no orphan wallet',
    async ({ request }) => {
      // An invalid API key causes Strike /v1/balances to return 401. The
      // adapter throws; or-discover-wallets catches and returns an error --
      // NOT a 200 with a discovered_wallets array.
      //
      // This is also the proxy for a "zero-invoice account" (a valid key
      // whose account has no invoices, so no receiverId can be established
      // and no wallet identity can be built). The failure path is the same:
      // no external_wallet_id is produced, and no row is inserted.
      //
      // "No orphan wallet" means: the response must not include
      // discovered_wallets, ensuring the caller cannot proceed to
      // or-link-complete and save a junk source_wallets row.
      const tokenFor5 = await mintToken(request);
      const { status, body } = await callDiscover(
        request,
        'INVALID-STRIKE-KEY-CASE-5',
        tokenFor5,
      );
      console.log(`[e2e:case5] status=${status}`, JSON.stringify(body));

      // Must NOT be 200 with a wallet -- that would mean syntheticDiscovery
      // (the old broken path) is still active and produced a fallback entry.
      expect(status, 'invalid Strike key must not return HTTP 200').not.toBe(200);

      // No discovered_wallets array -- no orphan wallet was built.
      expect(
        body.discovered_wallets,
        'no orphan wallet must be returned on auth failure',
      ).toBeUndefined();

      // An error field must be present: confirms a user-facing error path
      // rather than a silent empty result.
      expect(typeof body.error, 'error field must be a string').toBe('string');
      console.log(`[e2e:case5] error message: ${String(body.error)}`);
    },
  );
});
