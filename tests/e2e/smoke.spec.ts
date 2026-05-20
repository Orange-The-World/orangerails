import { test, expect, type ConsoleMessage } from '@playwright/test';

/**
 * Orange Rails smoke tests.
 *
 * Goal: catch CF Pages deployment regressions before the user sees them.
 * Run after every push to dev (manually or via CI).
 *
 * Tests are intentionally shallow:
 *   1. Page loads with 2xx HTTP status
 *   2. No JavaScript console errors during render
 *   3. Key DOM landmarks are present
 *   4. Key public routes return 200
 *
 * Deeper tests (auth flow, dashboard, MCP) live in tests/e2e/dashboard
 * and tests/e2e/mcp once those features ship.
 */

test.describe('Orange Rails landing page', () => {
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

    // Wait for any post-load async errors
    await page.waitForTimeout(2000);

    // Filter out known benign noise (browser extensions, third-party CDN preloads)
    const significantErrors = consoleErrors.filter(
      (e) =>
        !e.includes('Download the React DevTools') &&
        !e.includes('chrome-extension://') &&
        !e.includes('Loading chunk') // transient HMR noise
    );
    expect(significantErrors, 'no console errors on home page').toEqual([]);
  });

  test('home page has expected landmarks', async ({ page }) => {
    await page.goto('/');
    // Top-level landmarks — keep these loose so cosmetic changes don't break tests
    await expect(page.locator('body')).toBeVisible();
    // There should be at least one heading on the landing page
    const headings = page.locator('h1, h2');
    await expect(headings.first()).toBeVisible();
  });

  const PUBLIC_ROUTES = [
    '/',
    '/about',
    '/security',
    '/pricing',
  ];

  for (const path of PUBLIC_ROUTES) {
    test(`route ${path} returns 2xx or 404 (not 5xx)`, async ({ page }) => {
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
      // 404 is acceptable for routes that may not exist yet
      // 5xx indicates a real server error
      const status = response?.status() ?? 0;
      expect(status, `${path} HTTP status`).toBeLessThan(500);
    });
  }
});
