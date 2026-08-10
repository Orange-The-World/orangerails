/**
 * /connect/sparrow , Sparrow Wallet landing screen.
 *
 * The customer arrives here from a direct link in our docs or from a
 * marketing page. The page explains in plain English what a wallet
 * descriptor is, where in Sparrow to find it, what v0.1 actually
 * delivers (and does not deliver), and launches the Stealth Sync
 * widget when the customer is ready to paste.
 *
 * Source of truth: docs/Sparrow.md
 *
 * Why this route exists rather than dropping Sparrow into the generic
 * connect flow: Sparrow needs Sparrow-specific copy (where to click in
 * Sparrow to export the descriptor) and an honesty badge about the
 * receives-only limitation in v0.1. A generic "paste your xpub" widget
 * cannot carry that context.
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

export const Route = createFileRoute("/connect/sparrow")({
  head: () => ({
    meta: [
      { title: "Connect Sparrow Wallet | OrangeRails" },
      {
        name: "description",
        content:
          "Paste your Sparrow wallet descriptor into OrangeRails. We scan BIP 158 filters in your browser so the server never sees your addresses.",
      },
      { property: "og:title", content: "Connect Sparrow Wallet | OrangeRails" },
      {
        property: "og:description",
        content:
          "Descriptor watch only via Stealth Sync. The xpub never leaves your browser in plaintext.",
      },
      { rel: "canonical", href: "https://orangerails.com/connect/sparrow" },
    ],
  }),
  component: SparrowConnectPage,
});

// Consuming-app origins OR has registered for Stealth Sync. This is the
// same allowlist the Stealth widget enforces on OR_STEALTH_INIT
// (src/stealth/widget/App.tsx), reused here so the bounce below can only
// ever send the browser to an origin we already trust. An unvalidated
// app_url would be an open redirect.
const ALLOWED_APP_ORIGINS: ReadonlySet<string> = new Set(
  ((import.meta.env.VITE_OR_STEALTH_ALLOWED_ORIGINS as string | undefined) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

function SparrowConnectPage() {
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
        "[sparrow] Refused app_url with untrusted origin: " +
          (origin ?? "invalid URL") +
          ". Add it to VITE_OR_STEALTH_ALLOWED_ORIGINS if it is a registered app.",
      );
      setRefusedError(
        "We could not open the app that sent you here: its address is not on our allowlist. If you are testing an integration, register its origin first. Otherwise, start Stealth Sync from that app.",
      );
      return;
    }

    // Bare /connect/sparrow. Open the Stealth Sync widget in a popup.
    // Append parent_origin so the widget targets OR_STEALTH_READY at this
    // exact origin instead of broadcasting to '*'.
    const selfOrigin = window.location.origin;
    const url =
      "/connect/stealth?parent_origin=" + encodeURIComponent(selfOrigin);
    const w = window.open(
      url,
      "or-stealth-sparrow",
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
                SW
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
                    Sparrow Wallet
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
                  Paste your Sparrow wallet descriptor. We scan the chain in
                  your browser. Our server never sees your addresses.
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
                      <span className="text-foreground">✓ Confirmed receives.</span>{" "}
                      Every incoming Bitcoin payment shows up after the block
                      confirms (~10 minutes).
                    </li>
                    <li>
                      <span className="text-foreground">✓ Sends.</span>{" "}
                      Outgoing transactions are detected by tracking the UTXOs
                      your wallet receives and watching for inputs that spend
                      them. Works for any UTXO created at or after your wallet
                      birthday (default: one year ago, editable).
                    </li>
                    <li>
                      <span className="text-foreground">✓ Single key + multisig descriptors.</span>{" "}
                      <span className="font-mono text-xs">wpkh(...)</span>,{" "}
                      <span className="font-mono text-xs">tr(...)</span>,{" "}
                      <span className="font-mono text-xs">sh(wpkh(...))</span>,{" "}
                      <span className="font-mono text-xs">wsh(multi(...))</span>, plus bare
                      xpub / ypub / zpub.
                    </li>
                    <li>
                      <span className="text-foreground">⚠ Pre-birthday UTXO spends.</span>{" "}
                      A spend of a UTXO older than your wallet birthday will
                      not be detected. Push the birthday back to capture older
                      history.
                    </li>
                    <li>
                      <span className="text-foreground">✗ Pending transactions.</span>{" "}
                      A payment in the mempool will not appear until the block confirms.
                      Mempool overlay arrives in v0.3.
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
              Three steps. Sparrow does not need to be running after step 2.
            </p>

            <ol className="mt-8 space-y-6">
              <li className="flex gap-5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft font-mono text-sm font-semibold text-primary ring-1 ring-primary/20">
                  1
                </div>
                <div>
                  <h3 className="font-semibold">Open Sparrow on your computer</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    Sparrow is a free, open source Bitcoin wallet that runs on
                    Mac, Windows, and Linux. If you do not have it yet, download
                    it from{" "}
                    <a
                      href="https://sparrowwallet.com"
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      sparrowwallet.com
                    </a>
                    .
                  </p>
                </div>
              </li>
              <li className="flex gap-5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-soft font-mono text-sm font-semibold text-primary ring-1 ring-primary/20">
                  2
                </div>
                <div>
                  <h3 className="font-semibold">Export your wallet descriptor</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    Inside Sparrow:{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      File → Wallet → Export → Wallet Descriptor
                    </span>
                    . Copy the resulting text. It will look something like{" "}
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      wpkh([abc12345/84h/0h/0h]xpub6C...)
                    </span>
                    .
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    The descriptor is watch only. It cannot spend your bitcoin.
                    It only tells our scanner which addresses belong to your
                    wallet.
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
                    above. A popup opens. Paste the descriptor, pick a label, set
                    the wallet birthday so we do not scan more blocks than we
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
                  Your descriptor never leaves your browser in plaintext
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Before the descriptor is sent anywhere, your browser encrypts
                  it with a key derived from your password. Our server stores
                  the sealed envelope and could not open it if we tried.
                </p>
              </div>
              <div className="rounded-xl border border-border bg-background p-5">
                <Eye className="h-5 w-5 text-primary" />
                <h3 className="mt-4 font-semibold">
                  Your addresses never reach our server
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Stealth Sync downloads small BIP 158 compact filters from
                  public sources and matches them against your wallet addresses{" "}
                  <span className="text-foreground">in your browser</span>. We never
                  see the address list.
                </p>
              </div>
              <div className="rounded-xl border border-border bg-background p-5">
                <Copy className="h-5 w-5 text-primary" />
                <h3 className="mt-4 font-semibold">
                  The same is true on every other device
                </h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Add OR on a second device, sign in with the same password,
                  and the sealed envelope unwraps locally. Different device,
                  same privacy boundary.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
