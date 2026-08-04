/**
 * DL-0619 - Member grant signing and verification.
 *
 * The granting admin signs a canonical grant message client-side using
 * ML-DSA-65. The server stores only the admin's public key and the
 * signature; it never sees any plaintext MEK or the admin's secret key
 * (ZKA intact).
 *
 * Canonical message: "v1:{memberUserId}:{workspaceKeyId}:{sha256B64(wrappedMekCiphertextB64)}"
 *   - memberUserId:     the grantee's user id
 *   - workspaceKeyId:   the key slot this grant is for
 *   - sha256B64(blob):  SHA-256 of the wrapped-MEK ciphertext (base64),
 *                       binding the ciphertext so a same-length substitution
 *                       changes the message and invalidates the signature
 */

import { signToBase64, verifyFromBase64 } from "./signatures";

export interface MemberGrant {
  /** The user id of the co-admin being granted access. */
  memberUserId: string;
  /** The workspace key slot this grant is for. */
  workspaceKeyId: string;
  /** The wrapped MEK ciphertext, base64-encoded. */
  wrappedMekCiphertextB64: string;
}

/** SHA-256 of a UTF-8 string, returned as base64. Client-side only (Web Crypto). */
async function sha256B64(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const hashBuf = await crypto.subtle.digest("SHA-256", bytes);
  let binary = "";
  for (const b of new Uint8Array(hashBuf)) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Canonical message that is both signed and verified.
 *
 * Binding a SHA-256 hash of the wrapped MEK ciphertext means a substituted
 * ciphertext (even one of the same length) changes the message and
 * invalidates the ML-DSA-65 signature.
 */
async function canonicalMessage(grant: MemberGrant): Promise<string> {
  const ciphertextHash = await sha256B64(grant.wrappedMekCiphertextB64);
  return `v1:${grant.memberUserId}:${grant.workspaceKeyId}:${ciphertextHash}`;
}

/**
 * Sign a member grant with the granting admin's ML-DSA-65 secret key.
 *
 * Client-side only. The secret key never leaves the browser.
 *
 * @param adminSecretKey  The granting admin's ML-DSA-65 secret key.
 * @param grant           The grant to sign.
 * @returns               Base64 signature and algorithm identifier to store on the grant row.
 */
export async function signMemberGrant(
  adminSecretKey: Uint8Array,
  grant: MemberGrant,
): Promise<{ signature: string; algorithm: string }> {
  const message = await canonicalMessage(grant);
  return signToBase64(adminSecretKey, message);
}

/**
 * Verify a member grant signature.
 *
 * Fails closed: returns false (never throws) for all absence cases and
 * tamper cases:
 *   - signature is empty or absent
 *   - adminPublicKeyB64 is empty or absent
 *   - algorithm field is unrecognised (caught, mapped to false)
 *   - signature does not verify against the canonical grant message
 *   - wrapped MEK ciphertext was substituted (same-length or any other)
 *
 * There is no fallthrough to an unsigned path.
 *
 * @param adminPublicKeyB64  The granting admin's ML-DSA-65 public key (base64).
 * @param grant              The grant as stored.
 * @param signature          The base64 signature stored on the grant row.
 */
export async function verifyMemberGrant(
  adminPublicKeyB64: string,
  grant: MemberGrant,
  signature: string,
): Promise<boolean> {
  // Absence cases: all three hard-refuse, no fallthrough.
  if (!adminPublicKeyB64 || !signature) {
    return false;
  }
  try {
    const message = await canonicalMessage(grant);
    return await verifyFromBase64(adminPublicKeyB64, message, signature);
  } catch {
    // Unrecognised algorithm, malformed key, or malformed signature: fail closed.
    return false;
  }
}
