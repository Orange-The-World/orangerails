/**
 * Connector-identity acceptance spec -- Strike account isolation.
 *
 * Validates that PR #159 (SHA 9ddc58fd2f) correctly isolates Strike accounts
 * via server-side discovery: each account now produces a distinct UUID wallet
 * identifier instead of the shared slug 'strike' that caused all accounts to
 * merge into a single source_wallets row (bitbooks#281).
 *
 * Test path: Playwright request context calls or-discover-wallets in
 * raw-credentials mode, exactly the network call the connect widget makes
 * after the Step 1 wiring (PR #159). No browser window required; the identity
 * logic under test lives entirely in the edge function + Strike adapter.
 *
 * Cases runnable in this PR:
 *   1  Strike account A          -> exactly 1 wallet, UUID v4
 *   2  Strike account B          -> 1 wallet, UUID v4, wallet_fingerprint absent
 *   5  No-id / zero-invoice provider -> error, no orphan wallet
 *
 * Cases stubbed (test.skip) pending dependencies:
 *   3  Reconnect A -> no duplicate source_wallet row  [needs #153]
 *   4  BTC+USD Strike account -> 2 wallets            [needs per-currency adapter]
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
    'Case 1: Strike account A -> exactly 1 wallet, UUID v4 format',
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
      expect(
        wallets!.length,
        'Strike account A must yield exactly 1 wallet (one account, one identity)',
      ).toBe(1);

      const w = wallets![0];
      // The fix in PR #159 changed external_wallet_id from the shared slug
      // ('strike') to a per-call UUID v4. Assert the UUID shape.
      expect(
        w.external_wallet_id,
        'external_wallet_id must be a UUID v4 (not the old slug)',
      ).toMatch(UUID_V4);

      // wallet_fingerprint is the INTERNAL HMAC of the Strike receiverId.
      // It must never appear in an API response (Auditor gate 4).
      expect(
        (w as Record<string, unknown>).wallet_fingerprint,
        'wallet_fingerprint must not leak into the discover response',
      ).toBeUndefined();
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
      // default path and PR #159's wiring did not take effect.
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

  // -- Case 3 (stub) ----------------------------------------------------------
  test.skip(
    'Case 3: reconnect Strike account A -> no duplicate source_wallet row created',
    async () => {
      // Enable once #153 (wallet_fingerprint dedup in or-source-wallets-set) lands.
      //
      // When enabled:
      //   1. Call or-link-complete with Strike key A -> note source_wallet row W1
      //   2. Delete the connection (or-connection-delete)
      //   3. Call or-link-complete with Strike key A again -> connection C2
      //   4. Query source_wallets WHERE connection_id = C2
      //   5. Assert the existing W1 external_wallet_id is reused (fingerprint match),
      //      not a fresh UUID row.
      //
      // The dedup logic: or-source-wallets-set looks for an existing row
      // WHERE wallet_fingerprint = HMAC(key, receiverId), and if found
      // carries forward its external_wallet_id instead of inserting a new one.
    },
  );

  // -- Case 4 (stub) ----------------------------------------------------------
  test.skip(
    'Case 4: BTC+USD Strike account -> 2 wallets, one per currency',
    async () => {
      // Enable once the per-currency Strike adapter ships.
      //
      // When enabled:
      //   const { status, body } = await callDiscover(request, STRIKE_KEY_B, token);
      //   expect(status).toBe(200);
      //   const wallets = body.discovered_wallets as DiscoveredWallet[];
      //   expect(wallets).toHaveLength(2);
      //   const currencies = wallets.map(w => w.currency).sort();
      //   expect(currencies).toEqual(['BTC', 'USD']);
      //   wallets.forEach(w => expect(w.external_wallet_id).toMatch(UUID_V4));
      //
      // Dependency: the Strike adapter must split multi-currency balances
      // into separate DiscoveredWallet entries (one per non-zero balance).
    },
  );

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
