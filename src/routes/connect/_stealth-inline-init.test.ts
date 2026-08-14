import { describe, expect, it, vi } from "vitest";
import { STEALTH_PROTOCOL_VERSION } from "@/stealth/lib/postmessage";
import {
  buildStealthInlineInit,
  classifyStealthMessage,
  isStealthInlineSlug,
  sendStealthInitOnReady,
  STEALTH_INLINE_SLUGS,
  type StealthInlineInitArgs,
} from "./_stealth-inline-init";

const SELF = "https://dev.orangerails.com";
const OTHER = "https://evil.example.com";

function frame() {
  return { postMessage: vi.fn() };
}

function args(overrides: Partial<StealthInlineInitArgs> = {}): StealthInlineInitArgs {
  return {
    appSlug: "ow",
    appUserId: "user-1",
    credKeyB64: "a".repeat(44),
    widgetToken: "11111111-1111-1111-1111-111111111111",
    selfOrigin: SELF,
    ...overrides,
  };
}

const READY = { type: "OR_STEALTH_READY", protocol_version: STEALTH_PROTOCOL_VERSION };

describe("STEALTH_INLINE_SLUGS", () => {
  it("covers exactly the two Stealth Sync catalogue entries", () => {
    // Verified against the deployed catalogue: of 105 providers, only
    // sparrow, xpub and quiltt carry a connectUrl. quiltt is deliberately
    // excluded because it needs a server-minted session first.
    expect([...STEALTH_INLINE_SLUGS].sort()).toEqual(["sparrow", "xpub"]);
  });

  it("does not claim quiltt", () => {
    expect(isStealthInlineSlug("quiltt")).toBe(false);
  });

  it("does not claim a provider that stays on the credential form", () => {
    expect(isStealthInlineSlug("blink")).toBe(false);
  });

  it("tolerates undefined and null", () => {
    expect(isStealthInlineSlug(undefined)).toBe(false);
    expect(isStealthInlineSlug(null)).toBe(false);
  });
});

describe("buildStealthInlineInit", () => {
  it("builds a widget-mode add INIT", () => {
    expect(buildStealthInlineInit(args())).toEqual({
      type: "OR_STEALTH_INIT",
      protocol_version: STEALTH_PROTOCOL_VERSION,
      app_slug: "ow",
      app_user_id: "user-1",
      mode: "add",
      or_stealth_key_b64: "a".repeat(44),
      return_callback_origin: SELF,
      widget_token: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("omits widget_token entirely when there is none", () => {
    const init = buildStealthInlineInit(args({ widgetToken: undefined }));
    expect("widget_token" in init).toBe(false);
  });

  it("never carries an access_token or a proxy_base_url", () => {
    // A host-app user has no OrangeRails JWT, and the browser must never hold
    // a platform API key. If either of these ever appears here it means an
    // auth mode was wired in that this caller is not entitled to.
    const init = buildStealthInlineInit(args());
    expect("access_token" in init).toBe(false);
    expect("proxy_base_url" in init).toBe(false);
  });

  it("posts replies to our own origin, never a wildcard", () => {
    expect(buildStealthInlineInit(args()).return_callback_origin).toBe(SELF);
    expect(buildStealthInlineInit(args()).return_callback_origin).not.toBe("*");
  });

  it("requests add and names no connection_id", () => {
    const init = buildStealthInlineInit(args());
    expect(init.mode).toBe("add");
    expect("connection_id" in init).toBe(false);
  });
});

describe("sendStealthInitOnReady", () => {
  it("posts INIT for a well-formed READY from the frame", () => {
    const f = frame();
    const ok = sendStealthInitOnReady({ source: f, origin: SELF, data: READY }, f, args());
    expect(ok).toBe(true);
    expect(f.postMessage).toHaveBeenCalledTimes(1);
    expect(f.postMessage.mock.calls[0][1]).toBe(SELF);
  });

  it("refuses a READY from a different window", () => {
    const f = frame();
    const ok = sendStealthInitOnReady(
      { source: { postMessage: vi.fn() }, origin: SELF, data: READY },
      f,
      args(),
    );
    expect(ok).toBe(false);
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it("refuses a READY claiming a foreign origin", () => {
    const f = frame();
    const ok = sendStealthInitOnReady({ source: f, origin: OTHER, data: READY }, f, args());
    expect(ok).toBe(false);
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it("ignores a message that is not READY", () => {
    const f = frame();
    const ok = sendStealthInitOnReady(
      { source: f, origin: SELF, data: { type: "SOMETHING_ELSE" } },
      f,
      args(),
    );
    expect(ok).toBe(false);
    expect(f.postMessage).not.toHaveBeenCalled();
  });

  it("survives a null or non-object payload without throwing", () => {
    const f = frame();
    expect(sendStealthInitOnReady({ source: f, origin: SELF, data: null }, f, args())).toBe(false);
    expect(sendStealthInitOnReady({ source: f, origin: SELF, data: "hi" }, f, args())).toBe(false);
    expect(f.postMessage).not.toHaveBeenCalled();
  });
});

describe("classifyStealthMessage", () => {
  it("recognises ADD_COMPLETE from the frame at our origin", () => {
    const f = frame();
    expect(
      classifyStealthMessage(
        { source: f, origin: SELF, data: { type: "OR_STEALTH_ADD_COMPLETE" } },
        f,
        SELF,
      ),
    ).toBe("add-complete");
  });

  it("recognises an error", () => {
    const f = frame();
    expect(
      classifyStealthMessage({ source: f, origin: SELF, data: { type: "OR_STEALTH_ERROR" } }, f, SELF),
    ).toBe("error");
  });

  it("refuses a spoofed ADD_COMPLETE from a foreign origin", () => {
    // This is the case that matters. Treating this as success would let any
    // page that can reach this window fake a completed connection.
    const f = frame();
    expect(
      classifyStealthMessage(
        { source: f, origin: OTHER, data: { type: "OR_STEALTH_ADD_COMPLETE" } },
        f,
        SELF,
      ),
    ).toBe("ignore");
  });

  it("refuses an ADD_COMPLETE from a different window", () => {
    const f = frame();
    expect(
      classifyStealthMessage(
        { source: { postMessage: vi.fn() }, origin: SELF, data: { type: "OR_STEALTH_ADD_COMPLETE" } },
        f,
        SELF,
      ),
    ).toBe("ignore");
  });

  it("ignores unrelated traffic", () => {
    const f = frame();
    expect(classifyStealthMessage({ source: f, origin: SELF, data: { type: "x" } }, f, SELF)).toBe(
      "ignore",
    );
    expect(classifyStealthMessage({ source: f, origin: SELF, data: null }, f, SELF)).toBe("ignore");
  });
});
