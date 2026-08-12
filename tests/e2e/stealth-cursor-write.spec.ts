/**
 * Stealth Sync cursor-write harness (DL-0649 Part 2).
 *
 * Four requirements (per QA/Auditor gate, issue #570):
 *   1. Runs against a vite dev server so import.meta.env.DEV = true and
 *      isForceCursor() is active.
 *   2. Asserts or-stealth-envelope-update fires with last_block_scanned.
 *   3. Verifies stealth_connections.last_block_scanned is non-null via
 *      or-stealth-envelope-fetch after the call (Supabase test client path).
 *   4. Fixture inserted via or-stealth-connection-create (Option B), sealed
 *      with the 32-zero-byte key, cleaned up in afterEach.
 *
 * Skip guard: set PLAYWRIGHT_WITH_VITE_DEV=1 to activate. Without it the
 * suite skips cleanly. The main CI Playwright job targets the deployed
 * CF Pages build (import.meta.env.DEV = false, isForceCursor tree-shaken)
 * so the skip is expected in that context, not a lie.
 *
 * Full invocation (local or a dedicated CI job with PLAYWRIGHT_WITH_VITE_DEV=1):
 *   PLAYWRIGHT_WITH_VITE_DEV=1 \
 *   OR_API_BASE_URL=https://<project-ref>.supabase.co \
 *   OR_TEST_PLATFORM_API_KEY=<key> \
 *   VITE_OR_STEALTH_ALLOWED_ORIGINS=http://localhost:5173 \
 *   pnpm test:e2e --grep "stealth cursor write"
 */

import { test, expect } from '@playwright/test';
import { webcrypto } from 'node:crypto';

// ------ env ---------------------------------------------------------------

const WITH_VITE_DEV = !!process.env.PLAYWRIGHT_WITH_VITE_DEV;
const OR_API        = (process.env.OR_API_BASE_URL ?? '').replace(/\/$/, '');
const FN            = `${OR_API}/functions/v1`;
const PLATFORM_KEY  = process.env.OR_TEST_PLATFORM_API_KEY ?? '';

const VITE_BASE   = 'http://localhost:8080';
const WIDGET_PATH = '/connect/stealth';

// 32 zero bytes, base64-encoded. Fixture key described in Option B spec.
const ZERO_KEY_B64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// Fixed UUID for the fixture app_user_id (or-stealth-connection-delete
// requires UUID format for app_user_id).
const APP_USER_ID = 'e2e00000-cafe-4000-a000-000000000001';

// Non-UUID app_user_id for the DL-0697 acceptance test. Real host apps use
// opaque ids such as cuids; this value exercises the isValidAppUserId fix.
const NON_UUID_APP_USER_ID = 'bitbooks_user_abc123';

// 64-char all-lowercase-hex blind index (valid per BLIND_INDEX_HEX_RE).
// Safe to reuse across runs: UNIQUE constraint is per (connection_id, txid_blind_index_hex)
// and each run creates a fresh connection_id in beforeEach.
const FIXTURE_BLIND_INDEX = '0'.repeat(64);

// ------ crypto helpers ----------------------------------------------------

/**
 * Seal a WalletEnvelopePayload using AES-256-GCM under the 32-zero-byte key.
 *
 * Fixed zero IV makes the fixture deterministic across runs. Correct for a
 * test that owns both sides of the crypto; never do this in production.
 *
 * The format mirrors src/stealth/lib/seal.ts: version, algorithm, iv_b64
 * (base64 of the 12-byte IV), and ciphertext_b64 (base64 of the raw
 * Web Crypto output, which appends the 16-byte GCM auth tag automatically).
 */
async function sealFixtureEnvelope() {
  const keyBytes = Buffer.from(ZERO_KEY_B64, 'base64');
  const key = await webcrypto.subtle.importKey(
    'raw', keyBytes, 'AES-GCM', false, ['encrypt'],
  );
  const iv = new Uint8Array(12); // 12 zero bytes, fixed
  const payload = {
    kind: 'xpub_stealth',
    // BIP84 test-vector xpub (same key as BIP84_ZPUB, re-encoded with the
    // standard xpub prefix). runSync derives from this unconditionally even in
    // mock mode (sync.ts deriving phase has no mock bypass), so a full 111-char
    // key is required or derive.ts throws "wrong length, expected 78".
    xpub: 'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V',
    label: 'e2e cursor-write fixture',
    wallet_birthday: '2020-01-01',
    gap_limit: 20,
    script_type: 'p2wpkh',
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const b64 = (buf: ArrayBuffer | Uint8Array) =>
    Buffer.from(new Uint8Array(buf)).toString('base64');
  return {
    version: 1 as const,
    algorithm: 'AES-256-GCM' as const,
    iv_b64: b64(iv),
    ciphertext_b64: b64(ciphertext),
  };
}

// ------ fixture helpers (platform-mode, Node.js fetch) --------------------

async function createFixture(): Promise<string> {
  const sealed = await sealFixtureEnvelope();
  const resp = await fetch(`${FN}/or-stealth-connection-create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-API-Key': PLATFORM_KEY,
    },
    body: JSON.stringify({
      app_slug: 'e2e-stealth-cursor-test',
      app_user_id: APP_USER_ID,
      connection_kind: 'xpub_stealth',
      sealed_envelope: sealed,
      wallet_birthday_plaintext: '2020-01-01',
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`or-stealth-connection-create failed ${resp.status}: ${text}`);
  }
  const body = (await resp.json()) as { connection_id: string };
  return body.connection_id;
}

async function deleteFixture(connectionId: string): Promise<void> {
  // Best-effort: if the fixture row is already gone, ignore the error.
  await fetch(`${FN}/or-stealth-connection-delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-API-Key': PLATFORM_KEY,
    },
    body: JSON.stringify({ connection_id: connectionId, app_user_id: APP_USER_ID }),
  }).catch(() => {});
}

// ------ DL-0697 helpers (non-UUID fixture, Node.js fetch, no browser) ----------

/** Seal a minimal opaque blob for use as a SealedTransactionInput in tests. */
async function sealFixtureTx() {
  const keyBytes = Buffer.from(ZERO_KEY_B64, 'base64');
  const key = await webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12); // 12 zero bytes, fixed for determinism
  const plaintext = new TextEncoder().encode(JSON.stringify({ test: 'dl-0697' }));
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const b64 = (buf: ArrayBuffer | Uint8Array) =>
    Buffer.from(new Uint8Array(buf)).toString('base64');
  return {
    version: 1 as const,
    algorithm: 'AES-256-GCM' as const,
    iv_b64: b64(iv),
    ciphertext_b64: b64(ciphertext),
    occurred_at: '2024-01-01',
    block_height: 800_000,
    txid_blind_index_hex: FIXTURE_BLIND_INDEX,
  };
}

async function createNonUuidFixture(): Promise<string> {
  const sealed = await sealFixtureEnvelope();
  const resp = await fetch(`${FN}/or-stealth-connection-create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-API-Key': PLATFORM_KEY,
    },
    body: JSON.stringify({
      app_slug: 'e2e-dl0697-non-uuid-test',
      app_user_id: NON_UUID_APP_USER_ID,
      connection_kind: 'xpub_stealth',
      sealed_envelope: sealed,
      wallet_birthday_plaintext: '2020-01-01',
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`or-stealth-connection-create (non-uuid id) failed ${resp.status}: ${text}`);
  }
  const body = (await resp.json()) as { connection_id: string };
  return body.connection_id;
}

async function deleteNonUuidFixture(connectionId: string): Promise<void> {
  // or-stealth-connection-delete accepts any non-empty string for app_user_id
  // (typeof check only, no UUID requirement), so this cleanup is safe.
  await fetch(`${FN}/or-stealth-connection-delete`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-API-Key': PLATFORM_KEY,
    },
    body: JSON.stringify({ connection_id: connectionId, app_user_id: NON_UUID_APP_USER_ID }),
  }).catch(() => {});
}

// Requirement 3: check stealth_connections.last_block_scanned via the
// envelope-fetch edge function, which reads the real DB row.
async function fetchConnectionCursor(connectionId: string): Promise<number | null> {
  const resp = await fetch(`${FN}/or-stealth-envelope-fetch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-API-Key': PLATFORM_KEY,
    },
    body: JSON.stringify({
      connection_id: connectionId,
      app_user_id: APP_USER_ID,
      app_slug: 'e2e-stealth-cursor-test',
    }),
  });
  if (!resp.ok) throw new Error(`or-stealth-envelope-fetch failed ${resp.status}`);
  const row = (await resp.json()) as { last_block_scanned: number | null };
  return row.last_block_scanned;
}

// ------ suite -------------------------------------------------------------

// When PLAYWRIGHT_WITH_VITE_DEV is set, credentials must also be present.
// Fail loudly so a dedicated CI job with an expired or missing key cannot
// silently report green having run zero assertions.
if (WITH_VITE_DEV && (!OR_API || !PLATFORM_KEY)) {
  throw new Error(
    '[stealth-cursor-write] PLAYWRIGHT_WITH_VITE_DEV=1 is set but required credentials ' +
    'are missing: set both OR_API_BASE_URL and OR_TEST_PLATFORM_API_KEY.',
  );
}

// Use test.describe.skip (not test.skip() inside the callback) when
// PLAYWRIGHT_WITH_VITE_DEV is unset. test.describe.skip prevents the
// test.use() baseURL override from being registered in CI jobs targeting the
// deployed CF Pages build -- a registered http://localhost:5173 override would
// redirect smoke-suite page.goto('/') to a port that is not listening.
const _testDescribe = !WITH_VITE_DEV ? test.describe.skip : test.describe;

// ---- DL-0697: non-UUID app_user_id acceptance (API-only, no browser) --------
// Runs in normal CI without PLAYWRIGHT_WITH_VITE_DEV. Skips when credentials
// are absent (same env vars as the cursor-write suite).
test.describe('or-stealth-transactions-store: non-UUID app_user_id (DL-0697)', () => {
  test.setTimeout(30_000);

  test.skip(
    !OR_API || !PLATFORM_KEY,
    'OR_API_BASE_URL and OR_TEST_PLATFORM_API_KEY are required; skipping DL-0697 acceptance test',
  );

  let nonUuidConnectionId = '';

  test.beforeEach(async () => {
    nonUuidConnectionId = await createNonUuidFixture();
  });

  test.afterEach(async () => {
    if (nonUuidConnectionId) await deleteNonUuidFixture(nonUuidConnectionId);
  });

  test('accepts non-UUID app_user_id and stores the transaction row', async () => {
    const tx = await sealFixtureTx();
    const resp = await fetch(`${FN}/or-stealth-transactions-store`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Platform-API-Key': PLATFORM_KEY,
      },
      body: JSON.stringify({
        connection_id: nonUuidConnectionId,
        app_user_id: NON_UUID_APP_USER_ID,
        sealed_transactions: [tx],
        last_block_scanned: 800_000,
      }),
    });
    const bodyText = await resp.text();
    expect(
      resp.status,
      `or-stealth-transactions-store returned HTTP ${resp.status} for non-UUID app_user_id -- body: ${bodyText}`,
    ).toBe(200);
    const body = JSON.parse(bodyText) as { inserted: number; total: number };
    expect(body.inserted, 'inserted must be 1 (one sealed transaction written)').toBe(1);
    expect(body.total, 'total must be 1').toBe(1);
  });
});

_testDescribe('stealth cursor write (DL-0649 Part 2)', () => {
  // Mock sync is fast (tip = 800010, ~11 blocks). 60s is generous.
  test.setTimeout(60_000);


  let connectionId = '';

  test.beforeEach(async () => {
    // Requirement 4: insert the fixture row via or-stealth-connection-create,
    // sealed with the 32-zero-byte key. Store the connection_id for use in
    // the test and cleanup.
    connectionId = await createFixture();
  });

  test.afterEach(async () => {
    // Requirement 4: clean up after each run.
    if (connectionId) await deleteFixture(connectionId);
  });

  test('or-stealth-envelope-update fires and last_block_scanned is written', async ({
    page,
    context,
  }) => {
    // Captured from the intercepted or-stealth-envelope-update POST body.
    let updateBody: Record<string, unknown> | null = null;

    const capturedId  = connectionId;
    const sealed      = await sealFixtureEnvelope();

    // Navigate the parent page to the vite dev origin so postMessage from
    // this page has origin http://localhost:5173, which must be in the
    // widget's VITE_OR_STEALTH_ALLOWED_ORIGINS allowlist.
    // Navigate to the vite dev origin directly (no baseURL override needed).
    await page.goto(VITE_BASE);

    // Open the widget popup and keep a reference to it via a window property.
    // Use Promise.all so we are listening for the 'page' event before
    // window.open() executes.
    const popupPromise = context.waitForEvent('page');
    await page.evaluate(
      ({ base, path }: { base: string; path: string }) => {
        (window as unknown as Record<string, unknown>)['__testPopup'] =
          window.open(`${base}${path}?mock=1&force_cursor=1`) ?? undefined;
      },
      { base: VITE_BASE, path: WIDGET_PATH },
    );
    const widgetPage = await popupPromise;

    // Wait until the widget has mounted and is waiting for OR_STEALTH_INIT.
    // At this point it has sent OR_STEALTH_READY but made no edge-function
    // calls yet, so our route intercepts are safe to install now.
    await widgetPage.waitForSelector('text=Waiting for the parent app', {
      timeout: 15_000,
    });

    // Requirement 1 (implied): intercept or-stealth-envelope-fetch and return
    // a mock response with last_block_scanned: null. The widget runs in
    // ?mock=1 so the mock fetchers return tip = 800010. With
    // isForceCursor() = true (dev server + ?force_cursor=1) and
    // last_block_scanned = null, the condition
    //   (!useMock || isForceCursor()) && 800010 > (null ?? -1)
    // = (false || true) && true = true
    // fires the cursor write.
    await widgetPage.route('**/or-stealth-envelope-fetch', (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          connection_id: capturedId,
          sealed_envelope: sealed,
          connection_kind: 'xpub_stealth',
          wallet_birthday_plaintext: '2020-01-01',
          last_block_scanned: null,
          last_sync_at: null,
          status: 'active',
        }),
      });
    });

    // Requirement 2: intercept or-stealth-envelope-update. Capture the body
    // for assertion, then proxy it through from Node.js adding the platform
    // API key so stealth_connections is actually written in Supabase.
    // The widget sends no auth header (no access_token or proxy_base_url in
    // the INIT), so the call would 401 if forwarded as-is.
    await widgetPage.route('**/or-stealth-envelope-update', async (route) => {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      updateBody  = body;
      const proxied = await fetch(`${FN}/or-stealth-envelope-update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform-API-Key': PLATFORM_KEY,
        },
        body: JSON.stringify(body),
      });
      await route.fulfill({
        status: proxied.status,
        contentType: 'application/json',
        body: await proxied.text(),
      });
    });

    // Send OR_STEALTH_INIT from the parent page to the popup.
    // The widget validates event.origin === return_callback_origin, both
    // of which must equal http://localhost:5173.
    await page.evaluate(
      ({ connId, userId, keyB64, base }: {
        connId: string; userId: string; keyB64: string; base: string;
      }) => {
        const popup =
          (window as unknown as Record<string, Window | undefined>)['__testPopup'];
        if (!popup) throw new Error('popup reference lost');
        popup.postMessage(
          {
            type: 'OR_STEALTH_INIT',
            protocol_version: 1,
            app_slug: 'e2e-stealth-cursor-test',
            app_user_id: userId,
            mode: 'sync',
            connection_id: connId,
            or_stealth_key_b64: keyB64,
            return_callback_origin: base,
          },
          base,
        );
      },
      { connId: capturedId, userId: APP_USER_ID, keyB64: ZERO_KEY_B64, base: VITE_BASE },
    );

    // Wait for the outbound or-stealth-envelope-update request AND response.
    // waitForResponse (not waitForRequest + sleep) ensures the async route
    // handler has completed the Supabase proxy call before the DB check below.
    // Root cause of prior failures: waitForRequest resolved on dispatch; the
    // 300ms sleep that followed raced against edge-function cold starts
    // (200-2000ms). fetchConnectionCursor ran before the cursor was written.
    const envelopeUpdateResp = await widgetPage.waitForResponse(
      (resp) => resp.url().includes('or-stealth-envelope-update'),
      { timeout: 35_000 },
    );

    // Requirement 2: assert the POST was made and carried a numeric cursor.
    expect(updateBody, 'or-stealth-envelope-update was not called').not.toBeNull();
    const sentCursor = (updateBody as Record<string, unknown>)['last_block_scanned'];
    expect(
      typeof sentCursor,
      'update POST body must have a numeric last_block_scanned',
    ).toBe('number');
    expect(
      sentCursor as number,
      'last_block_scanned must be positive (mock tip = 800010)',
    ).toBeGreaterThan(0);

    // Verify proxy returned 200 before the DB check. If Supabase returned
    // non-200 the cursor was not written; naming the status here is clearer
    // than letting the DB-null assertion below be the first indication.
    expect(
      envelopeUpdateResp.status(),
      `Supabase cursor-write returned HTTP ${envelopeUpdateResp.status()} -- check playwright-stealth-cursor-report artifact for proxy error`,
    ).toBe(200);

    // Requirement 3: verify stealth_connections via the Supabase test client
    // (or-stealth-envelope-fetch, which reads the real DB row).
    const dbCursor = await fetchConnectionCursor(capturedId);
    expect(
      dbCursor,
      'stealth_connections.last_block_scanned must be non-null after cursor write',
    ).not.toBeNull();
    expect(
      typeof dbCursor,
      'stealth_connections.last_block_scanned must be a number',
    ).toBe('number');
  });
});
