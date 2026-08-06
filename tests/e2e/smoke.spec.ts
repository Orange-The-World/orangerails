import { test, expect, type Page } from "@playwright/test";

/**
 * Host-routing smoke tests for the Sparrow entry-point URLs (DL-0439).
 *
 * These tests target live production hosts and must NOT run on dev PRs.
 * Set SMOKE_PROD_CONNECT_URL and SMOKE_PROD_MAIN_URL in a dedicated
 * prod-smoke workflow (or scheduled run) to enable them.
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

async function assertAppTitle(title: string, label: string): Promise<void> {
  for (const signal of MARKETING_TITLE_SIGNALS) {
    expect(
      title,
      `${label}: <title> must not contain marketing signal "${signal}"`,
    ).not.toMatch(new RegExp(signal, "i"));
  }
}

async function assertSparrowHeading(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: /sparrow wallet/i, level: 1 }),
    "Sparrow h1 heading must be visible (not a marketing or error page)",
  ).toBeVisible({ timeout: 10_000 });
}

test.describe("Sparrow host-routing smoke (DL-0439)", () => {
  test.skip(
    !CONNECT_HOST_URL || !MAIN_DOMAIN_URL,
    "SMOKE_PROD_CONNECT_URL and SMOKE_PROD_MAIN_URL must be set to run " +
      "prod smoke tests. These tests target live production hosts and must " +
      "not run on dev PRs; enable them in a dedicated prod-smoke workflow.",
  );

  test(
    "connect.orangerails.com/sparrow serves the app, not the marketing site",
    async ({ page }) => {
      const res = await page.goto(CONNECT_HOST_URL);
      expect(res?.status(), `${CONNECT_HOST_URL} must return HTTP 200`).toBe(200);
      await assertAppTitle(await page.title(), CONNECT_HOST_URL);
      await assertSparrowHeading(page);
    },
  );

  test(
    "orangerails.com/connect/sparrow serves the same app as connect.orangerails.com/sparrow",
    async ({ page }) => {
      // Navigate to the canonical URL and capture the client-side-rendered
      // title. A raw request.get() returns the static SPA shell before any
      // route title is set, so the regex extraction always returns null and
      // the parity check silently does nothing. page.goto() waits for the
      // route to fully render.
      const canonicalRes = await page.goto(CONNECT_HOST_URL);
      expect(
        canonicalRes?.status(),
        `${CONNECT_HOST_URL} must return HTTP 200`,
      ).toBe(200);
      const canonicalTitle = await page.title();
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
      const title = await page.title();
      await assertAppTitle(title, MAIN_DOMAIN_URL);
      expect(
        title,
        "orangerails.com/connect/sparrow must serve the same rendered <title> as connect.orangerails.com/sparrow",
      ).toBe(canonicalTitle);
      await assertSparrowHeading(page);
    },
  );
});

