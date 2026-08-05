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

import { signBytesToBase64, verifyBytesFromBase64 } from "./signatures";

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

const _enc = new TextEncoder();

/**
 * encode(s) = uint32BE(utf8ByteLength(s)) || utf8Bytes(s)
 * A zero-length field produces a 4-byte 0x00000000 prefix,
 * distinguishable from absence and not silently dropped.
 */
function _lenField(s: string): Uint8Array {
  const utf8 = _enc.encode(s);
  const field = new Uint8Array(4 + utf8.length);
  new DataView(field.buffer).setUint32(0, utf8.length, false /* big-endian */);
  field.set(utf8, 4);
  return field;
}

/**
 * Canonical, domain-separated bytes that a grant signature covers.
 *
 * Length-prefixed raw-byte encoding: no JSON, no library trust beyond
 * TextEncoder. Fields are fixed-order; each is prefixed by its 4-byte
 * big-endian UTF-8 byte-length so no field value can spoof a delimiter
 * or bleed into an adjacent field.
 *
 * Layout: encode(ctx) || encode(memberUserId) || encode(workspaceKeyId) || encode(wrappedMekCiphertextB64)
 */
function canonicalGrantBytes(grant: MemberGrant): Uint8Array {
  const parts = [
    _lenField("orangerails:add-member:mek-wrap:v1"),
    _lenField(grant.memberUserId),
    _lenField(grant.workspaceKeyId),
    _lenField(grant.wrappedMekCiphertextB64),
  ];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Sign a co-admin grant with the granting admin's ML-DSA-65 secret key. */
export async function signMemberGrant(
  secretKey: Uint8Array,
  grant: MemberGrant,
): Promise<SignedMemberGrant> {
  return signBytesToBase64(secretKey, canonicalGrantBytes(grant));
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
    return await verifyBytesFromBase64(
      adminPublicKeyB64,
      canonicalGrantBytes(grant),
      signatureB64,
    );
  } catch {
    return false;
  }
}
