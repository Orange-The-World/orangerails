/**
 * Co-admin keyring, envelope v3 construction (d).
 *
 * READ src/lib/keyring.ts FIRST. This module is the co-admin half of the
 * same envelope, and every rule there applies here too.
 *
 * ## The construction
 *
 *   1. At grant time the owner generates a fresh random 32 byte co-admin key
 *      (the CAK). One CAK per grant, never reused across grants.
 *   2. The owner seals a PROJECTION of their keyring under that CAK. The
 *      projection carries the data keys and nothing else.
 *   3. The CAK is hybrid KEM wrapped to the admin's KEM public key.
 *   4. The caller signs (grantee user id, workspace key id, wrapped CAK
 *      ciphertext) with the owner's ML-DSA key, exactly once, at grant time.
 *      That signing lives in member-grant.ts and is not repeated here.
 *
 * ## The projection is the safety argument
 *
 * A v3 keyring holds the owner's KEM secret and the owner's ML-DSA SIGNING
 * secret alongside the data keys. An admin who obtained the signing secret
 * could mint grants in the owner's name: "this admin may read my data" would
 * quietly become "this admin is me". So the projection is an explicit
 * allowlist of two fields, written out one at a time. It is never a spread
 * of the keyring with fields deleted afterwards, because a delete list is a
 * list somebody has to remember to update, and the failure mode of
 * forgetting is a silent leak of the next secret added to the keyring.
 *
 * ## What is bound to what
 *
 * The sealed blob's AAD is the owner user id and the grant id. That is what
 * makes one grant's blob useless in another grant's row: the unseal fails
 * authentication rather than returning the wrong keys. It is also why this
 * blob does not carry its own signature. The signature covers the wrapped
 * CAK, and without the CAK the blob is inert.
 *
 * ## What this module does not do
 *
 *   - It never talks to the database. Callers persist what it returns.
 *   - It never rotates a data key and it never mints a keyring.
 *   - It does not decide whether a grant is valid. The signature check runs
 *     first, in the consume path, before anything here is called.
 */

import { encoding, importAesKey } from "./vault";
import { hybridEncapsulate, hybridDecapsulate, HYBRID_KEM_CIPHERTEXT_BYTES } from "./pqc";
import type { DataKeyEntry, DataKeyKind, VaultKeyring } from "./keyring";

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** On the wire format version of the sealed co-admin keyring. */
export const COADMIN_KEYRING_VERSION = 1;

/** On the wire format version of the KEM wrapped CAK payload. */
export const COADMIN_CAK_VERSION = 1;

/** Algorithm identifier stored alongside a wrapped CAK. */
export const COADMIN_CAK_ALGORITHM = "hybrid-x25519-mlkem768-cakv1";

/** Domain separator for the sealed co-admin keyring AAD. */
const AAD_PREFIX = "orangerails-coadmin-keyring-v1";

/** A CAK is a raw AES-256 key. */
const CAK_BYTES = 32;

/** Every data key is a raw AES-256 key, same as the owner keyring. */
const DATA_KEY_BYTES = 32;

/** AES-GCM nonce length, matching keyring.ts and encryptString in vault.ts. */
const IV_BYTES = 12;

/** AES-GCM authentication tag length. */
const GCM_TAG_BYTES = 16;

/**
 * Upper bound on generations of one data key, mirroring keyring.ts. An admin
 * that is handed more than this is being handed a keyring whose rotation
 * sweep never finished, and failing is better than decoding it.
 */
const MAX_GENERATIONS = 8;

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/**
 * What an admin receives: the owner's data keys, every generation of each,
 * and nothing else. There is deliberately no field here for a secret key of
 * any kind, so a future edit that tries to pass one has to change this type
 * and will be seen in review.
 */
export interface CoAdminKeyring {
  version: number;
  credentials: DataKeyEntry[];
  transactions: DataKeyEntry[];
}

/**
 * What the sealed blob is bound to. Both fields go into the AES-GCM AAD, so
 * a blob cannot be replayed onto another owner's row or onto another grant.
 */
export interface CoAdminBinding {
  ownerUserId: string;
  grantId: string;
}

// ------------------------------------------------------------------
// Projection, the allowlist
// ------------------------------------------------------------------

/**
 * Project an owner keyring down to what a co-admin may hold.
 *
 * ALLOWLIST, NOT DENYLIST. Every field that survives is named here
 * explicitly, including the fields of each entry. Nothing is copied by
 * spread, so a field added to VaultKeyring or to DataKeyEntry later cannot
 * reach an admin by default. If you are adding a field and you want an admin
 * to have it, you have to come here and say so, which is the entire point.
 */
export function projectKeyringForCoAdmin(keyring: VaultKeyring): CoAdminKeyring {
  return {
    version: COADMIN_KEYRING_VERSION,
    credentials: keyring.credentials.map((e) => ({
      generation: e.generation,
      keyB64: e.keyB64,
    })),
    transactions: keyring.transactions.map((e) => ({
      generation: e.generation,
      keyB64: e.keyB64,
    })),
  };
}

// ------------------------------------------------------------------
// Canonical encoding, what actually gets sealed
// ------------------------------------------------------------------
//
// Written out field by field for the same two reasons as keyring.ts: the
// bytes are canonical whatever order the object was built in, and the TS
// interface cannot gain a field that silently enters the ciphertext.

interface WireEntry {
  g: number;
  k: string;
}

interface WireCoAdminKeyring {
  v: number;
  creds: WireEntry[];
  txns: WireEntry[];
}

function toWireEntries(entries: DataKeyEntry[]): WireEntry[] {
  return [...entries]
    .sort((a, b) => a.generation - b.generation)
    .map((e) => ({ g: e.generation, k: e.keyB64 }));
}

/** Serialize a co-admin keyring to its canonical JSON form. */
export function encodeCoAdminKeyring(projection: CoAdminKeyring): string {
  const wire: WireCoAdminKeyring = {
    v: projection.version,
    creds: toWireEntries(projection.credentials),
    txns: toWireEntries(projection.transactions),
  };
  return JSON.stringify(wire);
}

function decodeEntries(raw: unknown, kind: DataKeyKind): DataKeyEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Co-admin keyring is missing its ${kind} data keys.`);
  }
  if (raw.length > MAX_GENERATIONS) {
    throw new Error(
      `Co-admin keyring carries ${raw.length} ${kind} generations, more than ${MAX_GENERATIONS}.`,
    );
  }
  const seen = new Set<number>();
  return raw.map((item) => {
    const e = item as { g?: unknown; k?: unknown };
    if (!Number.isInteger(e.g) || (e.g as number) < 1) {
      throw new Error(`Co-admin keyring ${kind} entry has an invalid generation.`);
    }
    if (typeof e.k !== "string" || e.k.length === 0) {
      throw new Error(
        `Co-admin keyring ${kind} entry at generation ${e.g} has no key material.`,
      );
    }
    const generation = e.g as number;
    if (seen.has(generation)) {
      throw new Error(`Co-admin keyring has two ${kind} entries at generation ${generation}.`);
    }
    seen.add(generation);
    if (encoding.base64ToBytes(e.k).length !== DATA_KEY_BYTES) {
      throw new Error(
        `Co-admin keyring ${kind} key at generation ${generation} is not ${DATA_KEY_BYTES} bytes.`,
      );
    }
    return { generation, keyB64: e.k };
  });
}

/**
 * Parse and validate a canonical co-admin keyring.
 *
 * The version is checked BEFORE any other field is read. That ordering is
 * load bearing: it is what lets the payload grow later without a reader from
 * an older build producing a confident wrong answer about the new shape.
 */
export function decodeCoAdminKeyring(json: string): CoAdminKeyring {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Co-admin keyring plaintext is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Co-admin keyring plaintext is not an object.");
  }
  const wire = parsed as Partial<WireCoAdminKeyring>;
  if (wire.v !== COADMIN_KEYRING_VERSION) {
    throw new Error(
      `Unsupported co-admin keyring version: ${String(wire.v)}. ` +
        `This build understands ${COADMIN_KEYRING_VERSION}.`,
    );
  }
  return {
    version: COADMIN_KEYRING_VERSION,
    credentials: decodeEntries(wire.creds, "credentials"),
    transactions: decodeEntries(wire.txns, "transactions"),
  };
}

// ------------------------------------------------------------------
// Seal and open, under the per grant CAK
// ------------------------------------------------------------------

function aadBytes(binding: CoAdminBinding): Uint8Array {
  if (typeof binding.ownerUserId !== "string" || binding.ownerUserId.length === 0) {
    throw new Error("Co-admin keyring binding requires an owner user id.");
  }
  if (typeof binding.grantId !== "string" || binding.grantId.length === 0) {
    throw new Error("Co-admin keyring binding requires a grant id.");
  }
  return new TextEncoder().encode(
    `${AAD_PREFIX}|${binding.ownerUserId}|${binding.grantId}`,
  );
}

function assertCakLength(cak: Uint8Array): void {
  if (cak.length !== CAK_BYTES) {
    throw new Error(`A co-admin key must be ${CAK_BYTES} bytes, got ${cak.length}.`);
  }
}

async function importCak(cak: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  assertCakLength(cak);
  const copy = new Uint8Array(cak);
  return crypto.subtle.importKey("raw", copy as BufferSource, { name: "AES-GCM" }, false, [
    usage,
  ]);
}

/** A fresh co-admin key. One per grant, never reused. */
export function generateCoAdminKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(CAK_BYTES));
}

/**
 * Seal a projected keyring under a CAK.
 *
 * Wire format: base64( IV[12] || ciphertext || tag[16] ), the same shape the
 * rest of the codebase writes into a ciphertext column. The difference from
 * encryptString is the AAD, which binds the owner and the grant.
 */
export async function sealCoAdminKeyring(
  projection: CoAdminKeyring,
  cak: Uint8Array,
  binding: CoAdminBinding,
): Promise<string> {
  const aad = aadBytes(binding);
  const key = await importCak(cak, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad as BufferSource },
    key,
    new TextEncoder().encode(encodeCoAdminKeyring(projection)) as BufferSource,
  );

  const combined = new Uint8Array(iv.length + sealed.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(sealed), iv.length);
  return encoding.bytesToBase64(combined);
}

/**
 * Open a sealed co-admin keyring.
 *
 * Throws if the CAK is wrong, if the blob was sealed for a different owner or
 * a different grant, if it was tampered with, or if it decodes to something
 * that is not a valid projection.
 */
export async function openCoAdminKeyring(
  ciphertextB64: string,
  cak: Uint8Array,
  binding: CoAdminBinding,
): Promise<CoAdminKeyring> {
  const aad = aadBytes(binding);
  const combined = encoding.base64ToBytes(ciphertextB64);
  if (combined.length < IV_BYTES + GCM_TAG_BYTES) {
    throw new Error("Co-admin keyring ciphertext is too short to be valid AES-GCM output.");
  }
  const iv = combined.slice(0, IV_BYTES);
  const body = combined.slice(IV_BYTES);

  const key = await importCak(cak, "decrypt");
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: aad as BufferSource },
    key,
    body as BufferSource,
  );

  return decodeCoAdminKeyring(new TextDecoder().decode(new Uint8Array(opened)));
}

// ------------------------------------------------------------------
// Wrapping the CAK to the admin
// ------------------------------------------------------------------
//
// Wire format:
//   bytes 0..HYBRID_KEM_CIPHERTEXT_BYTES : hybrid KEM ciphertext
//   next 12 bytes                        : AES-GCM nonce
//   remainder                            : AES-GCM(sharedSecret, payload) + tag
//
// The two offsets are algorithm parameters, not a claim about how long the
// payload is. The payload itself is canonical JSON carrying its own version,
// which is what makes this extendable where the v2 blob was not.

interface WireCak {
  v: number;
  cak: string;
}

/** Wrap a CAK for a recipient's hybrid KEM public key. */
export async function wrapCoAdminKey(
  cak: Uint8Array,
  recipientKemPublicKey: Uint8Array,
): Promise<Uint8Array> {
  assertCakLength(cak);

  const payload: WireCak = { v: COADMIN_CAK_VERSION, cak: encoding.bytesToBase64(cak) };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const { ciphertext: kemCt, sharedSecret } = hybridEncapsulate(recipientKemPublicKey);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    plaintext as BufferSource,
  );

  const out = new Uint8Array(kemCt.length + IV_BYTES + sealed.byteLength);
  out.set(kemCt, 0);
  out.set(iv, kemCt.length);
  out.set(new Uint8Array(sealed), kemCt.length + IV_BYTES);
  return out;
}

/**
 * Unwrap a CAK with the recipient's own hybrid KEM secret key.
 *
 * The only length check is the structural minimum: a KEM ciphertext, a nonce,
 * a tag and at least one byte of payload. There is deliberately no equality
 * check on the total length, because pinning the total length is exactly what
 * froze the previous construction.
 */
export async function unwrapCoAdminKey(
  wrapped: Uint8Array,
  ownKemSecretKey: Uint8Array,
): Promise<Uint8Array> {
  const minimum = HYBRID_KEM_CIPHERTEXT_BYTES + IV_BYTES + GCM_TAG_BYTES + 1;
  if (wrapped.length < minimum) {
    throw new Error(
      `Wrapped co-admin key is ${wrapped.length} bytes, shorter than the ${minimum} a valid one can be.`,
    );
  }

  const kemCt = wrapped.subarray(0, HYBRID_KEM_CIPHERTEXT_BYTES);
  const iv = wrapped.subarray(
    HYBRID_KEM_CIPHERTEXT_BYTES,
    HYBRID_KEM_CIPHERTEXT_BYTES + IV_BYTES,
  );
  const body = wrapped.subarray(HYBRID_KEM_CIPHERTEXT_BYTES + IV_BYTES);

  const sharedSecret = hybridDecapsulate(ownKemSecretKey, kemCt);
  const aesKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    body as BufferSource,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(opened)));
  } catch {
    throw new Error("Wrapped co-admin key plaintext is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Wrapped co-admin key plaintext is not an object.");
  }

  // Version first, before any other field is read.
  const wire = parsed as Partial<WireCak>;
  if (wire.v !== COADMIN_CAK_VERSION) {
    throw new Error(
      `Unsupported wrapped co-admin key version: ${String(wire.v)}. ` +
        `This build understands ${COADMIN_CAK_VERSION}.`,
    );
  }
  if (typeof wire.cak !== "string" || wire.cak.length === 0) {
    throw new Error("Wrapped co-admin key carries no key material.");
  }

  const cak = encoding.base64ToBytes(wire.cak);
  assertCakLength(cak);
  return cak;
}

// ------------------------------------------------------------------
// Reading a data key out of a projection
// ------------------------------------------------------------------
//
// The admin performs the same generation lookup the owner does, with the same
// throw by number and no fallback. A row whose generation is absent is
// unreadable, and saying so is the only safe answer: falling back to another
// generation produces plausible garbage against real ciphertext, which is
// indistinguishable from data loss.

function entriesFor(projection: CoAdminKeyring, kind: DataKeyKind): DataKeyEntry[] {
  return kind === "credentials" ? projection.credentials : projection.transactions;
}

/** The highest generation present, which is what a fresh row is written under. */
export function latestCoAdminDataKey(
  projection: CoAdminKeyring,
  kind: DataKeyKind,
): DataKeyEntry {
  const entries = entriesFor(projection, kind);
  if (entries.length === 0) {
    throw new Error(`Co-admin keyring holds no ${kind} data key.`);
  }
  return entries.reduce((best, e) => (e.generation > best.generation ? e : best));
}

/** The entry for one specific generation, as named by a data row. */
export function coAdminDataKeyAt(
  projection: CoAdminKeyring,
  kind: DataKeyKind,
  generation: number,
): DataKeyEntry {
  const entry = entriesFor(projection, kind).find((e) => e.generation === generation);
  if (!entry) {
    const present = entriesFor(projection, kind)
      .map((e) => e.generation)
      .join(", ");
    throw new Error(
      `Co-admin keyring has no ${kind} key at generation ${generation}. Present: ${present || "none"}.`,
    );
  }
  return entry;
}

/**
 * The AES key for a data kind. Omit `generation` for the newest one, which is
 * what a write path wants; pass a row's stored generation on a read path.
 */
export async function coAdminDataKeyFor(
  projection: CoAdminKeyring,
  kind: DataKeyKind,
  generation?: number,
): Promise<CryptoKey> {
  const entry =
    generation === undefined
      ? latestCoAdminDataKey(projection, kind)
      : coAdminDataKeyAt(projection, kind, generation);
  const raw = encoding.base64ToBytes(entry.keyB64);
  if (raw.length !== DATA_KEY_BYTES) {
    throw new Error(
      `Co-admin data key at generation ${entry.generation} is ${raw.length} bytes, expected ${DATA_KEY_BYTES}.`,
    );
  }
  return importAesKey(
    raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length) as ArrayBuffer,
  );
}
