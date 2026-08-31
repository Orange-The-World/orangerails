import { describe, expect, it } from "vitest";
import { GATEWAY_VERIFIED_IP_HEADER, forwardHeaders } from "../src/index";

describe("forwardHeaders", () => {
  it("re-injects the edge-set cf-connecting-ip under the trusted header and drops a caller-forged value under that same name", () => {
    const src = new Headers();
    src.set("cf-connecting-ip", "203.0.113.7"); // set by Cloudflare at its own edge
    src.set(GATEWAY_VERIFIED_IP_HEADER, "10.0.0.1"); // caller trying to forge the trusted header
    src.set("x-real-ip", "10.0.0.2"); // caller-supplied, never trusted
    src.set("host", "api.orangerails.com");

    const out = forwardHeaders(src);

    expect(out.get(GATEWAY_VERIFIED_IP_HEADER)).toBe("203.0.113.7");
    expect(out.get("cf-connecting-ip")).toBeNull();
    expect(out.get("host")).toBeNull();
    // Ordinary untrusted headers still pass through unchanged.
    expect(out.get("x-real-ip")).toBe("10.0.0.2");
  });

  it("strips every cf-* header from the outbound request", () => {
    const src = new Headers();
    src.set("cf-connecting-ip", "203.0.113.7");
    src.set("cf-ray", "abc123");
    src.set("cf-ipcountry", "US");

    const out = forwardHeaders(src);

    expect(out.get("cf-ray")).toBeNull();
    expect(out.get("cf-ipcountry")).toBeNull();
    expect(out.get(GATEWAY_VERIFIED_IP_HEADER)).toBe("203.0.113.7");
  });

  it("sets no trusted header when there is no edge-set cf-connecting-ip", () => {
    const src = new Headers();
    src.set("x-forwarded-for", "198.51.100.9");
    src.set(GATEWAY_VERIFIED_IP_HEADER, "198.51.100.9"); // still forged, still dropped

    const out = forwardHeaders(src);

    expect(out.get(GATEWAY_VERIFIED_IP_HEADER)).toBeNull();
    expect(out.get("x-forwarded-for")).toBe("198.51.100.9");
  });
});
