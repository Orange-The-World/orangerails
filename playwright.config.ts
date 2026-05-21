import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke tests for Orange Rails landing pages.
 *
 * Default target: dev.orangerails.com (the deployed dev site).
 * Override with: PLAYWRIGHT_BASE_URL=https://localhost:8080 npx playwright test
 *
 * Tests live in tests/e2e/. They are intentionally shallow — page loads,
 * no console errors, key routes return 200. Deeper integration tests
 * (auth, dashboard, MCP flow) come later in the implementation plan.
 */
export default defineConfig({
  testDir: './tests/e2e',
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
