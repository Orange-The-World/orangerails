import { test, expect, type Page } from "@playwright/test";

/**
 * /connect/bitcoin smoke tests (#760).
 *
 * Guards the picker -> /connect/bitcoin -> "Launch Stealth Sync" path so
 * the dead-end that shipped to prod (app_url absent, return_to ignored)
 * cannot regress silently.
 *
 * Test 1 is fixme until a trusted origin is in VITE_OR_STEALTH_ALLOWED_ORIGINS
 * on the dev Cloudflare Pages project. Tests 2-5 are env-independent and run
 * in CI today.
 *
 * DL-0347, #760
 */

const SHOT_DIR = "tests/e2e/screenshots";

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

test.describe("/connect/bitcoin - return_to bounce (#760)", () => {
  // Test 1: return_to with trusted origin -> browser bounces to return_to.
  // Fixme until the test origin is added to VITE_OR_STEALTH_ALLOWED_ORIGINS
  // on the orangerails-dev Cloudflare Pages project and a redeploy bakes it
  // into the bundle.
  test.fixme(
    "return_to with trusted origin bounces to the consuming app (#760)",
    async ({ page }) => {
      const allowedOrigin = "https://dev.orangerails.com"; // replace with literal from env
      const returnTo = `${allowedOrigin}/dashboard`;

      let bounced = false;
      await page.route(`${allowedOrigin}/**`, (route) => {
        bounced = true;
        void route.abort();
      });

      // Walk the full picker path: /connect?...&provider=xpub navigates to /connect/bitcoin.
      await page.goto(
        `/connect?platform=smoke-platform&app_user_id=smoke-user&return_to=${encodeURIComponent(returnTo)}&provider=xpub`,
      );
      await page.waitForURL(/\/connect\/bitcoin/, { timeout: 10_000 });
      await expect(page.getByRole("alert")).not.toBeVisible({ timeout: 2_000 });

      const launchButton = page.getByRole("button", {
        name: /launch stealth sync/i,
      });
      await expect(launchButton).toBeVisible();
      await launchButton.click();

      await page.waitForTimeout(500);
      expect(
        bounced,
        "window.location.assign must fire with the trusted return_to",
      ).toBe(true);
      await capture(page, "bitcoin-01-return-to-trusted-bounce");
    },
  );

  // Test 2: return_to with untrusted origin -> refusal alert, no redirect.
  // evil.example.com is never allowlisted regardless of env var content,
  // so this is fully env-independent and runs in CI today.
  test(
    "return_to with untrusted origin shows the refusal alert (#760)",
    async ({ page }) => {
      await page.goto(
        "/connect/bitcoin?return_to=" +
          encodeURIComponent("https://evil.example.com/callback"),
      );
      const launchButton = page.getByRole("button", {
        name: /launch stealth sync/i,
      });
      await expect(launchButton).toBeVisible();
      await launchButton.click();
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 5_000 });
      await expect(alert).toContainText(/not on our allowlist/i);
      await capture(page, "bitcoin-02-return-to-untrusted-refused");
    },
  );

  // Test 3: malformed return_to (URL constructor throws) -> same refusal path
  // as test 2. null can never satisfy Set.has(), so this is env-independent.
  test(
    "malformed return_to shows the refusal alert (#760)",
    async ({ page }) => {
      await page.goto("/connect/bitcoin?return_to=not-a-valid-url");
      const launchButton = page.getByRole("button", {
        name: /launch stealth sync/i,
      });
      await expect(launchButton).toBeVisible();
      await launchButton.click();
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 5_000 });
      await expect(alert).toContainText(/not on our allowlist/i);
      await capture(page, "bitcoin-03-malformed-return-to-refused");
    },
  );

  // Test 4: no return_to, no app_url, vault locked -> original "return to the
  // app that sent you here" message. In CI the vault is always locked.
  test(
    "no bounce target with vault locked shows the locked-vault message",
    async ({ page }) => {
      await page.goto("/connect/bitcoin");
      const launchButton = page.getByRole("button", {
        name: /launch stealth sync/i,
      });
      await expect(launchButton).toBeVisible();
      await launchButton.click();
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 5_000 });
      await expect(alert).toContainText(/return to the app that sent you here/i);
      await capture(page, "bitcoin-04-no-bounce-target-vault-locked");
    },
  );

  // Test 5: app_url is preferred over return_to when both present.
  // Both are untrusted here so the refusal fires on app_url, not return_to.
  // Env-independent.
  test(
    "app_url is preferred over return_to when both are present (#760)",
    async ({ page }) => {
      await page.goto(
        "/connect/bitcoin?app_url=" +
          encodeURIComponent("https://evil.example.com/") +
          "&return_to=" +
          encodeURIComponent("https://also-evil.example.com/"),
      );
      const launchButton = page.getByRole("button", {
        name: /launch stealth sync/i,
      });
      await expect(launchButton).toBeVisible();
      await launchButton.click();
      const alert = page.getByRole("alert");
      await expect(alert).toBeVisible({ timeout: 5_000 });
      await expect(alert).toContainText(/not on our allowlist/i);
      await capture(page, "bitcoin-05-app-url-preferred-refused");
    },
  );
});
