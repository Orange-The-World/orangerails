/**
 * Coinbase CSV -> typed rows + StagedImportPayload.
 *
 * Why this file owns preamble-skip / date parsing / type-to-sign handling:
 * OR's design is that every provider quirk gets normalized inside the
 * connector folder so V2/V3 never learn about Coinbase's report preamble or
 * its transaction-type vocabulary. Adding the next exchange is a copy of this
 * folder, not a fork of OR core. (Generic CSV-grid helpers are duplicated
 * per-connector by that same convention; a shared parser is a worthwhile
 * future refactor across strike/quickbooks/wave/coinbase, out of scope here.)
 *
 * Coinbase-specific quirks handled here:
 *   - Metadata preamble before the header row. Coinbase's "Transaction
 *     history" report prepends a few lines (title, account line, blank)
 *     before the real header. We scan for the header row instead of
 *     assuming it is row 0.
 *   - Timestamp: ISO-8601 UTC, e.g. "2024-09-24T13:21:51Z". V3 wants a
 *     YYYY-MM-DD date.
 *   - Sign lives in the Transaction Type, not the quantity. "Quantity
 *     Transacted" is always positive; Buy/Receive/*Income are inflows,
 *     Sell/Send/Withdrawal/Convert are outflows.
 *   - Multi-asset: one report can contain BTC, ETH, USDC, ... Each row's
 *     wallet_currency is its own Asset; we never collapse them.
 *   - "Notes" is a memo / counterparty address, NOT a human contact.
 *
 * Built to Coinbase's documented report layout; validate transaction-type
 * coverage against a fresh real export before trusting a new type.
 */

import { createHash } from "node:crypto";

import {
  STAGED_IMPORT_CONTRACT_VERSION,
  type StagedImportPayload,
  type V3StagedRow,
} from "../contract";
import type { CoinbaseCsvRow } from "./types";

const CONNECTOR_VERSION = "0.1.0";

/** Try `,`, `;`, `\t` on the header line; winner is delimiter with most splits. */
function detectDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const n = headerLine.split(d).length;
    if (n > bestCount) {
      bestCount = n;
      best = d;
    }
  }
  return best;
}

/** RFC-4180-ish parser parameterized by delimiter. */
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Keys that map to an actual CSV column (excludes the diagnostic sourceLine). */
type CoinbaseCsvColumn = Exclude<keyof CoinbaseCsvRow, "sourceLine">;

const HEADER_ALIASES: Record<CoinbaseCsvColumn, string[]> = {
  timestamp: ["timestamp", "time", "created at", "date"],
  type: ["transaction type", "type"],
  asset: ["asset", "currency"],
  quantity: ["quantity transacted", "quantity", "amount"],
  spotPriceCurrency: ["spot price currency", "price currency"],
  spotPrice: ["spot price at transaction", "price at transaction", "spot price"],
  subtotal: ["subtotal"],
  total: ["total (inclusive of fees and/or spread)", "total"],
  fees: ["fees and/or spread", "fees", "fee"],
  notes: ["notes", "note", "memo"],
  id: ["id", "transaction id", "reference"],
};

/** Columns without which we cannot build a meaningful staged row. */
const REQUIRED: Array<CoinbaseCsvColumn> = ["timestamp", "type", "asset", "quantity"];

/**
 * Coinbase prepends metadata lines before the header. Find the first grid row
 * that looks like the real header: it must resolve both a timestamp column and
 * a transaction-type column. Returns -1 if no header row is found.
 */
function findHeaderRowIndex(grid: string[][]): number {
  for (let r = 0; r < grid.length; r += 1) {
    const norm = grid[r].map(normalizeHeader);
    const hasTimestamp = HEADER_ALIASES.timestamp.some((a) => norm.includes(a));
    const hasType = HEADER_ALIASES.type.some((a) => norm.includes(a));
    if (hasTimestamp && hasType) return r;
  }
  return -1;
}

function buildHeaderIndex(headerRow: string[]): {
  index: Partial<Record<CoinbaseCsvColumn, number>>;
  missing: string[];
} {
  const norm = headerRow.map(normalizeHeader);
  const index: Partial<Record<CoinbaseCsvColumn, number>> = {};
  const missing: string[] = [];
  for (const key of Object.keys(HEADER_ALIASES) as Array<CoinbaseCsvColumn>) {
    let found = -1;
    for (const c of HEADER_ALIASES[key]) {
      const i = norm.indexOf(c);
      if (i >= 0) {
        found = i;
        break;
      }
    }
    if (found >= 0) index[key] = found;
    else if (REQUIRED.includes(key)) missing.push(key);
  }
  return { index, missing };
}

/** "2024-09-24T13:21:51Z" (or any ISO/date-leading string) -> "2024-09-24". */
export function normalizeCoinbaseDate(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return t; // leave as-is; caller emits a warning
}

/**
 * Map a Coinbase transaction type to flow direction.
 *   inflow  = asset received -> Debit
 *   outflow = asset sent     -> Credit
 * Returns null for an unrecognized type so the caller can warn + default.
 */
export function coinbaseTypeDirection(type: string): "inflow" | "outflow" | null {
  const t = type.trim().toLowerCase();
  if (!t) return null;
  const INFLOW = [
    "buy",
    "receive",
    "advanced trade buy",
    "deposit",
    "rewards income",
    "reward income",
    "staking income",
    "inflation reward",
    "coinbase earn",
    "learning reward",
    "interest",
  ];
  const OUTFLOW = [
    "sell",
    "send",
    "withdrawal",
    "advanced trade sell",
    "paid for an order",
    "convert",
  ];
  if (INFLOW.some((k) => t === k || t.startsWith(k))) return "inflow";
  if (OUTFLOW.some((k) => t === k || t.startsWith(k))) return "outflow";
  return null;
}

export type ParseCoinbaseCsvResult = {
  rows: CoinbaseCsvRow[];
  warnings: string[];
  delimiter: string;
};

export function parseCoinbaseCsv(input: string | Buffer): ParseCoinbaseCsvResult {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const warnings: string[] = [];

  // Detect delimiter from the line that contains "Transaction Type" so the
  // metadata preamble (which may use different punctuation) does not skew it.
  const probeLine =
    text.split(/\r?\n/).find((l) => /transaction type|timestamp/i.test(l)) ??
    text.split(/\r?\n/, 1)[0] ??
    "";
  const delimiter = detectDelimiter(probeLine);

  const grid = parseDelimited(text, delimiter);
  if (grid.length === 0) {
    return { rows: [], warnings: ["Coinbase CSV is empty."], delimiter };
  }

  const headerIdx = findHeaderRowIndex(grid);
  if (headerIdx < 0) {
    warnings.push(
      "Coinbase CSV header row not found (expected a row with Timestamp + Transaction Type).",
    );
    return { rows: [], warnings, delimiter };
  }

  const { index, missing } = buildHeaderIndex(grid[headerIdx]);
  if (missing.length) {
    warnings.push(
      `Coinbase CSV header is missing required column(s): ${missing.join(", ")}. Found: ${grid[headerIdx].join(" | ")}`,
    );
    return { rows: [], warnings, delimiter };
  }

  const rows: CoinbaseCsvRow[] = [];
  for (let r = headerIdx + 1; r < grid.length; r += 1) {
    const cells = grid[r];
    if (cells.every((c) => c.trim() === "")) continue;
    const get = (k: CoinbaseCsvColumn): string => {
      const i = index[k];
      return i === undefined ? "" : (cells[i] ?? "").trim();
    };
    rows.push({
      timestamp: get("timestamp"),
      type: get("type"),
      asset: get("asset"),
      quantity: get("quantity"),
      spotPriceCurrency: get("spotPriceCurrency"),
      spotPrice: get("spotPrice"),
      subtotal: get("subtotal"),
      total: get("total"),
      fees: get("fees"),
      notes: get("notes"),
      id: get("id"),
      // grid is 0-based; file lines are 1-based. Preserve the true file line so
      // downstream warnings point at the row the user actually sees.
      sourceLine: r + 1,
    });
  }
  return { rows, warnings, delimiter };
}

/** Strip any sign; direction is carried by the transaction type, not the number. */
export function magnitude(amount: string): string {
  return amount.replace(/^-/, "").trim();
}

/**
 * Convert typed Coinbase rows into V3 journal-entry-shaped staged rows.
 *
 * Each Coinbase transaction becomes ONE staged row with the account-side
 * fields blank; the mapping wizard / V3's default-account fallback fills them
 * in and pairs each row with a counter-account so the entry balances.
 * Debit vs Credit is decided by the transaction type:
 *   inflow  (Buy / Receive / *Income) -> Debit  (asset in)
 *   outflow (Sell / Send / Convert)   -> Credit (asset out)
 * Unrecognized types are kept (never silently dropped) but defaulted to Debit
 * with a warning so the user can correct them in the wizard.
 *
 * Known limitation: only the asset leg is emitted (quantity in its own
 * wallet_currency). The fiat columns (subtotal / total / fees) are parsed but
 * deliberately not turned into a second line here; V3's import wizard pairs
 * each asset line with its counter-account, which is where the cash side
 * belongs. Captured-but-deferred, not dropped data.
 */
export function coinbaseRowsToJournalStagedRows(rows: CoinbaseCsvRow[]): {
  staged: V3StagedRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const out: V3StagedRow[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    // True file line for diagnostics (falls back to array position if unset).
    const line = r.sourceLine ?? i + 1;
    const date = normalizeCoinbaseDate(r.timestamp);
    if (date === r.timestamp && r.timestamp && !/^\d{4}-\d{2}-\d{2}/.test(r.timestamp)) {
      warnings.push(`Row ${line}: could not normalize date "${r.timestamp}", left as-is.`);
    }
    let dir = coinbaseTypeDirection(r.type);
    if (dir === null) {
      warnings.push(
        `Row ${line}: unrecognized Coinbase type "${r.type}", defaulted to Debit, verify in the wizard.`,
      );
      dir = "inflow";
    }
    const amount = magnitude(r.quantity);
    const isInflow = dir === "inflow";
    out.push({
      je_date: date,
      "je_ref_#": r.id ?? "",
      je_memo: r.notes ?? "",
      je_status: "Posted",
      account_code: "",
      account_name: "",
      line_description: `${r.type} ${r.asset}`.trim(),
      wallet_currency: r.asset,
      debit: isInflow ? amount : "",
      credit: isInflow ? "" : amount,
      contact_name: "",
    });
  }
  return { staged: out, warnings };
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type BuildCoinbaseCsvPayloadInput = {
  csvText: string;
  fileName?: string;
  fileBytes?: Uint8Array;
  orgHint?: { name?: string; currency?: string };
};

export function buildCoinbaseCsvStagedPayload(input: BuildCoinbaseCsvPayloadInput): {
  payload: StagedImportPayload;
  warnings: string[];
  rows: CoinbaseCsvRow[];
} {
  const { rows, warnings: parseWarn } = parseCoinbaseCsv(input.csvText);
  const { staged, warnings: rowWarn } = coinbaseRowsToJournalStagedRows(rows);
  const warnings = [...parseWarn, ...rowWarn];

  // Count distinct journal entries. Coinbase's stable transaction id only
  // exists in newer report variants, so most exports have an empty je_ref_#.
  // A row WITHOUT an id is its own standalone entry (one transaction = one
  // entry); rows that DO share a non-empty id collapse into one. Counting
  // unique refs alone would wrongly report "1 entry" for an id-less export.
  const seenRefs = new Set<string>();
  let journalEntries = 0;
  for (const s of staged) {
    const ref = s["je_ref_#"];
    if (ref) {
      if (!seenRefs.has(ref)) {
        seenRefs.add(ref);
        journalEntries += 1;
      }
    } else {
      journalEntries += 1;
    }
  }

  const payload: StagedImportPayload = {
    contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
    source: {
      name: "coinbase",
      version: CONNECTOR_VERSION,
      exportedAt: new Date().toISOString(),
    },
    ...(input.orgHint ? { orgHint: input.orgHint } : {}),
    manifest: {
      files: [
        {
          name: input.fileName ?? "coinbase.csv",
          sizeBytes: input.fileBytes?.length ?? Buffer.byteLength(input.csvText, "utf8"),
          ...(input.fileBytes ? { sha256: sha256Hex(input.fileBytes) } : {}),
        },
      ],
    },
    summary: {
      accounts: 0,
      contacts: 0,
      journalEntries,
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
