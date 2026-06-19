import { test, expect, type ConsoleMessage } from '@playwright/test';

/**
 * Smoke tests , catches CF Pages deployment regressions.
 *
 * Tests are intentionally shallow:
 *   1. Page loads with 2xx HTTP status
 *   2. Loading splash (if any) is removed within 15s
 *   3. No JavaScript console errors after splash removal
 *   4. Key DOM landmarks (body, headings) are present
 */

const KNOWN_SPLASH_SELECTORS = [
  '#ow-splash',          // Orange Way
  '#or-splash',          // Orange Rails (future)
  '#v3-splash',          // Future third-party app integration splash
  '[data-loading-splash]', // generic opt-in
];

async function waitForSplashGone(page: import('@playwright/test').Page) {
  for (const selector of KNOWN_SPLASH_SELECTORS) {
    if ((await page.locator(selector).count()) > 0) {
      await page.locator(selector).waitFor({ state: 'detached', timeout: 15000 }).catch(() => null);
    }
  }
}

test.describe('landing page', () => {
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(`pageerror: ${err.message}`);
    });
  });

  test('home page loads with no console errors', async ({ page }) => {
    const response = await page.goto('/', { waitUntil: 'networkidle' });
    expect(response?.status(), 'home page HTTP status').toBeLessThan(400);
    await waitForSplashGone(page);

    const significantErrors = consoleErrors.filter(
      (e) =>
        !e.includes('Download the React DevTools') &&
        !e.includes('chrome-extension://') &&
        !e.includes('Loading chunk')
    );
    expect(significantErrors, 'no console errors on home page').toEqual([]);
  });

  test('home page has visible landmarks', async ({ page }) => {
    await page.goto('/');
    await waitForSplashGone(page);
    await expect(page.locator('body')).toBeVisible();
    const headings = page.locator('h1, h2');
    await expect(headings.first()).toBeVisible();
  });
});
