/**
 * DL-0619: signed co-admin member-grant.
 *
 * When an admin adds a co-admin, the co-admin is handed a wrapped MEK (the
 * master encryption key, re-wrapped to the co-admin's key). That wrapped MEK
 * must be signed with the granting admin's ML-DSA-65 key, and the read path
 * must verify that signature before trusting the wrapped MEK. The signature
 * covers a domain-separated canonical message that binds the wrapped MEK to
 * the member id and the workspace key id together, so a wrapped MEK the
 * granting admin did not sign does not verify, whatever its length.
 *
 * The granting admin's secret key is client-side only (same custody as every
 * other user key). Verification needs the admin's public key and the signature
 * and nothing else, so no secret that could produce a valid grant is required
 * outside the client.
 */

import { signToBase64, verifyFromBase64 } from "./signatures";

/** A co-admin grant: the wrapped MEK plus the identifiers it is bound to. */
export interface MemberGrant {
  memberUserId: string;
  workspaceKeyId: string;
  wrappedMekCiphertextB64: string;
}

export interface SignedMemberGrant {
  signature: string;
  algorithm: string;
}

/**
 * Canonical, domain-separated bytes that a grant signature covers.
 *
 * JSON.stringify of a fixed-order array gives a deterministic, injection-safe
 * encoding: field order is pinned, and JSON escaping means no field value can
 * spoof a delimiter or bleed into an adjacent field. The leading domain tag
 * stops a signature over this payload from ever being replayed as a signature
 * over some other ml-dsa-65 message in the app.
 */
function canonicalGrantMessage(grant: MemberGrant): string {
  return JSON.stringify([
    "orangerails.member-grant.v1",
    grant.memberUserId,
    grant.workspaceKeyId,
    grant.wrappedMekCiphertextB64,
  ]);
}

/** Sign a co-admin grant with the granting admin's ML-DSA-65 secret key. */
export async function signMemberGrant(
  secretKey: Uint8Array,
  grant: MemberGrant,
): Promise<SignedMemberGrant> {
  return signToBase64(secretKey, canonicalGrantMessage(grant));
}

/**
 * Verify a co-admin grant against the granting admin's ML-DSA-65 public key.
 *
 * Returns false (never throws) for an empty or malformed signature, so an
 * unsigned grant and a substituted wrapped MEK are both hard rejects rather
 * than errors that a caller might mistake for a pass.
 */
export async function verifyMemberGrant(
  adminPublicKeyB64: string,
  grant: MemberGrant,
  signatureB64: string,
): Promise<boolean> {
  if (!signatureB64) return false;
  try {
    return await verifyFromBase64(
      adminPublicKeyB64,
      canonicalGrantMessage(grant),
      signatureB64,
    );
  } catch {
    return false;
  }
}
