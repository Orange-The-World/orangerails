import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke tests for Orange Rails landing pages.
 *
 * Default target: dev.orangerails.com (the deployed dev application).
 * Override with: PLAYWRIGHT_BASE_URL=https://localhost:8080 npx playwright test
 *
 * Tests live in tests/e2e/. They are intentionally shallow -- page loads,
 * no console errors, key routes return 200. Deeper integration tests
 * (auth, dashboard, MCP flow) come later in the implementation plan.
 *
 * Stealth cursor-write harness (tests/e2e/stealth-cursor-write.spec.ts):
 * Requires import.meta.env.DEV = true so isForceCursor() is active (it is
 * tree-shaken to false in production builds). Set PLAYWRIGHT_WITH_VITE_DEV=1
 * to activate the webServer below; the suite skips otherwise. Also set:
 *   OR_API_BASE_URL, OR_TEST_PLATFORM_API_KEY,
 *   VITE_OR_STEALTH_ALLOWED_ORIGINS=http://localhost:5173
 */

// When set, start a local vite dev server for the stealth cursor test.
const WITH_VITE_DEV = !!process.env.PLAYWRIGHT_WITH_VITE_DEV;

export default defineConfig({
  testDir: './tests/e2e',
  // Only pick up real Playwright spec files. The audit-*.audit.mjs files
  // under tests/e2e/ are standalone Node runners (they call process.exit())
  // and would kill the Playwright runner mid-discovery if matched here.
  // Run them via tests/e2e/run-audit-suite.mjs instead.
  testMatch: '**/*.spec.ts',
  timeout: 30 * 1000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://dev.orangerails.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
