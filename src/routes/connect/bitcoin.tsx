/**
 * /connect/bitcoin - wallet-agnostic xpub connect page.
 *
 * Wallet users arrive here from the provider picker after clicking
 * the "Bitcoin wallet" tile. The page is intentionally wallet-agnostic:
 * it covers Sparrow, Trezor, Ledger, BlueWallet, Specter, and any
 * wallet that exports an extended public key (xpub / ypub / zpub).
 *
 * The underlying mechanism is the same Stealth Sync widget used by
 * /connect/sparrow. The widget accepts bare xpub/ypub/zpub as well as
 * full descriptors, so no separate code path is needed.
 *
 * Why this route exists rather than routing to /connect/sparrow:
 * The Sparrow page has Sparrow-specific copy and links ("Open Sparrow
 * on your computer", sparrowwallet.com). Trezor and Ledger users
 * landing on a Sparrow-branded page is confusing and wrong.
 *
 * DL-0680
 */

import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/context/VaultContext";
import { sendInitOnReady } from "./_sparrow-init-handler";
import {
  ArrowRight,
  CheckCircle2,
  Copy,
  Lock,
  Eye,
  AlertTriangle,
} from "lucide-react";

export const Route = createFileRoute("/connect/bitcoin")({
  head: () => ({
    meta: [
      { title: "Connect Bitcoin Wallet | OrangeRails" },
      {
        name: "description",
        content:
          "Paste your xpub, ypub, or zpub into OrangeRails. Works with Sparrow, Trezor, Ledger, BlueWallet, and any wallet that exports an extended public key.",
      },
      { property: "og:title", content: "Connect Bitcoin Wallet | OrangeRails" },
      {
        property: "og:description",
        content:
          "Watch-only Bitcoin sync via Stealth Sync. Your xpub stays in your browser; the server never sees your addresses.",
      },
      { rel: "canonical", href: "https://orangerails.com/connect/bitcoin" },
    ],
  }),
  component: BitcoinConnectPage,
});

// Consuming-app origins OR has registered for Stealth Sync. Same allowlist
// the Stealth widget enforces on OR_STEALTH_INIT and /connect/sparrow uses.
// An unvalidated app_url would be an open redirect.
const ALLOWED_APP_ORIGINS: ReadonlySet<string> = new Set(
  ((import.meta.env.VITE_OR_STEALTH_ALLOWED_ORIGINS as string | undefined) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

function BitcoinConnectPage() {
  const [refusedError, setRefusedError] = useState<string | null>(null);
  const { isUnlocked, exportStealthKeyForWidget } = useVault();

  // DL-0448: send OR_STEALTH_INIT when the vault is unlocked so a signed-in
  // OR user goes straight into AddRoute. Anonymous visitors still see
  // DirectLoadCard after the widget's 1500ms grace window.
  const handleLaunch = useCallback(async () => {
    setRefusedError(null);

    const params = new URLSearchParams(window.location.search);
    const appUrl = params.get("app_url");

    if (appUrl) {
      // Option B: bounce back to the consuming app (DL-0426). Unchanged.
      let origin: string | null = null;
      try {
        origin = new URL(appUrl).origin;
      } catch {
        origin = null;
      }
      if (origin && ALLOWED_APP_ORIGINS.has(origin)) {
        window.location.assign(appUrl);
        return;
      }
      console.warn(
        "[bitcoin] Refused app_url with untrusted origin: " +
          (origin ?? "invalid URL") +
          ". Add it to VITE_OR_STEALTH_ALLOWED_ORIGINS if it is a registered app.",
      );
      setRefusedError(
        "We could not open the app that sent you here: its address is not on our allowlist. If you are testing an integration, register its origin first. Otherwise, start Stealth Sync from that app.",
      );
      return;
    }

    // Bare /connect/bitcoin. Open the Stealth Sync widget in a popup.
    // Append parent_origin so the widget targets OR_STEALTH_READY at this
    // exact origin instead of broadcasting to '*'.
    const selfOrigin = window.location.origin;
    const url =
      "/connect/stealth?parent_origin=" + encodeURIComponent(selfOrigin);
    const w = window.open(
      url,
      "or-stealth-bitcoin",
      "width=560,height=720,menubar=no,toolbar=no,location=no,status=no",
    );
    if (!w) {
      // Popup blocked. Fall back to same-tab navigation; INIT cannot be sent.
      window.location.href = "/connect/stealth";
      return;
    }

    if (!isUnlocked) {
      // Anonymous visitor. Popup shows DirectLoadCard after the grace window.
      return;
    }

    // Listen for OR_STEALTH_READY from the popup, then post OR_STEALTH_INIT.
    let sent = false;
    // eslint-disable-next-line prefer-const
    let intervalId: ReturnType<typeof setInterval>;

    const handler = async (event: MessageEvent) => {
      if (sent) return;
      const didSend = await sendInitOnReady(
        event,
        w,
        selfOrigin,
        async () => {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          return session;
        },
        exportStealthKeyForWidget,
      );
      if (didSend) {
        sent = true;
        window.removeEventListener("message", handler);
        clearInterval(intervalId);
      }
    };

    window.addEventListener("message", handler);
    intervalId = setInterval(() => {
      if (w.closed) {
        clearInterval(intervalId);
        window.removeEventListener("message", handler);
      }
    }, 500);
  }, [isUnlocked, exportStealthKeyForWidget]);

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <main>
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="pointer-events-none absolute inset-0 grid-bg opacity-50 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
          <div className="relative mx-auto max-w-4xl px-6 py-16">
            <div className="flex items-start gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary-soft font-mono text-lg font-semibold text-primary ring-1 ring-primary/15">
                BTC
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                    Bitcoin wallet
                  </h1>
                  <span className="inline-flex items-center gap-1 rounded-full bg-tier-t0/15 px-2.5 py-1 text-xs font-medium text-tier-t0 ring-1 ring-tier-t0/30 ring-inset">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-tier-t0" />
                    T0 · Just you
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success ring-1 ring-success/20 ring-inset">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Available
                  </span>
                </div>
                <p className="mt-3 max-w-2xl text-base text-muted-foreground sm:text-lg">
                  Paste your extended public key (xpub, ypub, or zpub). Works with
                  Sparrow, Trezor, Ledger, BlueWallet, Specter, and any wallet that
                  exports a watch-only key. We scan the chain in your browser. Our
                  server never sees your addresses.
                </p>
              </div>
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <button
                onClick={() => { void handleLaunch(); }}
                className="group inline-flex h-11 items-center gap-1.5 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Launch Stealth Sync
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </button>
            </div>
            {refusedError && (
              <div
                role="alert"
                className="mt-4 flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{refusedError}</p>
              </div>
            )}
          </div>
        </section>

        {/* v0.1 honesty */}
        <section className="border-b border-border/60 bg-card/40 py-12">
          <div className="mx-auto max-w-4xl px-6">
            <div className="rounded-xl border border-primary/30 bg-primary-soft/50 p-5">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h2 className="text-sm font-semibold">
                    What v0.1 ships, and what it doesn&apos;t
                  </h2>
                  <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
                    <li>
                      <span className="text-foreground">Confirmed receives.</span>{" "}
                      Every incoming Bitcoin payment shows up after the block
                      confirms (~10 minutes).
                    </li>
                    <li>
                      <span className="text-foreground">Sends.</span>{" "}
                      Outgoing transactions are detected by tracking UTXOs your
                      wallet receives and watching for inputs that spend them.
                      Works for any UTXO created at or after your wallet birthday
                      (default: one year ago, editable).
                    </li>
                    <li>
                      <span className="text-foreground">xpub / ypub / zpub and descriptors.</span>{" "}
                      Bare extended public keys and full descriptors:{" "}
                      <span className="font-mono text-xs">wpkh(...)</span>,{" "}
                      <span className="font-mono text-xs">tr(...)</span>,{" "}
                      <span className="font-mono text-xs">sh(wpkh(...))</span>,{" "}
                      <span className="font-mono text-xs">wsh(multi(...))</span>.
                    </li>
                    <li>
                      <span className="text-foreground">Pre-birthday UTXO spends (not detected).</span>{" "}
                      A spend of a UTXO older than your wallet birthday will not
                      be detected. Push the birthday back to capture older history.
                    </li>
                    <li>
                      <span className="text-foreground">Pending transactions (not yet).</span>{" "}
                      A payment in the mempool will not appear until the block
                      confirms. Mempool overlay arrives in v0.3.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="py-16">
          <div className="mx-auto max-w-4xl px-6">
            <h2 className="text-2xl font-semibold tracking-tight">
              How to connect.
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Three steps. Your wallet does not need to stay open after step 2.
            </p>

            <ol className="mt-8 space-y-6">
              <li className="flex gap-5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft font-mono text-sm font-semibold text-primary ring-1 ring-primary/20">
                  1
                </div>
                <div>
                  <h3 className="font-semibold">Open your Bitcoin wallet</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    Any wallet that can export an extended public key works:
                    Sparrow, Trezor Suite, Ledger Live, BlueWallet, Specter,
                    Electrum, and most hardware wallets.
                  </p>
                </div>
              </li>
              <li className="flex gap-5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft font-mono text-sm font-semibold text-primary ring-1 ring-primary/20">
                  2
                </div>
                <div>
                  <h3 className="font-semibold">Export your extended public key</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    Look for a setting called{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      Export xpub
                    </span>
                    ,{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      Extended Public Key
                    </span>
                    , or{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      Watch-only wallet
                    </span>
                    . Common locations: Sparrow{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      File &rarr; Export &rarr; Wallet Descriptor
                    </span>
                    ; Trezor Suite{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      Coin &rarr; Public Key tab
                    </span>
                    ; Ledger Live{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      Account settings &rarr; Advanced &rarr; Export public key
                    </span>
                    ; BlueWallet{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      Wallet &rarr; Details &rarr; Export/Backup
                    </span>
                    . Copy the resulting key or descriptor.
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    The exported key is watch only. It cannot spend your bitcoin.
                    It only tells our scanner which addresses belong to your wallet.
                  </p>
                </div>
              </li>
              <li className="flex gap-5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft font-mono text-sm font-semibold text-primary ring-1 ring-primary/20">
                  3
                </div>
                <div>
                  <h3 className="font-semibold">Launch Stealth Sync and paste</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    Click <span className="font-medium">Launch Stealth Sync</span>{" "}
                    above. A popup opens. Paste the key or descriptor, pick a label,
                    set the wallet birthday so we do not scan more blocks than we
                    need, and click <span className="font-medium">Add</span>.
                    Your browser scans the chain. We see ciphertext only.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        {/* Privacy explainer */}
        <section className="border-t border-border/60 bg-card/40 py-16">
          <div className="mx-auto max-w-4xl px-6">
            <div className="grid gap-6 md:grid-cols-3">
              <div className="rounded-xl border border-border bg-background p-5">
                <Lock className="h-5 w-5 text-primary" />
                <h3 className="mt-4 font-semibold">
                  Your key never leaves your browser in plaintext
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Before the key is sent anywhere, your browser encrypts it with
                  a key derived from your password. Our server stores the sealed
                  envelope and could not open it if we tried.
                </p>
              </div>
              <div className="rounded-xl border border-border bg-background p-5">
                <Eye className="h-5 w-5 text-primary" />
                <h3 className="mt-4 font-semibold">
                  Your addresses never reach our server
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Stealth Sync downloads small BIP 158 compact filters from public
                  sources and matches them against your wallet addresses{" "}
                  <span className="text-foreground">in your browser</span>. We
                  never see the address list.
                </p>
              </div>
              <div className="rounded-xl border border-border bg-background p-5">
                <Copy className="h-5 w-5 text-primary" />
                <h3 className="mt-4 font-semibold">
                  The same is true on every other device
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Add OR on a second device, sign in with the same password, and
                  the sealed envelope unwraps locally. Different device, same
                  privacy boundary.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
