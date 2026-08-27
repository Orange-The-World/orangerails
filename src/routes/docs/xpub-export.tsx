/**
 * /docs/xpub-export , How to export your extended public key.
 *
 * Linked from the `helpHref` on the `xpub` provider manifest so the
 * "How to get your credentials" banner in the connect widget points
 * here. Provider-specific instructions for Sparrow, Specter,
 * BlueWallet, Electrum, and Wasabi.
 *
 * Plain English, no jargon dump. The goal is that a non-technical
 * Bitcoiner who already runs one of these wallets can find their
 * xpub in under two minutes.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Eye, Lock, Shield } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";

export const Route = createFileRoute("/docs/xpub-export")({
  head: () => ({
    meta: [
      { title: "How to export your xpub | OrangeRails docs" },
      {
        name: "description",
        content:
          "Step-by-step instructions for finding your extended public key (xpub, ypub, zpub) in Sparrow, Specter, BlueWallet, Electrum, and Wasabi.",
      },
      { property: "og:title", content: "How to export your xpub | OrangeRails docs" },
      {
        property: "og:description",
        content:
          "Find your extended public key in Sparrow, Specter, BlueWallet, Electrum, or Wasabi.",
      },
      { rel: "canonical", href: "https://orangerails.com/docs/xpub-export" },
    ],
  }),
  component: XpubExportPage,
});

interface WalletGuide {
  name: string;
  blurb: string;
  steps: string[];
  notes?: string;
}

const wallets: WalletGuide[] = [
  {
    name: "Sparrow",
    blurb:
      "Sparrow is the desktop wallet with the cleanest export UI. It calls the value a descriptor, which is a richer format than a bare xpub but contains the same watch-only information.",
    steps: [
      "Open Sparrow and select the wallet you want to share.",
      "Click the Settings cog at the bottom-left of the wallet pane.",
      "Switch to the Script Policy tab.",
      "Copy the value in the Descriptor field at the top.",
      "Paste it into OrangeRails. Sparrow's descriptor format starts with wpkh(...), tr(...), sh(wpkh(...)), or wsh(...) and includes the full derivation path.",
    ],
    notes:
      "If you prefer a bare zpub, look at the Keystores tab and copy the value from the Extended Public Key row instead.",
  },
  {
    name: "Specter Desktop",
    blurb:
      "Specter exports descriptors and bare xpubs for every wallet it manages. The location depends on whether you're looking at a single-sig or multisig wallet.",
    steps: [
      "Open Specter Desktop and select your wallet from the left sidebar.",
      "Click the Settings tab inside the wallet view.",
      "Scroll to the Export section.",
      "For OrangeRails, copy the Descriptor (recommended) , it survives software updates and address-type changes.",
      "Paste the full descriptor string into OrangeRails. If you prefer a bare xpub instead, the same panel shows it under Master Public Key.",
    ],
  },
  {
    name: "BlueWallet",
    blurb:
      "On mobile, BlueWallet exposes the xpub directly under the wallet's settings. It does not currently emit descriptors , you'll get a plain zpub or xpub.",
    steps: [
      "Open BlueWallet and tap the wallet you want to share.",
      "Tap the gear icon in the top-right corner.",
      "Tap Show wallet xpub.",
      "Confirm your biometric / passcode if prompted, then copy the displayed string.",
      "Paste the zpub (BIP 84 native SegWit) or xpub (BIP 44 legacy) into OrangeRails.",
    ],
  },
  {
    name: "Electrum",
    blurb:
      "Electrum's master public key lives behind the Wallet menu. It exports a bare xpub or ypub , not a descriptor.",
    steps: [
      "Open Electrum with the wallet file you want to share.",
      "Open the Wallet menu, then choose Information.",
      "Copy the value in the Master Public Keys section.",
      "Paste it into OrangeRails. Electrum's xpub uses an extended prefix that matches the wallet's address type (xpub for legacy, ypub for nested SegWit, zpub for native SegWit).",
    ],
  },
  {
    name: "Wasabi",
    blurb:
      "Wasabi exports its xpub from the wallet's password-protected info panel. Note that Wasabi's CoinJoin outputs use a different xpub branch than its receive addresses , make sure you copy the correct one.",
    steps: [
      "Open Wasabi and select your wallet.",
      "Click the wallet name at the top of the main pane and choose Wallet Info.",
      "Enter your passphrase to unlock the info view.",
      "Copy the value under Extended Public Key.",
      "Paste it into OrangeRails.",
    ],
  },
];

function XpubExportPage() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        <section className="border-b border-border/60">
          <div className="mx-auto max-w-3xl px-6 pt-14 pb-10">
            <Link
              to="/docs"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to docs
            </Link>
            <p className="mt-6 text-xs font-medium uppercase tracking-widest text-primary">
              Docs
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
              How to export your xpub.
            </h1>
            <p className="mt-3 text-base text-muted-foreground sm:text-lg">
              Find your extended public key in the wallet you already use, then
              paste it into OrangeRails. The xpub never leaves your browser in
              plaintext.
            </p>
          </div>
        </section>

        <section className="py-12">
          <div className="mx-auto max-w-3xl px-6 space-y-5">
            <div className="rounded-2xl border border-border bg-card/40 p-6">
              <div className="flex items-start gap-3">
                <Eye className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h2 className="text-base font-semibold">
                    What is an xpub, in plain English.
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    An extended public key is the watch-only half of your
                    wallet. With it, software can see every address your wallet
                    has ever derived (and will ever derive). With it,
                    software cannot move a single sat. Your private keys stay
                    in your wallet. The xpub is what banks would call a
                    statement-only view: read access, no withdraw rights.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card/40 p-6">
              <div className="flex items-start gap-3">
                <Lock className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h2 className="text-base font-semibold">
                    Descriptor or bare xpub , what to paste.
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Both work. Output descriptors (Sparrow, Specter, modern
                    Bitcoin Core) carry richer information about how addresses
                    are derived. Bare extended keys (xpub, ypub, zpub) work
                    for any standard BIP 44 / BIP 49 / BIP 84 wallet. If your
                    wallet offers a descriptor, prefer it , it's
                    self-describing and survives address-type upgrades.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card/40 p-6">
              <div className="flex items-start gap-3">
                <Shield className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h2 className="text-base font-semibold">
                    What OrangeRails sees, what we cannot see.
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    The xpub is encrypted in your browser before it leaves the
                    tab. The server stores ciphertext only and cannot decrypt
                    it. For supported wallets we run Stealth Sync , scanning
                    BIP 158 compact filters directly in your browser so the
                    server never learns your addresses at all.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-border/60 bg-card/20 py-16">
          <div className="mx-auto max-w-3xl px-6">
            <h2 className="text-2xl font-semibold tracking-tight">
              Per-wallet instructions.
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Pick the wallet you already use. If your wallet isn't listed and
              it supports a standard xpub / ypub / zpub export, the value will
              still work , paste it the same way.
            </p>

            <div className="mt-10 space-y-10">
              {wallets.map((w) => (
                <article key={w.name} id={w.name.toLowerCase().replace(/\s+/g, "-")}>
                  <h3 className="text-xl font-semibold">{w.name}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{w.blurb}</p>
                  <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm">
                    {w.steps.map((s) => (
                      <li key={s} className="leading-snug">
                        {s}
                      </li>
                    ))}
                  </ol>
                  {w.notes && (
                    <p className="mt-3 rounded-md border border-border/60 bg-background/60 p-3 text-xs text-muted-foreground">
                      {w.notes}
                    </p>
                  )}
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="py-16">
          <div className="mx-auto max-w-3xl px-6">
            <h2 className="text-xl font-semibold tracking-tight">
              Other places your xpub might live.
            </h2>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">
                  Hardware wallets (Coldcard, Ledger, Trezor):
                </span>{" "}
                use Sparrow or Specter as a software wrapper around the
                hardware wallet. The descriptor exported from that wrapper
                describes the hardware wallet's account and is what to paste
                here.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Bitcoin Core (modern, descriptor wallets):
                </span>{" "}
                use{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                  listdescriptors
                </code>{" "}
                from the RPC console and copy the active receive descriptor.
              </li>
              <li>
                <span className="font-medium text-foreground">
                  Mobile wallets without an xpub option:
                </span>{" "}
                some custodial Lightning wallets (Wallet of Satoshi, etc.) do
                not give you an xpub at all , those aren't on-chain wallets
                from a watch-only standpoint. Use the lightning connector
                instead of the xpub one.
              </li>
            </ul>

            <div className="mt-10 rounded-2xl border border-border bg-card/40 p-6">
              <h3 className="text-base font-semibold">Still stuck?</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Open a ticket at{" "}
                <a
                  href="https://github.com/Orange-The-World/orangerails/issues/new?labels=support"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                >
                  GitHub Issues
                </a>{" "}
                with the wallet you're trying to export from and we'll add it
                here.
              </p>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
