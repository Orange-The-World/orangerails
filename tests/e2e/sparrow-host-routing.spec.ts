import { test, expect, type Page } from "@playwright/test";

/**
 * Host-routing smoke tests for the Sparrow entry-point URLs (DL-0439).
 *
 * These tests target live production hosts and must NOT run on dev PRs.
 * They run in the dedicated playwright-prod-smoke CI job, which sets
 * SMOKE_PROD_CONNECT_URL and SMOKE_PROD_MAIN_URL.
 *
 * The guard for those two vars is a test.beforeAll inside the describe block,
 * NOT a module-level throw, and the distinction is load bearing. Playwright
 * imports every spec file to enumerate tests, so a module-level throw would
 * crash the regular `playwright` job, which loads this file and then excludes
 * it with --grep-invert. beforeAll runs only when this suite is selected: it
 * fails loudly in the prod-smoke job, which selects the file by path, and stays
 * correctly quiet in the dev-PR job, which deselects it.
 *
 * What the guard does NOT cover: a run where the suite is deselected AND the
 * vars are absent produces a skip, not a failure. That is the intended path
 * today, but it is the reason this comment states the scope exactly rather
 * than claiming a protection the code does not provide.
 *
 * WHAT THIS FILE GUARDS, AND WHY IT WAS REWRITTEN
 *
 * DL-0439's original criteria asserted a "Sparrow Wallet" h1 at both entry
 * URLs. DL-1007 then made /connect/sparrow and /connect/bitcoin redirect to
 * the /providers picker, because an earlier change had already moved those
 * setup flows inline into the picker and left the standalone pages as dead
 * ends. The two tickets therefore contradict each other, and the contradiction
 * stayed invisible because this file was failing for an unrelated reason at the
 * time (it read <title> before the router had set it, since fixed). Run
 * git log on this file for the changes referred to here; the repo is public,
 * so shipping code does not cite internal PR numbers.
 *
 * The heading string was never the point. DL-0439 exists because the Sparrow
 * entry points once served the MARKETING site instead of the app, on one host
 * but not the other. So the durable contract, restated independently of which
 * screen currently implements it:
 *
 *   1. Both entry URLs return HTTP 200 and render the APP, not marketing.
 *   2. From both entry URLs, a visitor can reach Sparrow setup.
 *   3. The two hosts behave identically to each other.
 *
 * Those hold before and after DL-1007. They are what is asserted below.
 *
 * WHY THIS NO LONGER TOLERATES TWO SHAPES
 *
 * This job always runs against LIVE production, including on pushes to dev, so
 * during a promotion the spec on dev is necessarily newer than the build it is
 * pointed at. While DL-1007 was in flight this file therefore accepted either
 * the old standalone Sparrow page or the inline picker, and asserted the
 * invariants above against whichever answered. Neither red would have meant a
 * defect.
 *
 * The promotion has landed and production serves the DL-1007 build, confirmed
 * in a browser on 2026-08-18: both entry URLs render the picker. The tolerance
 * is therefore removed, deliberately and not as cleanup. Keeping it would let
 * a regression back to the standalone page pass silently, which is the exact
 * failure this file exists to catch, and it also made the AC 2 assertion below
 * conditional, so the check that a customer can still reach Sparrow setup was
 * skipped on the very shape that would have needed it most.
 *
 * Full landing-page render assertions live in sparrow.spec.ts. This file only
 * guards host routing so a misdirected deploy is caught immediately.
 */

const CONNECT_HOST_URL = process.env.SMOKE_PROD_CONNECT_URL ?? "";
const MAIN_DOMAIN_URL = process.env.SMOKE_PROD_MAIN_URL ?? "";

/**
 * Strings whose presence in the page title indicates the marketing site was
 * served instead of the app. Case-insensitive check below.
 */
const MARKETING_TITLE_SIGNALS = ["The private finance app", "marketing"];

/**
 * The apex host serves its own marketing page at /providers, a public catalog
 * whose h1 reads "Every connection, in one catalog." It is NOT the app picker,
 * which renders an h1 of exactly "Providers".
 *
 * That distinction is the whole reason the picker match below is exact rather
 * than /providers/i. Both pages are built around the same word, and both carry
 * a search box over a long list of provider names, so a loose match would let
 * the marketing catalog satisfy a test whose entire purpose is to prove the
 * marketing site was NOT served. Matching loosely here would reintroduce the
 * original DL-0439 bug inside the guard against it.
 */
const APP_PICKER_H1 = /^Providers$/;
const MARKETING_CATALOG_H1 = /every connection, in one catalog/i;

/**
 * The h1 of the pre-DL-1007 standalone Sparrow page. It is no longer a
 * tolerated rendering at an entry URL, only something to assert the absence
 * of. Note that this same heading IS expected later, once the picker opens
 * Sparrow setup inline, which is why the absence check below is scoped to the
 * entry render and not applied for the whole test.
 */
const LEGACY_SPARROW_H1 = /sparrow wallet/i;

/**
 * Both hosts serve the same SPA shell, and that shell's static index.html
 * ships the marketing-flavoured default title. The per-route title is applied
 * by the client router after hydration, so a one-shot read of page.title()
 * races the router and sees the shell string instead of the route string.
 * Poll instead of sampling once: a genuinely misdirected deploy never settles
 * on an app title, so it still fails, just after the timeout rather than
 * instantly.
 *
 * LOAD-BEARING ORDERING. This is a negative assertion, so an empty or
 * not-yet-set title satisfies it on the very first tick. It only means
 * anything because the shape gate runs first and because the static shell
 * title genuinely carries a marketing signal, which is what gives the poll
 * something real to wait out. Always resolve the shape before calling this.
 * Reordering or dropping it makes this assertion vacuous while it keeps
 * passing, which is worse than a failure because nobody goes looking.
 */
async function assertAppTitle(page: Page, label: string): Promise<void> {
  for (const signal of MARKETING_TITLE_SIGNALS) {
    await expect
      .poll(() => page.title(), {
        message: `${label}: rendered <title> must not contain marketing signal "${signal}"`,
        timeout: 10_000,
      })
      .not.toMatch(new RegExp(signal, "i"));
  }
}

/**
 * Block the one false pass this spec is most exposed to.
 *
 * Under DL-1007 the entry URLs land on /providers, and on the apex host that
 * path also exists as a marketing page. A deploy that routed the apex entry
 * URL to the marketing site would drop the visitor somewhere that looks
 * broadly right and is not the app at all. Assert its absence explicitly
 * rather than leaning on the h1 match alone, so the failure names the cause.
 */
async function assertNotMarketingCatalog(page: Page, label: string): Promise<void> {
  await expect(
    page.getByRole("heading", { name: MARKETING_CATALOG_H1 }),
    `${label}: served the marketing /providers catalog instead of the app picker`,
  ).toHaveCount(0);
}

/**
 * Wait for the picker to render at an entry URL.
 *
 * Waits on the h1 rather than the URL, because the URL settles before the
 * render does and the question being asked is what the visitor actually sees.
 * Anything else times out here, which is the correct outcome: an unrecognised
 * render at a Sparrow entry point is exactly what this job exists to catch.
 *
 * The standalone-page check is a separate, explicit assertion rather than
 * being left implicit in the timeout. A regression that restored the old page
 * would fail either way, but only this way does the failure say so; a bare
 * timeout on the picker h1 reads like a slow deploy or a broken selector, and
 * that misreading costs a debugging cycle at exactly the wrong moment.
 */
async function assertPickerRendered(page: Page, label: string): Promise<void> {
  await expect(
    page.getByRole("heading", { name: APP_PICKER_H1, level: 1 }),
    `${label}: must render the app provider picker (h1 "Providers"). It did not, so ` +
      `this entry point is serving something else entirely.`,
  ).toBeVisible({ timeout: 15_000 });

  await expect(
    page.getByRole("heading", { name: LEGACY_SPARROW_H1, level: 1 }),
    `${label}: rendered the pre-DL-1007 standalone Sparrow page. The entry URL must ` +
      `redirect to the picker; this is a regression, not an old build.`,
  ).toHaveCount(0);
}

/**
 * AC 2, the part that actually matters to a customer: a Sparrow deep link
 * still ends at Sparrow setup.
 *
 * Under DL-1007 the entry URL no longer names Sparrow, so "the page loaded" is
 * no longer evidence of anything. Drive the search and the click, and require
 * the setup to open WITHOUT leaving the picker route, which is what "moved
 * inline into the picker" means. A marketing catalog entry navigates away or
 * opens an external link, so this doubles as a second, independent guard
 * against the marketing page.
 */
async function assertSparrowReachableInPicker(page: Page, label: string): Promise<void> {
  const pathBefore = new URL(page.url()).pathname;

  const search = page.locator('input[type="search"], input[placeholder*="earch" i]').first();
  await expect(
    search,
    `${label}: the picker must offer a search box, it is the only way to find one provider among many`,
  ).toBeVisible({ timeout: 10_000 });
  await search.fill("sparrow");

  const sparrowEntry = page
    .getByRole("button", { name: /sparrow/i })
    .or(page.getByRole("link", { name: /sparrow/i }))
    .first();
  await expect(
    sparrowEntry,
    `${label}: Sparrow must still be findable in the picker after the DL-1007 redirect`,
  ).toBeVisible({ timeout: 10_000 });
  await sparrowEntry.click();

  await expect(
    page.getByRole("heading", { name: /sparrow wallet/i }),
    `${label}: selecting Sparrow must open its setup step`,
  ).toBeVisible({ timeout: 10_000 });

  expect(
    new URL(page.url()).pathname,
    `${label}: Sparrow setup must open inline on the picker route, not navigate away`,
  ).toBe(pathBefore);
}

/**
 * Full contract for one entry URL. Returns the title so the parity test can
 * compare the two hosts on it.
 *
 * Shape is no longer returned because there is only one permitted shape now,
 * and assertPickerRendered has already failed the test if it is not the one
 * that arrived. Cross-host shape parity is therefore not dropped, it is
 * subsumed: two hosts that each individually proved they render the picker
 * cannot disagree.
 */
async function assertEntryPoint(page: Page, url: string): Promise<{ title: string }> {
  const res = await page.goto(url);
  expect(res?.status(), `${url} must return HTTP 200`).toBe(200);

  await assertPickerRendered(page, url);
  await assertNotMarketingCatalog(page, url);
  // Ordering is load-bearing: see assertAppTitle. The picker gate above is what
  // proves hydration finished, so the negative title assertion is not vacuous.
  await assertAppTitle(page, url);

  await assertSparrowReachableInPicker(page, url);

  return { title: await page.title() };
}

test.describe("Sparrow host-routing smoke (DL-0439)", () => {
  // beforeAll guard: fires only when tests in this describe block are selected.
  // --grep-invert in the regular smoke job excludes this suite at runtime so
  // this never executes there. The playwright-prod-smoke job sets both vars
  // before running this file directly, so the guard passes and tests run.
  test.beforeAll(() => {
    if (!CONNECT_HOST_URL || !MAIN_DOMAIN_URL) {
      throw new Error(
        "SMOKE_PROD_CONNECT_URL and SMOKE_PROD_MAIN_URL must both be set to run " +
          "these prod smoke tests. Run via the playwright-prod-smoke CI job, or " +
          "set both vars locally. A silent skip here would mean green CI with " +
          "zero prod assertions, which is the bug this guard exists to prevent.",
      );
    }
  });

  test("connect.orangerails.com/sparrow serves the app and reaches Sparrow setup", async ({
    page,
  }) => {
    await assertEntryPoint(page, CONNECT_HOST_URL);
  });

  test("orangerails.com/connect/sparrow behaves identically to connect.orangerails.com/sparrow", async ({
    page,
  }) => {
    const canonical = await assertEntryPoint(page, CONNECT_HOST_URL);
    const main = await assertEntryPoint(page, MAIN_DOMAIN_URL);

    // Rendering parity is now enforced inside assertEntryPoint: only one shape
    // is permitted, so each host proved it independently and they cannot
    // disagree. Title parity is the remaining cross-host signal, and it is not
    // redundant. A deploy that updated one host and not the other can still
    // ship two builds that both render a picker, which is exactly the
    // split-brain routing DL-0439 was opened for; the title is what tells them
    // apart.
    expect(
      main.title,
      `${MAIN_DOMAIN_URL} must serve the same rendered <title> as ${CONNECT_HOST_URL}`,
    ).toBe(canonical.title);
  });
});
