/**
 * Smart categorization suggester for Strike rows.
 *
 * Pure function — no side effects, no I/O, no UI coupling. The mapping wizard
 * (or `strike-convert` CLI) consumes the returned groups and renders bulk
 * assign UI like:
 *
 *   [ ] 142 "Receive" rows                  → assign to [Bitcoin Income ▼]
 *   [ ] 89  "Send" rows under 1000 sats     → assign to [Network Fees ▼]
 *   [ ] 5   "Send" rows over 100k sats      → assign to [Bitcoin Expense ▼]
 *
 * SOLID: new heuristics are ADDED as new suggesters in this file (open for
 * extension). Existing suggesters never mutate to accommodate them.
 *
 * Sats threshold rationale: a Lightning routing/probe payment is typically
 * sub-1000 sats (0.00001 BTC). Anything over 100k sats (0.001 BTC) is
 * realistically a deliberate spend, not a fee.
 */

import type { StrikeCsvRow } from "./types";

/** 1000 sats = 0.00001 BTC. */
const SMALL_BTC_THRESHOLD = 0.00001;
/** 100_000 sats = 0.001 BTC. */
const LARGE_BTC_THRESHOLD = 0.001;

export type CategorizationSuggestion = {
  /** Stable id the UI can use as a checkbox key. */
  id: string;
  /** Human-readable group label. */
  label: string;
  /** Suggested COA account name. Caller may swap based on user's actual COA. */
  suggestedAccountName: string;
  /** Row indices (into the input array) this group covers. */
  rowIndices: number[];
  /** Up to 3 sample rows for UI preview. */
  sampleRows: StrikeCsvRow[];
  /** Total rows in this group. */
  count: number;
};

function absBtc(amount: string): number {
  const n = Number.parseFloat(amount.replace(/^-/, "").trim());
  return Number.isFinite(n) ? n : 0;
}

type GroupDef = {
  id: string;
  label: string;
  suggestedAccountName: string;
  match: (row: StrikeCsvRow) => boolean;
};

const GROUPS: GroupDef[] = [
  {
    id: "receive-all",
    label: "Receive rows",
    suggestedAccountName: "Bitcoin Income",
    match: (r) => r.direction === "Receive",
  },
  {
    id: "send-small",
    label: "Send rows under 1000 sats (likely routing / network fees)",
    suggestedAccountName: "Network Fees",
    match: (r) =>
      r.direction === "Send" && absBtc(r.amount) > 0 && absBtc(r.amount) < SMALL_BTC_THRESHOLD,
  },
  {
    id: "send-with-fee",
    label: "Send rows with explicit fee column",
    suggestedAccountName: "Network Fees",
    match: (r) => r.direction === "Send" && !!r.fee && absBtc(r.fee) > 0,
  },
  {
    id: "send-large",
    label: "Send rows over 100,000 sats",
    suggestedAccountName: "Bitcoin Expense",
    match: (r) => r.direction === "Send" && absBtc(r.amount) >= LARGE_BTC_THRESHOLD,
  },
  {
    id: "send-medium",
    label: "Send rows between 1k and 100k sats",
    suggestedAccountName: "Bitcoin Expense",
    match: (r) =>
      r.direction === "Send" &&
      absBtc(r.amount) >= SMALL_BTC_THRESHOLD &&
      absBtc(r.amount) < LARGE_BTC_THRESHOLD,
  },
];

export function suggestCategorization(rows: StrikeCsvRow[]): CategorizationSuggestion[] {
  const out: CategorizationSuggestion[] = [];
  for (const g of GROUPS) {
    const indices: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (g.match(rows[i])) indices.push(i);
    }
    if (indices.length === 0) continue;
    out.push({
      id: g.id,
      label: g.label,
      suggestedAccountName: g.suggestedAccountName,
      rowIndices: indices,
      sampleRows: indices.slice(0, 3).map((i) => rows[i]),
      count: indices.length,
    });
  }
  return out;
}
