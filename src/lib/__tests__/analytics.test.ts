import { describe, it, expect } from "vitest";
import { resolveRef, REF_ALLOWLIST, HUB_SIGNUP_COMPLETE } from "../analytics";

const HOST = "orangerails.com";

describe("resolveRef: the ?ref= allowlist", () => {
  it("accepts a value that is on the allowlist", () => {
    expect(resolveRef("?ref=orangeworld", "", HOST)).toBe("orangeworld");
  });

  it("matches case-insensitively and trims", () => {
    expect(resolveRef("?ref=OrangeWorld", "", HOST)).toBe("orangeworld");
  });

  it("DROPS a value that is not on the allowlist, it does not pass it through", () => {
    expect(resolveRef("?ref=totally-made-up", "", HOST)).toBeNull();
  });

  it("drops an injection attempt rather than recording it", () => {
    expect(resolveRef("?ref=" + encodeURIComponent("<script>x</script>"), "", HOST)).toBeNull();
  });

  it("prefers the query param over the referrer when both are present", () => {
    expect(resolveRef("?ref=orangeworld", "https://example.com/a/b", HOST)).toBe("orangeworld");
  });
});

describe("resolveRef: the referrer fallback never yields a URL", () => {
  it("returns the hostname only, never the path or the query", () => {
    const out = resolveRef("", "https://example.com/private/path?token=secret", HOST);
    expect(out).toBe("example.com");
    expect(out).not.toContain("/");
    expect(out).not.toContain("?");
    expect(out).not.toContain("secret");
  });

  it("strips a www. prefix so one source is not counted as two", () => {
    expect(resolveRef("", "https://www.example.com/", HOST)).toBe("example.com");
  });

  it("returns null for a same-origin referrer, an internal navigation is not a source", () => {
    expect(resolveRef("", "https://orangerails.com/pricing", HOST)).toBeNull();
    expect(resolveRef("", "https://www.orangerails.com/pricing", HOST)).toBeNull();
  });

  it("returns null for a malformed referrer instead of throwing", () => {
    expect(resolveRef("", "not-a-url", HOST)).toBeNull();
  });

  it("returns null when there is no signal at all", () => {
    expect(resolveRef("", "", HOST)).toBeNull();
  });
});

describe("names the export contract depends on", () => {
  it("pins the conversion event name", () => {
    expect(HUB_SIGNUP_COMPLETE).toBe("hub_signup_complete");
  });

  it("keeps orangeworld on the allowlist, it is the launch distribution tag", () => {
    expect(REF_ALLOWLIST).toContain("orangeworld");
  });
});
