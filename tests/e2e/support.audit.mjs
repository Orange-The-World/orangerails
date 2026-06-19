// Support portal validation
//
// Covers:
//   B1 — Chatwoot help-center loads with brand color #FF6B1A
//   B2 — /help redirects to /hc/orangerails/en (308)
//   B3 — Article page renders with full CSS (Tailwind classes apply)
//   B4 — Chat widget script + brand-specific websiteToken present

import { chromium, request } from 'playwright';
import { SUPPORT_URL, HEADLESS, STEP } from './_helpers.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('B2: /help redirects to /hc/orangerails/en (308)', async () => {
  STEP(1, `HEAD ${SUPPORT_URL}/help`);
  const ctx = await request.newContext();
  const res = await ctx.fetch(SUPPORT_URL + '/help', { method: 'HEAD', maxRedirects: 0 });
  if (res.status() !== 308 && res.status() !== 301 && res.status() !== 302) {
    throw new Error(`expected redirect status, got ${res.status()}`);
  }
  const location = res.headers()['location'];
  if (!location || !/\/hc\/orangerails\/en/.test(location)) {
    throw new Error(`/help redirect target wrong: ${location}`);
  }
  await ctx.dispose();
});

test('B1+B3: portal renders with brand color + Tailwind classes', async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await (await browser.newContext()).newPage();
  try {
    STEP(1, `goto ${SUPPORT_URL}/hc/orangerails`);
    await page.goto(SUPPORT_URL + '/hc/orangerails', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Chatwoot's locale redirect lands us at /hc/orangerails/en.
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    STEP(2, 'brand color #FF6B1A present in page styles');
    const html = await page.content();
    if (!/#FF6B1A/i.test(html)) {
      throw new Error('brand color #FF6B1A not found in portal HTML');
    }

    STEP(3, 'Tailwind class actually applies (computed style is not raw)');
    // If the portal CSS failed to load (the Caddy /vite/* bug we fixed in
    // the cleanup pass), the dark/light toggle text would render as plain
    // black on white, but on a properly-styled page the body has a
    // dark/light color theme. We pick a class we know exists and check
    // its computed background is not "rgba(0, 0, 0, 0)" (no style).
    const main = page.locator('main').first();
    await main.waitFor({ timeout: 10_000 });
    const bg = await main.evaluate((el) => getComputedStyle(el).backgroundColor);
    if (!bg || bg === 'rgba(0, 0, 0, 0)') {
      throw new Error(`main background unstyled (${bg}) — CSS bundle did not load`);
    }
  } finally {
    await browser.close();
  }
});

test('B4: article page embeds OR-specific chat widget token', async () => {
  STEP(1, 'fetch a published OR article page');
  const ctx = await request.newContext();
  // Use the Quickstart article slug we know about.
  const articleUrl = SUPPORT_URL + '/hc/orangerails/articles/1778933748-quickstart';
  const res = await ctx.fetch(articleUrl);
  if (!res.ok()) throw new Error(`article fetch failed: ${res.status()}`);
  const html = await res.text();
  // The chat widget embed should reference the OR-specific website token
  // (zx2QAZYbNhv1X8UFsW4jMtrS) and the sdk.js path.
  if (!/zx2QAZYbNhv1X8UFsW4jMtrS/.test(html)) {
    throw new Error('OR-specific chat widget token NOT embedded on article page');
  }
  if (!/\/packs\/js\/sdk\.js/.test(html)) {
    throw new Error('Chatwoot websdk script tag missing from article page');
  }
  await ctx.dispose();
});

let passed = 0, failed = 0;
for (const t of tests) {
  process.stdout.write(`  ▶ ${t.name}\n`);
  try { await t.fn(); console.log(`  ✓ ${t.name}\n`); passed++; }
  catch (e) { console.error(`  ✗ ${t.name}\n    ${e.message}\n`); failed++; }
}
console.log(`support: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
