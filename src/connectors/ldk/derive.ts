/**
 * Orange Rails, LDK connector — client-side key derivation.
 *
 * SCAFFOLD, pre-audit. Mirrors `src/stealth/lib/derive.ts`. All derivation is
 * client-only, deterministic from the client MEK, with NO server-issued salt.
 * Gate criteria (a)/(b): seed/entropy never crosses the client boundary; the
 * envelope key is derived here and never leaves the device.
 */

const LDK_INFO = 'or-ldk-v1' as const;

/**
 * Derive the LDK envelope key from the client Master Encryption Key.
 *
 * HKDF-SHA-256(ikm = mek, salt = none, info = 'or-ldk-v1') -> 32 bytes.
 * Deterministic and client-only, exactly the scheme Stealth Sync uses with
 * info 'or-stealth-v1' (Sr. Developer msg 913, Developer msg 915).
 *
 * TODO(impl): back this with the same WebCrypto HKDF primitive derive.ts uses;
 * this stub only fixes the interface + the info string so the ZKA boundary is
 * unambiguous for the Auditor gate.
 */
export async function deriveOrLdkKey(_mek: Uint8Array): Promise<Uint8Array> {
  throw new Error(
    "deriveOrLdkKey: scaffold only. Pending (a)-(e) audit gate before crypto lands. " +
      `info='${LDK_INFO}', HKDF-SHA-256, client-only, no server salt.`,
  );
}

/**
 * Derive the blind-index key (separate from the envelope key by domain
 * separation in the info string) used to compute HMAC-SHA-256 blind indexes
 * over the funding outpoint. Client-only.
 */
export async function deriveOrLdkIndexKey(_mek: Uint8Array): Promise<Uint8Array> {
  throw new Error(
    "deriveOrLdkIndexKey: scaffold only. Pending (a)-(e) audit gate before crypto lands.",
  );
}

export { LDK_INFO };
