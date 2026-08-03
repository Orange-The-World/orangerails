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
    expect(sparrow.connectUrl).toBe("/connect/sparrow");
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

  test("/connect/sparrow renders the landing page sections", async ({ page }) => {
    await page.goto("/connect/sparrow");

    await expect(page.getByRole("heading", { name: /sparrow wallet/i, level: 1 })).toBeVisible();
    await expect(page.getByText(/what v0\.1 ships, and what it doesn/i)).toBeVisible();
    await expect(page.getByText(/confirmed receives/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: /how to connect/i })).toBeVisible();
    await expect(page.getByText(/open sparrow on your computer/i)).toBeVisible();
    await expect(page.getByText(/export your wallet descriptor/i)).toBeVisible();
    await expect(page.getByText(/launch stealth sync and paste/i)).toBeVisible();
    await expect(
      page.getByText(/your descriptor never leaves your browser in plaintext/i),
    ).toBeVisible();
    await capture(page, "04-connect-sparrow-landing");
  });

  // DL-0426: app_url redirect and refusal (three paths in launchStealthSync).
  // Test 1 is fixme until https://dev.orangerails.com is confirmed in
  // VITE_OR_STEALTH_ALLOWED_ORIGINS on the orangerails-dev Cloudflare Pages
  // project and a redeploy bakes it into the bundle. Tests 2 and 3 (the
  // no-app_url window.open path below) are env-independent and run today.

  // Test 1: trusted origin -> browser bounces (window.location.assign) to appUrl.
  // page.route intercepts the navigation before it leaves so the test does not
  // need the external origin to be reachable. Remove fixme once the origin
  // literal is confirmed from the deployed sparrow-*.js chunk on dev.orangerails.com
  // (dev chunk is behind Cloudflare Access; CTO or CoS must supply the value).
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
      const launchButton = page.getByRole("button", { name: /launch stealth sync/i });
      await expect(launchButton).toBeVisible();
      await launchButton.click();
      await page.waitForTimeout(500);
      expect(bounced, "window.location.assign must fire with the trusted appUrl").toBe(true);
    },
  );

  // Test 2: untrusted origin -> refusal alert shown, no redirect.
  // evil.example.com is never allowlisted regardless of the env var value,
  // so this test is fully env-independent and runs in CI today.
  test("app_url with untrusted origin shows the refusal alert (DL-0426)", async ({ page }) => {
    await page.goto(
      "/connect/sparrow?app_url=" + encodeURIComponent("https://evil.example.com/callback"),
    );
    const launchButton = page.getByRole("button", { name: /launch stealth sync/i });
    await expect(launchButton).toBeVisible();
    await launchButton.click();
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/not on our allowlist/i);
    await capture(page, "06-sparrow-app-url-refused");
  });

  // Test 3: malformed app_url (URL constructor throws, origin is null) -> same
  // refusal path as test 2. null can never satisfy Set.has(), so this is
  // fully env-independent regardless of ALLOWED_APP_ORIGINS content.
  test("malformed app_url shows the refusal alert (DL-0426)", async ({ page }) => {
    await page.goto("/connect/sparrow?app_url=not-a-valid-url");
    const launchButton = page.getByRole("button", { name: /launch stealth sync/i });
    await expect(launchButton).toBeVisible();
    await launchButton.click();
    const alert = page.getByRole("alert");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/not on our allowlist/i);
    await capture(page, "07-sparrow-malformed-url-refused");
  });

  test('"Launch Stealth Sync" button opens /connect/stealth via window.open', async ({ page }) => {
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
    await page.goto("/connect/sparrow");

    // Inject a same-origin iframe pointing at the widget. Inside it,
    // window.parent !== window (framed) while window.opener is null, which is
    // exactly the shape the old opener/parent gate rejected.
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "stealth-frame";
      frame.src = "/connect/stealth";
      frame.style.width = "480px";
      frame.style.height = "640px";
      document.body.appendChild(frame);
    });

    const widget = page.frameLocator("#stealth-frame");

    // Never post OR_STEALTH_INIT. Wait just past the grace window so awaitingInit
    // flips to false with no init set.
    await page.waitForTimeout(1600); // just past the 1500ms DIRECT_LOAD_GRACE_MS window

    await expect(
      widget.getByRole("heading", { name: /stealth sync widget/i, level: 1 }),
    ).toBeVisible();
    await expect(
      widget.getByText(/OR_STEALTH_INIT postMessage to this window/i),
    ).toBeVisible();
    await capture(page, "05-stealth-iframe-load-guidance-card");
  });
});
