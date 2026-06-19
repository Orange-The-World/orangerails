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
 *   - Direction: "Receive" / "Send" carries the sign , strip negative.
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
import type { StrikeCsvRow } from "./types";

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

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/\s+/g, " ");
}

const HEADER_ALIASES: Record<keyof StrikeCsvRow, string[]> = {
  date: ["date", "transaction date", "time"],
  direction: ["direction", "type"],
  currency: ["currency"],
  amount: ["amount (currency)", "amount", "amount (btc)"],
  description: ["description", "note", "memo"],
  destination: ["destination", "address", "to"],
  fee: ["fee", "network fee"],
  reference: ["reference", "ref", "id"],
};

function buildHeaderIndex(headerRow: string[]): {
  index: Partial<Record<keyof StrikeCsvRow, number>>;
  missing: string[];
} {
  const norm = headerRow.map(normalizeHeader);
  const index: Partial<Record<keyof StrikeCsvRow, number>> = {};
  const missing: string[] = [];
  for (const key of Object.keys(HEADER_ALIASES) as Array<keyof StrikeCsvRow>) {
    const candidates = HEADER_ALIASES[key];
    let found = -1;
    for (const c of candidates) {
      const i = norm.indexOf(c);
      if (i >= 0) {
        found = i;
        break;
      }
    }
    if (found >= 0) {
      index[key] = found;
    } else if (key !== "fee" && key !== "reference") {
      missing.push(key);
    }
  }
  return { index, missing };
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
    const get = (k: keyof StrikeCsvRow): string => {
      const i = index[k];
      return i === undefined ? "" : (cells[i] ?? "").trim();
    };
    const dirRaw = get("direction");
    const direction =
      dirRaw === "Receive" || dirRaw === "Send" ? (dirRaw as "Receive" | "Send") : null;
    if (!direction) {
      warnings.push(`Row ${r + 1}: unknown Direction "${dirRaw}" , skipped.`);
      continue;
    }
    rows.push({
      date: get("date"),
      direction,
      currency: get("currency"),
      amount: get("amount"),
      description: get("description"),
      destination: get("destination"),
      fee: get("fee"),
      reference: get("reference"),
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
 * Debit vs Credit is decided by Direction:
 *   Receive (inflow)  → Debit  (cash in)
 *   Send    (outflow) → Credit (cash out)
 * This is a placeholder convention; the mapping wizard will pair each row
 * with a counter-account so the entry balances.
 */
export function strikeRowsToJournalStagedRows(rows: StrikeCsvRow[]): {
  staged: V3StagedRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const out: V3StagedRow[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const date = normalizeStrikeDate(r.date);
    if (date === r.date && r.date && !/^\d{4}-\d{2}-\d{2}/.test(r.date)) {
      warnings.push(`Row ${i + 2}: could not normalize date "${r.date}" , left as-is.`);
    }
    const amount = magnitude(r.amount);
    const isInflow = r.direction === "Receive";
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
