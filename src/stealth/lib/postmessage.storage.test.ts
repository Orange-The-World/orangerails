import { describe, expect, it } from "vitest";

import { assertNoKeyInAppMode, type StealthInitStorageMessage } from "./postmessage";

const STORAGE_INIT: StealthInitStorageMessage = {
  type: "OR_STEALTH_INIT",
  protocol_version: 1,
  app_slug: "test",
  app_user_id: "user-1",
  mode: "storage",
  return_callback_origin: "https://app.example.test",
};

describe("storage-mode INIT", () => {
  it("is keyless and remains keyless after sender-side scrubbing", () => {
    const maliciousRuntimeShape = {
      ...STORAGE_INIT,
      or_stealth_key_b64: "must-not-cross-origins",
    } as unknown as StealthInitStorageMessage;

    expect(assertNoKeyInAppMode(maliciousRuntimeShape)).toEqual(STORAGE_INIT);
  });

  it("makes a storage key unrepresentable in the protocol type", () => {
    const invalid: StealthInitStorageMessage = {
      ...STORAGE_INIT,
      // @ts-expect-error storage mode never carries the wallet sealing key
      or_stealth_key_b64: "must-not-compile",
    };
    expect(invalid.mode).toBe("storage");
  });
});
