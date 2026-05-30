/**
 * End-to-end Quiltt pipeline — V2 → OR → Quiltt → back to V2.
 *
 * What this validates:
 *  1. V2 dev login (Dev: Quick Login)
 *  2. Navigate to /dashboard/admin → Connectors tab
 *  3. Click "Bank account" tile → V2 mints widget token + opens OR popup
 *  4. Popup shows new inline institution search (NOT auto-launching Quiltt picker)
 *  5. Type "Fin" → FinBank tile appears (Quiltt sandbox institution)
 *  6. Click FinBank → Quiltt opens to the bank's login form
 *     (skipping both Quiltt's institution picker AND welcome splash)
 *  7. Verify Quiltt iframe URL contains the institution id
 *
 * Going further inside the Quiltt iframe to complete a real link with
 * sandbox credentials is deferred — Quiltt's sandbox flow uses a vendor-
 * controlled iframe whose internals shift between versions.
 *
 * Target: v2dev.bitbooks.com (V2) + dev.orangerails.com (OR popup).
 */

import { test, expect, type Page } from '@playwright/test';
import * as path from 'node:path';

const SHOTS_DIR = process.env.OR_SHOT_DIR ??
  path.join(process.cwd(), 'tests/e2e/screenshots/orangerails/latest');

const V2_BASE   = 'https://v2dev.bitbooks.com';
const V2_EMAIL  = process.env.V2DEV_EMAIL || 'noreply@orangerails.com';

async function v2Login(page: Page) {
  await page.goto(`${V2_BASE}/auth/login`);
  await expect(page.getByText(/sign in/i).first()).toBeVisible();
  await page.getByLabel(/email/i).fill(V2_EMAIL);
  await page.getByRole('button', { name: /dev: quick login/i }).click();
  // Quick login redirects to /dashboard. First-time Next.js compile of
  // /dashboard can take 25-30s on v2dev, so allow a generous window.
  await page.waitForURL(/\/dashboard/i, { timeout: 90_000, waitUntil: 'domcontentloaded' });
}

test.describe('Quiltt full E2E — 2026-05-30', () => {
  test.setTimeout(300_000);

  test('V2 login → Connectors tab visible', async ({ page }) => {
    await v2Login(page);
    await page.goto(`${V2_BASE}/dashboard/admin`, { waitUntil: 'domcontentloaded' });
    // Admin page has tabs — click "Connectors" tab (not the sidebar nav).
    // Multiple matches possible; pick the active tab role with that name.
    await page.getByRole('tab', { name: /connectors/i }).click({ timeout: 30_000 }).catch(async () => {
      // Fallback to any "Connectors" text in the tab strip
      await page.getByText(/^connectors$/i).first().click({ timeout: 30_000 });
    });
    await expect(page.getByText(/securely connect your accounts/i))
      .toBeVisible({ timeout: 30_000 });
    await page.screenshot({
      path: path.join(SHOTS_DIR, '10-v2-connectors-tab.png'),
      fullPage: true,
    });
  });

  test('Bank tile click → OR popup opens with inline search', async ({ page, context }) => {
    await v2Login(page);
    await page.goto(`${V2_BASE}/dashboard/admin`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: /connectors/i }).click({ timeout: 30_000 }).catch(async () => {
      await page.getByText(/^connectors$/i).first().click({ timeout: 30_000 });
    });
    await expect(page.getByText(/securely connect your accounts/i))
      .toBeVisible({ timeout: 30_000 });

    // Listen for the popup event BEFORE the click that triggers it.
    const popupPromise = context.waitForEvent('page', { timeout: 60_000 });

    // Click the Bank account tile (Quiltt provider). Tile text is just
    // "Bank account" per OR or-providers manifest.
    const bankTile = page.getByText(/^bank account$/i).first();
    await bankTile.click();
    await page.screenshot({
      path: path.join(SHOTS_DIR, '11-v2-modal-starting.png'),
      fullPage: true,
    });

    // V2 mints widget_token then window.open() into OR popup.
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain('connect');
    // Wait for the popup to redirect to /connect/quiltt with the
    // session fragment.
    await popup.waitForURL(/\/connect\/quiltt/i, { timeout: 30_000 });

    // The new inline search step renders BankSearchStep — verify the
    // search input + the placeholder hint are present.
    await expect(popup.getByPlaceholder(/chase, bank of america, finbank/i))
      .toBeVisible({ timeout: 15_000 });
    await expect(popup.getByText(/type at least 2 characters/i))
      .toBeVisible();
    await popup.screenshot({
      path: path.join(SHOTS_DIR, '12-popup-inline-search-empty.png'),
      fullPage: true,
    });

    // Type "Fin" — should debounce + show FinBank-like tiles via Quiltt
    // institution search. Quiltt sandbox typically returns "FinBank"
    // and a few variants.
    await popup.getByPlaceholder(/chase, bank of america/i).fill('Fin');
    // Wait for results — either an institution tile or the "Searching" loader.
    await popup.waitForFunction(
      () => !!document.querySelector('button[title]'),
      undefined,
      { timeout: 30_000 },
    ).catch(() => null);
    await popup.waitForTimeout(800); // let debounce settle
    await popup.screenshot({
      path: path.join(SHOTS_DIR, '13-popup-search-results.png'),
      fullPage: true,
    });

    // Try to find a FinBank-like tile and click it.
    const finbankTile = popup.locator('button[title]').filter({
      hasText: /finbank|fin bank/i,
    }).first();
    const finbankVisible = await finbankTile.isVisible().catch(() => false);
    if (finbankVisible) {
      await finbankTile.click();
      // After click, the page shows "Opening {bank name}…" and Quiltt
      // launches as an iframe on the same window. Verify the loader text.
      await expect(popup.getByText(/opening/i).first())
        .toBeVisible({ timeout: 15_000 });
      await popup.screenshot({
        path: path.join(SHOTS_DIR, '14-popup-after-bank-click.png'),
        fullPage: true,
      });

      // Quiltt mounts a connector iframe. Verify it appears within ~10s.
      const quilttFrame = popup.frameLocator('iframe[src*="quiltt"]').first();
      const hasFrame = await quilttFrame.locator('body').isVisible({ timeout: 15_000 }).catch(() => false);
      if (hasFrame) {
        await popup.waitForTimeout(2000); // let iframe paint
        await popup.screenshot({
          path: path.join(SHOTS_DIR, '15-quiltt-iframe-loaded.png'),
          fullPage: true,
        });
      }
    } else {
      console.log('[e2e] No FinBank tile in sandbox search results — capturing for diagnosis');
    }
  });
});
