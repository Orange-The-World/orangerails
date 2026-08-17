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
 * Read the title only once the route has actually rendered. Every title
 * comparison in this file must go through here, otherwise it compares shell
 * titles and passes for the wrong reason.
 */
async function renderedTitle(page: Page): Promise<string> {
  await assertSparrowHeading(page);
  return page.title();
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
      const canonicalTitle = await renderedTitle(page);
      expect(
        canonicalTitle,
        "connect.orangerails.com/sparrow must set a non-empty rendered <title>",
      ).toBeTruthy();

      // Check the main-domain URL.
      const mainRes = await page.goto(MAIN_DOMAIN_URL);
      expect(
        mainRes?.status(),
        `${MAIN_DOMAIN_URL} must return HTTP 200`,
      ).toBe(200);
      const title = await renderedTitle(page);
      await assertAppTitle(page, MAIN_DOMAIN_URL);
      expect(
        title,
        "orangerails.com/connect/sparrow must serve the same rendered <title> as connect.orangerails.com/sparrow",
      ).toBe(canonicalTitle);
    },
  );
});
