/**
 * SourceWalletBadges — render currency chips for a connection's selected wallets.
 *
 * Each connection row in the /app UI shows which wallets are being synced.
 * The wallet metadata is encrypted on the server (see source_wallets table —
 * Bitwarden-style hybrid), so the parent decrypts in advance and passes the
 * plaintext currency / label here for display.
 *
 * If no wallets are configured the connection is in legacy account-wide
 * mode — render a neutral "Default account" badge to make that visible to
 * the user.
 */

interface DecryptedWallet {
  id: string;
  external_wallet_id: string;
  is_synced: boolean;
  currency: string;
  label?: string | null;
}

interface SourceWalletBadgesProps {
  wallets: DecryptedWallet[];
}

function chipClass(currency: string): string {
  switch (currency.toUpperCase()) {
    case "BTC":
      return "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/30";
    case "USD":
      return "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/30";
    default:
      return "bg-muted text-muted-foreground border-input";
  }
}

export function SourceWalletBadges({ wallets }: SourceWalletBadgesProps) {
  if (wallets.length === 0) {
    return (
      <span className="inline-flex items-center rounded border border-input bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Default account
      </span>
    );
  }

  // Show synced wallets first; greyed-out non-synced ones afterwards so the
  // user can see at-a-glance what they previously deselected.
  const sorted = [...wallets].sort((a, b) =>
    a.is_synced === b.is_synced ? 0 : a.is_synced ? -1 : 1,
  );

  return (
    <div className="flex flex-wrap gap-1.5">
      {sorted.map((w) => {
        const label = w.label?.trim() || w.currency;
        return (
          <span
            key={w.id}
            title={w.is_synced ? `Syncing ${w.currency}` : `${w.currency} (paused)`}
            className={[
              "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
              w.is_synced ? chipClass(w.currency) : "border-dashed border-muted text-muted-foreground line-through",
            ].join(" ")}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}
