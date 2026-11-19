/**
 * ViaBTC payment / profit / reward rows -> StagedImportPayload.
 *
 * Each payout and each earning becomes one V3 journal-entry line with the
 * account fields blank. The mapping wizard fills the counter-account. Both
 * event types are inflows (a miner never pays the pool).
 */

import { createHash } from "node:crypto";

import {
  STAGED_IMPORT_CONTRACT_VERSION,
  type StagedImportPayload,
  type V3StagedRow,
} from "../contract";
import type { ViaBtcHistory } from "./types";

const CONNECTOR_VERSION = "0.1.0";

function unixToDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function isZeroAmount(amount: string): boolean {
  return !amount.trim() || /^0+(\.0+)?$/.test(amount.trim());
}

export function historyToJournalStagedRows(history: ViaBtcHistory): {
  staged: V3StagedRow[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const staged: V3StagedRow[] = [];

  const pushInflow = (opts: {
    date: string;
    ref: string;
    memo: string;
    description: string;
    currency: string;
    amount: string;
  }) => {
    if (isZeroAmount(opts.amount)) return;
    staged.push({
      je_date: opts.date,
      "je_ref_#": opts.ref,
      je_memo: opts.memo,
      je_status: "Posted",
      account_code: "",
      account_name: "",
      line_description: opts.description,
      wallet_currency: opts.currency,
      debit: opts.amount.replace(/^-/, "").trim(),
      credit: "",
      contact_name: "",
    });
  };

  for (const p of history.payments) {
    pushInflow({
      date: unixToDate(p.create_time),
      ref: p.tx || `viabtc:payout:${p.id}`,
      memo: p.address,
      description: `ViaBTC payout ${p.coin}`,
      currency: p.coin,
      amount: p.amount,
    });
  }
  for (const row of history.profits) {
    pushInflow({
      date: row.date,
      ref: `viabtc:profit:${row.coin}:${row.date}`,
      memo: "",
      description: `ViaBTC profit ${row.coin} ${row.date}`,
      currency: row.coin,
      amount: row.total_profit,
    });
  }
  for (const row of history.rewards) {
    pushInflow({
      date: row.date,
      ref: `viabtc:reward:${row.coin}:${row.date}`,
      memo: "",
      description: `ViaBTC reward ${row.coin} ${row.date}`,
      currency: row.coin,
      amount: row.total_profit,
    });
  }

  if (staged.length === 0) {
    warnings.push("ViaBTC returned no payout or reward rows for this window.");
  }
  return { staged, warnings };
}

export function buildViaBtcStagedPayload(
  history: ViaBtcHistory,
  orgHint?: { name?: string; currency?: string },
): { payload: StagedImportPayload; warnings: string[] } {
  const { staged, warnings } = historyToJournalStagedRows(history);
  const refs = new Set<string>();
  for (const s of staged) refs.add(s["je_ref_#"] || "");

  const summary = JSON.stringify({
    payments: history.payments.length,
    profits: history.profits.length,
    rewards: history.rewards.length,
  });

  const payload: StagedImportPayload = {
    contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
    source: {
      name: "viabtc",
      version: CONNECTOR_VERSION,
      exportedAt: new Date().toISOString(),
    },
    ...(orgHint ? { orgHint } : {}),
    manifest: {
      files: [
        {
          name: "viabtc-api.json",
          sizeBytes: Buffer.byteLength(summary, "utf8"),
          sha256: createHash("sha256").update(summary).digest("hex"),
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
  return { payload, warnings };
}
