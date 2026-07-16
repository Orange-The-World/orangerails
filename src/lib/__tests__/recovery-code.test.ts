/**
 * Tests for the recovery-code path in src/lib/vault.ts.
 *
 * The recovery code is the last way back into a vault once the password is
 * gone. If it breaks, it breaks silently: nothing throws, nothing alerts, and
 * the user only discovers it on the day they need it. So the properties it
 * rests on are pinned here rather than assumed.
 *
 * Covered:
 *   - the reachable word alphabet is exactly 256, which is the 96-bit
 *     entropy claim stated in the source
 *   - a generated code never contains an out-of-range artifact
 *   - a code wraps and unwraps a MEK back to the identical bytes
 *   - a different code cannot unwrap (AES-GCM must reject, not return junk)
 *   - normalization: case and whitespace variants of the same code derive
 *     the same key, because a human retyping twelve words will get both wrong
 */

import { describe, it, expect } from "vitest";
import {
  deriveRecoveryKek,
  generateMekBytes,
  generateRecoveryCode,
  unwrapMekBytes,
  wrapMekBytes,
} from "../vault";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

describe("recovery code: generation", () => {
  it("emits exactly 12 words", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateRecoveryCode().split(" ")).toHaveLength(12);
    }
  });

  /**
   * generateRecoveryCode maps a raw byte (0..255) onto the wordlist, so the
   * set of words it can ever emit is capped at 256 and every one of them is
   * equally likely. That reachable set IS the entropy claim: 12 words drawn
   * from 256 gives 12 * log2(256) = 96 bits.
   *
   * We measure it by sampling instead of by reading the array, because what
   * matters is what the function can actually produce. With 20k codes we draw
   * 240k words; the chance of never seeing a given word is (1 - 1/256)^240000,
   * which is around e^-937. Missing one is not a flake, it is a bug.
   *
   * The failure this guards against: if the wordlist is ever shortened below
   * 256, the high byte values index past the end, the word becomes the string
   * "undefined", and the effective alphabet silently shrinks. No exception is
   * thrown. Entropy drops and nothing tells anyone.
   */
  it("can only ever emit 256 distinct words, and never an out-of-range artifact", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) {
      for (const word of generateRecoveryCode().split(" ")) {
        seen.add(word);
      }
    }

    for (const word of seen) {
      expect(word).not.toBe("undefined");
      expect(word).toMatch(/^[a-z]+$/);
    }

    expect(seen.size).toBe(256);
  });
});

describe("recovery code: wrap and unwrap the MEK", () => {
  it("round trips a MEK back to the identical bytes", async () => {
    const mek = generateMekBytes();
    const code = generateRecoveryCode();

    const kek = await deriveRecoveryKek(code);
    const wrapped = await wrapMekBytes(mek, kek);

    // The wrapped MEK is what the server holds. It must not contain the key.
    expect(wrapped).not.toContain(code);

    const rekek = await deriveRecoveryKek(code);
    const unwrapped = await unwrapMekBytes(wrapped, rekek);

    expect(unwrapped).toHaveLength(32);
    expect(bytesEqual(unwrapped, mek)).toBe(true);
  });

  it("a different recovery code cannot unwrap", async () => {
    const mek = generateMekBytes();
    const right = await deriveRecoveryKek(generateRecoveryCode());
    const wrong = await deriveRecoveryKek(generateRecoveryCode());

    const wrapped = await wrapMekBytes(mek, right);

    // AES-GCM authenticates. A wrong key must throw, never hand back bytes.
    await expect(unwrapMekBytes(wrapped, wrong)).rejects.toBeDefined();
  });
});

describe("recovery code: normalization", () => {
  /**
   * A user recovering an account is reading twelve words off a piece of paper
   * they wrote months ago. They will type them in caps, or with a double
   * space, or with a stray leading space. deriveRecoveryKek normalizes before
   * hashing precisely so that still works.
   *
   * If a refactor drops that normalization, the symptom is indistinguishable
   * from "the user copied their words down wrong", so it would be diagnosed as
   * user error and never fixed. Pin it.
   */
  it("recovers a vault from a code retyped with different case and spacing", async () => {
    const mek = generateMekBytes();
    const code = generateRecoveryCode();

    const wrapped = await wrapMekBytes(mek, await deriveRecoveryKek(code));

    const asRetypedByAHuman = [
      code.toUpperCase(),
      `  ${code}  `,
      code.replace(/ /g, "   "),
      `\t${code.toUpperCase().replace(/ /g, "  ")}\n`,
    ];

    for (const variant of asRetypedByAHuman) {
      const kek = await deriveRecoveryKek(variant);
      const unwrapped = await unwrapMekBytes(wrapped, kek);
      expect(bytesEqual(unwrapped, mek)).toBe(true);
    }
  });

  it("does not normalize away a genuinely different code", async () => {
    const mek = generateMekBytes();
    const code = generateRecoveryCode();
    const wrapped = await wrapMekBytes(mek, await deriveRecoveryKek(code));

    // Same words, one of them swapped. Order is part of the secret.
    const words = code.split(" ");
    [words[0], words[1]] = [words[1], words[0]];
    const reordered = words.join(" ");

    if (reordered !== code) {
      const kek = await deriveRecoveryKek(reordered);
      await expect(unwrapMekBytes(wrapped, kek)).rejects.toBeDefined();
    }
  });
});
