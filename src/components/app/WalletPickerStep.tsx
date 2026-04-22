/**
 * WalletPickerStep — second step of the add-connection flow.
 *
 * After the user provides API credentials, OR's or-discover-wallets edge
 * function returns the list of wallets visible to that key. This dialog lets
 * the user pick which ones to sync. Each pick is encrypted client-side with
 * the user's ORK before being sent to or-source-wallets-set.
 *
 * If the user closes without confirming, the connection still exists but has
 * no source_wallets — sync falls back to the legacy account-wide path. The
 * caller surfaces a warning toast in that case.
 */

import { useState } from "react";

export interface DiscoveredWallet {
  external_wallet_id: string;
  currency: string;
  label?: string;
}

interface WalletPickerStepProps {
  discoveredWallets: DiscoveredWallet[];
  providerName: string;
  onCancel: () => void;
  onConfirm: (selections: Array<DiscoveredWallet & { is_synced: boolean }>) => Promise<void>;
}

export function WalletPickerStep({
  discoveredWallets,
  providerName,
  onCancel,
  onConfirm,
}: WalletPickerStepProps) {
  // All wallets default to checked — matches the current "sync everything"
  // baseline so users don't lose data by accident on first connect.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(discoveredWallets.map((w) => w.external_wallet_id)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(walletId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(walletId)) next.delete(walletId);
      else next.add(walletId);
      return next;
    });
  }

  async function handleConfirm() {
    setError(null);
    setSubmitting(true);
    try {
      const selections = discoveredWallets.map((w) => ({
        ...w,
        is_synced: selected.has(w.external_wallet_id),
      }));
      await onConfirm(selections);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const noneSelected = selected.size === 0;

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4"
      onClick={onCancel}
    >
      <div
        className="bg-background rounded-lg p-6 max-w-md w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-lg font-semibold">
            Found {discoveredWallets.length}{" "}
            {discoveredWallets.length === 1 ? "wallet" : "wallets"} on {providerName}
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Pick which wallets to sync. Wallet labels and currencies are encrypted with
            your vault key before being saved — OrangeRails can't read them.
          </p>
        </div>

        {discoveredWallets.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            This account has no wallets to choose from.
          </div>
        ) : (
          <div className="space-y-2">
            {discoveredWallets.map((w) => {
              const isChecked = selected.has(w.external_wallet_id);
              return (
                <label
                  key={w.external_wallet_id}
                  className={[
                    "flex items-center gap-3 rounded-md border p-3 cursor-pointer transition-colors",
                    isChecked ? "bg-primary/5 border-primary/40" : "hover:bg-muted/30",
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(w.external_wallet_id)}
                    className="h-4 w-4 accent-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {w.label || w.currency} wallet
                    </div>
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {w.currency} · {w.external_wallet_id.slice(0, 12)}…
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {noneSelected && discoveredWallets.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
            No wallets selected. Saving as-is will pause sync for this connection.
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || discoveredWallets.length === 0}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Confirm selection"}
          </button>
        </div>
      </div>
    </div>
  );
}
