import { describe, it, expect, vi } from "vitest";
import { sendInitOnReady } from "./_sparrow-init-handler";
import { STEALTH_PROTOCOL_VERSION } from "@/stealth/lib/postmessage";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SELF_ORIGIN = "https://orangerails.com";
const USER_ID = "user-abc-00000000";
const ACCESS_TOKEN = "tok-def-00000000";
const STEALTH_KEY = "dGVzdC1zdGVhbHRoLWtleS0zMi1ieXRlcw==";

const makePopup = () => ({ postMessage: vi.fn() });
const makeSession = async () => ({ user: { id: USER_ID }, access_token: ACCESS_TOKEN });
const getKey = async () => STEALTH_KEY;

function readyEvent(popup: object, origin = SELF_ORIGIN) {
  return { source: popup, origin, data: { type: "OR_STEALTH_READY" } };
}

const EXPECTED_INIT = {
  type: "OR_STEALTH_INIT",
  protocol_version: STEALTH_PROTOCOL_VERSION,
  app_slug: "or",
  app_user_id: USER_ID,
  mode: "add",
  or_stealth_key_b64: STEALTH_KEY,
  return_callback_origin: SELF_ORIGIN,
  access_token: ACCESS_TOKEN,
  gap_limit: 250,
};

// ---------------------------------------------------------------------------
// Tests (DL-0448 signed-in INIT path)
// ---------------------------------------------------------------------------

describe("sendInitOnReady (DL-0448 signed-in INIT path)", () => {
  it("sends OR_STEALTH_INIT with correct fields on valid OR_STEALTH_READY", async () => {
    const popup = makePopup();

    const result = await sendInitOnReady(
      readyEvent(popup),
      popup,
      SELF_ORIGIN,
      makeSession,
      getKey,
    );

    expect(result).toBe(true);
    expect(popup.postMessage).toHaveBeenCalledOnce();
    expect(popup.postMessage).toHaveBeenCalledWith(EXPECTED_INIT, SELF_ORIGIN);
  });

  it("ignores messages from a different source window (source guard)", async () => {
    const popup = makePopup();
    const otherWindow = {};

    const result = await sendInitOnReady(
      { source: otherWindow, origin: SELF_ORIGIN, data: { type: "OR_STEALTH_READY" } },
      popup,
      SELF_ORIGIN,
      makeSession,
      getKey,
    );

    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("ignores messages from a different origin (origin guard)", async () => {
    const popup = makePopup();

    const result = await sendInitOnReady(
      readyEvent(popup, "https://evil.example.com"),
      popup,
      SELF_ORIGIN,
      makeSession,
      getKey,
    );

    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("ignores non-OR_STEALTH_READY message types (type guard)", async () => {
    const popup = makePopup();

    const result = await sendInitOnReady(
      { source: popup, origin: SELF_ORIGIN, data: { type: "OR_STEALTH_PROGRESS" } },
      popup,
      SELF_ORIGIN,
      makeSession,
      getKey,
    );

    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("skips postMessage when getSession returns null (signed-out opener edge case)", async () => {
    const popup = makePopup();

    const result = await sendInitOnReady(
      readyEvent(popup),
      popup,
      SELF_ORIGIN,
      async () => null,
      getKey,
    );

    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it("returns false and logs a warning when getStealthKey rejects (crypto error)", async () => {
    const popup = makePopup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await sendInitOnReady(
      readyEvent(popup),
      popup,
      SELF_ORIGIN,
      makeSession,
      async () => {
        throw new Error("HKDF failure");
      },
    );

    expect(result).toBe(false);
    expect(popup.postMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[sparrow] Could not send OR_STEALTH_INIT:",
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
