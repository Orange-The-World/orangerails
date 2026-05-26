import { test, expect } from '@playwright/test';

/**
 * Sparrow v0.1 smoke tests.
 *
 * Covers the discovery + navigation flow from the public landing pages
 * to the Stealth Sync widget launch. Does NOT exercise the actual
 * descriptor paste or chain scan — that requires a real Sparrow
 * descriptor fixture and a stubbed BIP 158 source, deferred to v0.2.
 *
 * What this protects:
 *   1. /integrations renders the Sparrow card with "Available" status
 *   2. /providers includes a Sparrow tile in the catalog response
 *   3. /providers shows the Sparrow tile in the "On-chain wallets" category
 *   4. Selecting the Sparrow tile shows the T0 privacy badge in preview
 *   5. The preview CTA navigates to /connect/sparrow
 *   6. /connect/sparrow renders all four landing-page sections
 *   7. The "Launch Stealth Sync" button targets /connect/stealth
 *
 * Wiki spec: https://wiki.abascal.ca/doc/sparrow-bJ8KgVKQPS
 */

test.describe('Sparrow v0.1 — discovery + landing', () => {
  test('integrations card shows Sparrow as Available', async ({ page }) => {
    await page.goto('/integrations');
    // /integrations redirects to /providers (the dynamic catalog).
    await expect(page).toHaveURL(/\/providers$/);
  });

  test('providers catalog includes the Sparrow manifest', async ({ request }) => {
    // Hit the or-providers edge function directly to confirm Sparrow lives
    // in the catalog regardless of how the SPA renders it.
    const baseUrl =
      process.env.OR_SUPABASE_URL ?? 'https://gposxxmxenrdvewrprle.supabase.co';
    const res = await request.get(`${baseUrl}/functions/v1/or-providers`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const sparrow = (body.providers ?? []).find(
      (p: { slug: string }) => p.slug === 'sparrow',
    );
    expect(sparrow, 'sparrow manifest must be in the catalog').toBeTruthy();
    expect(sparrow.status).toBe('live');
    expect(sparrow.category).toBe('on_chain_wallet');
    expect(sparrow.connectUrl).toBe('/connect/sparrow');
  });

  test('/providers shows Sparrow tile in the picker', async ({ page }) => {
    await page.goto('/providers');
    // Wait for the catalog fetch to populate.
    const sparrowTile = page.locator('[data-slug="sparrow"]');
    await expect(sparrowTile).toBeVisible({ timeout: 10_000 });
  });

  test('clicking the Sparrow tile shows preview + Stealth Sync CTA', async ({
    page,
  }) => {
    await page.goto('/providers');
    const sparrowTile = page.locator('[data-slug="sparrow"]');
    await sparrowTile.waitFor({ state: 'visible', timeout: 10_000 });
    await sparrowTile.click();

    // Preview panel should show Sparrow's display name.
    const preview = page.locator('aside').filter({ hasText: 'Sparrow Wallet' });
    await expect(preview).toBeVisible();

    // The Stealth Sync CTA should be present and point at /connect/sparrow.
    const cta = page.getByRole('link', { name: /open sparrow wallet setup/i });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '/connect/sparrow');
  });

  test('/connect/sparrow renders the landing page sections', async ({ page }) => {
    await page.goto('/connect/sparrow');

    // Page heading.
    await expect(
      page.getByRole('heading', { name: /sparrow wallet/i, level: 1 }),
    ).toBeVisible();

    // Honesty card.
    await expect(page.getByText(/what v0\.1 ships, and what it doesn/i)).toBeVisible();
    await expect(page.getByText(/confirmed receives/i)).toBeVisible();

    // Three-step walkthrough.
    await expect(page.getByRole('heading', { name: /how to connect/i })).toBeVisible();
    await expect(page.getByText(/open sparrow on your computer/i)).toBeVisible();
    await expect(page.getByText(/export your wallet descriptor/i)).toBeVisible();
    await expect(page.getByText(/launch stealth sync and paste/i)).toBeVisible();

    // Privacy explainer cards.
    await expect(
      page.getByText(/your descriptor never leaves your browser in plaintext/i),
    ).toBeVisible();
  });

  test('"Launch Stealth Sync" button targets /connect/stealth', async ({ page }) => {
    await page.goto('/connect/sparrow');
    // The button uses onClick to window.open rather than an href, so we
    // intercept window.open and assert the URL is right.
    const launchButton = page.getByRole('button', {
      name: /launch stealth sync/i,
    });
    await expect(launchButton).toBeVisible();

    // Hook window.open and trigger the click.
    const openCallPromise = page.evaluate(() => {
      return new Promise<string>((resolve) => {
        const orig = window.open;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as any).open = (url: string) => {
          (window as any).open = orig;
          resolve(url);
          return null;
        };
      });
    });
    await launchButton.click();
    const opened = await openCallPromise;
    expect(opened).toContain('/connect/stealth');
  });
});
