/**
 * Orange Rails to BitBooks push contract.
 *
 * This file defines the JSON shape every OR connector emits and V3 ingests.
 * It is the canonical handoff format between OR (source-specific import
 * logic) and V3 (the books).
 *
 * Two ingress paths into V3, both honoured by this contract:
 *
 *   Mode 1 , CSV upload (working today)
 *     OR connector emits V3-shaped CSV files. Founder uploads them through
 *     V3's existing inline ImportPopup widgets (Admin / JournalEntries /
 *     Wallets / Transactions / Payments pages). V3 parses CSV, encrypts in
 *     the browser, writes to entity tables. import_jobs is not involved.
 *     This is what the Wave connector ships today.
 *
 *   Mode 2 , Staged payload upload (target for QB + future connectors)
 *     OR connector emits a single `.or-import.json` file containing a
 *     StagedImportPayload. Founder uploads it through a new V3 wizard
 *     ("Import from Orange Rails"). V3 stages the payload into import_jobs
 *     (rows encrypted under MEK), then commits to entity tables on
 *     confirmation. The wizard surfaces parse_summary / warnings / errors
 *     and lets the user override any classification hint.
 *
 * The staged-row shape matches V3's existing CSV importer
 * `ImportPreviewRow.data` map exactly, so V3 can reuse all of `src/lib/csv/*`
 * row validation + commit logic , no parallel commit path needed.
 *
 * ZKA boundary
 *   The payload travels plaintext on the founder's machine (the OR CLI is
 *   local-only). V3 encrypts before write. The server only ever sees
 *   ciphertext + plaintext orchestration metadata.
 */

import type { LNInvoice } from './lightning';

export const STAGED_IMPORT_CONTRACT_VERSION = 1;

/**
 * One row, shaped as a flat string map keyed by the V3 CSV importer's
 * lower-snake-case column key (`importPopupRow.data`). Examples:
 *
 *   accounts:        { name, code, type, subtype, normal_balance, category, description }
 *   contacts:        { name, type, email, phone, street, city, state, country, zip }
 *   journal_entries: { je_date, "je_ref_#", je_memo, je_status, account_code,
 *                      account_name, line_description, wallet_currency,
 *                      debit, credit }
 *
 * Keys MUST match the column header (lowercased, spaces to underscores) so
 * V3's reuse of `parseCsv*` validation rules works without translation.
 */
export type V3StagedRow = Record<string, string>;

/**
 * A Lightning invoice that has crossed the settled boundary.
 *
 * This is `LNInvoice` narrowed so the type system guarantees what the
 * confirms client (#105) enforces at runtime: `settled` is literally `true`
 * and `settled_at` is a non-null ISO-8601 string. Only invoices of this
 * shape may enter the push contract. A pending or failed invoice
 * (`settled:false, settled_at:null`) has no place in the books and must be
 * rejected at the boundary, never silently dropped.
 */
export type LNSettledInvoice = LNInvoice & {
  state: { settled: true; settled_at: string };
};

/**
 * Fail-closed guard for the settled boundary.
 *
 * Carries the #105 ingest-boundary invariant into the contract: a connector
 * filling `staged.lightning` must run every invoice through this first. It
 * throws on any non-settled record rather than admitting it, so a unit or
 * cursor bug upstream surfaces as a loud failure instead of a quietly
 * missing or bogus financial row.
 */
export function assertLNSettledForContract(inv: LNInvoice): asserts inv is LNSettledInvoice {
  if (inv.state.settled !== true || inv.state.settled_at === null) {
    throw new Error(
      `Staged import: only terminal-settled invoices may enter the contract (payment_hash ${inv.payment_hash}).`,
    );
  }
}

export type StagedImportPayload = {
  contractVersion: typeof STAGED_IMPORT_CONTRACT_VERSION;

  /** Which OR connector built this payload. */
  source: {
    /** Stable connector identifier, e.g. 'wave', 'quickbooks', 'plaid'. */
    name: string;
    /** OR connector version (semver) for debugging compat issues. */
    version: string;
    /** ISO-8601 timestamp the connector emitted the payload. */
    exportedAt: string;
  };

  /**
   * Best-effort hints to help the founder pick the right V3 org. The wizard
   * shows these prominently. Never used for matching automatically.
   */
  orgHint?: {
    name?: string;
    currency?: string;
  };

  /** What raw files the connector consumed. Helps with reproducibility. */
  manifest: {
    files: Array<{
      name: string;
      sizeBytes: number;
      /** SHA-256 hex of the raw file bytes. Optional but recommended. */
      sha256?: string;
    }>;
  };

  /** Counts + connector-level warnings/errors. Surfaced in the wizard. */
  summary: {
    accounts: number;
    contacts: number;
    journalEntries: number;
    journalLines: number;
    warnings: string[];
    errors: string[];
  };

  /**
   * The actual rows V3 will import. Each entity array is optional , a
   * connector may emit only contacts, only accounts, etc. V3 applies them
   * in the order: accounts to contacts to journal entries. (JE rows depend
   * on account codes existing; contacts have no dependencies.)
   *
   * `lightning` is the settled-invoice staging input from the LN confirms
   * client. It is NOT a V3StagedRow array: settled invoices are carried in
   * their canonical provider-agnostic shape and mapped to journal-entry rows
   * by the V3 wizard, which is where the fiat rate and the incoming/outgoing
   * direction are supplied (with user override). The connector cannot build
   * a balanced journal entry on its own, so it stages the raw settled facts
   * and lets V3 finish the mapping. Every element MUST have passed
   * `assertLNSettledForContract`.
   */
  staged: {
    accounts?: V3StagedRow[];
    contacts?: V3StagedRow[];
    journalEntries?: V3StagedRow[];
    lightning?: LNSettledInvoice[];
  };

  /**
   * Optional classification hints from the connector. The wizard pre-fills
   * its review step with these but the user can override. Currently only
   * meaningful for QB-style imports where account names need categorising.
   */
  reconciliation?: {
    accountClassifications?: Record<
      string,
      {
        /** ASSET / LIABILITY / EQUITY / INCOME / EXPENSE */
        type: string;
        subtype?: string;
        /** 0..1, how confident the connector is. */
        confidence: number;
      }
    >;
  };
};

/**
 * Validate the structural shape of a payload without touching its contents.
 * Throws on malformed input. Used by both the OR connector (sanity-check
 * before writing) and V3 (sanity-check on upload).
 */
export function assertStagedImportPayload(value: unknown): asserts value is StagedImportPayload {
  if (!value || typeof value !== 'object') {
    throw new Error('Staged import: payload is not an object.');
  }
  const v = value as Record<string, unknown>;
  if (v.contractVersion !== STAGED_IMPORT_CONTRACT_VERSION) {
    throw new Error(
      `Staged import: contractVersion ${String(v.contractVersion)} is not supported (expected ${STAGED_IMPORT_CONTRACT_VERSION}).`,
    );
  }
  const source = v.source as Record<string, unknown> | undefined;
  if (!source || typeof source.name !== 'string' || typeof source.version !== 'string') {
    throw new Error('Staged import: source.name / source.version are required strings.');
  }
  const summary = v.summary as Record<string, unknown> | undefined;
  if (!summary || typeof summary !== 'object') {
    throw new Error('Staged import: summary section is required.');
  }
  const staged = v.staged as Record<string, unknown> | undefined;
  if (!staged || typeof staged !== 'object') {
    throw new Error('Staged import: staged section is required (may have empty arrays).');
  }
  for (const key of ['accounts', 'contacts', 'journalEntries'] as const) {
    const arr = staged[key];
    if (arr !== undefined && !Array.isArray(arr)) {
      throw new Error(`Staged import: staged.${key} must be an array if present.`);
    }
  }
  const lightning = staged.lightning;
  if (lightning !== undefined) {
    if (!Array.isArray(lightning)) {
      throw new Error('Staged import: staged.lightning must be an array if present.');
    }
    // Enforce the settled boundary here so an unsettled record cannot be
    // admitted through the upload path, not just the connector build path.
    for (const inv of lightning) {
      assertLNSettledForContract(inv as LNInvoice);
    }
  }
}
