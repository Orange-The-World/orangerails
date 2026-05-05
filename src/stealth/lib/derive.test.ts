/**
 * BIP32 derivation, address encoding, and output-descriptor tests.
 *
 * The single-key cases test against the canonical BIP84, BIP49, and
 * BIP86 test vectors (account-level xpubs, derive m/account/0/0 + 0/1).
 *
 * The multisig case tests our descriptor parser + derivation end-to-end:
 * we confirm `sortedmulti` reorders the cosigners (BIP67), that the
 * three wrappers (wsh, sh-wsh, sh) produce addresses with the right
 * shape and prefix, and that derivations are deterministic.
 */

import { describe, expect, it } from "vitest";

import {
  deriveAddress,
  deriveMultisigAddress,
  deriveMultisigScriptPubkeyBytes,
  detectScriptType,
  gapLimitWalk,
  parseDescriptor,
} from "./derive";

// ─── BIP test vectors ────────────────────────────────────────────────────
//
// All three are produced from the canonical BIP test mnemonic:
//   "abandon abandon abandon abandon abandon abandon abandon abandon
//    abandon abandon abandon about"
// no passphrase. Account 0. The xpubs below are the account-level
// extended public keys at m/PURPOSE'/0'/0'.

// BIP84 / native segwit / zpub
// Source: https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki
const BIP84_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const BIP84_RECEIVE_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const BIP84_RECEIVE_1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const BIP84_CHANGE_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";

// BIP49 / wrapped segwit / ypub
// Source: https://github.com/bitcoin/bips/blob/master/bip-0049.mediawiki
// (account xpub re-encoded under the BIP49 ypub version bytes; receive 0
// matches the BIP49 spec address.)
const BIP49_YPUB =
  "ypub6Ww3ibxVfGzLrAH1PNcjyAWenMTbbAosGNB6VvmSEgytSER9azLDWCxoJwW7Ke7icmizBMXrzBx9979FfaHxHcrArf3zbeJJJUZPf663zsP";
const BIP49_RECEIVE_0 = "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf";

// BIP86 / taproot single-key / standard xpub at m/86'/0'/0'
// Source: https://github.com/bitcoin/bips/blob/master/bip-0086.mediawiki
const BIP86_XPUB =
  "xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ";
const BIP86_RECEIVE_0 =
  "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
const BIP86_RECEIVE_1 =
  "bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh";

describe("detectScriptType", () => {
  it("maps SLIP-132 prefixes to the right script types", () => {
    expect(detectScriptType(BIP84_ZPUB)).toBe("p2wpkh");
    expect(detectScriptType(BIP49_YPUB)).toBe("p2sh-p2wpkh");
    expect(detectScriptType(BIP86_XPUB)).toBe("p2pkh");
  });
});

// Same key bytes as BIP84_ZPUB above, but re-encoded with the standard
// `xpub` SLIP-132 version prefix. This is the shape Sparrow Wallet
// frequently exports for BIP84 wallets, and it is what motivated the
// script-type picker in the add-wallet widget. The underlying BIP32
// chain code and pubkey are identical to BIP84_ZPUB, so forcing
// `p2wpkh` derivation must produce the same addresses as the canonical
// vector. This locks in the explicit-script-type override path.
const BIP84_AS_XPUB =
  "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";

describe("deriveAddress — single key", () => {
  it("matches the BIP84 (P2WPKH) test vector for receive 0 and 1", () => {
    expect(deriveAddress(BIP84_ZPUB, 0, 0, "p2wpkh")).toBe(BIP84_RECEIVE_0);
    expect(deriveAddress(BIP84_ZPUB, 0, 1, "p2wpkh")).toBe(BIP84_RECEIVE_1);
  });

  it("matches the BIP84 vector when the same key is given with an xpub prefix and forced to p2wpkh", () => {
    // Sanity: the bare prefix would default to legacy.
    expect(detectScriptType(BIP84_AS_XPUB)).toBe("p2pkh");
    // But once the caller overrides the script type to p2wpkh (as the
    // widget's wallet-type picker does), the addresses must match the
    // canonical zpub-prefix BIP84 receive chain.
    expect(deriveAddress(BIP84_AS_XPUB, 0, 0, "p2wpkh")).toBe(BIP84_RECEIVE_0);
    expect(deriveAddress(BIP84_AS_XPUB, 0, 1, "p2wpkh")).toBe(BIP84_RECEIVE_1);
    expect(deriveAddress(BIP84_AS_XPUB, 1, 0, "p2wpkh")).toBe(BIP84_CHANGE_0);
  });

  it("matches the BIP84 change-chain receive 0", () => {
    expect(deriveAddress(BIP84_ZPUB, 1, 0, "p2wpkh")).toBe(BIP84_CHANGE_0);
  });

  it("matches the BIP49 (P2SH-P2WPKH) test vector for receive 0", () => {
    expect(deriveAddress(BIP49_YPUB, 0, 0, "p2sh-p2wpkh")).toBe(
      BIP49_RECEIVE_0,
    );
  });

  it("matches the BIP86 (P2TR) test vector for receive 0 and 1", () => {
    expect(deriveAddress(BIP86_XPUB, 0, 0, "p2tr")).toBe(BIP86_RECEIVE_0);
    expect(deriveAddress(BIP86_XPUB, 0, 1, "p2tr")).toBe(BIP86_RECEIVE_1);
  });
});

describe("parseDescriptor — single key shapes", () => {
  it("accepts a bare zpub", () => {
    const d = parseDescriptor(BIP84_ZPUB);
    expect(d.kind).toBe("single");
    expect(d.keys[0].xpub).toBe(BIP84_ZPUB);
    expect(d.keys[0].scriptType).toBe("p2wpkh");
  });

  it("accepts wpkh(<xpub>)", () => {
    const d = parseDescriptor(`wpkh(${BIP84_ZPUB})`);
    expect(d.kind).toBe("single");
    expect(d.keys[0].scriptType).toBe("p2wpkh");
  });

  it("accepts tr(<xpub>)", () => {
    const d = parseDescriptor(`tr(${BIP86_XPUB})`);
    expect(d.kind).toBe("single");
    expect(d.keys[0].scriptType).toBe("p2tr");
  });

  it("accepts sh(wpkh(<ypub>))", () => {
    const d = parseDescriptor(`sh(wpkh(${BIP49_YPUB}))`);
    expect(d.kind).toBe("single");
    expect(d.keys[0].scriptType).toBe("p2sh-p2wpkh");
  });

  it("strips a checksum suffix", () => {
    const d = parseDescriptor(`${BIP84_ZPUB}#abcdefgh`);
    expect(d.kind).toBe("single");
    expect(d.keys[0].xpub).toBe(BIP84_ZPUB);
  });

  it("rejects hardened steps in the suffix", () => {
    expect(() => parseDescriptor(`wpkh(${BIP84_ZPUB}/0'/*)`)).toThrow();
  });

  it("rejects unsupported wrappers", () => {
    expect(() => parseDescriptor(`combo(${BIP84_ZPUB})`)).toThrow();
  });
});

// ─── Multisig tests ──────────────────────────────────────────────────────

// Use two distinct BIP test xpubs as cosigners. The actual multisig key
// material does not need to come from the BIP48 spec for our purposes:
// what we are testing is that `parseDescriptor` returns the right shape,
// that wsh / sh-wsh / sh produce addresses with the right prefix and
// length, and that sortedmulti reorders the cosigners (BIP67) so that the
// resulting address is independent of the order keys are listed in.
const COSIGNER_A = BIP84_ZPUB;
const COSIGNER_B = BIP86_XPUB;

describe("parseDescriptor — multisig shapes", () => {
  it("parses wsh(multi(2,A,B))", () => {
    const d = parseDescriptor(`wsh(multi(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*))`);
    expect(d.kind).toBe("multisig");
    expect(d.m).toBe(2);
    expect(d.n).toBe(2);
    expect(d.sorted).toBe(false);
    expect(d.scriptWrapper).toBe("wsh");
  });

  it("parses sh(wsh(sortedmulti(2,A,B)))", () => {
    const d = parseDescriptor(
      `sh(wsh(sortedmulti(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*)))`,
    );
    expect(d.kind).toBe("multisig");
    expect(d.sorted).toBe(true);
    expect(d.scriptWrapper).toBe("sh-wsh");
  });

  it("parses sh(multi(2,A,B)) — legacy P2SH multisig", () => {
    const d = parseDescriptor(`sh(multi(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*))`);
    expect(d.kind).toBe("multisig");
    expect(d.scriptWrapper).toBe("sh");
  });

  it("rejects sortedmulti with M > N", () => {
    expect(() =>
      parseDescriptor(`wsh(sortedmulti(3,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*))`),
    ).toThrow();
  });
});

describe("deriveMultisigAddress", () => {
  it("wsh produces a bech32 P2WSH address (62 chars, bc1q…)", () => {
    const d = parseDescriptor(
      `wsh(sortedmulti(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*))`,
    );
    const addr = deriveMultisigAddress(d, 0, 0);
    expect(addr).toMatch(/^bc1q/);
    expect(addr.length).toBe(62);
  });

  it("sh-wsh produces a P2SH address (starts with 3, base58)", () => {
    const d = parseDescriptor(
      `sh(wsh(sortedmulti(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*)))`,
    );
    const addr = deriveMultisigAddress(d, 0, 0);
    expect(addr.startsWith("3")).toBe(true);
  });

  it("sh produces a P2SH address (starts with 3)", () => {
    const d = parseDescriptor(
      `sh(sortedmulti(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*))`,
    );
    const addr = deriveMultisigAddress(d, 0, 0);
    expect(addr.startsWith("3")).toBe(true);
  });

  it("sortedmulti is order-independent (BIP67)", () => {
    const ab = parseDescriptor(
      `wsh(sortedmulti(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*))`,
    );
    const ba = parseDescriptor(
      `wsh(sortedmulti(2,${COSIGNER_B}/0/*,${COSIGNER_A}/0/*))`,
    );
    expect(deriveMultisigAddress(ab, 0, 0)).toBe(
      deriveMultisigAddress(ba, 0, 0),
    );
  });

  it("plain multi() is order-dependent", () => {
    const ab = parseDescriptor(
      `wsh(multi(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*))`,
    );
    const ba = parseDescriptor(
      `wsh(multi(2,${COSIGNER_B}/0/*,${COSIGNER_A}/0/*))`,
    );
    expect(deriveMultisigAddress(ab, 0, 0)).not.toBe(
      deriveMultisigAddress(ba, 0, 0),
    );
  });

  it("script-pubkey bytes start with 0x0020 for wsh (P2WSH)", () => {
    const d = parseDescriptor(
      `wsh(sortedmulti(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*))`,
    );
    const spk = deriveMultisigScriptPubkeyBytes(d, 0, 0);
    expect(spk[0]).toBe(0x00);
    expect(spk[1]).toBe(0x20);
    expect(spk.length).toBe(34);
  });
});

// ─── gapLimitWalk smoke test (single + multisig) ────────────────────────

describe("gapLimitWalk", () => {
  it("walks until gap_limit empty addresses are seen (single key)", async () => {
    const seen: string[] = [];
    const used = new Set<number>([0, 3]); // mark indexes 0 and 3 as used
    const { addresses } = await gapLimitWalk(
      { extendedKey: BIP84_ZPUB, scriptType: "p2wpkh" },
      0,
      3, // gap limit
      async (addr) => {
        seen.push(addr);
        const i = seen.length - 1;
        return used.has(i);
      },
    );
    // Expected: scan up to index 3 (used) + 3 more (gap limit) = 7 addresses.
    expect(addresses.length).toBe(7);
    expect(addresses[0]).toBe(BIP84_RECEIVE_0);
  });

  it("walks a multisig descriptor", async () => {
    const desc = parseDescriptor(
      `wsh(sortedmulti(2,${COSIGNER_A}/0/*,${COSIGNER_B}/0/*))`,
    );
    const { addresses } = await gapLimitWalk(
      { descriptor: desc },
      0,
      2, // small gap limit so the loop terminates quickly
      async () => false,
    );
    // No activity → walk stops after gap_limit empty addresses.
    expect(addresses.length).toBe(2);
    for (const a of addresses) {
      expect(a).toMatch(/^bc1q/);
      expect(a.length).toBe(62);
    }
  });
});
