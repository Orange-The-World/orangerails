/**
 * Stealth Sync widget OR_STEALTH_INIT handshake tests.
 *
 * Requires a vite dev server started with:
 *   VITE_OR_STEALTH_ALLOWED_ORIGINS=http://localhost:8080
 *
 * Set PLAYWRIGHT_WITH_VITE_DEV=1 to activate this suite. Without it the
 * suite skips cleanly. The main CI Playwright smoke job targets the deployed
 * CF Pages build where the branch-preview origin is not in the allowlist,
 * so the skip is expected in that context.
 *
 * Why the smoke suite cannot run these tests:
 *   The widget validates event.origin against VITE_OR_STEALTH_ALLOWED_ORIGINS
 *   before accepting OR_STEALTH_INIT. In CI the smoke suite targets a Pages
 *   preview URL (e.g. https://feat-dl-0448-sparrow-stealth.orangerails-dev.pages.dev)
 *   whose origin is never in the allowlist, so the INIT is rejected and
 *   AddRoute never renders. The vite dev server is started with
 *   VITE_OR_STEALTH_ALLOWED_ORIGINS=http://localhost:8080, so same-origin
 *   iframe postMessage passes the check.
 *
 * No Supabase credentials are needed: the tests exercise the postMessage
 * protocol only and make no edge-function calls.
 *
 * CI job: playwright-stealth-cursor (in .github/workflows/ci.yml), leg 1,
 * grep extended to 'stealth cursor write|DL-0448'.
 */

import { test, expect, type Page } from "@playwright/test";

const WITH_VITE_DEV = !!process.env.PLAYWRIGHT_WITH_VITE_DEV;
const VITE_BASE = "http://localhost:8080";
const SHOT_DIR = "tests/e2e/screenshots";

async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: `${SHOT_DIR}/${name}.png`,
    fullPage: true,
  });
}

// Use test.describe.skip (not test.skip() inside the callback) when
// PLAYWRIGHT_WITH_VITE_DEV is unset. test.describe.skip prevents the
// test.use() baseURL override from being registered in CI jobs targeting
// the deployed CF Pages build -- a registered http://localhost:8080 override
// would redirect smoke-suite page.goto('/') to a port that is not listening.
const _testDescribe = !WITH_VITE_DEV ? test.describe.skip : test.describe;

_testDescribe("Stealth Sync widget OR_STEALTH_INIT handshake", () => {
  test.use({ baseURL: VITE_BASE });

  // DL-0448: widget receives OR_STEALTH_INIT before the grace window and
  // skips DirectLoadCard, rendering AddRoute. This is the signed-in OR user
  // path where the parent app completes the handshake within the 1500ms grace
  // window. Testing via same-origin iframe keeps this env-independent (no
  // Supabase auth or real xpub needed).
  //
  // Required INIT fields that the original smoke-suite test omitted:
  //   protocol_version: 1      -- App.tsx line 183 rejects on mismatch
  //   return_callback_origin   -- App.tsx line 173 rejects if != event.origin
  test(
    "widget receives OR_STEALTH_INIT before grace window and renders AddRoute (DL-0448)",
    async ({ page }) => {
      await page.goto("/connect/sparrow");

      await page.evaluate(() => {
        const frame = document.createElement("iframe");
        frame.id = "stealth-frame-init";
        frame.src = "/connect/stealth";
        frame.style.cssText = "width:480px;height:640px";
        document.body.appendChild(frame);
      });

      // Generate a synthetic 32-byte key (same shape HKDF produces) and post
      // OR_STEALTH_INIT to the widget as soon as it signals OR_STEALTH_READY.
      await page.evaluate(async () => {
        const frame = document.getElementById(
          "stealth-frame-init",
        ) as HTMLIFrameElement;
        const rawKey = crypto.getRandomValues(new Uint8Array(32));
        const keyB64 = btoa(String.fromCharCode(...Array.from(rawKey)));
        await new Promise<void>((resolve) => {
          function onMsg(ev: MessageEvent) {
            if (ev.data?.type !== "OR_STEALTH_READY") return;
            window.removeEventListener("message", onMsg);
            frame.contentWindow?.postMessage(
              {
                type: "OR_STEALTH_INIT",
                protocol_version: 1,
                app_slug: "test-sparrow",
                app_user_id: "test-e2e",
                or_stealth_key_b64: keyB64,
                mode: "add",
                return_callback_origin: window.location.origin,
              },
              window.location.origin,
            );
            resolve();
          }
          window.addEventListener("message", onMsg);
        });
      });

      const widget = page.frameLocator("#stealth-frame-init");
      await expect(
        widget.getByRole("heading", { name: /stealth sync.*add wallet/i, level: 1 }),
      ).toBeVisible({ timeout: 5_000 });
      await capture(page, "08-stealth-widget-add-route");
    },
  );
});
