import { test, expect } from '@playwright/test';

/**
 * Post-#112 regression: the Strike step in the connect widget should
 * carry the "A note on Strike's API" tooltip and the API-key help link
 * should point at the dashboard root (no more /developer/api-keys 404).
 *
 * Run target: dev.orangerails.com.
 */

const CONNECT_URL =
  '/connect?platform=bitbooks-v2&app_user_id=pw-strike-tooltip&provider=strike&return_to=https%3A%2F%2Fexample.com';

test('Strike step renders the API-note tooltip + sends users to dashboard root', async ({ page }, testInfo) => {
  page.on('pageerror', (err) => {
    throw new Error(`runtime console error: ${err.message}`);
  });

  await page.goto(CONNECT_URL, { waitUntil: 'networkidle' });

  // Heading should label this as the Strike step.
  await expect(page.getByText(/Connect your Strike account/i)).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath('01-strike-step-loaded.png'),
    fullPage: true,
  });

  // Help link below the API key field — must point at dashboard ROOT,
  // never the broken /developer/api-keys path.
  const helpLink = page.getByRole('link', { name: /dashboard\.strike\.me/i });
  await expect(helpLink).toBeVisible();
  const href = await helpLink.getAttribute('href');
  expect(href).toBe('https://dashboard.strike.me/');
  expect(href).not.toContain('/developer/api-keys');

  // Info icon next to the heading opens the tooltip on hover.
  const infoIcon = page.getByRole('button', { name: /About Strike's API/i });
  await expect(infoIcon).toBeVisible();
  await infoIcon.hover();
  // Radix renders the tooltip content twice (visible + a11y mirror). `.first()`
  // selects the visible one. All four key strings should appear.
  await expect(page.getByText(/A note on Strike's API/i).first()).toBeVisible({ timeout: 3000 });
  await expect(
    page.getByText(/Strike's public API does not expose a full transaction history/i).first(),
  ).toBeVisible();
  await expect(page.getByText(/Going forward:/i).first()).toBeVisible();
  await expect(page.getByText(/The past:/i).first()).toBeVisible();

  await page.screenshot({
    path: testInfo.outputPath('02-strike-tooltip-open.png'),
    fullPage: true,
  });
});

test('Strike step on mobile viewport still surfaces the tooltip trigger', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(CONNECT_URL, { waitUntil: 'networkidle' });
  await expect(page.getByText(/Connect your Strike account/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /About Strike's API/i })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('03-strike-step-mobile.png'),
    fullPage: true,
  });
});
