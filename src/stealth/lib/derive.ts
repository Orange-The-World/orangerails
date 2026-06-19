/**
 * BIP32 child-key derivation and BIP44 / BIP49 / BIP84 / BIP86 address
 * encoding, in pure browser TypeScript.
 *
 * The server-side adapter at `supabase/functions/_shared/providers/xpub/index.ts`
 * uses `@scure/bip32` and `@scure/btc-signer` from esm.sh. We can't pull
 * those into the browser bundle (no new npm dependencies allowed at this
 * milestone), so this module re-implements the slice we need on top of
 * `@noble/curves/secp256k1` and `@noble/hashes`, both of which are already
 * present transitively via `@noble/post-quantum`.
 *
 * Scope:
 *   - SLIP-132 prefix detection (xpub/ypub/zpub) plus BIP86 P2TR
 *   - Non-hardened BIP32 child derivation (m/chain/index for chain in {0,1})
 *   - Address encoding for P2PKH, P2SH-P2WPKH, P2WPKH, P2TR
 *   - Script-pubkey bytes for the BIP158 matcher
 *   - BIP44 gap-limit walk
 *
 * Out of scope right now (deferred to milestone 2B):
 *   - Multisig descriptors. `parseDescriptor()` is a TODO stub.
 *   - Hardened derivation (the watch-only xpub doesn't have the secret
 *     anyway, so this is correct).
 *   - Testnet xpubs (tpub/upub/vpub). The version table only lists
 *     mainnet today; adding testnet is one row each.
 *
 * References:
 *   - BIP32: https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
 *   - SLIP-132: https://github.com/satoshilabs/slips/blob/master/slip-0132.md
 *   - BIP86 (taproot single-key): https://github.com/bitcoin/bips/blob/master/bip-0086.mediawiki
 *   - bech32 / bech32m: https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki
 *     and https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki
 */

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";

// ─── Public types ────────────────────────────────────────────────────────

export type ScriptType = "p2pkh" | "p2sh-p2wpkh" | "p2wpkh" | "p2tr";

/**
 * A parsed output descriptor or bare extended key. The widget consumes
 * either shape uniformly.
 *
 * `single`     One xpub. The script type comes from the SLIP-132 prefix
 *              or, for taproot, from a `tr(...)` wrapper in a descriptor.
 * `multisig`   M-of-N descriptor. `keys[*]` carry the underlying xpubs and
 *              the receive/change derivation suffix (e.g. `/0/*`).
 */
export interface ParsedDescriptor {
  kind: "single" | "multisig";
  /** Outermost script wrapper for a multisig (wsh, sh-wsh, sh). Single-key
   *  inputs leave this undefined. */
  scriptWrapper?: "wsh" | "sh-wsh" | "sh";
  /** M and N for multisig. Undefined for single. */
  m?: number;
  n?: number;
  /** Whether the multi() variant is sortedmulti (BIP67). Defaults to false. */
  sorted?: boolean;
  keys: ParsedKey[];
}

export interface ParsedKey {
  /** Bare extended public key (xpub / ypub / zpub). */
  xpub: string;
  /** The script type to use when deriving leaves from this key alone.
   *  For a single-key input this drives `deriveScriptPubkeyBytes`. For a
   *  multisig it is informational. */
  scriptType: ScriptType;
  /**
   * The derivation suffix attached to the key in the descriptor. We support
   * the common `/0/*` / `/1/*` chain pattern and a bare `/*` (which means
   * "the chain is supplied at derivation time"). Hardened steps (`'`) in
   * the suffix are rejected because watch-only xpubs cannot do hardened.
   */
  derivationPath: string;
  /** Optional master fingerprint + derivation prefix from `[xfp/path]`. We
   *  parse and preserve it but do not use it for derivation; consumers may
   *  display it for verification. */
  origin?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

// SLIP-132 version-byte table. The 4-byte big-endian prefix at the start of
// the 78-byte serialized extended key tells us which payment encoding the
// wallet meant when it published the xpub.
//
// See https://github.com/satoshilabs/slips/blob/master/slip-0132.md.
const VERSION_TABLE: Record<string, { bytes: Uint8Array; scriptType: ScriptType }> = {
  // BIP44 P2PKH legacy
  xpub: { bytes: new Uint8Array([0x04, 0x88, 0xb2, 0x1e]), scriptType: "p2pkh" },
  // BIP49 P2SH-wrapped P2WPKH
  ypub: { bytes: new Uint8Array([0x04, 0x9d, 0x7c, 0xb2]), scriptType: "p2sh-p2wpkh" },
  // BIP84 P2WPKH native segwit
  zpub: { bytes: new Uint8Array([0x04, 0xb2, 0x47, 0x46]), scriptType: "p2wpkh" },
};

// secp256k1 curve order. Per BIP32 we reject `IL >= n` derivations and
// retry with the next index; in practice this never fires.
const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Tell which payment encoding the extended key was published for, based on
 * its 4-byte SLIP-132 version prefix.
 *
 * BIP86 / P2TR is detected via a derivation hint embedded in the xpub
 * itself only when the wallet uses the standard `xpub` prefix and we
 * cannot tell taproot from legacy from the prefix alone. To keep the
 * detection unambiguous, callers who want taproot must override the
 * detected type with `'p2tr'` explicitly. The current heuristic returns
 * `p2pkh` for `xpub`, `p2sh-p2wpkh` for `ypub`, `p2wpkh` for `zpub`.
 *
 * Throws if the prefix is unknown.
 */
export function detectScriptType(extendedKey: string): ScriptType {
  const prefix = extendedKey.slice(0, 4);
  const cfg = VERSION_TABLE[prefix];
  if (!cfg) {
    throw new Error(
      `Unsupported extended-key prefix '${prefix}'. Supported today: ` +
        `xpub (BIP44 legacy), ypub (BIP49 wrapped segwit), zpub (BIP84 native segwit). ` +
        `For BIP86 taproot, paste an xpub and pass scriptType='p2tr' explicitly.`,
    );
  }
  return cfg.scriptType;
}

/**
 * Derive the address at `m/chain/index` from the given extended public
 * key, encoded for the given script type.
 *
 * `chain` is 0 for the receive chain or 1 for the change chain. `index`
 * is the leaf index. Both must be non-hardened (a watch-only xpub cannot
 * derive hardened children anyway).
 */
export function deriveAddress(
  extendedKey: string,
  chain: 0 | 1,
  index: number,
  scriptType: ScriptType,
): string {
  const child = deriveChildPub(extendedKey, chain, index);
  return encodeAddress(child, scriptType);
}

/**
 * Same derivation, but return the raw script-pubkey bytes that go on-chain.
 * The BIP158 matcher needs script-pubkey bytes, not addresses.
 */
export function deriveScriptPubkeyBytes(
  extendedKey: string,
  chain: 0 | 1,
  index: number,
  scriptType: ScriptType,
): Uint8Array {
  const child = deriveChildPub(extendedKey, chain, index);
  return scriptPubkey(child, scriptType);
}

/**
 * Walk one chain (receive or change) sequentially until we have seen
 * `gapLimit` consecutive empty addresses, then stop. This is the BIP44
 * gap-limit semantics that every reasonable wallet uses.
 *
 * Accepts either a bare extended public key + script type (single-key
 * wallets) OR a parsed descriptor (multisig). For multisig the script
 * pubkey is the P2WSH / P2SH-P2WSH / P2SH wrap of the multi() redeem.
 *
 * The caller passes `hasActivity(addr)` so this module stays free of any
 * particular indexer (mempool.space, Esplora, BIP158 filter scan, etc.).
 */
export async function gapLimitWalk(
  source:
    | { extendedKey: string; scriptType: ScriptType }
    | { descriptor: ParsedDescriptor },
  chain: 0 | 1,
  gapLimit: number,
  hasActivity: (addr: string) => Promise<boolean>,
): Promise<{ addresses: string[]; scriptPubkeys: Uint8Array[] }> {
  if (gapLimit < 1) {
    throw new Error(`gapLimit must be at least 1, got ${gapLimit}`);
  }
  // Hard cap to protect against a wallet with weirdly-shaped gaps.
  const MAX_INDEX = 10_000;

  const addresses: string[] = [];
  const scriptPubkeys: Uint8Array[] = [];
  let lastUsedIdx = -1;
  let i = 0;

  while (i - lastUsedIdx <= gapLimit && i < MAX_INDEX) {
    let addr: string;
    let spk: Uint8Array;
    if ("descriptor" in source) {
      addr = deriveMultisigAddress(source.descriptor, chain, i);
      spk = deriveMultisigScriptPubkeyBytes(source.descriptor, chain, i);
    } else {
      const child = deriveChildPub(source.extendedKey, chain, i);
      addr = encodeAddress(child, source.scriptType);
      spk = scriptPubkey(child, source.scriptType);
    }
    addresses.push(addr);
    scriptPubkeys.push(spk);
    if (await hasActivity(addr)) {
      lastUsedIdx = i;
    }
    i++;
  }

  return { addresses, scriptPubkeys };
}

// ─── Output-descriptor parsing ───────────────────────────────────────────

/**
 * Parse a Bitcoin output descriptor string OR a bare extended public key.
 *
 * Supported shapes:
 *   - bare 'xpub...' / 'ypub...' / 'zpub...' (legacy / segwit / native segwit)
 *   - 'pkh(xpub...)'           (legacy single-key, BIP44)
 *   - 'sh(wpkh(xpub...))'      (wrapped segwit single-key, BIP49)
 *   - 'wpkh(xpub...)'          (native segwit single-key, BIP84)
 *   - 'tr(xpub...)'            (taproot single-key, BIP86)
 *   - 'wsh(multi(M,KEY,...))'  / 'wsh(sortedmulti(M,KEY,...))'
 *   - 'sh(wsh(multi(M,KEY,...)))' / 'sh(wsh(sortedmulti(M,KEY,...)))'
 *   - 'sh(multi(M,KEY,...))'   / 'sh(sortedmulti(M,KEY,...))' (legacy P2SH)
 *
 * Each KEY may carry an `[xfp/derivation]` origin prefix and a `/0/*` or
 * `/<0;1>/*` chain suffix. We accept `/0/*` and `/<0;1>/*` and `/*`. The
 * `<0;1>` form (BIP389 multipath) is normalized to a leaf-time chain pick.
 *
 * Optional `#checksum` suffixes are tolerated and ignored.
 */
export function parseDescriptor(input: string): ParsedDescriptor {
  if (typeof input !== "string") {
    throw new Error("parseDescriptor: input must be a string");
  }
  let s = input.trim();
  if (s.length === 0) throw new Error("parseDescriptor: empty input");
  // Strip optional checksum.
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) s = s.slice(0, hashIdx).trim();

  // Bare extended key.
  if (/^(x|y|z)pub[A-Za-z0-9]+$/.test(s)) {
    return {
      kind: "single",
      keys: [
        { xpub: s, scriptType: detectScriptType(s), derivationPath: "" },
      ],
    };
  }

  // pkh(...)
  if (/^pkh\(/.test(s)) {
    const inner = unwrap(s, "pkh");
    const k = parseKeyExpr(inner);
    return { kind: "single", keys: [{ ...k, scriptType: "p2pkh" }] };
  }

  // wpkh(...)
  if (/^wpkh\(/.test(s)) {
    const inner = unwrap(s, "wpkh");
    const k = parseKeyExpr(inner);
    return { kind: "single", keys: [{ ...k, scriptType: "p2wpkh" }] };
  }

  // tr(...)
  if (/^tr\(/.test(s)) {
    const inner = unwrap(s, "tr");
    // Single-key taproot only at this milestone (no script trees).
    const k = parseKeyExpr(inner);
    return { kind: "single", keys: [{ ...k, scriptType: "p2tr" }] };
  }

  // sh(wpkh(...))
  if (/^sh\(wpkh\(/.test(s)) {
    const shInner = unwrap(s, "sh");
    const inner = unwrap(shInner, "wpkh");
    const k = parseKeyExpr(inner);
    return { kind: "single", keys: [{ ...k, scriptType: "p2sh-p2wpkh" }] };
  }

  // sh(wsh(multi|sortedmulti(...)))
  if (/^sh\(wsh\((sortedmulti|multi)\(/.test(s)) {
    const shInner = unwrap(s, "sh");
    const wshInner = unwrap(shInner, "wsh");
    const ms = parseMultiExpr(wshInner);
    return { ...ms, scriptWrapper: "sh-wsh" };
  }

  // wsh(multi|sortedmulti(...))
  if (/^wsh\((sortedmulti|multi)\(/.test(s)) {
    const inner = unwrap(s, "wsh");
    const ms = parseMultiExpr(inner);
    return { ...ms, scriptWrapper: "wsh" };
  }

  // sh(multi|sortedmulti(...)) , legacy P2SH multisig.
  if (/^sh\((sortedmulti|multi)\(/.test(s)) {
    const inner = unwrap(s, "sh");
    const ms = parseMultiExpr(inner);
    return { ...ms, scriptWrapper: "sh" };
  }

  throw new Error(
    `parseDescriptor: unsupported descriptor. Supported shapes: bare xpub/ypub/zpub; ` +
      `pkh, wpkh, sh(wpkh), tr, wsh(multi|sortedmulti), sh(wsh(multi|sortedmulti)), sh(multi|sortedmulti).`,
  );
}

/** Strip a `name(...)` wrapper. Throws on malformed input. */
function unwrap(s: string, name: string): string {
  const prefix = name + "(";
  if (!s.startsWith(prefix)) {
    throw new Error(`Expected '${name}(' wrapper`);
  }
  if (!s.endsWith(")")) {
    throw new Error(`Expected closing ')' for ${name}(`);
  }
  return s.slice(prefix.length, s.length - 1);
}

/**
 * Parse a multi() / sortedmulti() body. Body looks like:
 *   "M,KEY1,KEY2,KEY3"
 * The first token is the threshold, the rest are key expressions.
 */
function parseMultiExpr(
  body: string,
): { kind: "multisig"; m: number; n: number; sorted: boolean; keys: ParsedKey[] } {
  const sorted = body.startsWith("sortedmulti(");
  const inner = sorted
    ? unwrap(body, "sortedmulti")
    : unwrap(body, "multi");
  const parts = splitTopLevelCommas(inner);
  if (parts.length < 2) {
    throw new Error("multi() needs at least M and one key");
  }
  const m = Number.parseInt(parts[0], 10);
  if (!Number.isInteger(m) || m < 1) {
    throw new Error(`Invalid M in multi(): ${parts[0]}`);
  }
  const keyParts = parts.slice(1);
  if (m > keyParts.length) {
    throw new Error(`multi(): M=${m} > N=${keyParts.length}`);
  }
  const keys = keyParts.map(parseKeyExpr).map((k) => ({
    ...k,
    // For multisig the per-key scriptType is informational; the outermost
    // wrapper drives the on-chain script. Use the SLIP-132 hint anyway so
    // displays can show "this wallet was published as a zpub" etc.
    scriptType: safeDetect(k.xpub),
  }));
  return { kind: "multisig", m, n: keys.length, sorted, keys };
}

function safeDetect(xpub: string): ScriptType {
  try {
    return detectScriptType(xpub);
  } catch {
    // Multisig wallets often publish all keys as plain `xpub` regardless
    // of the script type. Fall back to p2pkh as a placeholder; it is
    // informational only for multisig.
    return "p2pkh";
  }
}

/**
 * Parse a single key expression like `[xfp/m/48h/0h/0h/2h]xpub.../0/*`.
 *
 * Returns the bare extended key, the optional origin annotation, and the
 * derivation suffix (everything after the xpub).
 */
function parseKeyExpr(expr: string): ParsedKey {
  let s = expr.trim();
  let origin: string | undefined;
  if (s.startsWith("[")) {
    const close = s.indexOf("]");
    if (close < 0) throw new Error("Unclosed origin '[...]'");
    origin = s.slice(1, close);
    s = s.slice(close + 1);
  }
  // Match an extended-key prefix at the start.
  const m = s.match(/^([xyz]pub[A-Za-z0-9]+)(.*)$/);
  if (!m) {
    throw new Error(`Could not find extended public key in '${expr}'`);
  }
  const xpub = m[1];
  const rest = m[2];
  if (rest.includes("'") || rest.includes("h")) {
    throw new Error(
      "Hardened derivation steps are not allowed in the watch-only suffix",
    );
  }
  return { xpub, derivationPath: rest, scriptType: safeDetect(xpub), origin };
}

/**
 * Split a multi() body on top-level commas, ignoring commas inside
 * brackets (BIP389 multipath like `<0;1>`) or parentheses.
 */
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let bracketDepth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "<") bracketDepth++;
    else if (c === ">") bracketDepth--;
    else if (c === "," && depth === 0 && bracketDepth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}

/**
 * Resolve the per-key derivation suffix into a concrete `(chain, index)`
 * pair. Accepted suffix shapes:
 *   ""               (the chain and index come from the caller)
 *   "/*"             same as ""
 *   "/0/*"           force receive chain
 *   "/1/*"           force change chain
 *   "/<0;1>/*"       BIP389 multipath; caller's chain picks the slot
 */
function resolveLeafDerivation(
  suffix: string,
  chain: 0 | 1,
  index: number,
): { chain: 0 | 1; index: number } {
  const s = suffix.trim();
  if (s.length === 0 || s === "/*") return { chain, index };
  // /<0;1>/*
  const multipath = s.match(/^\/<(\d+);(\d+)>\/\*$/);
  if (multipath) {
    const slot0 = Number.parseInt(multipath[1], 10);
    const slot1 = Number.parseInt(multipath[2], 10);
    const picked = chain === 0 ? slot0 : slot1;
    if (picked !== 0 && picked !== 1) {
      throw new Error(`Multipath chain must be 0 or 1, got ${picked}`);
    }
    return { chain: picked as 0 | 1, index };
  }
  // /N/*
  const explicit = s.match(/^\/(\d+)\/\*$/);
  if (explicit) {
    const c = Number.parseInt(explicit[1], 10);
    if (c !== 0 && c !== 1) {
      throw new Error(`Descriptor chain step must be 0 or 1, got ${c}`);
    }
    return { chain: c as 0 | 1, index };
  }
  throw new Error(
    `Unsupported key suffix '${s}'. Expected '', '/*', '/0/*', '/1/*', or '/<0;1>/*'.`,
  );
}

/**
 * Derive the script-pubkey bytes for a multisig descriptor at
 * (chain, index). Wraps the multi() redeem script per the descriptor's
 * outermost wrapper (wsh / sh-wsh / sh).
 */
export function deriveMultisigScriptPubkeyBytes(
  desc: ParsedDescriptor,
  chain: 0 | 1,
  index: number,
): Uint8Array {
  if (desc.kind !== "multisig") {
    throw new Error("deriveMultisigScriptPubkeyBytes: not a multisig descriptor");
  }
  if (!desc.scriptWrapper) {
    throw new Error("deriveMultisigScriptPubkeyBytes: missing scriptWrapper");
  }
  // Derive each cosigner's leaf pubkey at (chain, index).
  const childPubkeys: Uint8Array[] = desc.keys.map((k) => {
    const { chain: c, index: i } = resolveLeafDerivation(k.derivationPath, chain, index);
    return deriveChildPub(k.xpub, c, i);
  });
  const ordered = desc.sorted
    ? sortPubkeysLexicographic(childPubkeys)
    : childPubkeys;

  const redeem = buildMultiRedeemScript(desc.m as number, ordered);

  switch (desc.scriptWrapper) {
    case "wsh": {
      // OP_0 push32 sha256(redeem)
      const h = sha256(redeem);
      return concat(new Uint8Array([0x00, 0x20]), h);
    }
    case "sh-wsh": {
      // p2sh wrapping the p2wsh program: OP_HASH160 push20 hash160(0x0020||sha256(redeem)) OP_EQUAL
      const witnessProgram = concat(new Uint8Array([0x00, 0x20]), sha256(redeem));
      const h = hash160(witnessProgram);
      return concat(new Uint8Array([0xa9, 0x14]), h, new Uint8Array([0x87]));
    }
    case "sh": {
      // OP_HASH160 push20 hash160(redeem) OP_EQUAL
      const h = hash160(redeem);
      return concat(new Uint8Array([0xa9, 0x14]), h, new Uint8Array([0x87]));
    }
  }
}

/**
 * Encode the address corresponding to a multisig descriptor leaf.
 */
export function deriveMultisigAddress(
  desc: ParsedDescriptor,
  chain: 0 | 1,
  index: number,
): string {
  if (desc.kind !== "multisig") {
    throw new Error("deriveMultisigAddress: not a multisig descriptor");
  }
  const childPubkeys: Uint8Array[] = desc.keys.map((k) => {
    const { chain: c, index: i } = resolveLeafDerivation(k.derivationPath, chain, index);
    return deriveChildPub(k.xpub, c, i);
  });
  const ordered = desc.sorted
    ? sortPubkeysLexicographic(childPubkeys)
    : childPubkeys;
  const redeem = buildMultiRedeemScript(desc.m as number, ordered);

  switch (desc.scriptWrapper) {
    case "wsh":
      return segwitEncode("bc", 0, sha256(redeem));
    case "sh-wsh": {
      const witnessProgram = concat(new Uint8Array([0x00, 0x20]), sha256(redeem));
      const payload = concat(new Uint8Array([0x05]), hash160(witnessProgram));
      return base58checkEncode(payload);
    }
    case "sh": {
      const payload = concat(new Uint8Array([0x05]), hash160(redeem));
      return base58checkEncode(payload);
    }
    default:
      throw new Error(
        `deriveMultisigAddress: missing or unsupported wrapper ${desc.scriptWrapper}`,
      );
  }
}

/** Build the multi(M, p1, p2, ...) bitcoin script:
 *    M  <p1> <p2> ... <pN>  N  OP_CHECKMULTISIG
 *  OP_M = 0x50 + M (only valid for 1..16). N is encoded the same way. */
function buildMultiRedeemScript(m: number, pubkeys: Uint8Array[]): Uint8Array {
  if (m < 1 || m > 16) throw new Error(`multi M out of range: ${m}`);
  const n = pubkeys.length;
  if (n < 1 || n > 16) throw new Error(`multi N out of range: ${n}`);
  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([0x50 + m]));
  for (const pk of pubkeys) {
    if (pk.length !== 33) {
      throw new Error(`Cosigner pubkey must be 33-byte compressed, got ${pk.length}`);
    }
    parts.push(new Uint8Array([pk.length]));
    parts.push(pk);
  }
  parts.push(new Uint8Array([0x50 + n]));
  parts.push(new Uint8Array([0xae])); // OP_CHECKMULTISIG
  return concat(...parts);
}

function sortPubkeysLexicographic(pubs: Uint8Array[]): Uint8Array[] {
  return [...pubs].sort((a, b) => {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return a.length - b.length;
  });
}

// ─── BIP32 derivation internals ──────────────────────────────────────────

/** A decoded BIP32 extended public key, ready for child derivation. */
interface ExtendedPub {
  /** 33-byte compressed public key. */
  publicKey: Uint8Array;
  /** 32-byte chain code. */
  chainCode: Uint8Array;
}

function decodeExtendedKey(extendedKey: string): ExtendedPub {
  const prefix = extendedKey.slice(0, 4);
  if (!(prefix in VERSION_TABLE)) {
    throw new Error(`Unsupported extended-key prefix '${prefix}'.`);
  }
  const decoded = base58checkDecode(extendedKey);
  if (decoded.length !== 78) {
    throw new Error(
      `Decoded extended key has wrong length ${decoded.length}, expected 78.`,
    );
  }
  // Layout: 4 version | 1 depth | 4 fingerprint | 4 child_number |
  //         32 chain_code | 33 key.
  const chainCode = decoded.slice(13, 45);
  const key = decoded.slice(45, 78);
  if (key[0] !== 0x02 && key[0] !== 0x03) {
    throw new Error(
      "Extended key payload is not a compressed public key. " +
        "Did you paste an xprv (private) by mistake? Watch-only xpubs only.",
    );
  }
  return { publicKey: key, chainCode };
}

/**
 * Derive the child public key at m/chain/index from the parent extended
 * key. Non-hardened only (which is fine: chain 0 and 1 are not hardened).
 */
function deriveChildPub(
  extendedKey: string,
  chain: 0 | 1,
  index: number,
): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error(
      `BIP32 leaf index must be a non-negative integer below 2^31 (non-hardened), got ${index}`,
    );
  }
  // Step 1: derive the chain-level node (m/chain).
  const root = decodeExtendedKey(extendedKey);
  const chainNode = ckdPub(root, chain);
  // Step 2: derive the leaf (m/chain/index).
  const leaf = ckdPub(chainNode, index);
  return leaf.publicKey;
}

/**
 * BIP32 CKDpub. Given a parent (publicKey, chainCode) and a non-hardened
 * child index, return the child node.
 */
function ckdPub(parent: ExtendedPub, index: number): ExtendedPub {
  const data = new Uint8Array(33 + 4);
  data.set(parent.publicKey, 0);
  // index as big-endian uint32
  data[33] = (index >>> 24) & 0xff;
  data[34] = (index >>> 16) & 0xff;
  data[35] = (index >>> 8) & 0xff;
  data[36] = index & 0xff;

  const I = hmac(sha512, parent.chainCode, data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32, 64);

  const il = bytesToBigInt(IL);
  if (il >= SECP256K1_N) {
    throw new Error("BIP32: IL >= n; please use the next index");
  }

  // child point = parent point + IL * G
  const parentPoint = secp256k1.Point.fromBytes(parent.publicKey);
  const tweakPoint = secp256k1.Point.BASE.multiply(il);
  const childPoint = parentPoint.add(tweakPoint);
  const childPub = childPoint.toBytes(true);

  return { publicKey: childPub, chainCode: IR };
}

// ─── Address / script-pubkey encoding ────────────────────────────────────

/** Bitcoin HASH160 = RIPEMD160(SHA256(x)). */
function hash160(x: Uint8Array): Uint8Array {
  return ripemd160(sha256(x));
}

/**
 * Build the on-chain script-pubkey bytes for a given pubkey + script type.
 * These are the bytes the BIP158 matcher tests against.
 *
 * - p2pkh:        OP_DUP OP_HASH160 <20> {hash160} OP_EQUALVERIFY OP_CHECKSIG
 * - p2sh-p2wpkh:  OP_HASH160 <20> {h160(0x0014||h160(pubkey))} OP_EQUAL
 * - p2wpkh:       OP_0 <20> {hash160(pubkey)}
 * - p2tr:         OP_1 <32> {bip86_taproot_xonly}
 */
function scriptPubkey(pubkey: Uint8Array, scriptType: ScriptType): Uint8Array {
  const h160 = hash160(pubkey);
  switch (scriptType) {
    case "p2pkh":
      return concat(
        new Uint8Array([0x76, 0xa9, 0x14]), // OP_DUP OP_HASH160 push20
        h160,
        new Uint8Array([0x88, 0xac]), // OP_EQUALVERIFY OP_CHECKSIG
      );
    case "p2wpkh":
      return concat(new Uint8Array([0x00, 0x14]), h160);
    case "p2sh-p2wpkh": {
      // The redeem script is OP_0 push20 <hash160(pubkey)>; we hash THAT
      // and wrap in p2sh (OP_HASH160 push20 <...> OP_EQUAL).
      const redeem = concat(new Uint8Array([0x00, 0x14]), h160);
      const redeemHash = hash160(redeem);
      return concat(
        new Uint8Array([0xa9, 0x14]),
        redeemHash,
        new Uint8Array([0x87]),
      );
    }
    case "p2tr": {
      const xonly = taprootXOnly(pubkey);
      return concat(new Uint8Array([0x51, 0x20]), xonly);
    }
  }
}

function encodeAddress(pubkey: Uint8Array, scriptType: ScriptType): string {
  switch (scriptType) {
    case "p2pkh": {
      // mainnet P2PKH version byte = 0x00
      const payload = concat(new Uint8Array([0x00]), hash160(pubkey));
      return base58checkEncode(payload);
    }
    case "p2sh-p2wpkh": {
      const redeem = concat(new Uint8Array([0x00, 0x14]), hash160(pubkey));
      // mainnet P2SH version byte = 0x05
      const payload = concat(new Uint8Array([0x05]), hash160(redeem));
      return base58checkEncode(payload);
    }
    case "p2wpkh":
      return segwitEncode("bc", 0, hash160(pubkey));
    case "p2tr":
      return segwitEncode("bc", 1, taprootXOnly(pubkey));
  }
}

// ─── Taproot tweak (BIP86) ───────────────────────────────────────────────

/**
 * BIP86 single-key taproot: take the 32-byte x-only public key and tweak
 * it by `t = taggedHash("TapTweak", x)`. The output x-only key is the
 * x-coordinate of (P + t*G), with P having even Y.
 */
function taprootXOnly(pubkey: Uint8Array): Uint8Array {
  // Compressed pubkey is 33 bytes; the x-only key is bytes 1..33.
  const xOnly = pubkey.slice(1, 33);
  const t = bytesToBigInt(taggedHash("TapTweak", xOnly));
  if (t >= SECP256K1_N) {
    throw new Error("Taproot tweak >= n; should be astronomically rare");
  }
  // Parent point with forced even-Y: the 0x02 prefix is "even Y", 0x03 is
  // "odd Y". The internal-key form for BIP86 starts from the even-Y
  // representation of the x-only key.
  const evenParent = concat(new Uint8Array([0x02]), xOnly);
  const P = secp256k1.Point.fromBytes(evenParent);
  const tweaked = P.add(secp256k1.Point.BASE.multiply(t));
  const tweakedBytes = tweaked.toBytes(true); // 33-byte compressed
  return tweakedBytes.slice(1, 33);
}

function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  return sha256(concat(tagHash, tagHash, msg));
}

// ─── Base58check ─────────────────────────────────────────────────────────

const B58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  // Count leading zeros (each becomes a '1' in base58).
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert the rest to base58 by repeated division.
  const buf = Array.from(bytes);
  let out = "";
  let start = zeros;
  while (start < buf.length) {
    let remainder = 0;
    for (let i = start; i < buf.length; i++) {
      const acc = remainder * 256 + buf[i];
      buf[i] = Math.floor(acc / 58);
      remainder = acc % 58;
    }
    out = B58_ALPHABET[remainder] + out;
    while (start < buf.length && buf[start] === 0) start++;
  }
  return "1".repeat(zeros) + out;
}

function base58Decode(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;

  const digits: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const c = str[i];
    const v = B58_ALPHABET.indexOf(c);
    if (v < 0) throw new Error(`Invalid base58 character '${c}'`);
    let carry = v;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 58;
      digits[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>>= 8;
    }
  }

  const out = new Uint8Array(zeros + digits.length);
  for (let i = 0; i < digits.length; i++) {
    out[zeros + (digits.length - 1 - i)] = digits[i];
  }
  return out;
}

function base58checkEncode(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4);
  return base58Encode(concat(payload, checksum));
}

function base58checkDecode(str: string): Uint8Array {
  const decoded = base58Decode(str);
  if (decoded.length < 5) throw new Error("base58check input too short");
  const payload = decoded.slice(0, decoded.length - 4);
  const checksum = decoded.slice(decoded.length - 4);
  const expected = sha256(sha256(payload)).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error("base58check checksum mismatch");
    }
  }
  return payload;
}

// ─── Bech32 / bech32m (BIP173 + BIP350) ──────────────────────────────────

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function createChecksum(hrp: string, data: number[], constant: number): number[] {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ constant;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}

function convertBits(
  data: Uint8Array | number[],
  fromBits: number,
  toBits: number,
  pad: boolean,
): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const v of data) {
    if (v < 0 || v >> fromBits !== 0) {
      throw new Error("convertBits: input out of range");
    }
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) {
    throw new Error("convertBits: invalid padding");
  }
  return out;
}

/**
 * Encode a SegWit address. Uses bech32 for witness version 0 and bech32m
 * for v1+ (per BIP350).
 */
function segwitEncode(
  hrp: string,
  witnessVersion: number,
  program: Uint8Array,
): string {
  const constant = witnessVersion === 0 ? BECH32_CONST : BECH32M_CONST;
  const programBits = convertBits(program, 8, 5, true);
  const data = [witnessVersion, ...programBits];
  const checksum = createChecksum(hrp, data, constant);
  const combined = [...data, ...checksum];
  let out = hrp + "1";
  for (const v of combined) out += BECH32_CHARSET[v];
  return out;
}

// ─── Tiny utilities ──────────────────────────────────────────────────────

function concat(...arrs: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}
