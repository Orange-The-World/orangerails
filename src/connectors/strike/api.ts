/**
 * Strike API adapter (scaffold).
 *
 * Strike's public API surface is documented at https://docs.strike.me but the
 * exact endpoints/auth model + transaction list pagination need confirmation
 * against a live account before this can ship. Until then this module:
 *   - exposes the SAME ingest() contract as csv.ts (DIP — the chooser in
 *     index.ts depends on the interface, not on which adapter is live),
 *   - returns StrikeApiUnavailableError from any call that would need a real
 *     endpoint, so the chooser's `auto` mode falls back to CSV cleanly,
 *   - documents every TODO with a specific endpoint-confirmation step so the
 *     next pass is a copy-paste, not a redesign.
 *
 * Do NOT fake transaction data here. Empty payload + clear error is honest.
 */

import { createHash } from "node:crypto";

import { STAGED_IMPORT_CONTRACT_VERSION, type StagedImportPayload } from "../contract";
import {
  StrikeApiUnavailableError,
  type StrikeAdapter,
  type StrikeApiAccount,
  type StrikeApiTransaction,
  type StrikeCsvRow,
} from "./types";
import { strikeRowsToJournalStagedRows } from "./csv";

const CONNECTOR_VERSION = "0.1.0";

// TODO(strike-api): confirm production base URL + versioning scheme.
// Per docs.strike.me the current public API is at https://api.strike.me/v1
// but customers on legacy plans may be on a different host. Confirm before
// hard-coding.
const STRIKE_API_BASE = "https://api.strike.me/v1";

export type StrikeApiClientOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Inject for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export class StrikeApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: StrikeApiClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? STRIKE_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    // TODO(strike-api): replace with a real low-impact endpoint once confirmed.
    // Candidates from docs.strike.me: GET /accounts (auth probe) or GET /rates/ticker
    // (no-auth, can't validate the API key). Prefer an auth-required endpoint
    // so the result reflects whether the supplied key is actually usable.
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/accounts`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        return { ok: false, error: `Strike API responded ${res.status} ${res.statusText}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // TODO(strike-api): confirm /accounts response shape — current Strike docs
  // show currency + balance per "account" but field names vary by API version.
  async fetchAccounts(): Promise<StrikeApiAccount[]> {
    throw new StrikeApiUnavailableError(
      "Strike API fetchAccounts() is not yet implemented — endpoint shape pending docs confirmation.",
    );
  }

  // TODO(strike-api): confirm transaction list endpoint. Strike historically
  // exposed payment-quote / invoice endpoints but a unified "ledger" list is
  // what we want here. May require iterating two endpoints (payments + invoices)
  // and merging client-side.
  async fetchTransactions(_opts: {
    since?: string;
    until?: string;
  }): Promise<StrikeApiTransaction[]> {
    throw new StrikeApiUnavailableError(
      "Strike API fetchTransactions() is not yet implemented — endpoint shape pending docs confirmation.",
    );
  }
}

/** Map an API transaction into the same typed shape the CSV path uses. */
export function apiTransactionToCsvRow(t: StrikeApiTransaction): StrikeCsvRow {
  return {
    date: t.occurredAt,
    direction: t.direction,
    currency: t.currency,
    amount: t.amount,
    description: t.description ?? "",
    destination: t.destination ?? "",
    fee: t.fee,
    reference: t.reference ?? t.id,
  };
}

export function buildStrikeApiStagedPayload(
  accounts: StrikeApiAccount[],
  transactions: StrikeApiTransaction[],
  orgHint?: { name?: string; currency?: string },
): { payload: StagedImportPayload; warnings: string[]; rows: StrikeCsvRow[] } {
  const rows = transactions.map(apiTransactionToCsvRow);
  const { staged, warnings } = strikeRowsToJournalStagedRows(rows);
  const refs = new Set<string>();
  for (const s of staged) refs.add(s["je_ref_#"] || "");

  const manifestSummary = JSON.stringify({
    accountIds: accounts.map((a) => a.id),
    txCount: transactions.length,
  });
  const payload: StagedImportPayload = {
    contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
    source: {
      name: "strike",
      version: CONNECTOR_VERSION,
      exportedAt: new Date().toISOString(),
    },
    ...(orgHint ? { orgHint } : {}),
    manifest: {
      files: [
        {
          name: "strike-api.json",
          sizeBytes: Buffer.byteLength(manifestSummary, "utf8"),
          sha256: createHash("sha256").update(manifestSummary).digest("hex"),
        },
      ],
    },
    summary: {
      accounts: 0,
      contacts: 0,
      journalEntries: refs.size,
      journalLines: staged.length,
      warnings,
      errors: [],
    },
    staged: {
      ...(staged.length ? { journalEntries: staged } : {}),
    },
  };
  return { payload, warnings, rows };
}

export class StrikeApiAdapter implements StrikeAdapter {
  constructor(
    private readonly client: StrikeApiClient,
    private readonly orgHint?: { name?: string; currency?: string },
  ) {}

  async ingest(): Promise<{
    payload: StagedImportPayload;
    warnings: string[];
    rows: StrikeCsvRow[];
  }> {
    const health = await this.client.healthCheck();
    if (!health.ok) {
      throw new StrikeApiUnavailableError(
        `Strike API health check failed: ${health.error ?? "unknown error"}`,
      );
    }
    const accounts = await this.client.fetchAccounts();
    const txs = await this.client.fetchTransactions({});
    return buildStrikeApiStagedPayload(accounts, txs, this.orgHint);
  }
}
