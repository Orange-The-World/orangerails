/**
 * TransactionsPanel , the full Recent Transactions surface on /app.
 *
 * Owns: wallet-filter dropdown, page-size selector, pagination controls,
 * row selection (Set<string> of `${connection_id}-${id}` keys), CSV export
 * (selected vs. all), and the table render itself.
 *
 * Extracted from app.tsx to keep that file readable. Stays purely
 * client-side: never mutates server state, never calls Supabase, never
 * exfiltrates data. The CSV is generated in-browser from already-decrypted
 * NormalizedTransactions and downloaded as a Blob , OR's server never sees
 * plaintext transactions, preserving the zero-knowledge guarantee.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Download,
} from "lucide-react";
import type { NormalizedTransaction } from "@/lib/crypto-fields";
import { buildCsv, downloadCsv, todayStamp } from "@/lib/csv";
import { usePagination } from "@/hooks/usePagination";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

/** Decrypted transaction enriched with the row metadata we need on screen. */
export type DecryptedTxRow = NormalizedTransaction & {
  connection_id: string;
  occurred_at: string;
};

/** Minimal connection shape this component needs to resolve wallet badges. */
export interface ConnectionLike {
  id: string;
  source_wallets?: Array<{
    id: string;
    external_wallet_id: string;
    currency: string;
    label?: string | null;
  }>;
}

interface TransactionsPanelProps {
  rows: DecryptedTxRow[];
  connections: ConnectionLike[];
  /** Optional callback for surfacing toasts/notices (e.g. "Exported N rows"). */
  onNotice?: (msg: string) => void;
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 500] as const;
const DEFAULT_PAGE_SIZE = 25;
const PAGE_SIZE_STORAGE_KEY = "or_app_tx_page_size";
const ALL_WALLETS = "__all__";
const NO_WALLET = "__legacy__"; // for source_wallet_id = null/undefined

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Stable composite key for selection state. tx.id alone may collide across connections. */
function rowKey(tx: DecryptedTxRow): string {
  return `${tx.connection_id}-${tx.id}`;
}

/**
 * Resolve a transaction's wallet display info: { currency, label } or null
 * for legacy rows. Walks all connections looking for a source_wallet whose
 * id matches tx.source_wallet_id. O(c*w) total connections × wallets, but
 * that's tiny in practice (< 50).
 */
function findWalletInfo(
  tx: DecryptedTxRow,
  connections: ConnectionLike[],
): { currency: string; label?: string | null } | null {
  if (!tx.source_wallet_id) return null;
  for (const c of connections) {
    if (c.id !== tx.connection_id) continue;
    const w = c.source_wallets?.find((sw) => sw.external_wallet_id === tx.source_wallet_id);
    if (w) return { currency: w.currency, label: w.label };
  }
  return null;
}

/** "BTC", "USD", "Default" , the short label shown in the wallet column / filter. */
function walletShortLabel(info: { currency: string; label?: string | null } | null): string {
  if (!info) return "Default";
  return info.label?.trim() || info.currency.toUpperCase();
}

/** Tailwind classes for the wallet badge , mirrors SourceWalletBadges styling. */
function walletChipClass(currency: string | null): string {
  if (!currency) return "bg-muted text-muted-foreground border-input";
  switch (currency.toUpperCase()) {
    case "BTC":
      return "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/30";
    case "USD":
      return "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30";
    default:
      return "bg-muted text-muted-foreground border-input";
  }
}

/** Format a transaction's amount for the on-screen table. */
function formatAmountDisplay(tx: DecryptedTxRow): string {
  if (typeof tx.amount_sats === "number") {
    return `${tx.amount_sats.toLocaleString()} sats`;
  }
  if (typeof tx.amount === "number" && tx.currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: tx.currency.toUpperCase(),
      }).format(tx.amount);
    } catch {
      // Unknown currency code , fall back to "amount CCY" text.
      return `${tx.amount} ${tx.currency}`;
    }
  }
  return ",";
}

/** Numeric amount + currency code for CSV (no formatting / thousands sep). */
function csvAmountFields(tx: DecryptedTxRow): { amount: string; currency: string } {
  if (typeof tx.amount_sats === "number") {
    return { amount: String(tx.amount_sats), currency: "sats" };
  }
  if (typeof tx.amount === "number" && tx.currency) {
    return { amount: String(tx.amount), currency: tx.currency };
  }
  return { amount: "", currency: "" };
}

/** Read persisted page size; fall back to default on missing/invalid. */
function loadPageSize(): number {
  try {
    const raw = localStorage.getItem(PAGE_SIZE_STORAGE_KEY);
    if (!raw) return DEFAULT_PAGE_SIZE;
    const n = parseInt(raw, 10);
    return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
  } catch {
    // localStorage unavailable (private browsing in some browsers).
    return DEFAULT_PAGE_SIZE;
  }
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export function TransactionsPanel({ rows, connections, onNotice }: TransactionsPanelProps) {
  const [walletFilter, setWalletFilter] = useState<string>(ALL_WALLETS);
  const [pageSize, setPageSize] = useState<number>(() => loadPageSize());
  const [page, setPage] = useState<number>(1);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Persist page size whenever the user changes it.
  useEffect(() => {
    try {
      localStorage.setItem(PAGE_SIZE_STORAGE_KEY, String(pageSize));
    } catch {
      // No-op: see loadPageSize().
    }
  }, [pageSize]);

  // Build the wallet-filter options from the data actually present. We key
  // by source_wallet_id (or NO_WALLET) so the dropdown reflects real
  // synced wallets only , no empty options for wallets that produced zero tx.
  const walletOptions = useMemo(() => {
    const seen = new Map<string, { id: string; label: string }>();
    let hasLegacy = false;
    for (const tx of rows) {
      if (!tx.source_wallet_id) {
        hasLegacy = true;
        continue;
      }
      if (seen.has(tx.source_wallet_id)) continue;
      const info = findWalletInfo(tx, connections);
      seen.set(tx.source_wallet_id, {
        id: tx.source_wallet_id,
        label: `${walletShortLabel(info)} wallet`,
      });
    }
    const opts = Array.from(seen.values()).sort((a, b) => a.label.localeCompare(b.label));
    if (hasLegacy) opts.push({ id: NO_WALLET, label: "Default (legacy)" });
    return opts;
  }, [rows, connections]);

  // Apply wallet filter to the visible row set.
  const filteredRows = useMemo(() => {
    if (walletFilter === ALL_WALLETS) return rows;
    if (walletFilter === NO_WALLET) return rows.filter((r) => !r.source_wallet_id);
    return rows.filter((r) => r.source_wallet_id === walletFilter);
  }, [rows, walletFilter]);

  // Reset to page 1 whenever the filter changes , otherwise the user may
  // land on an empty page if the new filter has fewer pages.
  useEffect(() => {
    setPage(1);
  }, [walletFilter]);

  const { totalPages, pageItems, rangeStart, rangeEnd } = usePagination(
    filteredRows,
    page,
    pageSize,
    setPage,
  );

  // Header checkbox state: derived from the visible page only ("select all
  // visible" is the standard interaction; cross-page selection is preserved
  // when the user changes pages but is not toggled by the header).
  const visibleKeys = useMemo(() => pageItems.map(rowKey), [pageItems]);
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((k) => selected.has(k));
  const someVisibleSelected = visibleKeys.some((k) => selected.has(k));

  function toggleAllVisible(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) {
        for (const k of visibleKeys) next.add(k);
      } else {
        for (const k of visibleKeys) next.delete(k);
      }
      return next;
    });
  }

  function toggleRow(key: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  // CSV export. Builds rows in-memory and downloads a Blob , never touches
  // the network. `subset === "selected"` exports only checked rows; "all"
  // exports the full decrypted dataset (ignoring the current filter / page).
  function exportCsv(subset: "selected" | "all") {
    const source =
      subset === "selected" ? rows.filter((r) => selected.has(rowKey(r))) : rows;
    if (source.length === 0) return;

    const headers = [
      "When",
      "Direction",
      "Type",
      "Wallet",
      "Amount",
      "Currency",
      "Memo",
      "Counterparty",
      "Status",
      "External ID",
    ];
    const dataRows = source.map((tx) => {
      const info = findWalletInfo(tx, connections);
      const { amount, currency } = csvAmountFields(tx);
      return [
        new Date(tx.occurred_at).toISOString(),
        tx.direction,
        tx.type,
        walletShortLabel(info),
        amount,
        currency,
        tx.description ?? "",
        tx.counterparty ?? "",
        tx.status ?? "",
        tx.id, // OR-side id; provider's external_id lives on the encrypted_transactions row, not in payload
      ];
    });

    const csv = buildCsv(headers, dataRows);
    downloadCsv(`orangerails-transactions-${todayStamp()}.csv`, csv);
    onNotice?.(
      `Exported ${source.length} transaction${source.length === 1 ? "" : "s"}.`,
    );
  }

  const selectedCount = selected.size;

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  return (
    <div className="space-y-3">
      {/* Toolbar: filter on the left, export + page size on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="wallet-filter">
            Wallet
          </label>
          <Select value={walletFilter} onValueChange={setWalletFilter}>
            <SelectTrigger id="wallet-filter" className="h-8 w-[180px] text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_WALLETS}>All wallets</SelectItem>
              {walletOptions.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={selectedCount === 0}
            onClick={() => exportCsv("selected")}
          >
            <Download />
            {selectedCount > 0
              ? `Export ${selectedCount} selected`
              : "Export selected"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportCsv("all")}>
            <Download />
            Export all ({rows.length})
          </Button>

          <div className="flex items-center gap-2 pl-2 border-l">
            <label
              className="text-xs text-muted-foreground"
              htmlFor="page-size"
            >
              Per page
            </label>
            <Select
              value={String(pageSize)}
              onValueChange={(v) => setPageSize(parseInt(v, 10))}
            >
              <SelectTrigger id="page-size" className="h-8 w-[80px] text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-md border overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 w-8">
                <Checkbox
                  aria-label="Select all visible"
                  checked={
                    allVisibleSelected
                      ? true
                      : someVisibleSelected
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={(c) => toggleAllVisible(c === true)}
                />
              </th>
              <th className="text-left px-3 py-2 font-medium">When</th>
              <th className="text-left px-3 py-2 font-medium">Direction</th>
              <th className="text-left px-3 py-2 font-medium">Type</th>
              <th className="text-left px-3 py-2 font-medium">Wallet</th>
              <th className="text-right px-3 py-2 font-medium">Amount</th>
              <th className="text-left px-3 py-2 font-medium">Memo</th>
              <th className="text-left px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {pageItems.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-3 py-6 text-center text-sm text-muted-foreground"
                >
                  No transactions match the current filter.
                </td>
              </tr>
            ) : (
              pageItems.map((tx) => {
                const key = rowKey(tx);
                const info = findWalletInfo(tx, connections);
                const walletLabel = walletShortLabel(info);
                const isSelected = selected.has(key);
                return (
                  <tr
                    key={key}
                    className="border-t"
                    data-state={isSelected ? "selected" : undefined}
                  >
                    <td className="px-3 py-2">
                      <Checkbox
                        aria-label={`Select transaction ${tx.id}`}
                        checked={isSelected}
                        onCheckedChange={(c) => toggleRow(key, c === true)}
                      />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {new Date(tx.occurred_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      {tx.direction === "in" ? "↓ in" : "↑ out"}
                    </td>
                    <td className="px-3 py-2">{tx.type}</td>
                    <td className="px-3 py-2">
                      <span
                        className={[
                          "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                          info
                            ? walletChipClass(info.currency)
                            : "border-dashed border-input text-muted-foreground",
                        ].join(" ")}
                        title={
                          info
                            ? `${info.currency}${info.label ? ` , ${info.label}` : ""}`
                            : "Legacy account-wide sync (no wallet recorded)"
                        }
                      >
                        {walletLabel}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">
                      {formatAmountDisplay(tx)}
                    </td>
                    <td className="px-3 py-2 max-w-xs truncate">
                      {tx.description ?? ","}
                    </td>
                    <td className="px-3 py-2">{tx.status ?? ","}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: range summary on the left, pagination on the right. */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div>
          {filteredRows.length === 0 ? (
            <span>0 transactions</span>
          ) : (
            <span>
              {rangeStart}–{rangeEnd} of {filteredRows.length}
              {filteredRows.length !== rows.length && (
                <span className="ml-1">(filtered from {rows.length})</span>
              )}
              {selectedCount > 0 && (
                <span className="ml-2 text-foreground">
                  · {selectedCount} selected
                </span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page <= 1}
            onClick={() => setPage(1)}
            aria-label="First page"
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="Previous page"
          >
            <ChevronLeft />
          </Button>
          <span className="px-2 tabular-nums">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            aria-label="Next page"
          >
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page >= totalPages}
            onClick={() => setPage(totalPages)}
            aria-label="Last page"
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  );
}
