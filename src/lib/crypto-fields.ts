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
import { deriveCredentialsKey, deriveTransactionsKey } from './key-derivation';

// ------------------------------------------------------------------
// Types — match the Phase 1 schema.
// ------------------------------------------------------------------

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
