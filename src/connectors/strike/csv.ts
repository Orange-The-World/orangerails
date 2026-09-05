/**
 * Strike CSV → typed rows + StagedImportPayload.
 *
 * Why this file owns delimiter detection / date parsing / sign handling:
 * OR's design is that every provider quirk gets normalized inside the
 * connector folder so V2/V3 never learn about Strike's "Sep 24 2024" format
 * or its semicolon delimiter. Adding ShakePay tomorrow is a copy of this
 * folder, not a fork of OR core.
 *
 * Strike-specific quirks handled here:
 *   - Semicolon delimiter (CSV-with-semicolons is European-Excel style).
 *   - Date: "Sep 24 2024 13:21:51" (3-letter month, no zero pad on day).
 *   - Transaction Type is a label, not a sign. A real export signs its
 *     amounts, so the sign decides debit vs credit and the type is only a
 *     fallback for files that carry unsigned magnitudes.
 *   - No Account column. Emit empty account_code / account_name; mapping
 *     wizard handles the fallback.
 *   - "Destination" is an LN invoice or BTC address. Emit as memo, NOT as
 *     contact_name , these are addresses, not people.
 */

import { createHash } from "node:crypto";

import {
  STAGED_IMPORT_CONTRACT_VERSION,
  type StagedImportPayload,
  type V3StagedRow,
} from "../contract";
import type { StrikeCsvRow, StrikeTxType } from "./types";

const CONNECTOR_VERSION = "0.1.0";

const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

/** Try `;`, `,`, `\t` on the first line , winner is delimiter with most splits. */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [";", ",", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const n = firstLine.split(d).length;
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

/** "Sep 24 2024 13:21:51" → "2024-09-24" (V3 importer wants ISO-style date). */
export function normalizeStrikeDate(raw: string): string {
  const t = raw.trim();
  // Pattern: MMM D[D] YYYY [HH:MM:SS]
  const m = t.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/);
  if (!m) return t; // leave as-is; warning emitted by caller
  const mon = MONTHS[m[1].toLowerCase()];
  if (!mon) return t;
  const day = m[2].padStart(2, "0");
  return `${m[3]}-${mon}-${day}`;
}

/**
 * Legacy header names, kept so files exported by our own CLI and the older
 * fixtures keep parsing. A genuine Strike export matches none of these, which
 * is why real files used to be rejected outright.
 */
const LEGACY_ALIASES = {
  date: ["date", "transaction date", "time"],
  direction: ["direction", "type"],
  currency: ["currency"],
  amount: ["amount (currency)", "amount", "amount (btc)"],
  description: ["description", "memo"],
  destination: ["destination", "address", "to"],
  fee: ["fee", "network fee"],
  reference: ["reference", "ref", "id"],
} as const;

/**
 * A real Strike export names the currency inside the column rather than in a
 * column of its own: "Amount EUR", "Fee EUR", "Cost Basis (EUR)". The code
 * varies per account, so it has to be read off the header instead of matched
 * against a fixed list. The 2-to-4 letter bound is what keeps the legacy
 * placeholder header "Amount (Currency)" out: it is not a currency code, and
 * it is handled by the legacy alias table instead.
 */
const AMOUNT_RE = /^amount\s*\(?([a-z]{2,4})\)?$/;
const FEE_RE = /^fee\s*\(?([a-z]{2,4})\)?$/;
const COST_BASIS_RE = /^cost basis\s*\(?([a-z]{2,4})\)?$/;

type HeaderIndex = {
  date?: number;
  direction?: number;
  description?: number;
  destination?: number;
  reference?: number;
  btcAmount?: number;
  btcFee?: number;
  fiatAmount?: number;
  fiatFee?: number;
  fiatCurrency?: string;
  btcPrice?: number;
  costBasis?: number;
  txHash?: number;
  note?: number;
  legacyCurrency?: number;
  legacyAmount?: number;
  legacyFee?: number;
};

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

function firstIndexOf(norm: string[], candidates: readonly string[]): number | undefined {
  for (const c of candidates) {
    const i = norm.indexOf(c);
    if (i >= 0) return i;
  }
  return undefined;
}

function buildHeaderIndex(headerRow: string[]): {
  index: HeaderIndex;
  missing: string[];
} {
  const norm = headerRow.map(normalizeHeader);
  const index: HeaderIndex = {};

  index.date = firstIndexOf(norm, ["date & time (utc)", "date and time (utc)", ...LEGACY_ALIASES.date]);
  index.direction = firstIndexOf(norm, ["transaction type", ...LEGACY_ALIASES.direction]);
  index.description = firstIndexOf(norm, LEGACY_ALIASES.description);
  index.destination = firstIndexOf(norm, LEGACY_ALIASES.destination);
  index.reference = firstIndexOf(norm, LEGACY_ALIASES.reference);
  index.btcPrice = firstIndexOf(norm, ["btc price"]);
  index.txHash = firstIndexOf(norm, ["transaction hash"]);
  index.note = firstIndexOf(norm, ["note"]);
  index.legacyCurrency = firstIndexOf(norm, LEGACY_ALIASES.currency);

  for (let i = 0; i < norm.length; i += 1) {
    const h = norm[i];
    const amount = AMOUNT_RE.exec(h);
    if (amount) {
      const code = amount[1];
      if (code === "btc") index.btcAmount = i;
      else {
        index.fiatAmount = i;
        index.fiatCurrency = code.toUpperCase();
      }
      continue;
    }
    const fee = FEE_RE.exec(h);
    if (fee) {
      const code = fee[1];
      if (code === "btc") index.btcFee = i;
      else index.fiatFee = i;
      continue;
    }
    const basis = COST_BASIS_RE.exec(h);
    if (basis) index.costBasis = i;
  }

  // Legacy files carry a single unqualified Amount / Fee plus a Currency column.
  if (index.btcAmount === undefined && index.fiatAmount === undefined) {
    index.legacyAmount = firstIndexOf(norm, LEGACY_ALIASES.amount);
  }
  if (index.btcFee === undefined && index.fiatFee === undefined) {
    index.legacyFee = firstIndexOf(norm, LEGACY_ALIASES.fee);
  }
  // Only fall back to Note-as-description when there is no Description column.
  if (index.description === undefined) index.description = firstIndexOf(norm, ["note"]);

  const missing: string[] = [];
  if (index.date === undefined) missing.push("date");
  if (index.direction === undefined) missing.push("transaction type");
  if (
    index.btcAmount === undefined &&
    index.fiatAmount === undefined &&
    index.legacyAmount === undefined
  ) {
    missing.push("amount");
  }
  return { index, missing };
}

const TX_TYPES: readonly StrikeTxType[] = [
  "Receive",
  "Send",
  "Deposit",
  "Withdrawal",
  "Purchase",
  "Sale",
];

function toTxType(raw: string): StrikeTxType | null {
  const t = raw.trim().toLowerCase();
  return TX_TYPES.find((v) => v.toLowerCase() === t) ?? null;
}

export type ParseStrikeCsvResult = {
  rows: StrikeCsvRow[];
  warnings: string[];
  delimiter: string;
};

export function parseStrikeCsv(input: string | Buffer): ParseStrikeCsvResult {
  const text = typeof input === "string" ? input : input.toString("utf8");
  const warnings: string[] = [];
  const delimiter = detectDelimiter(text);

  const grid = parseDelimited(text, delimiter);
  if (grid.length === 0) {
    return { rows: [], warnings: ["Strike CSV is empty."], delimiter };
  }
  const headerRow = grid[0];
  const { index, missing } = buildHeaderIndex(headerRow);
  if (missing.length) {
    warnings.push(
      `Strike CSV header is missing required column(s): ${missing.join(", ")}. Found: ${headerRow.join(" | ")}`,
    );
    return { rows: [], warnings, delimiter };
  }

  const rows: StrikeCsvRow[] = [];
  for (let r = 1; r < grid.length; r += 1) {
    const cells = grid[r];
    if (cells.every((c) => c.trim() === "")) continue;
    const at = (i: number | undefined): string =>
      i === undefined ? "" : (cells[i] ?? "").trim();

    const typeRaw = at(index.direction);
    const direction = toTxType(typeRaw);
    if (!direction) {
      warnings.push(`Row ${r + 1}: unknown Transaction Type "${typeRaw}", skipped.`);
      continue;
    }

    const btcAmount = at(index.btcAmount);
    const fiatAmount = at(index.fiatAmount);
    const legacyAmount = at(index.legacyAmount);
    const btcFee = at(index.btcFee);
    const fiatFee = at(index.fiatFee);
    const legacyFee = at(index.legacyFee);

    // Bitcoin is the primary leg when present, so `amount` and `currency`
    // keep meaning what they meant to callers written before fiat legs
    // existed. Legacy files have one unqualified amount and a Currency column.
    const primaryAmount = btcAmount || fiatAmount || legacyAmount;
    const primaryFee = btcAmount ? btcFee : fiatAmount ? fiatFee : legacyFee;
    const primaryCurrency = btcAmount
      ? "BTC"
      : fiatAmount
        ? (index.fiatCurrency ?? "")
        : at(index.legacyCurrency);

    if (!primaryAmount) {
      warnings.push(`Row ${r + 1}: no amount in any currency column, skipped.`);
      continue;
    }

    rows.push({
      date: at(index.date),
      direction,
      currency: primaryCurrency,
      amount: primaryAmount,
      description: at(index.description),
      destination: at(index.destination),
      ...(primaryFee ? { fee: primaryFee } : {}),
      ...(at(index.reference) ? { reference: at(index.reference) } : {}),
      ...(btcAmount ? { btcAmount } : {}),
      ...(btcFee ? { btcFee } : {}),
      ...(fiatAmount ? { fiatAmount } : {}),
      ...(fiatFee ? { fiatFee } : {}),
      ...(index.fiatCurrency ? { fiatCurrency: index.fiatCurrency } : {}),
      ...(at(index.btcPrice) ? { btcPrice: at(index.btcPrice) } : {}),
      ...(at(index.costBasis) ? { costBasis: at(index.costBasis) } : {}),
      ...(at(index.txHash) ? { txHash: at(index.txHash) } : {}),
      ...(at(index.note) ? { note: at(index.note) } : {}),
    });
  }
  return { rows, warnings, delimiter };
}

/**
 * Strip sign from a Strike-signed amount: Direction carries the sign in V3
 * (debit vs credit), so the magnitude is all we want.
 */
export function magnitude(amount: string): string {
  return amount.replace(/^-/, "").trim();
}

/**
 * Convert typed Strike rows into V3 journal-entry-shaped staged rows.
 *
 * Each Strike transaction becomes ONE staged row with the account-side fields
 * blank. The mapping wizard / V3's default-account fallback fills them in.
 * Debit vs Credit is decided by the sign of the amount, not by the type
 * label: a Sale moves bitcoin out and a Withdrawal moves fiat out, and
 * neither of them is called "Send".
 * This is a placeholder convention; the mapping wizard will pair each row
 * with a counter-account so the entry balances.
 *
 * Which side a row lands on:
 *
 *   1. An explicit sign on the amount wins. A real export signs its outflows,
 *      and the sign is the only field that distinguishes a target order being
 *      opened from the same order being cancelled: same type, same reference,
 *      opposite amounts.
 *   2. If no row in the file carries a sign, the file states magnitudes only
 *      and the Transaction Type decides instead. That is the shape the legacy
 *      alias table describes.
 *   3. Where the sign and the type disagree, the sign wins and the row is
 *      named in a warning, so a guessed direction is never silent.
 */
/** Which way a Transaction Type moves the PRIMARY leg, when no sign is given. */
function typeImpliesInflow(t: StrikeTxType): boolean {
  // Purchase brings bitcoin in, Sale sends it out; the primary leg is bitcoin
  // whenever the row has one, so those two read opposite to their fiat side.
  return t === "Receive" || t === "Deposit" || t === "Purchase";
}

export function strikeRowsToJournalStagedRows(rows: StrikeCsvRow[]): {
  staged: V3StagedRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const out: V3StagedRow[] = [];
  // Decided once per file, not per row. If anything in this export is signed,
  // the export signs its outflows, so an unsigned amount means positive. Only
  // a file with no signs anywhere is stating bare magnitudes.
  const fileIsSigned = rows.some((r) => r.amount.trim().startsWith("-"));
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const date = normalizeStrikeDate(r.date);
    if (date === r.date && r.date && !/^\d{4}-\d{2}-\d{2}/.test(r.date)) {
      warnings.push(`Row ${i + 2}: could not normalize date "${r.date}" , left as-is.`);
    }
    // Purchase and Sale rows carry a fiat leg AND a bitcoin leg on one line.
    // A staged row has a single debit/credit pair, so posting one of the two
    // legs would silently misstate the entry. Hold them back and say so.
    if (r.btcAmount && r.fiatAmount) {
      warnings.push(
        `Row ${i + 2}: ${r.direction} has both a bitcoin leg and a ${r.fiatCurrency ?? "fiat"} leg, ` +
          `which needs two-sided staging. Held back rather than posted as one side.`,
      );
      continue;
    }
    const amount = magnitude(r.amount);
    const raw = r.amount.trim();
    const isSigned = raw.startsWith("-") || raw.startsWith("+");
    const impliedByType = typeImpliesInflow(r.direction);
    // See the docblock: sign first, type only when the whole file is unsigned.
    const isInflow = isSigned || fileIsSigned ? !raw.startsWith("-") : impliedByType;
    if (isInflow !== impliedByType) {
      warnings.push(
        `Row ${i + 2}: ${r.direction} of ${raw} posts as ${isInflow ? "a debit" : "a credit"}, ` +
          `which is the opposite of what the type alone implies. The sign was followed.`,
      );
    }
    out.push({
      je_date: date,
      "je_ref_#": r.reference ?? "",
      je_memo: r.destination,
      je_status: "Posted",
      account_code: "",
      account_name: "",
      line_description: r.description,
      wallet_currency: r.currency,
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

export type BuildStrikeCsvPayloadInput = {
  csvText: string;
  fileName?: string;
  fileBytes?: Uint8Array;
  orgHint?: { name?: string; currency?: string };
};

export function buildStrikeCsvStagedPayload(input: BuildStrikeCsvPayloadInput): {
  payload: StagedImportPayload;
  warnings: string[];
  rows: StrikeCsvRow[];
} {
  const { rows, warnings: parseWarn } = parseStrikeCsv(input.csvText);
  const { staged, warnings: rowWarn } = strikeRowsToJournalStagedRows(rows);
  const warnings = [...parseWarn, ...rowWarn];

  const refs = new Set<string>();
  for (const s of staged) refs.add(s["je_ref_#"] || "");

  const payload: StagedImportPayload = {
    contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
    source: {
      name: "strike",
      version: CONNECTOR_VERSION,
      exportedAt: new Date().toISOString(),
    },
    ...(input.orgHint ? { orgHint: input.orgHint } : {}),
    manifest: {
      files: [
        {
          name: input.fileName ?? "strike.csv",
          sizeBytes: input.fileBytes?.length ?? Buffer.byteLength(input.csvText, "utf8"),
          ...(input.fileBytes ? { sha256: sha256Hex(input.fileBytes) } : {}),
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
