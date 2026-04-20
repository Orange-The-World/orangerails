/**
 * Recipient-oriented data-key wrapping.
 *
 * Given a 32-byte AES data key and a list of recipients' hybrid KEM
 * public keys, produces one wrapped blob per recipient. Each recipient
 * can independently unwrap with their own secret key to recover the
 * original data key; no recipient can unwrap another's row.
 *
 * Algorithm strategies are looked up by name in KEY_WRAP_STRATEGIES.
 * Adding ML-KEM-1024 later = one additional map entry, zero edits to
 * this file's existing code (OCP). Consumers depend on the
 * KeyWrapStrategy interface, not on the concrete hybrid (DIP).
 *
 * Wire format of one wrapped blob:
 *   bytes 0..1119  : hybrid KEM ciphertext (X25519 ephem pub + ML-KEM ct)
 *   bytes 1120..1131: AES-GCM IV (12 bytes)
 *   bytes 1132..   : AES-GCM ciphertext + auth tag (data key + 16-byte tag)
 *
 * The wrapped blob is stored as base64 in `wrapped_data_keys.wrapped_ciphertext`.
 */

import {
  HYBRID_KEM_CIPHERTEXT_BYTES,
  HYBRID_KEM_PUBLIC_KEY_BYTES,
  HYBRID_KEM_SECRET_KEY_BYTES,
  hybridEncapsulate,
  hybridDecapsulate,
} from "./pqc";

// ------------------------------------------------------------------
// Strategy contract — consumers depend on this, not on hybrid.
// ------------------------------------------------------------------

export interface KeyWrapStrategy {
  readonly algorithm: string;
  /** Wrap a data key for one recipient, producing opaque bytes. */
  wrapForRecipient(dataKey: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array>;
  /** Unwrap a blob with one's own secret key, recovering the original data key. */
  unwrapForSelf(wrapped: Uint8Array, ownSecretKey: Uint8Array): Promise<Uint8Array>;
}

// ------------------------------------------------------------------
// AES-GCM primitives — matched to vault.ts's at-rest format for
// familiarity. IV is 12 bytes; tag is 16 bytes appended to ciphertext.
// ------------------------------------------------------------------

const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;
const DATA_KEY_CIPHERTEXT_BYTES = DATA_KEY_BYTES + AES_GCM_TAG_BYTES; // 48

async function importAesKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    rawBytes as BufferSource,
    { name: "AES-GCM" },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
}

async function aesGcmEncrypt(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plaintext as BufferSource,
  );
  return new Uint8Array(ct);
}

async function aesGcmDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(pt);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ------------------------------------------------------------------
// Hybrid X25519 + ML-KEM-768 strategy.
// ------------------------------------------------------------------

const hybridX25519MlKem768Strategy: KeyWrapStrategy = Object.freeze({
  algorithm: "hybrid-x25519-mlkem768",

  async wrapForRecipient(dataKey: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array> {
    if (dataKey.length !== DATA_KEY_BYTES) {
      throw new Error(`data key must be ${DATA_KEY_BYTES} bytes, got ${dataKey.length}`);
    }
    if (recipientPublicKey.length !== HYBRID_KEM_PUBLIC_KEY_BYTES) {
      throw new Error(
        `recipient public key must be ${HYBRID_KEM_PUBLIC_KEY_BYTES} bytes, got ${recipientPublicKey.length}`,
      );
    }

    const { ciphertext: kemCt, sharedSecret } = hybridEncapsulate(recipientPublicKey);
    const aesKey = await importAesKey(sharedSecret);
    const iv = new Uint8Array(AES_GCM_IV_BYTES);
    crypto.getRandomValues(iv);
    const wrappedDataKey = await aesGcmEncrypt(aesKey, iv, dataKey);

    return concat(kemCt, iv, wrappedDataKey);
  },

  async unwrapForSelf(wrapped: Uint8Array, ownSecretKey: Uint8Array): Promise<Uint8Array> {
    if (ownSecretKey.length !== HYBRID_KEM_SECRET_KEY_BYTES) {
      throw new Error(
        `recipient secret key must be ${HYBRID_KEM_SECRET_KEY_BYTES} bytes, got ${ownSecretKey.length}`,
      );
    }
    const expectedMinLength =
      HYBRID_KEM_CIPHERTEXT_BYTES + AES_GCM_IV_BYTES + DATA_KEY_CIPHERTEXT_BYTES;
    if (wrapped.length !== expectedMinLength) {
      throw new Error(`wrapped blob must be ${expectedMinLength} bytes, got ${wrapped.length}`);
    }

    const kemCt = wrapped.subarray(0, HYBRID_KEM_CIPHERTEXT_BYTES);
    const iv = wrapped.subarray(
      HYBRID_KEM_CIPHERTEXT_BYTES,
      HYBRID_KEM_CIPHERTEXT_BYTES + AES_GCM_IV_BYTES,
    );
    const wrappedDataKey = wrapped.subarray(HYBRID_KEM_CIPHERTEXT_BYTES + AES_GCM_IV_BYTES);

    const sharedSecret = hybridDecapsulate(ownSecretKey, kemCt);
    const aesKey = await importAesKey(sharedSecret);
    return aesGcmDecrypt(aesKey, iv, wrappedDataKey);
  },
});

// ------------------------------------------------------------------
// Strategy registry — add new algorithms here, not by editing the hybrid.
// ------------------------------------------------------------------

export const KEY_WRAP_STRATEGIES: Readonly<Record<string, KeyWrapStrategy>> = Object.freeze({
  "hybrid-x25519-mlkem768": hybridX25519MlKem768Strategy,
});

export const DEFAULT_WRAP_ALGORITHM = "hybrid-x25519-mlkem768";

// ------------------------------------------------------------------
// Orchestrator — fan out a data key to recipients, returning rows
// ready to insert into public.wrapped_data_keys.
// ------------------------------------------------------------------

export interface WrappedDataKeyRow {
  recipient_user_id: string;
  wrapped_ciphertext: string; // base64
  algorithm: string;
}

export interface WrapRecipient {
  userId: string;
  publicKey: Uint8Array;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Wrap one data key for each recipient.
 *
 * @param dataKey     32-byte raw AES-256 key to be shared.
 * @param recipients  Users authorized to read. Each needs their hybrid
 *                    public key (as produced by generateHybridKemKeyPair).
 * @param algorithm   Defaults to hybrid-x25519-mlkem768. Pass a key from
 *                    KEY_WRAP_STRATEGIES to pick a different strategy.
 *
 * Output rows are ready to insert into `public.wrapped_data_keys`; the
 * caller is responsible for assigning `data_key_id`.
 */
export async function wrapDataKeyForRecipients(
  dataKey: Uint8Array,
  recipients: WrapRecipient[],
  algorithm: string = DEFAULT_WRAP_ALGORITHM,
): Promise<WrappedDataKeyRow[]> {
  const strategy = KEY_WRAP_STRATEGIES[algorithm];
  if (!strategy) {
    throw new Error(`unknown key-wrap algorithm: ${algorithm}`);
  }

  const rows: WrappedDataKeyRow[] = [];
  for (const r of recipients) {
    const wrapped = await strategy.wrapForRecipient(dataKey, r.publicKey);
    rows.push({
      recipient_user_id: r.userId,
      wrapped_ciphertext: bytesToBase64(wrapped),
      algorithm: strategy.algorithm,
    });
  }
  return rows;
}
