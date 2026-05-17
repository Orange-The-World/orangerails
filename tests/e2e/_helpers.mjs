// Shared helpers for Orange Rails audit-validation Playwright tests.
//
// Reads OR dev configuration from process.env. Defaults assume a run
// against dev.orangerails.com + the orangerails-dev Supabase project.
//
// Optional env:
//   OR_APP_URL         (default https://dev.orangerails.com)
//   OR_SUPPORT_URL     (default https://support.orangerails.com)
//   OR_API_BASE_URL    (default https://gposxxmxenrdvewrprle.supabase.co)
//   OR_HEADLESS        (default '1')

export const APP_URL = process.env.OR_APP_URL || 'https://dev.orangerails.com';
export const SUPPORT_URL = process.env.OR_SUPPORT_URL || 'https://support.orangerails.com';
export const API_BASE_URL = process.env.OR_API_BASE_URL || 'https://gposxxmxenrdvewrprle.supabase.co';
export const HEADLESS = (process.env.OR_HEADLESS ?? '1') !== '0';

export const STEP = (n, label) => console.log(`  → step ${n}: ${label}`);

export const expectText = async (page, locator, regex, name) => {
  const text = await locator.textContent();
  if (!text || !regex.test(text)) {
    throw new Error(`${name} expected to match ${regex} but got ${JSON.stringify(text)}`);
  }
  return text;
};

export const expectNotText = async (page, locator, regex, name) => {
  const text = await locator.textContent();
  if (text && regex.test(text)) {
    throw new Error(`${name} should NOT contain ${regex} but got ${JSON.stringify(text)}`);
  }
};
