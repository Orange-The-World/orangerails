/**
 * Orange Way Me (OWM) sink adapter.
 *
 * Translates OR's NormalizedTransaction into OWM's row shape, ready for
 * OWM's owm-or-sync-stream → client → DB insert pipeline.
 *
 * ZKA model: OWM stores transactions encrypted at rest under the user's
 * vault MEK. This sink returns row drafts with PLAINTEXT values in the
 * enc_* fields, and lists those field paths in metadata.requires_encryption.
 * OWM's client receives the response, AES-256-GCM encrypts each listed field
 * under the user's MEK in-browser, then inserts. The server never persists
 * a plaintext amount, description, merchant, or memo.
 *
 * The brief in-memory exposure inside OR (Quiltt → OR → client) is the
 * unavoidable cost of pulling bank data , Quiltt itself sees plaintext
 * because it has to log into the bank. The ZKA guarantee covers the
 * at-rest boundary at OR + OWM, not the in-flight transformation step.
 *
 * Row shapes match the public.transactions + public.connection_account_map
 * schemas in OWM (see migration 20260418021640_… and 20260423120000_…).
 *
 * Account creation happens out of band via owm-or-discover-quiltt , by the
 * time or-sync runs for a connection, the account row already exists.
 * This sink emits only transaction rows + (idempotent) connection-account
 * mapping hints. If the mapping is missing, the OWM client uses
 * __resolveAccountId to look up or create the link client-side.
 */

import type { SinkAdapter, SinkInput, SinkOutput } from './types.ts';

const SCHEMA_VERSION = '1.0.0';

/**
 * OWM's transactions.enc_* fields. These are AES-256-GCM ciphertext under
 * the user's MEK at rest. The sink emits plaintext; the client encrypts
 * before INSERT. Paths use array-merged form because mergeSinkOutputs
 * accumulates rows across transactions.
 */
function encryptionPaths(rowIndex: number): string[] {
  const prefix = `transactions.${rowIndex}`;
  return [
    `${prefix}.enc_amount`,
    `${prefix}.enc_description`,
    `${prefix}.enc_merchant`,
    `${prefix}.enc_category_id`,
    `${prefix}.enc_memo`,
  ];
}

/**
 * Map NormalizedTransaction.type → OWM's category hint.
 * OWM categories are user-defined post-import; this is only a hint that
 * the client may or may not honor. Keep conservative.
 */
function defaultCategoryHint(type: string, direction: 'in' | 'out'): string | null {
  if (type === 'lightning' || type === 'onchain') {
    return direction === 'in' ? 'income:bitcoin' : 'expense:bitcoin';
  }
  if (type === 'trade') return 'transfer:trade';
  if (type === 'deposit') return 'income:deposit';
  if (type === 'withdrawal') return 'expense:withdrawal';
  if (type === 'fee') return 'expense:fee';
  return null;
}

/**
 * Build the OWM transaction row. Fields with `enc_` prefix arrive as
 * plaintext and are encrypted client-side before insert.
 */
function transactionRow(input: SinkInput) {
  const { transaction: tx, or_connection_id, or_subaccount_id, external_user_id } = input;

  // OWM stores `date` plaintext (it's needed for sort/index and is not
  // a load-bearing privacy field , bank statements regularly publish dates
  // in clear). The cleartext occurredAt is preserved here.
  const occurredAt = new Date(tx.timestamp);
  const date = occurredAt.toISOString().slice(0, 10); // YYYY-MM-DD

  // Resolve amount. Quiltt returns USD/CAD/etc as `amount` (number),
  // Lightning/onchain returns `amount_sats`. OWM stores `enc_amount` as
  // a string ciphertext; the plaintext we hand over is a JSON-encoded
  // amount object so the client knows the currency on decrypt.
  let plaintextAmount: string;
  if (typeof tx.amount_sats === 'number') {
    plaintextAmount = JSON.stringify({
      value: String(tx.amount_sats),
      currency: 'sats',
      direction: tx.direction,
    });
  } else if (typeof tx.amount === 'number') {
    plaintextAmount = JSON.stringify({
      value: String(tx.amount),
      currency: tx.currency ?? 'USD',
      direction: tx.direction,
    });
  } else {
    plaintextAmount = JSON.stringify({ value: '0', currency: 'USD', direction: tx.direction });
  }

  return {
    // Server-generated UUID at INSERT , placeholder so the row stays
    // structurally complete on the wire. Client overwrites before INSERT.
    id: null,
    user_id: external_user_id,
    // account_id resolved client-side via the connection_account_map.
    // Hint shape mirrors V2's __resolveWalletId pattern.
    __resolveAccountId: {
      or_connection_id,
      or_external_wallet_id: tx.source_wallet_id ?? null,
    },
    household_id: null, // Per-user scope by default; client adds household
                       // scope explicitly via household-osk wrapping.
    date,

    // Encrypted-at-rest fields , PLAINTEXT on the wire, ciphertext after
    // the client's AES-GCM step. Paths listed in requires_encryption.
    enc_amount:      plaintextAmount,
    enc_description: tx.description ?? '',
    enc_merchant:    tx.counterparty ?? '',
    enc_category_id: defaultCategoryHint(tx.type, tx.direction),
    enc_memo:        '',

    // Blind indexes (server-side searchable hashes) are computed client-
    // side over the cleartext + a per-user HMAC key. Server doesn't know
    // the keys → cannot reverse. Sink emits nulls; client overwrites.
    hmac_merchant: null,
    hmac_category: null,

    is_split_parent: false,

    // Provenance , the only OR-side bookkeeping that survives into OWM.
    // Lets owm-or-sync-stream dedupe re-syncs by (or_subaccount_id, external_id).
    _meta: {
      or_subaccount_id,
      or_connection_id,
      external_id: tx.id,
      provider_slug: tx.adapter,
      schema_version: SCHEMA_VERSION,
    },
  };
}

/**
 * Build the connection_account_map row. Tells OWM which `accounts.id`
 * this OR external wallet should resolve to. The encrypted_account_id
 * column is MEK-ciphertext of an OWM accounts.id UUID , the client
 * provides it after vault-side lookup. We emit a hint here so the
 * client can find or create the mapping idempotently.
 */
function connectionMapHint(input: SinkInput) {
  const { transaction: tx, or_connection_id, external_user_id } = input;
  return {
    user_id: external_user_id,
    or_connection_id,
    or_external_wallet_id: tx.source_wallet_id ?? '',
    // encrypted_account_id resolved client-side from the user's
    // existing accounts list. Sink emits the lookup hint:
    __resolveEncryptedAccountId: {
      or_connection_id,
      or_external_wallet_id: tx.source_wallet_id ?? null,
    },
    is_active: true,
  };
}

export const orangewayMeSink: SinkAdapter = {
  format: 'orangeway-me',
  version: SCHEMA_VERSION,
  toAppShape(input: SinkInput): SinkOutput {
    const transactionsRows = [transactionRow(input)];
    const connectionMapRows = [connectionMapHint(input)];

    return {
      rows: {
        transactions:           transactionsRows,
        connection_account_map: connectionMapRows,
      },
      metadata: {
        canonical_id: input.transaction.id,
        // Tell the OWM client which fields to AES-GCM under the MEK
        // before insert. Server never persists these as plaintext.
        requires_encryption: encryptionPaths(0),
      },
    };
  },
};
