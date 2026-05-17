// Audit 2026-05-16 — landing-page surface validation against dev.orangerails.com
//
// Covers:
//   * Hero — "aggregator that cannot read your data" + 100+ counter + no MCP claim
//   * PlaidProblem — "Traditional aggregators monetize your data"
//   * Features — "Privacy tiers disclosed" present, "Books ready" absent
//   * Comparison — no "Books ready" row
//   * Footer — no "BitBooks family" line, Support link goes to support.orangerails.com

import { chromium } from 'playwright';
import { APP_URL, HEADLESS, STEP } from './_helpers.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('A1-A7: landing page audit assertions', async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    STEP(1, `goto ${APP_URL}/`);
    await page.goto(APP_URL + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Wait for the SPA to hydrate so React-rendered Hero is visible.
    await page.waitForSelector('h1', { timeout: 20_000 });

    STEP(2, 'A1 — hero says "aggregator that cannot read your data"');
    const h1 = await page.locator('h1').first().textContent();
    if (!h1 || !/aggregator that\s+cannot read your data/i.test(h1)) {
      throw new Error(`Hero h1 mismatch: ${JSON.stringify(h1)}`);
    }
    if (/MCP layer/i.test(h1)) {
      throw new Error('Hero still contains the MCP-layer claim');
    }

    STEP(3, 'A7 — hero subhead contains 100+ live connections');
    const bodyText = await page.locator('body').innerText();
    if (!/\b\d{2,}\+? live connections\b/i.test(bodyText)) {
      throw new Error('Hero subhead missing "<N>+ live connections" phrasing');
    }

    STEP(4, 'A2 — PlaidProblem section title');
    if (!/Traditional aggregators monetize your data/i.test(bodyText)) {
      throw new Error('PlaidProblem section title not found');
    }
    if (/Plaid was built on your data/i.test(bodyText)) {
      throw new Error('Old PlaidProblem title still present');
    }

    STEP(5, 'A3 — Features grid contains "Privacy tiers disclosed", not "Books ready"');
    if (!/Privacy tiers disclosed/i.test(bodyText)) {
      throw new Error('"Privacy tiers disclosed" Feature card missing');
    }
    if (/\bBooks ready\b/.test(bodyText)) {
      throw new Error('"Books ready" still present somewhere on the landing');
    }
    if (/Accounting[- ]grade/i.test(bodyText)) {
      throw new Error('Stale "Accounting-grade" label still present');
    }

    STEP(6, 'A4 — Comparison table no "Books ready" row');
    // The comparison rows render as table-like sections; check the whole DOM.
    const compHtml = await page.content();
    if (/Books ready/.test(compHtml)) {
      throw new Error('Comparison table still has Books-ready row');
    }

    STEP(7, 'A5 — Footer does not say "Part of the BitBooks family"');
    if (/Part of the [A-Za-z ]*BitBooks[A-Za-z ]* family/i.test(bodyText)) {
      throw new Error('Footer still says "Part of the BitBooks family"');
    }

    STEP(8, 'A6 — Footer Support link → support.orangerails.com');
    const supportHref = await page.locator('a:has-text("Support")').first().getAttribute('href');
    if (!supportHref || !/support\.orangerails\.com/.test(supportHref)) {
      throw new Error(`Footer Support link is wrong: ${supportHref}`);
    }
  } finally {
    await browser.close();
  }
});

test('A8-A9: /docs page wires KB cards correctly', async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await (await browser.newContext()).newPage();
  try {
    STEP(1, `goto ${APP_URL}/docs`);
    await page.goto(APP_URL + '/docs', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('h1', { timeout: 20_000 });

    STEP(2, 'count cards with href');
    const hrefs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.getAttribute('href') || '')
        .filter((h) => /support\.orangerails\.com|wiki\.abascal\.ca/.test(h)),
    );
    if (hrefs.length < 8) {
      throw new Error(`Expected ≥8 doc card hrefs, got ${hrefs.length}: ${JSON.stringify(hrefs)}`);
    }

    STEP(3, 'no card points at the old /help fork');
    const badHelp = hrefs.find((h) => /\/help(\/|$|\?)/.test(h));
    if (badHelp) {
      throw new Error(`Card still points at custom /help: ${badHelp}`);
    }

    STEP(4, 'at least three cards on the chatwoot help-center');
    const chatwootHrefs = hrefs.filter((h) => /support\.orangerails\.com\/hc\//.test(h));
    if (chatwootHrefs.length < 3) {
      throw new Error(`Expected ≥3 cards on /hc/, got ${chatwootHrefs.length}`);
    }
  } finally {
    await browser.close();
  }
});

test('A10: /providers page lists multiple providers', async () => {
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await (await browser.newContext()).newPage();
  try {
    STEP(1, `goto ${APP_URL}/providers`);
    await page.goto(APP_URL + '/providers', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('h1', { timeout: 20_000 });
    // Provider names render somewhere on the page — sample for 5 known slugs.
    const body = await page.locator('body').innerText();
    const known = ['Coinbase', 'Kraken', 'Binance', 'Bitstamp', 'Strike'];
    const missing = known.filter((p) => !body.includes(p));
    if (missing.length > 1) {
      throw new Error(`/providers missing too many expected names: ${missing.join(', ')}`);
    }
  } finally {
    await browser.close();
  }
});

let passed = 0, failed = 0;
for (const t of tests) {
  process.stdout.write(`  ▶ ${t.name}\n`);
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}\n`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${t.name}\n    ${e.message}\n`);
    failed++;
  }
}
console.log(`landing: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
