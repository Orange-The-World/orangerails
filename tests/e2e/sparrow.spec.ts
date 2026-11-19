import { test, expect, type Page } from "@playwright/test";

/**
 * Sparrow v0.1 smoke tests.
 *
 * Covers the discovery + navigation flow from the public landing pages
 * to the Stealth Sync widget launch. Does NOT exercise the actual
 * descriptor paste or chain scan , that requires a real Sparrow
 * descriptor fixture and a stubbed BIP 158 source, deferred to a later
 * milestone.
 *
 * What this protects:
 *   1. /integrations redirects to /providers           [fixme: #430]
 *   2. /providers catalog includes the Sparrow manifest
 *   3. /providers picker shows the Sparrow tile        [fixme: #430]
 *   4. Selecting the Sparrow tile shows preview + CTA  [fixme: #430]
 *   5. The preview CTA navigates to /connect/sparrow
 *   6. /connect/sparrow renders all four landing-page sections
 *   7. The "Launch Stealth Sync" button targets /connect/stealth
 *
 * Each test takes a screenshot saved to tests/e2e/screenshots/ for the
 * CI artifact upload. Screenshots are full-page so the founder review
 * doesn't need to redo the click path manually.
 *
 * Spec: see docs/Sparrow.md
 */

const SHOT_DIR = "tests/e2e/screenshots";

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `${SHOT_DIR}/${name}.png`,
    fullPage: true,
  });
}

test.describe("Sparrow v0.1 , discovery + landing", () => {
  // #430: /integrations route does not exist; the picker lives at /connect.
  // Remove fixme and update selector once the route or redirect is added.
  test.fixme("integrations redirects to providers", async ({ page }) => {
    await page.goto("/integrations");
    await expect(page).toHaveURL(/\/providers$/);
    await capture(page, "01-integrations-redirect");
  });

  test("providers catalog includes the Sparrow manifest", async ({ request }) => {
    // Hit the or-providers edge function directly to confirm Sparrow lives
    // in the catalog regardless of how the SPA renders it.
    const baseUrl = process.env.OR_SUPABASE_URL ?? "https://fzwmnzmtqidumdqjdddz.supabase.co";
    const res = await request.get(`${baseUrl}/functions/v1/or-providers`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    const sparrow = (body.providers ?? []).find((p: { slug: string }) => p.slug === "sparrow");
    expect(sparrow, "sparrow manifest must be in the catalog").toBeTruthy();
    expect(sparrow.status).toBe("live");
    expect(sparrow.category).toBe("on_chain_wallet");
    // connectUrl removed from sparrow manifest in DL-1007 to close the redirect
    // loop. The unit test in dispatch.test.ts guards that field is absent from
    // listProviderManifests(). Not asserted here: the E2E test hits the deployed
    // dev function, which reflects the change only after merge + redeploy.
  });

  // #430: /providers route does not exist; data-slug is not rendered on any tile.
  // Remove fixme once /connect picker tiles carry data-slug attributes.
  test.fixme("/providers shows Sparrow tile in the picker", async ({ page }) => {
    await page.goto("/providers");
    const sparrowTile = page.locator('[data-slug="sparrow"]');
    await expect(sparrowTile).toBeVisible({ timeout: 10_000 });
    await capture(page, "02-providers-with-sparrow");
  });

  // #430: same dependency on /providers route and data-slug selector.
  test.fixme("clicking the Sparrow tile shows preview + Stealth Sync CTA", async ({ page }) => {
    await page.goto("/providers");
    const sparrowTile = page.locator('[data-slug="sparrow"]');
    await sparrowTile.waitFor({ state: "visible", timeout: 10_000 });
    await sparrowTile.click();

    const preview = page.locator("aside").filter({ hasText: "Sparrow Wallet" });
    await expect(preview).toBeVisible();

    const cta = page.getByRole("link", { name: /open sparrow wallet setup/i });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "/connect/sparrow");
    await capture(page, "03-providers-sparrow-selected");
  });

  test("/connect/sparrow redirects to /providers (DL-1007)", async ({ page }) => {
    // DL-1007: /connect/sparrow is now a backwards-compat redirect to the picker.
    // The old Sparrow landing page moved inline into /providers. Bookmarks and
    // external links (including the sparrow provider manifest connectUrl) still
    // land correctly because the redirect preserves the full query string.
    await page.goto("/connect/sparrow");
    await page.waitForURL(/\/providers/, { timeout: 10_000 });
    expect(page.url()).toMatch(/\/providers/);
    await capture(page, "04-connect-sparrow-redirect-to-picker");
  });

  // DL-0426: app_url redirect and refusal (three paths in launchStealthSync).
  // Test 1 is fixme until https://dev.orangerails.com is confirmed in
  // VITE_OR_STEALTH_ALLOWED_ORIGINS on the orangerails-dev Cloudflare Pages
  // project and a redeploy bakes it into the bundle. Tests 2 and 3 (the
  // no-app_url window.open path below) are env-independent and run today.

  // Test 1: trusted origin -> browser bounces (window.location.assign) to appUrl.
  // /connect/sparrow redirects to /providers; the picker preserves a trusted app_url
  // for when the Stealth Sync setup flow completes (follow-up: picker completion
  // should call window.location.assign(appUrl)). Remove fixme once:
  //   (a) the picker completion path calls window.location.assign(appUrl), and
  //   (b) VITE_OR_STEALTH_ALLOWED_ORIGINS on orangerails-dev includes the test origin.
  test.fixme(
    "app_url with trusted origin bounces to the app (DL-0426)",
    async ({ page }) => {
      const allowedOrigin = "https://dev.orangerails.com"; // replace with literal from chunk
      const appUrl = `${allowedOrigin}/stealth-return`;

      let bounced = false;
      await page.route(`${allowedOrigin}/**`, (route) => {
        bounced = true;
        route.abort();
      });

      await page.goto(`/connect/sparrow?app_url=${encodeURIComponent(appUrl)}`);
      await page.waitForURL(/\/providers/, { timeout: 10_000 });
      // Trusted origin: picker shows without a refusal alert.
      await expect(page.getByRole("alert")).not.toBeVisible({ timeout: 2_000 });
      // TODO: trigger stealth sync completion and assert the bounce fires.
      await page.waitForTimeout(500);
      expect(bounced, "window.location.assign must fire with the trusted appUrl").toBe(true);
    },
  );

  // Test 2: untrusted origin -> refusal alert shown, no redirect.
  // evil.example.com is never allowlisted regardless of the env var value,
  // so this test is fully env-independent and runs in CI today.
  // DL-1007: /connect/sparrow redirects to /providers which validates app_url
  // on mount and shows a refusal alert immediately for untrusted origins.
  test("app_url with untrusted origin shows the refusal alert (DL-0426)", async ({ page }) => {
    await page.goto(
      "/connect/sparrow?app_url=" + encodeURIComponent("https://evil.example.com/callback"),
    );
    await page.waitForURL(/\/providers/, { timeout: 10_000 });
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 5_000 });
    await expect(alert).toContainText(/not on our allowlist/i);
    await capture(page, "06-sparrow-app-url-refused");
  });

  // Test 3: malformed app_url (URL constructor throws, origin is null) -> same
  // refusal path as test 2. null can never satisfy Set.has(), so this is
  // fully env-independent regardless of ALLOWED_APP_ORIGINS content.
  // /connect/sparrow redirects to /providers which rejects a malformed app_url
  // on mount with the same refusal alert as an untrusted origin.
  test("malformed app_url shows the refusal alert (DL-0426)", async ({ page }) => {
    await page.goto("/connect/sparrow?app_url=not-a-valid-url");
    await page.waitForURL(/\/providers/, { timeout: 10_000 });
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible({ timeout: 5_000 });
    await expect(alert).toContainText(/not on our allowlist/i);
    await capture(page, "07-sparrow-malformed-url-refused");
  });

  // DL-0426: the isUnlocked guard before window.open means CI (vault locked)
  // shows the refusal panel instead of opening a popup. This covers that path.
  test.fixme("clicking Launch Stealth Sync with vault locked shows the refusal message", async ({ page }) => {
    await page.goto("/connect/sparrow");
    const launchButton = page.getByRole("button", { name: /launch stealth sync/i });
    await expect(launchButton).toBeVisible();
    await launchButton.click();
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/return to the app that sent you here/i);
    await capture(page, "08-sparrow-locked-vault-refusal");
  });

  // fixme: requires isUnlocked = true (authenticated session) to reach the
  // window.open path. Remove fixme once E2E can log in with a test account.
  test.fixme('"Launch Stealth Sync" button opens /connect/stealth via window.open when vault is unlocked', async ({ page }) => {
    await page.goto("/connect/sparrow");
    const launchButton = page.getByRole("button", { name: /launch stealth sync/i });
    await expect(launchButton).toBeVisible();

    // Patch window.open before clicking. Promise.all starts both concurrently:
    // the evaluate message is sent to the browser first (JS is single-threaded,
    // array items are processed left-to-right), so the intercept is guaranteed
    // to be in place when the click event fires.
    //
    // Returning a mock non-null Window suppresses the popup-blocked fallback
    // (window.location.href = url) so the page does not navigate away and the
    // promise can resolve back to Node.js cleanly.
    const [destination] = await Promise.all([
      page.evaluate(() =>
        new Promise<string>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const orig = (window as any).open;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (window as any).open = (url: string) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).open = orig;
            resolve(url);
            return { closed: false } as unknown as Window;
          };
        })
      ),
      launchButton.click(),
    ]);
    expect(destination).toContain("/connect/stealth");
  });

  // #451: the widget must reach the guidance card for ANY entry shape once the
  // grace window expires, not only a top-level tab where window.parent === window.
  // Load it inside a same-origin iframe: window.opener stays null while
  // window.parent !== window. On the pre-fix gate the card only rendered when
  // window.parent === window, so this framed load stayed stuck on the waiting
  // state. This case is the regression guard that the fix dropped that condition:
  // red at the dev tip, green on this branch.
  test("iframe direct-load of /connect/stealth shows the guidance card after the grace window", async ({ page }) => {
    // Strip framing-denial headers so the real iframe can load in this test.
    // Both X-Frame-Options and the CSP frame-ancestors directive must be absent
    // or the browser refuses to render the iframe regardless of which branch
    // this test runs against. Header correctness is covered by the security PR;
    // this test guards the widget JS behaviour when window.parent !== window.
    await page.route("**/connect/stealth", async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      delete headers["x-frame-options"];
      delete headers["content-security-policy"];
      await route.fulfill({ response, headers });
    });

    // Load the widget in a real iframe so window.parent !== window is true
    // by construction, not by monkey-patch (#451 regression shape).
    await page.goto("/");
    await page.evaluate(() => {
      const iframe = document.createElement("iframe");
      iframe.id = "stealth-iframe-fixture";
      iframe.src = "/connect/stealth";
      Object.assign(iframe.style, {
        width: "100vw",
        height: "100vh",
        border: "none",
      });
      document.body.replaceChildren(iframe);
    });

    // Web-first: 5000ms covers the 1500ms grace window plus render time.
    // No hardcoded waitForTimeout; the assertion retries until visible.
    const widget = page.frameLocator("#stealth-iframe-fixture");
    await expect(
      widget.getByRole("heading", { name: /stealth sync widget/i }),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      widget.getByText(/OR_STEALTH_INIT postMessage to this window/i),
    ).toBeVisible({ timeout: 5000 });
    await capture(page, "05-stealth-iframe-load-guidance-card");
  });

});
