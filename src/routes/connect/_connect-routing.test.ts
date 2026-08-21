/**
 * Unit tests for _connect-routing.ts (DL-1007).
 *
 * The critical invariant: stealth-inline providers (sparrow, xpub) must reach
 * the "stealth-inline" step regardless of whether their manifests carry a
 * connectUrl. The slug check must win over the connectUrl check.
 */

import { describe, it, expect } from "vitest";
import { resolveConnectStep } from "./_connect-routing";

describe("resolveConnectStep", () => {
  it("routes sparrow to stealth-inline when connectUrl is absent", () => {
    expect(resolveConnectStep("sparrow", undefined)).toBe("stealth-inline");
  });

  it("routes xpub to stealth-inline when connectUrl is absent", () => {
    expect(resolveConnectStep("xpub", undefined)).toBe("stealth-inline");
  });

  it("routes sparrow to stealth-inline even when connectUrl is present (slug takes priority)", () => {
    expect(resolveConnectStep("sparrow", "/connect/sparrow")).toBe("stealth-inline");
  });

  it("routes xpub to stealth-inline even when connectUrl is present (slug takes priority)", () => {
    expect(resolveConnectStep("xpub", "/connect/bitcoin")).toBe("stealth-inline");
  });

  it("routes quiltt (connectUrl, not stealth slug) to navigate", () => {
    expect(resolveConnectStep("quiltt", "https://quiltt.dev/connect")).toBe("navigate");
  });

  it("routes a plain credential provider with no connectUrl to credential-form", () => {
    expect(resolveConnectStep("coinbase", undefined)).toBe("credential-form");
  });

  it("routes undefined slug with no connectUrl to credential-form", () => {
    expect(resolveConnectStep(undefined, undefined)).toBe("credential-form");
  });

  it("routes null slug with no connectUrl to credential-form", () => {
    expect(resolveConnectStep(null, null)).toBe("credential-form");
  });
});
