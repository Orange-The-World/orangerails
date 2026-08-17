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
 * Acceptance criteria (QA, DL-0439):
 *   1. GET https://connect.orangerails.com/sparrow
 *      - HTTP 200
 *      - rendered <title> does NOT contain "marketing" or "The private finance app"
 *      - Sparrow h1 heading is visible in the rendered page
 *   2. GET https://orangerails.com/connect/sparrow
 *      - HTTP 200
 *      - Same rendered title as (1): both hosts must be consistent
 *      - Sparrow h1 heading is visible in the rendered page
 *
 * Full landing-page render assertions live in sparrow.spec.ts. This file
 * only guards host routing so a misdirected deploy is caught immediately.
 */

const CONNECT_HOST_URL = process.env.SMOKE_PROD_CONNECT_URL ?? "";
const MAIN_DOMAIN_URL = process.env.SMOKE_PROD_MAIN_URL ?? "";


/**
 * Strings whose presence in the page title indicates the marketing site was
 * served instead of the app. Case-insensitive check below.
 */
const MARKETING_TITLE_SIGNALS = ["The private finance app", "marketing"];

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
 * anything because assertSparrowHeading() runs first and because the static
 * shell title genuinely carries a marketing signal, which is what gives the
 * poll something real to wait out. Always call the heading gate before this.
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

async function assertSparrowHeading(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: /sparrow wallet/i, level: 1 }),
    "Sparrow h1 heading must be visible (not a marketing or error page)",
  ).toBeVisible({ timeout: 10_000 });
}

/**
 * Read the title only once the route has fully settled. Polls until the title
 * is no longer a marketing-signal value, proving both that the heading is
 * visible AND that the title effect has flushed. A one-shot read after the
 * heading becomes visible still races the title effect; polling closes that gap.
 */
async function renderedTitle(page: Page): Promise<string> {
  await assertSparrowHeading(page);
  let settled = "";
  await expect
    .poll(
      async () => {
        const t = await page.title();
        const isShell = MARKETING_TITLE_SIGNALS.some((s) =>
          new RegExp(s, "i").test(t),
        );
        if (!isShell) settled = t;
        return isShell;
      },
      {
        message:
          "rendered <title> must settle to a non-marketing value after hydration",
        timeout: 10_000,
      },
    )
    .toBe(false);
  return settled;
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

  test(
    "connect.orangerails.com/sparrow serves the app, not the marketing site",
    async ({ page }) => {
      const res = await page.goto(CONNECT_HOST_URL);
      expect(res?.status(), `${CONNECT_HOST_URL} must return HTTP 200`).toBe(200);
      await assertSparrowHeading(page);
      await assertAppTitle(page, CONNECT_HOST_URL);
    },
  );

  test(
    "orangerails.com/connect/sparrow serves the same app as connect.orangerails.com/sparrow",
    async ({ page }) => {
      // Navigate to the canonical URL and capture the client-side-rendered
      // title. A raw request.get() returns the static SPA shell before any
      // route title is set, so the regex extraction always returns null and
      // the parity check silently does nothing. renderedTitle() waits for the
      // Sparrow heading first, which is the observable proof that the client
      // router has taken over and applied the per-route title.
      const canonicalRes = await page.goto(CONNECT_HOST_URL);
      expect(
        canonicalRes?.status(),
        `${CONNECT_HOST_URL} must return HTTP 200`,
      ).toBe(200);
      // renderedTitle() polls until the title is no longer a marketing value,
      // proving hydration completed on the canonical host. assertAppTitle then
      // validates the settled title, so a canonical host stuck on the shell
      // still fails rather than seeding a bogus canonicalTitle.
      const canonicalTitle = await renderedTitle(page);
      await assertAppTitle(page, CONNECT_HOST_URL);

      // Check the main-domain URL.
      const mainRes = await page.goto(MAIN_DOMAIN_URL);
      expect(
        mainRes?.status(),
        `${MAIN_DOMAIN_URL} must return HTTP 200`,
      ).toBe(200);
      // AC 2 requires the Sparrow h1 to be visible on this host too, not just
      // on the canonical one. It is also the gate that keeps the assertAppTitle
      // call below from being satisfied by an empty title on the first tick.
      await assertSparrowHeading(page);
      await assertAppTitle(page, MAIN_DOMAIN_URL);
      // Poll until the main-domain title matches the canonical. Comparing two
      // captured strings could pass if both reads sampled the shell; polling
      // here closes that gap.
      await expect
        .poll(() => page.title(), {
          message:
            "orangerails.com/connect/sparrow must serve the same rendered <title> as connect.orangerails.com/sparrow",
          timeout: 10_000,
        })
        .toBe(canonicalTitle);
    },
  );
});
