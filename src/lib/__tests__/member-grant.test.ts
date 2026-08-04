/**
 * DL-0619 proof-only RED test.
 *
 * Requirement: when an admin adds a co-admin, the wrapped MEK grant handed to
 * that co-admin must be signed with the granting admin's ML-DSA-65 key, and the
 * read path must verify that signature before trusting the wrapped MEK.
 *
 * Today `signToBase64` has zero production callers and the co-admin wrap is
 * stored unsigned, so a party who can write the grant row can SUBSTITUTE a
 * different wrapped MEK and the app would accept it. That is the hole this test
 * closes.
 *
 * This pins the contract of the not-yet-built seam in `src/lib/member-grant.ts`.
 * It is RED until that helper and its production call sites land. When they do,
 * the substitution and unsigned cases below must fail for exactly one reason:
 * ML-DSA-65 signature verification returning false. The substituted grant uses a
 * wrapped MEK of the SAME LENGTH as the honest one, so no shape or length guard
 * can be what rejects it.
 */
import { describe, expect, it } from "vitest";
import { generateSigKeyPair } from "../signatures";
import { signMemberGrant, verifyMemberGrant } from "../member-grant";

/** Wrapped MEK is a hybrid KEM ciphertext blob; the exact length is not load-bearing here. */
const WRAPPED_MEK_BYTES = 1120;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function makeGrant(wrappedMekCiphertextB64: string) {
  return {
    memberUserId: "co-admin-user-id",
    workspaceKeyId: "ws-key-1",
    wrappedMekCiphertextB64,
  };
}

describe("DL-0619 co-admin wrapped-MEK grant must be ML-DSA-65 signed", () => {
  it("accepts a grant signed by the granting admin", async () => {
    const admin = generateSigKeyPair();
    const grant = makeGrant(bytesToBase64(randomBytes(WRAPPED_MEK_BYTES)));

    const { signature } = await signMemberGrant(admin.secretKey, grant);

    await expect(
      verifyMemberGrant(bytesToBase64(admin.publicKey), grant, signature),
    ).resolves.toBe(true);
  });

  it("REJECTS a grant whose wrapped MEK was substituted after signing (same length)", async () => {
    const admin = generateSigKeyPair();
    const honest = makeGrant(bytesToBase64(randomBytes(WRAPPED_MEK_BYTES)));

    const { signature } = await signMemberGrant(admin.secretKey, honest);

    // Attacker swaps in a DIFFERENT but equally valid, equally long wrapped MEK,
    // keeping the honest signature. Only signature verification can catch this.
    const substituted = makeGrant(bytesToBase64(randomBytes(WRAPPED_MEK_BYTES)));
    expect(substituted.wrappedMekCiphertextB64.length).toBe(
      honest.wrappedMekCiphertextB64.length,
    );

    await expect(
      verifyMemberGrant(bytesToBase64(admin.publicKey), substituted, signature),
    ).resolves.toBe(false);
  });

  it("REJECTS an unsigned grant (an empty signature is not a pass)", async () => {
    const admin = generateSigKeyPair();
    const grant = makeGrant(bytesToBase64(randomBytes(WRAPPED_MEK_BYTES)));

    await expect(
      verifyMemberGrant(bytesToBase64(admin.publicKey), grant, ""),
    ).resolves.toBe(false);
  });
});
