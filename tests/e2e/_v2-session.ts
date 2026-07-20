/**
 * Shared V2 session helpers for Orange Rails Playwright tests.
 *
 * Provides login, navigation, and vault-password injection so each spec
 * can focus on the connector under test rather than boilerplate.
 *
 * Required env vars for vault-locked providers (Blink, Strike, xpub):
 *   V2_TEST_BASE_URL     V2 dev base URL (default: https://v2dev.example.com)
 *   V2DEV_EMAIL          V2 dev account email
 *   V2DEV_VAULT_PASSWORD Vault password for MEK derivation in the OR popup
 *
 * Usage pattern:
 *   import { v2Login, gotoConnectorsTab, v2FillVaultPassword } from './_v2-session';
 *
 *   test.skip(!process.env.V2DEV_VAULT_PASSWORD, 'Requires V2DEV_VAULT_PASSWORD env var.');
 *   await v2Login(page);
 *   await gotoConnectorsTab(page);
 *   const popup = await context.waitForEvent('page', { timeout: 90_000 });
 *   // click the connector tile...
 *   await popup.waitForURL(/\/connect/i, { waitUntil: 'domcontentloaded' });
 *   // fill the provider credential field(s)...
 *   await v2FillVaultPassword(popup, process.env.V2DEV_VAULT_PASSWORD!);
 *   // click Save / Connect...
 */

import { expect, type Page } from '@playwright/test';

export const V2_BASE  = process.env.V2_TEST_BASE_URL ?? 'https://v2dev.example.com';
export const V2_EMAIL = process.env.V2DEV_EMAIL       ?? 'test@example.com';

/**
 * Log in to V2 using the Dev: Quick Login button.
 *
 * Sets the email field and clicks the dev-only quick-login shortcut.
 * Waits for the auth callback and for the SPA to land on /dashboard
 * before returning.
 */
export async function v2Login(page: Page): Promise<void> {
  await page.goto(`${V2_BASE}/auth/login`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/sign in/i).first()).toBeVisible({ timeout: 30_000 });

  const emailInput = page.locator('input[type="email"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 10_000 });
  await emailInput.click();
  await emailInput.pressSequentially(V2_EMAIL, { delay: 20 });
  await emailInput.press('Tab');
  await expect(emailInput).toHaveValue(V2_EMAIL);

  await page.getByRole('button', { name: /dev: quick login/i }).click();
  await page.waitForResponse(
    (resp) => resp.url().includes('/api/auth/sign-in/email') && resp.status() < 400,
    { timeout: 60_000 },
  );
  await page.waitForURL(/\/dashboard/i, { timeout: 120_000, waitUntil: 'domcontentloaded' });
}

/**
 * Navigate to the Connectors tab in the V2 admin dashboard.
 * Assumes the page is already logged in via v2Login().
 *
 * Uses the ?tab=connectors query param, which V2 honours to skip the
 * manual tab click (more reliable under Playwright).
 */
export async function gotoConnectorsTab(page: Page): Promise<void> {
  await page.goto(
    `${V2_BASE}/dashboard/admin?tab=connectors`,
    { waitUntil: 'domcontentloaded' },
  );
  await expect(page.getByText(/securely connect your accounts/i))
    .toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/loading providers/i))
    .toBeHidden({ timeout: 60_000 });
}

/**
 * Fill the inline vault password field inside the OR connect popup.
 *
 * When V2 opens the OR widget with defer_cred_key=1, the popup renders
 * an extra "Vault password" input alongside the provider credential form
 * (connect.tsx line 1609). The user types their vault password there; when
 * they click Save the popup forwards it to V2 via postMessage so V2 can
 * derive the cred_key without showing a separate modal.
 *
 * This helper locates that field by its placeholder and fills it from the
 * supplied string, automating the otherwise-interactive vault unlock step.
 *
 * Call AFTER the popup has reached the credential-entry step but BEFORE
 * clicking Save / Connect.
 */
export async function v2FillVaultPassword(popup: Page, password: string): Promise<void> {
  const vpInput = popup.getByPlaceholder('Vault password');
  await vpInput.waitFor({ state: 'visible', timeout: 30_000 });
  await vpInput.click();
  await vpInput.pressSequentially(password, { delay: 15 });
}
