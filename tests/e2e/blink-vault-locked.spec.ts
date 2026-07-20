// blink-vault-locked.spec.ts
// Blink connector: Add Connection happy path and vault-locked sync behavior.
//
// C-1003: proves that when the vault is locked a sync attempt surfaces a
// visible error, does not advance the last-synced timestamp, and leaves
// the connection flagged stale or error rather than healthy.
//
// Run via the V2 Playwright wrapper on the runner host.
// Required env vars: BLINK_KEY, VAULT_EMAIL, VAULT_PASSWORD, VAULT_VAULT_PASSWORD
// These are injected at call time by the wrapper -- never hardcoded here.

import { test, expect } from '@playwright/test';

// ---- env (injected by run wrapper, never hardcoded) ----
const BLINK_KEY       = process.env.BLINK_KEY           ?? '';
const VAULT_EMAIL     = process.env.VAULT_EMAIL         ?? '';
const VAULT_PASSWORD  = process.env.VAULT_PASSWORD      ?? '';
const VAULT_VAULT_PWD = process.env.VAULT_VAULT_PASSWORD ?? '';

test.describe('Blink connector -- happy path and vault-locked behavior', () => {
  // Needs real vault credentials not present in CI. Run via the V2 wrapper.
  test.skip(
    !process.env.BLINK_KEY,
    'Requires BLINK_KEY, VAULT_EMAIL, VAULT_PASSWORD, VAULT_VAULT_PASSWORD env vars -- server only, not CI.',
  );

  test.setTimeout(120_000);

  // -------------------------------------------------------
  // SHARED SETUP: sign in and unlock vault
  // -------------------------------------------------------
  test.beforeEach(async ({ page }) => {
    await page.goto('/');

    // Sign in
    // NOTE: verify selector names against the real app before running
    await page.fill('[data-testid="email"]',    VAULT_EMAIL);
    await page.fill('[data-testid="password"]', VAULT_PASSWORD);
    await page.click('[data-testid="sign-in-button"]');

    // Unlock vault
    await page.fill('[data-testid="vault-password-input"]', VAULT_VAULT_PWD);
    await page.click('[data-testid="unlock-vault-button"]');
    await expect(page.locator('[data-testid="dashboard"]')).toBeVisible({ timeout: 15_000 });
  });

  // -------------------------------------------------------
  // TEST 1: Full Add Connection happy path for Blink
  // Pre-condition: no Blink connection exists for this test account
  // -------------------------------------------------------
  test('Add Connection happy path -- Blink', async ({ page }) => {
    await page.click('[data-testid="add-connection-button"]');
    await page.click('[data-testid="provider-blink"]');

    await page.fill('[data-testid="blink-api-key-input"]', BLINK_KEY);
    await page.click('[data-testid="connect-button"]');

    // Connection created
    await expect(page.locator('[data-testid="connection-status"]'))
      .toContainText('Connected', { timeout: 15_000 });

    // Sync ran (last-synced timestamp is not "never" or empty)
    const lastSynced = page.locator('[data-testid="last-synced"]');
    await expect(lastSynced).not.toContainText('never', { timeout: 30_000 });
    await expect(lastSynced).not.toBeEmpty();
  });

  // -------------------------------------------------------
  // TEST 2: Vault-locked sync behavior (C-1003)
  // Pre-condition: a Blink connection already exists (run happy path first,
  //                or seed via setup fixture).
  // -------------------------------------------------------
  test('C-1003 -- vault-locked sync surfaces error, does not advance timestamp', async ({ page }) => {
    // ---- 1. Capture pre-lock state ----
    await page.goto('/connections');
    const connectionCard = page.locator('[data-testid="blink-connection"]').first();
    await expect(connectionCard).toBeVisible({ timeout: 10_000 });

    const lastSyncedBefore = await page.locator('[data-testid="last-synced"]').first().textContent();
    const statusBefore     = await page.locator('[data-testid="connection-status"]').first().textContent();
    void statusBefore; // captured for context; assertion is on statusAfter

    // ---- 2. Lock the vault ----
    await page.click('[data-testid="lock-vault-button"]');
    await expect(page.locator('[data-testid="vault-locked-indicator"]')).toBeVisible({ timeout: 5_000 });

    // ---- 3. Trigger a sync while locked ----
    await page.click('[data-testid="sync-connection-button"]');
    // Give the adapter time to attempt and fail
    await page.waitForTimeout(8_000);

    // ---- 4. Capture post-attempt state ----
    const lastSyncedAfter = await page.locator('[data-testid="last-synced"]').first().textContent();
    const statusAfter     = await page.locator('[data-testid="connection-status"]').first().textContent();
    const errorVisible    = await page.locator('[data-testid="sync-error-banner"]').isVisible();

    // ---- ASSERTION 1: visible error (not silence) ----
    expect(
      errorVisible,
      'C-1003 FAIL: vault-locked sync produced no visible error. ' +
      'User sees a healthy connection that silently did nothing.',
    ).toBe(true);

    // ---- ASSERTION 2: recovery action present alongside error ----
    if (errorVisible) {
      await expect(
        page.locator('[data-testid="sync-error-action"]'),
        'C-1003 FAIL: error shown but no recovery action (unlock vault / re-auth prompt).',
      ).toBeVisible();
    }

    // ---- ASSERTION 3: timestamp did not advance ----
    expect(
      lastSyncedAfter,
      'C-1003 FAIL: last-synced timestamp advanced despite vault being locked. ' +
      'This would be a false-positive sync record.',
    ).toBe(lastSyncedBefore);

    // ---- ASSERTION 4: connection is flagged stale or error, not healthy ----
    const isFlagged = statusAfter?.toLowerCase().includes('stale')
                   || statusAfter?.toLowerCase().includes('error')
                   || statusAfter?.toLowerCase().includes('locked');
    expect(
      isFlagged,
      `C-1003 FAIL: connection status is "${statusAfter}" after vault-locked sync attempt. ` +
      'Expected stale, error, or locked.',
    ).toBe(true);
  });
});
