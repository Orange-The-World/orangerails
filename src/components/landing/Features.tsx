import { Plug, Activity, Webhook, Lock, Eye, Server } from "lucide-react";

const features = [
  {
    icon: Plug,
    title: "Unified API",
    body: "One normalized API for banks, exchanges, wallets, and Lightning nodes. The aggregator primitives every fintech already expects.",
  },
  {
    icon: Activity,
    title: "Real time accounts",
    body: "Balances, transactions, identity, all current. Same data shapes as the incumbents you already evaluated.",
  },
  {
    icon: Webhook,
    title: "Webhooks",
    body: "Event driven. Connections, transactions, provider failures, all pushed in real time. No polling, no missed updates.",
  },
  {
    icon: Lock,
    title: "Sealed envelopes",
    body: "Customer credentials encrypted in their browser. Your operator holds ciphertext it cannot open. A breach of our infrastructure surfaces noise, not customer data.",
  },
  {
    icon: Eye,
    title: "Stealth Sync",
    body: "A BIP 158 widget runs in the customer's browser. The xpub never leaves the page. You see balances, not addresses.",
  },
  {
    icon: Server,
    title: "Open source by default",
    body: "Apache 2.0. Self hostable. Same code we run, you run. The aggregator that does not own you.",
  },
];

export function Features() {
  return (
    <section id="features" className="py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">Features</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            Everything a Bitcoin business needs. Nothing it doesn&apos;t.
          </h2>
        </div>

        <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
          {features.map((f) => (
            <div
              key={f.title}
              className="group relative bg-background p-7 transition-colors hover:bg-card"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-soft text-primary ring-1 ring-primary/15">
                <f.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-5 font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
