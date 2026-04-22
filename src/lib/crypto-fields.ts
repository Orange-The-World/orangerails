/**
 * Per-entity encryption helpers for OrangeRails.
 *
 * These are the only functions callers in the rest of the codebase should
 * touch. They compose vault.ts + key-derivation.ts into "encrypt this
 * connection's API key" / "decrypt this transaction payload" level APIs
 * that match the shape of the database tables in the Phase 1 migration.
 *
 * The rest of the app should never touch CryptoKey objects directly. If a
 * new entity type needs encryption, add a helper here; don't let every page
 * re-implement the HKDF context derivation.
 */

import { encryptString, decryptString } from './vault';
import { deriveCredentialsKey, deriveTransactionsKey, deriveBlindIndexKey } from './key-derivation';

// ------------------------------------------------------------------
// Types — match the Phase 1 schema.
// ------------------------------------------------------------------

/**
 * Shape of the encrypted_transactions DB row fields produced by
 * encryptTransactionRow(). Caller inserts these directly.
 */
export interface TransactionRow {
  encrypted_payload: string;
  /** HMAC-SHA256 of tx.type, normalized. Null if field absent. */
  hmac_type: string | null;
  /** HMAC-SHA256 of tx.direction, normalized. */
  hmac_direction: string | null;
  /** HMAC-SHA256 of tx.counterparty, normalized. Null if field absent. */
  hmac_counterparty: string | null;
}

/** Payload stored in connections.encrypted_credentials. */
export interface CredentialsPayload {
  /** Provider-specific credential fields. For Blink: { api_key: string }. */
  [field: string]: string;
}

/** Payload stored in encrypted_transactions.encrypted_payload. Normalized shape. */
export interface NormalizedTransaction {
  id: string;                       // OrangeRails-side uuid (provider's external_id lives plaintext alongside)
  adapter: string;                  // 'blink', 'kraken', etc.
  direction: 'in' | 'out';
  type: 'lightning' | 'onchain' | 'trade' | 'deposit' | 'withdrawal' | 'fee';
  amount_sats?: number;
  amount?: number;                  // for non-sat adapters (USD, etc.)
  currency?: string;
  fee_sats?: number;
  description?: string | null;
  counterparty?: string | null;
  status?: string;
  timestamp: string;                // ISO 8601
  /**
   * Wallet this transaction came from (provider-opaque external_wallet_id).
   * Set when the connection has a source_wallets selection and or-sync used
   * the wallet-scoped query path; null/undefined for legacy connections that
   * still use the account-wide sync path. Downstream consumers (V3, Personal)
   * route per-wallet using this field.
   */
  source_wallet_id?: string | null;
  raw?: unknown;                    // original provider response for audit
}

// ------------------------------------------------------------------
// Credentials — encrypt / decrypt
// ------------------------------------------------------------------

/**
 * Encrypt a provider's credentials payload with the user's credentials subkey.
 *
 * Returns the ciphertext ready to insert into `connections.encrypted_credentials`.
 * The caller is responsible for setting `credentials_key_version` to the
 * matching HKDF context version.
 */
export async function encryptCredentials(
  payload: CredentialsPayload,
  mek: CryptoKey,
  saltB64: string,
): Promise<string> {
  const key = await deriveCredentialsKey(mek, saltB64);
  return encryptString(JSON.stringify(payload), key);
}

/**
 * Decrypt a credentials ciphertext loaded from the database.
 *
 * @throws if the key is wrong or the ciphertext has been tampered with.
 */
export async function decryptCredentials(
  ciphertextB64: string,
  mek: CryptoKey,
  saltB64: string,
): Promise<CredentialsPayload> {
  const key = await deriveCredentialsKey(mek, saltB64);
  const plaintext = await decryptString(ciphertextB64, key);
  const parsed = JSON.parse(plaintext);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Decrypted credentials payload is not a valid object');
  }
  return parsed as CredentialsPayload;
}

// ------------------------------------------------------------------
// Transactions — encrypt / decrypt
// ------------------------------------------------------------------

/**
 * Encrypt a normalized transaction with the user's transactions subkey.
 *
 * Returns the ciphertext ready to insert into `encrypted_transactions.encrypted_payload`.
 */
export async function encryptTransaction(
  transaction: NormalizedTransaction,
  mek: CryptoKey,
  saltB64: string,
): Promise<string> {
  const key = await deriveTransactionsKey(mek, saltB64);
  return encryptString(JSON.stringify(transaction), key);
}

/**
 * Decrypt a transaction ciphertext.
 */
export async function decryptTransaction(
  ciphertextB64: string,
  mek: CryptoKey,
  saltB64: string,
): Promise<NormalizedTransaction> {
  const key = await deriveTransactionsKey(mek, saltB64);
  const plaintext = await decryptString(ciphertextB64, key);
  const parsed = JSON.parse(plaintext);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Decrypted transaction payload is not a valid object');
  }
  return parsed as NormalizedTransaction;
}

// ------------------------------------------------------------------
// Batch helpers — common case in sync flows.
// ------------------------------------------------------------------

/** Decrypt many transactions in parallel. */
export async function decryptTransactions(
  ciphertexts: string[],
  mek: CryptoKey,
  saltB64: string,
): Promise<NormalizedTransaction[]> {
  // Derive the key once, not per-transaction.
  const key = await deriveTransactionsKey(mek, saltB64);
  return Promise.all(
    ciphertexts.map(async (c) => {
      const plaintext = await decryptString(c, key);
      return JSON.parse(plaintext) as NormalizedTransaction;
    }),
  );
}

/** Encrypt many transactions in parallel. */
export async function encryptTransactions(
  transactions: NormalizedTransaction[],
  mek: CryptoKey,
  saltB64: string,
): Promise<string[]> {
  const key = await deriveTransactionsKey(mek, saltB64);
  return Promise.all(
    transactions.map(async (t) => {
      return encryptString(JSON.stringify(t), key);
    }),
  );
}

// ------------------------------------------------------------------
// Blind indexes — HMAC-SHA256 for server-side filtering of encrypted fields.
// ------------------------------------------------------------------

/**
 * Compute a deterministic HMAC-SHA256 blind index for a plaintext value.
 *
 * The HMAC key is derived from the MEK via HKDF with a purpose-specific
 * context so it is cryptographically independent from all encryption keys.
 * Normalization (trim + lowercase) ensures that case/whitespace variants of
 * the same value produce the same index.
 *
 * Returns null for absent/empty values — the DB column will be NULL and
 * WHERE hmac_col = $1 queries simply won't match those rows.
 */
export async function computeBlindIndex(
  value: string | null | undefined,
  hmacKey: CryptoKey,
): Promise<string | null> {
  if (value == null || value === '') return null;
  const normalized = value.trim().toLowerCase();
  const sig = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(normalized));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/**
 * Encrypt a transaction payload AND compute its blind indexes in one call.
 *
 * Prefer this over encryptTransaction() for any new write path — it returns
 * the full DB row shape including hmac_* columns so filtering works server-side.
 */
export async function encryptTransactionRow(
  tx: NormalizedTransaction,
  mek: CryptoKey,
  saltB64: string,
): Promise<TransactionRow> {
  const [encKey, hmacKey] = await Promise.all([
    deriveTransactionsKey(mek, saltB64),
    deriveBlindIndexKey(mek, saltB64),
  ]);

  const [encrypted_payload, hmac_type, hmac_direction, hmac_counterparty] = await Promise.all([
    encryptString(JSON.stringify(tx), encKey),
    computeBlindIndex(tx.type, hmacKey),
    computeBlindIndex(tx.direction, hmacKey),
    computeBlindIndex(tx.counterparty ?? null, hmacKey),
  ]);

  return { encrypted_payload, hmac_type, hmac_direction, hmac_counterparty };
}

/**
 * Batch version of encryptTransactionRow — derives both keys once for the set.
 */
export async function encryptTransactionRows(
  transactions: NormalizedTransaction[],
  mek: CryptoKey,
  saltB64: string,
): Promise<TransactionRow[]> {
  const [encKey, hmacKey] = await Promise.all([
    deriveTransactionsKey(mek, saltB64),
    deriveBlindIndexKey(mek, saltB64),
  ]);

  return Promise.all(
    transactions.map(async (tx) => {
      const [encrypted_payload, hmac_type, hmac_direction, hmac_counterparty] = await Promise.all([
        encryptString(JSON.stringify(tx), encKey),
        computeBlindIndex(tx.type, hmacKey),
        computeBlindIndex(tx.direction, hmacKey),
        computeBlindIndex(tx.counterparty ?? null, hmacKey),
      ]);
      return { encrypted_payload, hmac_type, hmac_direction, hmac_counterparty };
    }),
  );
}
