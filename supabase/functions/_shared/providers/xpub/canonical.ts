/**
 * Canonicalization of SLIP-132 extended public keys (xpub / ypub / zpub).
 *
 * Extracted from the xpub adapter so the shared connector identity module can
 * import it directly, without pulling in the adapter's network client, address
 * scanner, or tx normalizer. This module is pure: no I/O, no state, no clock.
 *
 * Mainnet only in v1. Testnet prefixes (tpub / upub / vpub) are rejected, not
 * silently accepted: an unsupported prefix must fail loudly at connect time
 * rather than quietly derive addresses on the wrong network.
 *
 * READ THIS BEFORE BUILDING AN IDENTITY ON TOP OF IT.
 * Canonicalization deliberately DESTROYS the SLIP-132 prefix by rewriting the
 * version bytes to xpub. That is correct for derivation, because HDKey only
 * parses xpub. But it means a BIP44 account and a BIP84 account over identical
 * key bytes canonicalize to the SAME canonicalXpub while owning DISJOINT
 * address sets and disjoint transaction histories.
 *
 * Therefore: canonicalXpub alone is NOT an account identity. Any caller
 * computing an identity fingerprint MUST include scriptType in the input
 * alongside canonicalXpub, or two separate wallets dedupe into one and the user
 * silently loses an account. canonical_test.ts pins that collision so this
 * invariant cannot be lost by a future refactor.
 */

import { base58check } from 'https://esm.sh/@scure/base@1.1.7';
import { sha256 } from 'https://esm.sh/@noble/hashes@1.4.0/sha256';

export type ScriptType = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';

/**
 * Version-byte to script-type table. The extended key encodes its script type
 * in the 4-byte version prefix. We rewrite to xpub before handing the key to
 * HDKey.fromExtendedKey (which only knows xpub/xprv) and keep the original
 * script type so address derivation uses the right payment encoding.
 *
 * Version bytes from SLIP-132:
 * https://github.com/satoshilabs/slips/blob/master/slip-0132.md
 */
export const VERSION_TABLE: Record<string, { version: Uint8Array; scriptType: ScriptType }> = {
  xpub: { version: new Uint8Array([0x04, 0x88, 0xb2, 0x1e]), scriptType: 'p2pkh' },
  ypub: { version: new Uint8Array([0x04, 0x9d, 0x7c, 0xb2]), scriptType: 'p2sh-p2wpkh' },
  zpub: { version: new Uint8Array([0x04, 0xb2, 0x47, 0x46]), scriptType: 'p2wpkh' },
};

const b58check = base58check(sha256);

/**
 * Detect the prefix and return both the canonical xpub form (BIP44 version
 * bytes, parseable by HDKey.fromExtendedKey) and the original script type.
 *
 * Throws, never coerces, on: an unsupported prefix, a payload that fails
 * base58check, or a decoded body that is not exactly 78 bytes.
 */
export function normalizeExtendedPubkey(
  input: string,
): { canonicalXpub: string; scriptType: ScriptType } {
  const prefix = input.slice(0, 4);
  const cfg = VERSION_TABLE[prefix];
  if (!cfg) {
    throw new Error(
      `[xpub] unsupported extended-pubkey prefix '${prefix}' , supported: xpub, ypub, zpub`,
    );
  }

  // Decode base58check, swap version bytes to xpub (BIP44), re-encode.
  let decoded: Uint8Array;
  try {
    decoded = b58check.decode(input);
  } catch (err) {
    throw new Error(
      `[xpub] base58check decode failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (decoded.length !== 78) {
    throw new Error(`[xpub] decoded extended key has wrong length ${decoded.length} (expected 78)`);
  }
  const rewritten = new Uint8Array(decoded);
  rewritten.set(VERSION_TABLE.xpub.version, 0);
  return { canonicalXpub: b58check.encode(rewritten), scriptType: cfg.scriptType };
}
