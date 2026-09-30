import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VaultProvider, useVault } from "./VaultContext";
import {
  generateVaultSalt,
  deriveKek,
  wrapMekBytes,
  importMekAsHkdf,
  createVaultVerifier,
  CURRENT_VAULT_KEY_VERSION,
} from "@/lib/vault";
import { deriveVerifierKey } from "@/lib/key-derivation";

// Runs the real unlock and exportStealthKeyForWidget path on a fixed master key
// and compares with the independently computed known answer used in
// src/stealth/lib/derivation-known-answer.test.ts (same 32 byte input, same
// label, HKDF-SHA256 with an empty salt). No mocks: this is the code a customer
// hits. A plain server render captures the live useVault() value; the refs that
// unlock sets are real, and state setters are no-ops on the server renderer.

const PASSWORD = "xk4$Qzrmw9!bLpVt2h";
const MEK_BYTES = Uint8Array.from({ length: 32 }, (_, i) => i);
const EXPECTED_STEALTH_KEY_B64 = "6yggPzmRGL8EWsoX8ZHv8T56xxNcckQ/d03qaMeFiII=";

type VaultContextValue = ReturnType<typeof useVault>;

function captureVaultContextValue(): VaultContextValue {
  let captured: VaultContextValue | undefined;
  function Capture() {
    captured = useVault();
    return null;
  }
  renderToStaticMarkup(createElement(VaultProvider, null, createElement(Capture)));
  if (!captured) throw new Error("useVault() did not run during the capture render.");
  return captured;
}

describe("exportStealthKeyForWidget", () => {
  it("returns the independently computed stealth key for a fixed master key", async () => {
    const storedSaltB64 = generateVaultSalt();
    const kek = await deriveKek(PASSWORD, storedSaltB64);
    const encMekCiphertext = await wrapMekBytes(MEK_BYTES.slice(), kek);
    const mek = await importMekAsHkdf(MEK_BYTES.slice());
    const verifierKey = await deriveVerifierKey(mek, storedSaltB64);
    const verifierCiphertext = await createVaultVerifier(verifierKey);

    const vault = captureVaultContextValue();
    const unlocked = await vault.unlock(
      PASSWORD,
      storedSaltB64,
      verifierCiphertext,
      CURRENT_VAULT_KEY_VERSION,
      encMekCiphertext,
    );
    expect(unlocked).toBe(true);

    expect(await vault.exportStealthKeyForWidget()).toBe(EXPECTED_STEALTH_KEY_B64);
  }, 60_000);
});
