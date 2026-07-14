/**
 * Sealed-envelope helpers for Stealth Sync.
 *
 * Every piece of stealth data the widget uploads to orangerails.com is
 * sealed with AES-256-GCM under the per-app key the consuming app sent
 * over postMessage. The server can store and shard sealed envelopes but
 * cannot read them. This file is the canonical browser-side seal/unseal
 * surface, plus the txid blind index the server needs to dedupe rows by
 * exact match without learning which transaction a row is.
 *
 * Crypto choices match the V3 pattern: Web Crypto API directly, no
 * library dependency. AES-256-GCM with a fresh random 12-byte IV per
 * envelope and a 32-byte key. HMAC-SHA-256 for the blind index, under a
 * separately derived subkey, hex output so it doubles as a JSON / SQL
 * friendly identifier with no base64 case or padding foot-guns.
 *
 * Key discipline: an absent key is a loud, typed refusal, never a lucky
 * exception. Every public entry point validates keyB64 explicitly before
 * it touches any crypto primitive. The base64 decode path is not the
 * guard, it is only a decoder.
 *
 * Master plan §13 (locked decisions, v0.3 patch).
 */

export interface SealedEnvelope {
  version: 1;
  algorithm: "AES-256-GCM";
  iv_b64: string;
  ciphertext_b64: string;
}

const ALGO = "AES-256-GCM" as const;
const IV_LEN = 12; // bytes; the standard for AES-GCM
const KEY_LEN = 32; // bytes; AES-256

/**
 * Domain separation label for the blind-index subkey. The sealing key and
 * the blind-index key are derived for different purposes and must never be
 * the same bytes: one decrypts, the other produces a value the server holds
 * in an indexed column. Bump the version suffix if the derivation changes,
 * and never reuse a label across primitives.
 */
const BLIND_INDEX_INFO = "or-stealth/blind-index/v1" as const;

/**
 * The canonical txid form: lowercase hex, display byte order, 64 chars.
 * This is the form Bitcoin Core, every block explorer, and every filter
 * API hand back, so it is what call sites already hold.
 */
const CANONICAL_TXID_RE = /^[0-9a-f]{64}$/;

// ─── Errors ─────────────────────────────────────────────────────────────

/**
 * The caller passed no key, or an empty key. Thrown before any crypto
 * primitive runs. Callers that see this have a wiring bug: they reached a
 * sealing path in a mode that holds no key.
 */
export class StealthKeyMissingError extends Error {
  constructor(fn: string) {
    super(
      `${fn}: stealth key is missing. A non-empty base64 key is required; ` +
        `this code path never seals or indexes without an explicit key.`,
    );
    this.name = "StealthKeyMissingError";
  }
}

/** The caller passed a key that is not valid base64, or not 32 bytes. */
export class StealthKeyInvalidError extends Error {
  constructor(fn: string, detail: string) {
    super(`${fn}: stealth key is invalid (${detail}).`);
    this.name = "StealthKeyInvalidError";
  }
}

/**
 * The caller passed something that is not a canonical txid.
 *
 * This is a refusal, not a normalization, on purpose. Silently upcasing,
 * downcasing, or byte-reversing a caller's input is how two call sites end
 * up producing two different indexes for the same transaction: no error is
 * raised, dedupe just stops working and the duplicate rows look real.
 */
export class StealthTxidInvalidError extends Error {
  constructor(detail: string) {
    super(
      `computeTxidBlindIndex: txid must be canonical (lowercase hex, ` +
        `display byte order, 64 chars): ${detail}.`,
    );
    this.name = "StealthTxidInvalidError";
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Encrypt a JSON-serializable payload under a 32-byte key (passed as
 * standard base64). Returns a sealed envelope ready for transport or
 * persistence.
 *
 * Throws StealthKeyMissingError if keyB64 is absent or empty, and
 * StealthKeyInvalidError if it is not a 32-byte base64 key.
 */
export async function sealEnvelope(
  payload: object,
  keyB64: string,
): Promise<SealedEnvelope> {
  const key = await importAesKey("sealEnvelope", keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext),
  );
  return {
    version: 1,
    algorithm: ALGO,
    iv_b64: b64encode(iv),
    ciphertext_b64: b64encode(new Uint8Array(ciphertext)),
  };
}

/**
 * Decrypt a sealed envelope under the given key. Throws if the key is
 * wrong or the envelope is tampered with (Web Crypto throws on a GCM tag
 * mismatch). The caller chooses the type to expect.
 *
 * Throws StealthKeyMissingError if keyB64 is absent or empty, and
 * StealthKeyInvalidError if it is not a 32-byte base64 key.
 */
export async function unsealEnvelope<T = unknown>(
  env: SealedEnvelope,
  keyB64: string,
): Promise<T> {
  requireKeyB64("unsealEnvelope", keyB64);
  if (env.version !== 1) {
    throw new Error(`Sealed envelope version ${env.version} not supported`);
  }
  if (env.algorithm !== ALGO) {
    throw new Error(`Sealed envelope algorithm ${env.algorithm} not supported`);
  }
  const key = await importAesKey("unsealEnvelope", keyB64);
  const iv = b64decode(env.iv_b64);
  const ciphertext = b64decode(env.ciphertext_b64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(ciphertext),
  );
  const text = new TextDecoder().decode(plaintext);
  return JSON.parse(text) as T;
}

/**
 * Compute the blind index for a transaction id: hex-encoded HMAC-SHA-256
 * under a subkey derived from the per-app stealth key. Deterministic for a
 * given (txid, key) pair, which is what lets the server dedupe rows by
 * exact match without learning which transaction any row is.
 *
 * The privacy claim, stated plainly because it is the whole point of the
 * field: a txid is public and enumerable, and the server already holds the
 * block height, so an index the server could recompute would let it hash
 * every txid in that block and read the wallet straight off the table. The
 * index is safe only because the subkey is derived from the per-app stealth
 * key, which the server never holds, and which is distinct per (user, app).
 * Two users therefore never produce the same index for the same txid, and
 * the server can compare indexes to each other and to nothing else. If the
 * subkey ever stops being per (user, app), this field stops being blind.
 *
 * The subkey is HKDF-SHA-256 from the master with
 * info="or-stealth/blind-index/v1", so it is not the key that seals
 * envelopes. One key doing both jobs is the classic way a side channel
 * opens later.
 *
 * The input must be canonical (lowercase hex, display byte order, 64
 * chars). A non-canonical txid is refused, never normalized: two call sites
 * disagreeing on case or byte order would otherwise produce two indexes for
 * one transaction, and dedupe would fail silently.
 *
 * Throws StealthTxidInvalidError for a non-canonical txid,
 * StealthKeyMissingError if keyB64 is absent or empty, and
 * StealthKeyInvalidError if it is not a 32-byte base64 key.
 */
export async function computeTxidBlindIndex(
  txid: string,
  keyB64: string,
): Promise<string> {
  requireCanonicalTxid(txid);
  const hmacKey = await deriveBlindIndexKey("computeTxidBlindIndex", keyB64);
  const sig = await crypto.subtle.sign(
    "HMAC",
    hmacKey,
    toArrayBuffer(new TextEncoder().encode(txid)),
  );
  return hexEncode(new Uint8Array(sig));
}

// ─── Internals ──────────────────────────────────────────────────────────

/**
 * The explicit key guard. Runs before any decode or crypto call, so a
 * missing key is refused by design rather than by whatever the base64
 * decoder happens to do with `undefined`.
 *
 * Typed as `unknown` on purpose: the callers are reachable from runtime
 * postMessage data, where TypeScript's `string` is a promise, not a fact.
 */
function requireKeyB64(fn: string, keyB64: unknown): string {
  if (typeof keyB64 !== "string" || keyB64.length === 0) {
    throw new StealthKeyMissingError(fn);
  }
  return keyB64;
}

/**
 * The canonical-input guard. Same reasoning as requireKeyB64: the txid
 * arrives from runtime scan data, so its type is a promise, not a fact.
 */
function requireCanonicalTxid(txid: unknown): string {
  if (typeof txid !== "string") {
    throw new StealthTxidInvalidError(`got ${typeof txid}`);
  }
  if (!CANONICAL_TXID_RE.test(txid)) {
    throw new StealthTxidInvalidError(`got ${txid.length} chars, not canonical`);
  }
  return txid;
}

/** Guard, decode, and length-check a key in one place. */
function decodeKeyBytes(fn: string, keyB64: unknown): Uint8Array {
  const validated = requireKeyB64(fn, keyB64);
  let raw: Uint8Array;
  try {
    raw = b64decode(validated);
  } catch {
    throw new StealthKeyInvalidError(fn, "not valid base64");
  }
  if (raw.length !== KEY_LEN) {
    throw new StealthKeyInvalidError(
      fn,
      `expected ${KEY_LEN} bytes, got ${raw.length}`,
    );
  }
  return raw;
}

/**
 * Derive the blind-index subkey from the per-app master key and import it
 * for signing only.
 *
 * extractable=false and usages ["sign"] are both deliberate: the subkey
 * cannot be read back out of the CryptoKey, and it cannot be used to
 * verify. A verify capability would let a caller test a candidate index
 * against a txid, which is exactly the oracle the blind index exists to
 * deny.
 */
async function deriveBlindIndexKey(
  fn: string,
  keyB64: unknown,
): Promise<CryptoKey> {
  const master = decodeKeyBytes(fn, keyB64);
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(master),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(BLIND_INDEX_INFO),
    },
    hkdfKey,
    KEY_LEN * 8,
  );
  // Best-effort wipe of the master bytes we copied out of base64.
  master.fill(0);
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function importAesKey(fn: string, keyB64: unknown): Promise<CryptoKey> {
  const raw = decodeKeyBytes(fn, keyB64);
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Copy a Uint8Array into a fresh ArrayBuffer. Web Crypto's strict typing
 * (post lib.dom.d.ts updates that distinguish ArrayBuffer from
 * SharedArrayBuffer) requires a plain ArrayBuffer for keys.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}
