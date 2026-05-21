/**
 * Strike API adapter.
 *
 * Endpoints used (confirmed against https://docs.strike.me/api/ on 2026-05-21):
 *   - GET /v1/balances             — health probe + per-currency "account" synthesis
 *   - GET /v1/invoices             — incoming payments (state=PAID) with OData pagination
 *   - GET /v1/payouts              — outgoing fiat payouts with $skip/$top pagination
 *
 * Strike has NO public "list lightning/onchain payments (outgoing)" endpoint:
 * docs only expose GET /v1/payments/{id}. We surface that gap as a warning and
 * fall back to CSV for full outgoing-Lightning history. Bake that limitation
 * into the file so the next reader doesn't go hunting.
 *
 * Strike has NO "list accounts" endpoint — an API key is bound to one Strike
 * user. We synthesize one StrikeApiAccount per non-zero balance currency from
 * GET /v1/balances. Mapping to V3's chart-of-accounts is the importer's job.
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

const CONNECTOR_VERSION = "0.2.0";

/**
 * Strike's documented production base URL. All resources are versioned under
 * /v1 (docs.strike.me/api/ — "Introduction"). No legacy hosts in docs.
 */
const STRIKE_API_BASE = "https://api.strike.me/v1";

/** Strike's OData $top maximum is 100 per docs.strike.me/api/get-invoices/. */
const STRIKE_PAGE_SIZE = 100;

export type StrikeApiClientOptions = {
  apiKey: string;
  baseUrl?: string;
  /** Inject for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/** Strike's currency-amount envelope. */
type StrikeMoney = { amount: string; currency: string };

/** GET /v1/balances response entry. */
type StrikeBalance = {
  currency: string;
  current?: string;
  available?: string;
  pending?: string;
  outgoing?: string;
  reserved?: string;
  total?: string;
};

/** GET /v1/invoices response item. */
type StrikeInvoice = {
  invoiceId: string;
  amount: StrikeMoney;
  state: "UNPAID" | "PENDING" | "PAID" | "CANCELLED";
  created: string;
  issuerId?: string;
  receiverId?: string;
  payerId?: string;
  correlationId?: string;
  description?: string;
  transactions?: Array<{
    transactionId: string;
    state: string;
    amountReceived?: StrikeMoney;
    created?: string;
    completed?: string;
  }>;
};

/** GET /v1/payouts response item. */
type StrikePayout = {
  id: string;
  state: "NEW" | "INITIATED" | "COMPLETED" | "FAILED" | "REVERSED";
  created: string;
  amount: StrikeMoney;
  fee?: StrikeMoney & { feePolicy?: "INCLUSIVE" | "EXCLUSIVE" };
  reference?: string;
  initiated?: string;
  completed?: string;
  transactionId?: string;
  paymentMethodId?: string;
};

/** Strike's standard OData paginated envelope. */
type StrikePage<T> = {
  items?: T[];
  count?: number;
  isCountUnknown?: boolean;
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

  /** Issue an authenticated GET; never logs the key. Throws on network errors only. */
  private async get(path: string): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: this.headers(),
    });
  }

  /**
   * Lightweight auth probe. GET /v1/balances requires `partner.balances.read`
   * and returns a short array — the smallest authenticated response Strike
   * exposes. A 200 means the bearer key is valid AND has the read scope OR's
   * adapter needs to do anything useful.
   */
  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await this.get("/balances");
      if (!res.ok) {
        return { ok: false, error: `Strike API responded ${res.status} ${res.statusText}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Strike has no "list accounts" endpoint. An API key represents one Strike
   * user. We synthesize one StrikeApiAccount per currency in GET /v1/balances
   * so V3's importer can map BTC vs USD as separate ledger accounts.
   */
  async fetchAccounts(): Promise<StrikeApiAccount[]> {
    const res = await this.get("/balances");
    if (!res.ok) {
      throw new StrikeApiUnavailableError(
        `Strike GET /balances responded ${res.status} ${res.statusText}`,
      );
    }
    const body = (await res.json()) as StrikeBalance[] | StrikePage<StrikeBalance>;
    const balances: StrikeBalance[] = Array.isArray(body) ? body : (body.items ?? []);
    return balances.map((b) => ({
      id: `strike:${b.currency}`,
      currency: b.currency,
      balance: b.available ?? b.total ?? b.current,
    }));
  }

  /**
   * Returns merged invoices (incoming, state=PAID) + payouts (outgoing fiat).
   *
   * Known limitation: Strike does NOT publish a "list payments" endpoint for
   * outgoing Lightning/on-chain sends — only GET /v1/payments/{id}. Customers
   * who need full outgoing-LN history must use the CSV path. See
   * https://docs.strike.me/api/ ("Payments" section, 2026-05-21).
   */
  async fetchTransactions(opts: {
    since?: string;
    until?: string;
  }): Promise<StrikeApiTransaction[]> {
    const [invoices, payouts] = await Promise.all([
      this.fetchAllInvoices(opts),
      this.fetchAllPayouts(),
    ]);
    const fromInvoices = invoices.filter((inv) => inv.state === "PAID").map(invoiceToTransaction);
    const fromPayouts = payouts
      .filter((p) => p.state === "COMPLETED")
      .filter((p) => withinRange(p.completed ?? p.created, opts))
      .map(payoutToTransaction);
    return [...fromInvoices, ...fromPayouts].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt),
    );
  }

  private async fetchAllInvoices(opts: {
    since?: string;
    until?: string;
  }): Promise<StrikeInvoice[]> {
    const filterParts: string[] = ["state eq 'PAID'"];
    if (opts.since) filterParts.push(`created ge ${opts.since}`);
    if (opts.until) filterParts.push(`created le ${opts.until}`);
    const filter = filterParts.join(" and ");
    const baseQuery = `$filter=${encodeURIComponent(filter)}&$orderby=created%20asc`;
    return paginateOData<StrikeInvoice>(async (skip, top) => {
      const res = await this.get(`/invoices?${baseQuery}&$skip=${skip}&$top=${top}`);
      if (!res.ok) {
        throw new StrikeApiUnavailableError(
          `Strike GET /invoices responded ${res.status} ${res.statusText}`,
        );
      }
      return (await res.json()) as StrikePage<StrikeInvoice>;
    });
  }

  private async fetchAllPayouts(): Promise<StrikePayout[]> {
    return paginateOData<StrikePayout>(async (skip, top) => {
      const res = await this.get(`/payouts?$skip=${skip}&$top=${top}`);
      if (!res.ok) {
        throw new StrikeApiUnavailableError(
          `Strike GET /payouts responded ${res.status} ${res.statusText}`,
        );
      }
      return (await res.json()) as StrikePage<StrikePayout>;
    });
  }
}

/**
 * Generic OData $skip/$top paginator. Open for extension (any endpoint with
 * Strike's standard `{items, count, isCountUnknown}` envelope); single
 * responsibility (loops, doesn't decide endpoint or auth).
 */
export async function paginateOData<T>(
  fetchPage: (skip: number, top: number) => Promise<StrikePage<T>>,
): Promise<T[]> {
  const out: T[] = [];
  let skip = 0;
  for (;;) {
    const page = await fetchPage(skip, STRIKE_PAGE_SIZE);
    const items = page.items ?? [];
    out.push(...items);
    if (items.length < STRIKE_PAGE_SIZE) break;
    skip += items.length;
    // Hard safety cap — Strike accounts can't realistically have >100k rows
    // and we'd rather throw than loop forever on a misbehaving server.
    if (skip > 100_000) {
      throw new StrikeApiUnavailableError(
        "Strike pagination exceeded 100,000 rows; refusing to continue.",
      );
    }
  }
  return out;
}

function withinRange(when: string | undefined, opts: { since?: string; until?: string }): boolean {
  if (!when) return true;
  if (opts.since && when < opts.since) return false;
  if (opts.until && when > opts.until) return false;
  return true;
}

/** Map a paid invoice into the canonical typed shape. Pure function. */
export function invoiceToTransaction(inv: StrikeInvoice): StrikeApiTransaction {
  const settled = inv.transactions?.find((t) => t.completed)?.completed ?? inv.created;
  return {
    id: inv.invoiceId,
    occurredAt: settled,
    direction: "Receive",
    currency: inv.amount.currency,
    amount: inv.amount.amount,
    description: inv.description,
    reference: inv.correlationId ?? inv.invoiceId,
  };
}

/** Map a completed payout into the canonical typed shape. Pure function. */
export function payoutToTransaction(p: StrikePayout): StrikeApiTransaction {
  return {
    id: p.id,
    occurredAt: p.completed ?? p.created,
    direction: "Send",
    currency: p.amount.currency,
    amount: p.amount.amount,
    description: p.reference,
    fee: p.fee?.amount,
    reference: p.transactionId ?? p.id,
  };
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

  // Always-on disclosure: Strike's public API can't return outgoing Lightning
  // payment history (no list endpoint), so an API-only import is incomplete
  // for any user who sends LN. Surface as a warning so the importer wizard
  // can prompt for a CSV top-up.
  const apiWarnings = [
    "Strike API does not expose outgoing Lightning payment history (no list endpoint as of 2026-05-21). For complete Send history, also upload the CSV export.",
  ];

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
      warnings: [...apiWarnings, ...warnings],
      errors: [],
    },
    staged: {
      ...(staged.length ? { journalEntries: staged } : {}),
    },
  };
  return { payload, warnings: [...apiWarnings, ...warnings], rows };
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
