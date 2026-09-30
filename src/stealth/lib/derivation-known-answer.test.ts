import { describe, expect, it } from "vitest";
import { STEALTH_HKDF_INFO, deriveOrStealthKey } from "@/stealth/lib/postmessage";
import { BLIND_INDEX_INFO, computeTxidBlindIndex } from "@/stealth/lib/seal";

// Known answer tests for the two derivations the widget and the app must agree
// on. The expected values below were NOT produced by the code under test. They
// were computed with an independent HMAC-SHA-256 implementation that follows
// RFC 5869 (HKDF with an empty salt, which is 32 zero bytes; for a 32 byte
// output the result is the first block, HMAC(PRK, info || 0x01)). That
// implementation was first checked against the published RFC 5869 test vectors.
// Changing a label or the derivation must make these tests fail.

// Fixed input key material: the 32 bytes 0x00 through 0x1f.
const IKM = Uint8Array.from({ length: 32 }, (_, i) => i);
const IKM_B64 = btoa(String.fromCharCode(...IKM));

// A canonical txid: 64 lowercase hex characters.
const TXID = "0123456789abcdef".repeat(4);

// HKDF-SHA256(IKM, salt = empty, info = "or-stealth-v1", L = 32), base64.
const EXPECTED_STEALTH_KEY_B64 = "6yggPzmRGL8EWsoX8ZHv8T56xxNcckQ/d03qaMeFiII=";

// HMAC-SHA256(HKDF-SHA256(IKM, empty, "or-stealth/blind-index/v1", 32), txid), hex.
const EXPECTED_BLIND_INDEX_HEX =
  "b704e9fbce4140622041d6940b573f23ca5162e82b5fc3532e2584a276c6e055";

describe("stealth derivation known answers", () => {
  it("pins the two derivation label strings", () => {
    expect(STEALTH_HKDF_INFO).toBe("or-stealth-v1");
    expect(BLIND_INDEX_INFO).toBe("or-stealth/blind-index/v1");
  });

  it("derives the stealth key to the independently computed value", async () => {
    // deriveOrStealthKey exports the master key, so it must be extractable.
    const mek = await crypto.subtle.importKey(
      "raw",
      IKM.slice(),
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
    expect(await deriveOrStealthKey(mek)).toBe(EXPECTED_STEALTH_KEY_B64);
  });

  it("derives the txid blind index to the independently computed value", async () => {
    expect(await computeTxidBlindIndex(TXID, IKM_B64)).toBe(EXPECTED_BLIND_INDEX_HEX);
  });
});
