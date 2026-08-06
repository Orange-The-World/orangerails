import { describe, it, expect } from "vitest";
import { resolveFunctionUrl } from "./resolveFunctionUrl";

const PAGES_HOST = "connect.orangerails.com";
const SUPABASE_PROJECT_URL = "https://fzwmnzmtqidumdqjdddz.supabase.co";
const FUNCTIONS_BASE = `${SUPABASE_PROJECT_URL}/functions/v1`;
const PROXY_BASE = "https://app.example.com/api/or";

describe("resolveFunctionUrl", () => {
  it("uses proxyBaseUrl when provided, ignoring env", () => {
    const url = resolveFunctionUrl("or-stealth-connection-create", PROXY_BASE, {});
    expect(url).toBe(`${PROXY_BASE}/or-stealth-connection-create`);
  });

  it("strips trailing slash from proxyBaseUrl", () => {
    const url = resolveFunctionUrl("or-stealth-connection-create", `${PROXY_BASE}/`, {});
    expect(url).toBe(`${PROXY_BASE}/or-stealth-connection-create`);
  });

  it("uses VITE_OR_FUNCTIONS_BASE_URL when set and no proxy", () => {
    const url = resolveFunctionUrl("or-stealth-envelope-fetch", undefined, {
      VITE_OR_FUNCTIONS_BASE_URL: FUNCTIONS_BASE,
    });
    expect(url).toBe(`${FUNCTIONS_BASE}/or-stealth-envelope-fetch`);
  });

  it("strips trailing slash from VITE_OR_FUNCTIONS_BASE_URL", () => {
    const url = resolveFunctionUrl("or-stealth-transactions-store", undefined, {
      VITE_OR_FUNCTIONS_BASE_URL: `${FUNCTIONS_BASE}/`,
    });
    expect(url).toBe(`${FUNCTIONS_BASE}/or-stealth-transactions-store`);
  });

  it("falls back to VITE_SUPABASE_URL/functions/v1/<name> when only VITE_SUPABASE_URL is set", () => {
    const url = resolveFunctionUrl("or-stealth-transactions-store", undefined, {
      VITE_SUPABASE_URL: SUPABASE_PROJECT_URL,
    });
    expect(url).toBe(`${SUPABASE_PROJECT_URL}/functions/v1/or-stealth-transactions-store`);
  });

  it("strips trailing slash from VITE_SUPABASE_URL", () => {
    const url = resolveFunctionUrl("or-stealth-connection-create", undefined, {
      VITE_SUPABASE_URL: `${SUPABASE_PROJECT_URL}/`,
    });
    expect(url).toBe(`${SUPABASE_PROJECT_URL}/functions/v1/or-stealth-connection-create`);
  });

  it("throws when neither env var is configured", () => {
    expect(() =>
      resolveFunctionUrl("or-stealth-connection-create", undefined, {}),
    ).toThrow(/VITE_OR_FUNCTIONS_BASE_URL|VITE_SUPABASE_URL/);
  });

  it("resolved URL host is never the Pages host", () => {
    const candidates = [
      resolveFunctionUrl("fn", PROXY_BASE, {}),
      resolveFunctionUrl("fn", undefined, { VITE_OR_FUNCTIONS_BASE_URL: FUNCTIONS_BASE }),
      resolveFunctionUrl("fn", undefined, { VITE_SUPABASE_URL: SUPABASE_PROJECT_URL }),
    ];
    for (const url of candidates) {
      expect(new URL(url).host).not.toBe(PAGES_HOST);
    }
  });

  it("resolved URL is always absolute (starts with https://)", () => {
    const candidates = [
      resolveFunctionUrl("fn", PROXY_BASE, {}),
      resolveFunctionUrl("fn", undefined, { VITE_OR_FUNCTIONS_BASE_URL: FUNCTIONS_BASE }),
      resolveFunctionUrl("fn", undefined, { VITE_SUPABASE_URL: SUPABASE_PROJECT_URL }),
    ];
    for (const url of candidates) {
      expect(url.startsWith("https://")).toBe(true);
    }
  });
});
