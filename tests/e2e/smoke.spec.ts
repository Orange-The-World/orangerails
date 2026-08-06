import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * Host-routing smoke tests for the Sparrow entry-point URLs (DL-0439).
 *
 * Both URLs are absolute so these tests always target the live production
 * hosts, independent of PLAYWRIGHT_BASE_URL. They exist to catch the class
 * of regression where the marketing site is served instead of the app at
 * either customer entry point.
 *
 * Acceptance criteria (QA, DL-0439):
 *   1. GET https://connect.orangerails.com/sparrow
 *      - HTTP 200
 *      - <title> does NOT contain "marketing" or "The private finance app"
 *      - Sparrow h1 heading is visible in the rendered page
 *   2. GET https://orangerails.com/connect/sparrow
 *      - HTTP 200
 *      - Same title as (1): both hosts must be consistent
 *      - Sparrow h1 heading is visible in the rendered page
 *
 * Full landing-page render assertions live in sparrow.spec.ts. This file
 * only guards host routing so a misdirected deploy is caught immediately.
 */

const CONNECT_HOST_URL = "https://connect.orangerails.com/sparrow";
const MAIN_DOMAIN_URL = "https://orangerails.com/connect/sparrow";

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

async function assertHttp200(
  request: APIRequestContext,
  url: string,
): Promise<void> {
  const res = await request.get(url);
  expect(res.status(), `${url} must return HTTP 200`).toBe(200);
}

test.describe("Sparrow host-routing smoke (DL-0439)", () => {
  test(
    "connect.orangerails.com/sparrow serves the app, not the marketing site",
    async ({ request, page }) => {
      await assertHttp200(request, CONNECT_HOST_URL);
      await page.goto(CONNECT_HOST_URL);
      await assertAppTitle(await page.title(), CONNECT_HOST_URL);
      await assertSparrowHeading(page);
    },
  );

  test(
    "orangerails.com/connect/sparrow serves the same app as connect.orangerails.com/sparrow",
    async ({ request, page }) => {
      // Capture canonical title first so we can assert parity.
      const canonicalRes = await request.get(CONNECT_HOST_URL);
      const canonicalHtml = await canonicalRes.text();
      const canonicalTitleMatch = /<title>([^<]*)<\/title>/i.exec(canonicalHtml);
      const canonicalTitle = canonicalTitleMatch ? canonicalTitleMatch[1] : null;

      await assertHttp200(request, MAIN_DOMAIN_URL);
      await page.goto(MAIN_DOMAIN_URL);

      const title = await page.title();
      await assertAppTitle(title, MAIN_DOMAIN_URL);

      if (canonicalTitle) {
        expect(
          title,
          "orangerails.com/connect/sparrow must serve the same <title> as connect.orangerails.com/sparrow",
        ).toBe(canonicalTitle);
      }

      await assertSparrowHeading(page);
    },
  );
});
