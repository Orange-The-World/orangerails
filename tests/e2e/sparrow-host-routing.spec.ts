import { test, expect, type Page } from "@playwright/test";

/**
 * Host-routing smoke tests for the Sparrow entry-point URLs (DL-0439).
 *
 * These tests target live production hosts and must NOT run on dev PRs.
 * They run in the dedicated playwright-prod-smoke CI job, which sets
 * SMOKE_PROD_CONNECT_URL and SMOKE_PROD_MAIN_URL. The module-level guard
 * below throws at eval time when either var is absent, so a run without
 * the vars is a loud failure, not a silent skip.
 *
 * WHAT THIS FILE GUARDS, AND WHY IT WAS REWRITTEN
 *
 * DL-0439's original criteria asserted a "Sparrow Wallet" h1 at both entry
 * URLs. DL-1007 then made /connect/sparrow and /connect/bitcoin redirect to
 * the /providers picker, because PR #721 had already moved those setup flows
 * inline into the picker and left the standalone pages as dead ends. The two
 * tickets therefore contradict each other, and the contradiction stayed
 * invisible because this file was failing for an unrelated reason at the time
 * (it read <title> before the router had set it, fixed in PR #750).
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
 * TRANSITIONAL, REMOVE AFTER THE NEXT PROD DEPLOY
 *
 * This job always runs against LIVE production, including on pushes to dev.
 * During a promotion the spec on dev is therefore necessarily newer than the
 * build it is pointed at: asserting only the new shape goes red on every dev
 * push until prod redeploys, and asserting only the old shape goes red the
 * moment it does. Neither red would indicate a defect.
 *
 * So both known-good shapes are accepted, and the invariants above are
 * asserted against whichever one answers. Once prod serves the DL-1007 build,
 * the LEGACY_STANDALONE branch is dead code and should be deleted. Leaving it
 * in permanently would weaken the check, because a regression back to the
 * standalone page would then pass silently.
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

/** The two renderings this spec tolerates. See the transitional note above. */
type EntryShape = "LEGACY_STANDALONE" | "PICKER_INLINE";

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
 * Wait for either known-good rendering and report which one arrived.
 *
 * Races the two h1s rather than branching on the URL, because the URL settles
 * before the render does and the question being asked is what the visitor
 * actually sees. A page that is neither shape times out here, which is the
 * correct outcome: an unrecognised render at a Sparrow entry point is exactly
 * what this job exists to catch.
 */
async function resolveEntryShape(page: Page, label: string): Promise<EntryShape> {
  const sparrowH1 = page.getByRole("heading", {
    name: /sparrow wallet/i,
    level: 1,
  });
  const pickerH1 = page.getByRole("heading", { name: APP_PICKER_H1, level: 1 });

  await expect
    .poll(
      async () => {
        if (await sparrowH1.isVisible().catch(() => false)) {
          return "LEGACY_STANDALONE";
        }
        if (await pickerH1.isVisible().catch(() => false)) {
          return "PICKER_INLINE";
        }
        return "NEITHER";
      },
      {
        message:
          `${label}: must render either the standalone Sparrow page (h1 "Sparrow Wallet") ` +
          `or the app provider picker (h1 "Providers"). Neither appeared, so this entry ` +
          `point is serving something else entirely.`,
        timeout: 15_000,
      },
    )
    .not.toBe("NEITHER");

  return (await sparrowH1.isVisible().catch(() => false)) ? "LEGACY_STANDALONE" : "PICKER_INLINE";
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
 * Full contract for one entry URL. Returns the settled shape and title so the
 * parity test can compare the two hosts on both.
 */
async function assertEntryPoint(
  page: Page,
  url: string,
): Promise<{ shape: EntryShape; title: string }> {
  const res = await page.goto(url);
  expect(res?.status(), `${url} must return HTTP 200`).toBe(200);

  const shape = await resolveEntryShape(page, url);
  await assertNotMarketingCatalog(page, url);
  // Ordering is load-bearing: see assertAppTitle. The shape gate above is what
  // proves hydration finished, so the negative title assertion is not vacuous.
  await assertAppTitle(page, url);

  if (shape === "PICKER_INLINE") {
    await assertSparrowReachableInPicker(page, url);
  }

  return { shape, title: await page.title() };
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

    // Same rendering, not merely "both are valid renderings". A deploy that
    // updated one host and not the other would satisfy every assertion above
    // on each host individually while leaving exactly the split-brain routing
    // DL-0439 was opened for. This is the assertion that catches that.
    expect(
      main.shape,
      `${MAIN_DOMAIN_URL} rendered ${main.shape} while ${CONNECT_HOST_URL} rendered ${canonical.shape}. ` +
        `The two hosts are serving different builds.`,
    ).toBe(canonical.shape);

    expect(
      main.title,
      `${MAIN_DOMAIN_URL} must serve the same rendered <title> as ${CONNECT_HOST_URL}`,
    ).toBe(canonical.title);
  });
});
