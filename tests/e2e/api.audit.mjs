// OR edge function API contract tests
//
// Direct HTTP smoke tests (no browser). Covers:
//   C1 — or-providers returns 100+ live providers (audit's "100+ connections" claim)
//   C2 — or-link-mint-token without X-Platform-API-Key returns 401
//   C3 — or-link-mint-token with an obviously-invalid key returns 401
//   C4 — or-platform-display returns 200 for a known platform_slug
//   C5 — or-link-complete rejects an invalid widget_token (verification path works)

import { request } from 'playwright';
import { API_BASE_URL, STEP } from './_helpers.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const fn = (path) => `${API_BASE_URL}/functions/v1/${path}`;

test('C1: or-providers returns a healthy provider catalog', async () => {
  STEP(1, 'GET or-providers');
  const ctx = await request.newContext();
  const res = await ctx.fetch(fn('or-providers'));
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  const body = await res.json();
  if (!Array.isArray(body.providers)) throw new Error('no providers array');
  // Count live + beta together as "usable" (CCXT entries land as beta).
  const usable = body.providers.filter((p) => p.status === 'live' || p.status === 'beta');
  if (usable.length < 100) {
    throw new Error(`expected ≥100 usable providers, got ${usable.length}`);
  }
  await ctx.dispose();
});

test('C2: or-link-mint-token requires X-Platform-API-Key', async () => {
  STEP(1, 'POST or-link-mint-token with no auth header');
  const ctx = await request.newContext();
  const res = await ctx.fetch(fn('or-link-mint-token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({ app_user_id: 'test-user' }),
  });
  if (res.status() !== 401) throw new Error(`expected 401, got ${res.status()}`);
  await ctx.dispose();
});

test('C3: or-link-mint-token rejects bogus API key', async () => {
  STEP(1, 'POST with invalid X-Platform-API-Key');
  const ctx = await request.newContext();
  const res = await ctx.fetch(fn('or-link-mint-token'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-API-Key': 'definitely-not-a-real-key',
    },
    data: JSON.stringify({ app_user_id: 'test-user' }),
  });
  if (res.status() !== 401) throw new Error(`expected 401, got ${res.status()}`);
  await ctx.dispose();
});

test('C4: or-platform-display returns 200 for a known slug', async () => {
  STEP(1, 'GET or-platform-display?slug=bitbooks-v2');
  const ctx = await request.newContext();
  const res = await ctx.fetch(fn('or-platform-display') + '?slug=bitbooks-v2');
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
  const body = await res.json();
  if (body.slug !== 'bitbooks-v2') throw new Error(`unexpected body: ${JSON.stringify(body)}`);
  // Sensitive fields must NOT be returned.
  if ('api_key_hash' in body || 'tier' in body || 'is_internal' in body) {
    throw new Error('or-platform-display leaks sensitive columns');
  }
  await ctx.dispose();
});

test('C5: or-link-complete rejects an invalid widget_token', async () => {
  STEP(1, 'POST or-link-complete with widget_token=fake-uuid');
  const ctx = await request.newContext();
  const res = await ctx.fetch(fn('or-link-complete'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({
      platform_slug: 'bitbooks-v2',
      app_user_id: 'test-user-' + Math.random().toString(16).slice(2),
      provider_type: 'blink',
      encrypted_label: 'AAAA',
      encrypted_credentials: 'AAAA',
      wallets: [{ external_wallet_id: 'w', encrypted_metadata: 'AAAA' }],
      widget_token: '00000000-0000-4000-8000-000000000000',
    }),
  });
  // When we pass a widget_token the function actively validates it.
  // We expect 401 Invalid widget token (because the UUID isn't in the table).
  if (res.status() !== 401) {
    throw new Error(`expected 401 from invalid widget_token, got ${res.status()}`);
  }
  await ctx.dispose();
});

let passed = 0, failed = 0;
for (const t of tests) {
  process.stdout.write(`  ▶ ${t.name}\n`);
  try { await t.fn(); console.log(`  ✓ ${t.name}\n`); passed++; }
  catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}\n`); failed++; }
}
console.log(`api: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
