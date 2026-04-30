/**
 * BitBooks V2 sink adapter.
 *
 * Translates OR's NormalizedTransaction (Lightning + on-chain transactions
 * from Blink today, more sources later) into V2's Prisma row shape, ready
 * for V2's bb-or-proxy + sync handler to insert.
 *
 * Architecture (post-YAML-loader):
 *   account_mapping_rules + status_to_v2  →  YAML at profiles/bitbooks-v2.yaml
 *   output row shape (Wallet, Transaction, JE, JELine)  →  this file
 *
 * The YAML is load-bearing: editing rule rows changes runtime behavior, no
 * TypeScript redeploy needed for rule edits. The TS still owns row
 * construction because output_tables encoding is more invariant than
 * mapping rules and benefits from compile-time type checks for now. When
 * a third consumer joins the protocol we lift output_tables to YAML too
 * and this file shrinks to a generic interpreter.
 *
 * V2 schema reference: prisma/schema.prisma in DeeJanuz/bitbooks (V2 is on
 * Daenon's GitHub profile, not the MorningRevolution org).
 *
 * V2 stores transactions in plaintext at rest. requires_encryption is empty.
 */

import type { SinkAdapter, SinkInput, SinkOutput, NormalizedTransaction } from './types.ts';
import { loadProfile } from './profile-loader.ts';
import { findMatchingRule, mapStatus, type DerivedContext, type InputContext, type ResolvedCoaHint } from './profile-engine.ts';

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Generate a deterministic short id from the source transaction id. Used
 * to build `Transaction.refNum` and `JournalEntry.refNum` so re-syncing
 * produces the same value (idempotent on V2's UNIQUE constraints).
 */
function shortIdFrom(sourceId: string): string {
  return sourceId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
}

/**
 * V2 uses Prisma's `@default(cuid())` on its primary keys. We generate IDs
 * server-side as UUIDs (Prisma treats them as strings and accepts UUIDs in
 * cuid columns) so the sink can cross-reference between Transaction and
 * JournalEntry within one emission.
 */
function newId(): string {
  return crypto.randomUUID();
}

/** Map OR's NormalizedTransaction.direction to V2's TransactionDirection enum. */
function mapDirection(direction: 'in' | 'out'): 'IN' | 'OUT' {
  return direction === 'in' ? 'IN' : 'OUT';
}

/**
 * Pick the "asset" string V2 stores on Transaction.asset based on what
 * the source provider returned. Blink BTC wallets return amounts in sats
 * (amount_sats); USD/stablecoin wallets return amount + currency.
 */
function determineAsset(tx: NormalizedTransaction): string {
  if (tx.amount_sats != null) return 'BTC';
  if (tx.currency) return tx.currency.toUpperCase();
  return 'BTC';
}

/**
 * Convert the source-side amount to V2's Decimal-string convention. V2's
 * Transaction.amount is `Decimal(30, 10)` — strings serialize cleanly.
 *
 * Sat-denominated values become BTC with 8 decimal places to match V2's
 * existing display + reporting logic, which already understands BTC.
 */
function amountToDecimalString(tx: NormalizedTransaction): string {
  if (tx.amount_sats != null) {
    const btc = tx.amount_sats / 100_000_000;
    return btc.toFixed(8);
  }
  if (tx.amount != null) {
    return tx.amount.toFixed(2);
  }
  return '0';
}

/**
 * Pre-compute everything the YAML rules might reference via `derived.<key>`.
 * Sinks own the derived layer; the engine just reads it.
 */
function buildDerivedContext(tx: NormalizedTransaction): DerivedContext {
  return {
    asset: determineAsset(tx),
    amount: amountToDecimalString(tx),
    direction: tx.direction,
    type: tx.type,
    source_wallet_id: tx.source_wallet_id ?? null,
    now: new Date().toISOString(),
  };
}

// ─── The sink ─────────────────────────────────────────────────────────────

export const bitbooksV2Sink: SinkAdapter = {
  format: 'bitbooks-v2',
  version: '2026.04.29',

  toAppShape(input: SinkInput): SinkOutput {
    const { transaction: tx, or_connection_id, external_user_id } = input;

    // Profile is cached after the first call. Synchronous reads are not
    // possible inside SinkAdapter.toAppShape (the interface is sync), so
    // the caller must `await ensureProfileLoaded()` before invoking the
    // sink for the first time. or-sync does this once per request batch.
    const profile = profileSync;
    if (!profile) {
      throw new Error('[bitbooks-v2] profile not loaded — call ensureProfileLoaded() before toAppShape');
    }

    const derived = buildDerivedContext(tx);
    const inputCtx: InputContext = {
      org_id: external_user_id,
      or_connection_id,
      or_subaccount_id: input.or_subaccount_id,
    };

    const txId = newId();
    const jeId = newId();
    const orgId = external_user_id;
    const refNumSuffix = shortIdFrom(tx.id);
    const txRefNum = `OR-${refNumSuffix}`;
    const jeRefNum = `JE-OR-${refNumSuffix}`;

    const asset = determineAsset(tx);
    const amount = amountToDecimalString(tx);
    const direction = mapDirection(tx.direction);
    const status = mapStatus(profile, tx.status);

    const occurredAt = new Date(tx.timestamp);
    const date = occurredAt.toISOString().slice(0, 10);
    const time = occurredAt.toISOString().slice(11, 19);

    // Engine-driven account-role resolution from the YAML rules.
    const mapping = findMatchingRule(profile, tx, derived, inputCtx);

    // Wallet upsert — only if a source_wallet_id is set. The V2 sync handler
    // de-duplicates upserts within a sync batch.
    const walletUpserts: unknown[] = [];
    if (tx.source_wallet_id) {
      walletUpserts.push({
        sourceWalletId: tx.source_wallet_id,
        organizationId: orgId,
        orConnectionId: or_connection_id,
        name: `${tx.adapter} ${asset}`,
        walletType: 'SOFTWARE',
        currency: asset,
        __resolveCoa: {
          accountType: 'ASSET' as const,
          accountSubType: 'WALLETS' as const,
          isWallet: true,
          currency: asset,
        },
        syncStatus: 'SYNCED',
        lastSyncAt: new Date().toISOString(),
      });
    }

    // JournalEntry header
    const journalEntries: unknown[] = [{
      id: jeId,
      organizationId: orgId,
      date,
      currency: asset,
      refNum: jeRefNum,
      memo: tx.description ?? null,
      status: 'POSTED' as const,
      sourceType: 'ORANGE_RAILS',
      __resolveSystemUser: 'orange_rails',
    }];

    // JournalEntryLines — debit + credit pair. Account roles came from the
    // YAML-driven engine; we just embed them as __resolveCoa hints so V2's
    // sync handler does the find-or-create against its own Prisma client.
    //
    // V2 convention (matches its manual-wallet flow): amountNative is
    // SIGNED — positive on the debit side, negative on the credit side.
    // V2's wallet statement view derives the debit/credit display
    // columns from the SIGN of amountNative (see V2's
    // app/api/.../wallets/[walletId]/statement/route.ts), so emitting
    // both lines with positive amountNative makes every transaction
    // appear as a debit on the wallet's CoA — wrong balance.
    const negatedAmount = `-${amount}`;
    const journalEntryLines: unknown[] = [
      {
        id: newId(),
        journalEntryId: jeId,
        __resolveCoa: hintToResolveShape(mapping.debit),
        nativeCurrency: asset,
        amountNative: amount, // positive on the debit side
        debit: amount,
        credit: null,
        ratePending: false,
        rateTimestamp: occurredAt.toISOString(),
        memo: tx.description ?? null,
      },
      {
        id: newId(),
        journalEntryId: jeId,
        __resolveCoa: hintToResolveShape(mapping.credit),
        nativeCurrency: asset,
        amountNative: negatedAmount, // negative on the credit side
        debit: null,
        credit: amount,
        ratePending: false,
        rateTimestamp: occurredAt.toISOString(),
        memo: tx.description ?? null,
      },
    ];

    // Transaction.chartOfAccountId hint — the categorisation account
    // (income for IN, expense for OUT). The wallet-leg is wallet's
    // own CoA (already covered by V2's wallet linkage); the
    // OTHER leg of the JE is what V2's edit modal calls "Account."
    //
    // Picks: whichever of mapping.debit / mapping.credit is NOT the
    // wallet itself. If both legs map to wallet (shouldn't happen in
    // practice) or neither (the SUSPENSE default), falls back to the
    // credit side for IN, debit side for OUT, which matches accounting
    // convention.
    const categorisationHint = (() => {
      if (mapping.credit && mapping.credit.isWallet !== true) {
        return hintToResolveShape(mapping.credit);
      }
      if (mapping.debit && mapping.debit.isWallet !== true) {
        return hintToResolveShape(mapping.debit);
      }
      // Both legs are wallet-shaped (defensive — shouldn't happen).
      return tx.direction === 'in'
        ? hintToResolveShape(mapping.credit)
        : hintToResolveShape(mapping.debit);
    })();

    // Transaction row (1:1 with journalEntries[0] via journalEntryId @unique)
    const transactions: unknown[] = [{
      id: txId,
      organizationId: orgId,
      __resolveWalletId: tx.source_wallet_id
        ? { sourceWalletId: tx.source_wallet_id }
        : null,
      __resolveChartOfAccountId: categorisationHint,
      mode: 'STANDARD' as const,
      date,
      time,
      amount,
      asset,
      direction,
      status,
      clearedStatus: 'NOT_CLEARED' as const,
      __resolveContactId: tx.counterparty
        ? {
            name: tx.counterparty,
            kind: tx.direction === 'in' ? ('CUSTOMER' as const) : ('VENDOR' as const),
          }
        : null,
      toFromAddress: tx.counterparty ?? null,
      exchangeRate: null,
      txFee: null,
      refNum: txRefNum,
      memo: tx.description ?? null,
      journalEntryId: jeId,
    }];

    return {
      rows: {
        Wallet: walletUpserts,
        Transaction: transactions,
        JournalEntry: journalEntries,
        JournalEntryLine: journalEntryLines,
      },
      metadata: {
        canonical_id: tx.id,
        requires_encryption: [],
      },
    };
  },
};

/**
 * Strip undefined fields from a ResolvedCoaHint before emission. V2's sync
 * handler reads the __resolveCoa hint as JSON; cleaner output keeps the
 * wire payload tight and the V2-side resolver simpler.
 */
function hintToResolveShape(hint: ResolvedCoaHint): Record<string, unknown> {
  const out: Record<string, unknown> = {
    accountType: hint.accountType,
    accountSubType: hint.accountSubType,
  };
  if (hint.isWallet !== undefined) out.isWallet = hint.isWallet;
  if (hint.targetSourceWalletId !== undefined) out.targetSourceWalletId = hint.targetSourceWalletId;
  if (hint.currency !== undefined) out.currency = hint.currency;
  if (hint.name !== undefined) out.name = hint.name;
  return out;
}

// ─── Profile bootstrap ────────────────────────────────────────────────────

// Module-level cache. or-sync calls `ensureProfileLoaded` once per request
// batch (cheap on cache hit, single async parse on cold start) before
// invoking toAppShape.
// deno-lint-ignore no-explicit-any
let profileSync: any = null;

export async function ensureProfileLoaded(): Promise<void> {
  if (profileSync) return;
  // loadProfile is sync now (reads from a bundled TS string), but the
  // outer ensure*Loaded API stays async so callers can keep awaiting
  // without breaking. The async signature also leaves room for future
  // remote-fetch profile sources (e.g. consumer-published HTTP endpoints).
  profileSync = loadProfile('bitbooks-v2');
}
