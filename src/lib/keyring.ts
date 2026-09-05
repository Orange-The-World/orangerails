/**
 * OrangeRails vault keyring , envelope v3.
 *
 * In envelope v2 the MEK is the root of a DERIVATION tree: the credentials
 * subkey, the transactions subkey and the verifier are all HKDF-derived from
 * it. Rotating the MEK therefore invalidates every row bound to it, which is
 * why recovery has to sweep every connection and every transaction and
 * re-encrypt each one. A sweep that dies half way leaves no single key that
 * opens everything.
 *
 * In v3 the MEK stops being a derivation root and becomes a pure key-WRAPPING
 * root over a single-row keyring. The data keys are independent random keys
 * generated once at vault creation. Rotating the MEK re-wraps one blob and
 * touches no data row at all.
 *
 * READ THIS BEFORE CHANGING ANYTHING HERE. The security property this trades
 * away, and why the trade was made, is recorded in the design decision on the
 * wiki (Knowledge, vault recovery and the v3 envelope). A change that quietly
 * re-derives a data key from the MEK undoes the entire point of this module
 * and silently reintroduces the sweep.
 *
 * WHAT THIS MODULE DOES NOT DO
 *   - It never talks to the database. Callers persist the returned ciphertext.
 *   - It does not rotate data keys. The keyring can HOLD several generations,
 *     which is what makes a future rotation sweep safe, but no sweep lives
 *     here and none is wired up.
 *   - It does not hold the verifier, and the verifier must never be moved in
 *     here: the verifier is what proves an unwrap produced the right MEK, so
 *     it cannot live inside the thing the MEK unwraps.
 */

import { encoding, importAesKey } from "./vault";
import { deriveKeyringWrapKey } from "./key-derivation";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** On-the-wire keyring format version. Independent of vault_key_version. */
export const KEYRING_VERSION = 1;

/** Domain separator for the AES-GCM additional authenticated data. */
const AAD_PREFIX = "orangerails-keyring-v1";

/** Every data key is a raw AES-256 key. */
const DATA_KEY_BYTES = 32;

/** AES-GCM nonce length, matching encryptString in vault.ts. */
const IV_BYTES = 12;

/** AES-GCM authentication tag length. */
const GCM_TAG_BYTES = 16;

/**
 * Upper bound on how many generations of one data key a keyring may carry.
 * A rotation sweep holds exactly two at a time; anything approaching this
 * limit means a sweep never finished and the blob is growing without bound,
 * which we would rather fail on than keep decoding.
 */
const MAX_GENERATIONS = 8;

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** Which family of data rows a key belongs to. */
export type DataKeyKind = "credentials" | "transactions";

/**
 * One generation of one data key.
 *
 * `generation` is what a data row's `data_key_generation` column points at.
 * It is a counter and it is deliberately NOT any of the existing
 * `*_key_version` columns: those are envelope scheme selectors stamped as a
 * hardcoded 1, and overloading a scheme selector as a counter is a mistake
 * this codebase has already made once.
 */
export interface DataKeyEntry {
  generation: number;
  /** Raw 32 random bytes, base64. Never derived from the MEK. */
  keyB64: string;
}

/**
 * The plaintext contents of user_vault_meta.keyring_ciphertext.
 *
 * The PQC secrets live in here rather than in their own columns because two
 * separate MEK-wrapped columns are the live proof that a rotation which has
 * to remember a list will eventually forget one. One blob, one re-wrap,
 * nothing left to enumerate.
 */
export interface VaultKeyring {
  version: number;
  credentials: DataKeyEntry[];
  transactions: DataKeyEntry[];
  /** Hybrid KEM secret, base64. Null until PQC setup has run. */
  kemSecretB64: string | null;
  /** ML-DSA signing secret, base64. Null until PQC setup has run. */
  sigSecretB64: string | null;
}

/**
 * What the wrap is bound to. Both fields go into the AES-GCM AAD, so a blob
 * cannot be replayed onto another user's row, and an older generation of
 * this same row cannot be restored underneath a caller. Getting either wrong
 * makes the unwrap fail loudly rather than return the wrong keys.
 *
 * WHY THIS IS keyring_epoch AND NOT vault_key_version. An AAD may bind a
 * value only if that value is fixed for the lifetime of the ciphertext it
 * protects. vault_key_version is not: it is an envelope scheme selector that
 * other call sites raise on their own, and the AAD is recomputed from
 * whatever the row currently says, so raising it without re-wrapping in the
 * same statement leaves a blob whose AAD can never be reproduced. That is an
 * unopenable vault. keyring_epoch qualifies because the database forbids it
 * from moving unless keyring_ciphertext is rewritten in the same statement,
 * and forbids the ciphertext from moving without it.
 *
 * There is deliberately no compatibility fallback anywhere in this module.
 * A fallback that accepts an older AAD hands back exactly the rollback the
 * epoch exists to stop.
 */
export interface KeyringBinding {
  userId: string;
  /**
   * user_vault_meta.keyring_epoch for this row. Strictly increasing, never
   * reused, and only ever changed in the same statement that rewrites the
   * ciphertext it is bound to.
   */
  keyringEpoch: number;
}

// ------------------------------------------------------------------
// Creation
// ------------------------------------------------------------------

function randomKeyB64(): string {
  return encoding.bytesToBase64(crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES)));
}

/**
 * Generate a fresh keyring for a brand new vault.
 *
 * Both data keys are independent random keys at generation 1. They are never
 * derived from the MEK, which is the entire change v3 makes.
 */
export function generateVaultKeyring(): VaultKeyring {
  return {
    version: KEYRING_VERSION,
    credentials: [{ generation: 1, keyB64: randomKeyB64() }],
    transactions: [{ generation: 1, keyB64: randomKeyB64() }],
    kemSecretB64: null,
    sigSecretB64: null,
  };
}

/**
 * Return a copy of the keyring carrying the PQC secrets.
 *
 * Pure: the input is not mutated, so a caller that fails to persist the
 * result has not corrupted the keyring it still holds.
 */
export function withPqcSecrets(
  keyring: VaultKeyring,
  secrets: { kemSecretB64: string | null; sigSecretB64: string | null },
): VaultKeyring {
  return {
    ...keyring,
    credentials: [...keyring.credentials],
    transactions: [...keyring.transactions],
    kemSecretB64: secrets.kemSecretB64,
    sigSecretB64: secrets.sigSecretB64,
  };
}

/**
 * Return a copy of the keyring with a NEW generation of one data key added,
 * keeping every existing generation.
 *
 * This is the shape that makes a future data-key rotation safe: while both
 * generations are present, every row is readable by something in the keyring
 * at every instant, so the sweep can stop, resume and retry and can never
 * strand a row. No sweep is implemented here and nothing calls this yet.
 */
export function addDataKeyGeneration(keyring: VaultKeyring, kind: DataKeyKind): VaultKeyring {
  const entries = entriesFor(keyring, kind);
  if (entries.length >= MAX_GENERATIONS) {
    throw new Error(
      `Keyring already holds ${entries.length} generations of the ${kind} key. ` +
        "Finish or abandon the in-flight rotation before starting another.",
    );
  }
  const next = { generation: latestDataKey(keyring, kind).generation + 1, keyB64: randomKeyB64() };
  const grown = [...entries, next];
  return kind === "credentials"
    ? { ...keyring, credentials: grown, transactions: [...keyring.transactions] }
    : { ...keyring, credentials: [...keyring.credentials], transactions: grown };
}

// ------------------------------------------------------------------
// Lookup
// ------------------------------------------------------------------

function entriesFor(keyring: VaultKeyring, kind: DataKeyKind): DataKeyEntry[] {
  return kind === "credentials" ? keyring.credentials : keyring.transactions;
}

/** The highest generation present. This is what a new row is written under. */
export function latestDataKey(keyring: VaultKeyring, kind: DataKeyKind): DataKeyEntry {
  const entries = entriesFor(keyring, kind);
  if (entries.length === 0) {
    throw new Error(`Keyring holds no ${kind} data key.`);
  }
  return entries.reduce((best, e) => (e.generation > best.generation ? e : best));
}

/**
 * The entry for one specific generation, as named by a data row.
 *
 * Throws, loudly and by number, when the generation is absent. A row whose
 * key is not in the keyring is unreadable, and the only safe response is to
 * say so rather than fall back to another generation and produce garbage.
 */
export function dataKeyAt(
  keyring: VaultKeyring,
  kind: DataKeyKind,
  generation: number,
): DataKeyEntry {
  const entry = entriesFor(keyring, kind).find((e) => e.generation === generation);
  if (!entry) {
    const present = entriesFor(keyring, kind)
      .map((e) => e.generation)
      .join(", ");
    throw new Error(
      `Keyring has no ${kind} key at generation ${generation}. Present: ${present || "none"}.`,
    );
  }
  return entry;
}

/**
 * Import a keyring entry as an AES-256-GCM CryptoKey.
 *
 * Extractable, matching the v2 data subkeys: the credentials and transactions
 * keys are exported for a single in-transit handoff to the sync edge function.
 * The keyring WRAPPING key is not extractable; see deriveKeyringWrapKey.
 */
export async function importDataKey(entry: DataKeyEntry): Promise<CryptoKey> {
  const raw = encoding.base64ToBytes(entry.keyB64);
  if (raw.length !== DATA_KEY_BYTES) {
    throw new Error(
      `Keyring data key at generation ${entry.generation} is ${raw.length} bytes, expected ${DATA_KEY_BYTES}.`,
    );
  }
  return importAesKey(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) as ArrayBuffer);
}

/**
 * The AES key for a data kind. Omit `generation` for the newest one, which is
 * what a write path wants; pass a row's stored generation on a read path.
 */
export async function dataKeyFor(
  keyring: VaultKeyring,
  kind: DataKeyKind,
  generation?: number,
): Promise<CryptoKey> {
  const entry =
    generation === undefined ? latestDataKey(keyring, kind) : dataKeyAt(keyring, kind, generation);
  return importDataKey(entry);
}

// ------------------------------------------------------------------
// Canonical encoding , what actually gets encrypted.
// ------------------------------------------------------------------
//
// The wire shape is written out field by field rather than by handing the TS
// object to JSON.stringify, for two reasons. It is canonical, so the same
// keyring always produces the same bytes whatever order the properties were
// built in. And it is a deliberate boundary: the TS interface can gain a
// field without that field silently entering the encrypted blob.

interface WireEntry {
  g: number;
  k: string;
}

interface WireKeyring {
  v: number;
  creds: WireEntry[];
  txns: WireEntry[];
  kem: string | null;
  sig: string | null;
}

function toWireEntries(entries: DataKeyEntry[]): WireEntry[] {
  return [...entries]
    .sort((a, b) => a.generation - b.generation)
    .map((e) => ({ g: e.generation, k: e.keyB64 }));
}

/** Serialize a keyring to its canonical JSON form. */
export function encodeKeyring(keyring: VaultKeyring): string {
  const wire: WireKeyring = {
    v: keyring.version,
    creds: toWireEntries(keyring.credentials),
    txns: toWireEntries(keyring.transactions),
    kem: keyring.kemSecretB64,
    sig: keyring.sigSecretB64,
  };
  return JSON.stringify(wire);
}

function decodeEntries(raw: unknown, kind: DataKeyKind): DataKeyEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Keyring is missing its ${kind} data keys.`);
  }
  if (raw.length > MAX_GENERATIONS) {
    throw new Error(`Keyring carries ${raw.length} ${kind} generations, more than ${MAX_GENERATIONS}.`);
  }
  const seen = new Set<number>();
  return raw.map((item) => {
    const e = item as { g?: unknown; k?: unknown };
    if (!Number.isInteger(e.g) || (e.g as number) < 1) {
      throw new Error(`Keyring ${kind} entry has an invalid generation.`);
    }
    if (typeof e.k !== "string" || e.k.length === 0) {
      throw new Error(`Keyring ${kind} entry at generation ${e.g} has no key material.`);
    }
    const generation = e.g as number;
    if (seen.has(generation)) {
      throw new Error(`Keyring has two ${kind} entries at generation ${generation}.`);
    }
    seen.add(generation);
    if (encoding.base64ToBytes(e.k).length !== DATA_KEY_BYTES) {
      throw new Error(
        `Keyring ${kind} key at generation ${generation} is not ${DATA_KEY_BYTES} bytes.`,
      );
    }
    return { generation, keyB64: e.k };
  });
}

/**
 * Parse and validate a canonical keyring.
 *
 * Every failure here throws. A keyring that decodes to the wrong thing is
 * worse than one that fails to decode: it silently produces wrong keys, and
 * wrong keys against real ciphertext look like data loss.
 */
export function decodeKeyring(json: string): VaultKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Keyring plaintext is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Keyring plaintext is not an object.");
  }
  const wire = parsed as Partial<WireKeyring>;
  if (wire.v !== KEYRING_VERSION) {
    throw new Error(`Unsupported keyring version: ${String(wire.v)}. This build understands ${KEYRING_VERSION}.`);
  }
  const kem = wire.kem ?? null;
  const sig = wire.sig ?? null;
  if (kem !== null && typeof kem !== "string") {
    throw new Error("Keyring KEM secret is present but is not a string.");
  }
  if (sig !== null && typeof sig !== "string") {
    throw new Error("Keyring signature secret is present but is not a string.");
  }
  return {
    version: KEYRING_VERSION,
    credentials: decodeEntries(wire.creds, "credentials"),
    transactions: decodeEntries(wire.txns, "transactions"),
    kemSecretB64: kem,
    sigSecretB64: sig,
  };
}

// ------------------------------------------------------------------
// Wrap / unwrap
// ------------------------------------------------------------------

/**
 * The one place a keyring epoch turns into AAD bytes.
 *
 * keyring_epoch is a bigint in Postgres, and a client library is free to hand
 * it back as a JavaScript number or as a string depending on the driver. Two
 * callers that disagree by a single character produce different AAD bytes and
 * an unwrap failure that reads to the user as a destroyed vault, possibly
 * months after the mistake was made. So it is normalised exactly once, here,
 * to canonical decimal: digits only, no sign, no separators, no leading
 * zeros, no exponent form. Anything else throws rather than being coerced,
 * because a silent coercion is the failure this function exists to prevent.
 */
export function canonicalKeyringEpoch(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        "Keyring binding requires a keyring epoch that is a safe positive integer.",
      );
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (!/^[1-9][0-9]*$/.test(value)) {
      throw new Error(
        "Keyring binding requires a keyring epoch in canonical decimal form: " +
          "digits only, no sign, no separators, no leading zeros.",
      );
    }
    if (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        "Keyring epoch is past the JavaScript safe integer range, so a caller " +
          "holding it as a number and one holding it as a string would build " +
          "different AAD bytes.",
      );
    }
    return value;
  }
  throw new Error(
    "Keyring binding requires a keyring epoch as a number or a decimal string.",
  );
}

function aadBytes(binding: KeyringBinding): Uint8Array {
  if (typeof binding.userId !== "string" || binding.userId.length === 0) {
    throw new Error("Keyring binding requires a user id.");
  }
  const epoch = canonicalKeyringEpoch(binding.keyringEpoch);
  return new TextEncoder().encode(`${AAD_PREFIX}|${binding.userId}|${epoch}`);
}

/**
 * Wrap a keyring for storage in user_vault_meta.keyring_ciphertext.
 *
 * Wire format: base64( IV[12] || ciphertext || tag[16] ), the same shape
 * encryptString produces, so the column looks like every other ciphertext
 * column. The difference is the AAD, which encryptString does not carry.
 */
export async function wrapKeyring(
  keyring: VaultKeyring,
  mek: CryptoKey,
  saltB64: string,
  binding: KeyringBinding,
): Promise<string> {
  const aad = aadBytes(binding);
  const wrapKey = await deriveKeyringWrapKey(mek, saltB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad as BufferSource },
    wrapKey,
    new TextEncoder().encode(encodeKeyring(keyring)) as BufferSource,
  );

  const combined = new Uint8Array(iv.length + sealed.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(sealed), iv.length);
  return encoding.bytesToBase64(combined);
}

/**
 * Unwrap a stored keyring.
 *
 * Throws if the MEK is wrong, if the blob was written for a different user or
 * under a different keyring epoch, if it was tampered with, or if it decodes
 * to something that is not a valid keyring. There is no fallback: a failure
 * here is a failure, never a second attempt under an older binding.
 */
export async function unwrapKeyring(
  ciphertextB64: string,
  mek: CryptoKey,
  saltB64: string,
  binding: KeyringBinding,
): Promise<VaultKeyring> {
  const aad = aadBytes(binding);
  const combined = encoding.base64ToBytes(ciphertextB64);
  if (combined.length < IV_BYTES + GCM_TAG_BYTES) {
    throw new Error("Keyring ciphertext is too short to be valid AES-GCM output.");
  }
  const iv = combined.slice(0, IV_BYTES);
  const body = combined.slice(IV_BYTES);

  const wrapKey = await deriveKeyringWrapKey(mek, saltB64);
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad as BufferSource },
    wrapKey,
    body as BufferSource,
  );

  return decodeKeyring(new TextDecoder().decode(new Uint8Array(opened)));
}

/**
 * Re-wrap an existing keyring under a new MEK. This is the whole of what a
 * recovery has to do to the user's key material.
 *
 * The keyring CONTENTS are unchanged, which is the property that makes
 * recovery stop touching data rows: every existing ciphertext stays readable
 * because the key that encrypted it did not move. The caller persists the
 * returned ciphertext in the same single statement that writes the new MEK
 * wrappers and the new verifier.
 *
 * The user does not change. The EPOCH does, and it has to: the stored
 * ciphertext is about to be replaced, and the database refuses a keyring
 * ciphertext write that does not raise keyring_epoch in the same statement.
 * So `binding` is the CURRENT binding, used to open the old blob, and the new
 * blob is sealed under epoch + 1. The returned `keyringEpoch` is the value
 * the caller must write.
 *
 * What the caller then owes, and it cannot be done from here because this
 * module never touches the database: one UPDATE that matches BOTH the exact
 * prior keyring_ciphertext AND the exact prior keyring_epoch, and sets the
 * new ciphertext and this epoch together. Zero rows matched means someone
 * else rotated first, which is a lost race and is retryable. A rejection from
 * the epoch guard means something tried to move one column without the other,
 * which is not a race. Report them differently.
 */
export async function rewrapKeyringUnderNewMek(params: {
  ciphertextB64: string;
  oldMek: CryptoKey;
  newMek: CryptoKey;
  saltB64: string;
  binding: KeyringBinding;
}): Promise<{ keyring: VaultKeyring; ciphertextB64: string; keyringEpoch: number }> {
  const currentEpoch = Number(canonicalKeyringEpoch(params.binding.keyringEpoch));
  const keyringEpoch = currentEpoch + 1;
  if (!Number.isSafeInteger(keyringEpoch)) {
    throw new Error(
      "Keyring epoch cannot be raised without leaving the safe integer range.",
    );
  }

  const keyring = await unwrapKeyring(
    params.ciphertextB64,
    params.oldMek,
    params.saltB64,
    params.binding,
  );
  const ciphertextB64 = await wrapKeyring(keyring, params.newMek, params.saltB64, {
    userId: params.binding.userId,
    keyringEpoch,
  });
  return { keyring, ciphertextB64, keyringEpoch };
}
