import { Bitcoin, BarChart3, Landmark, Plug, Lock, Wrench } from "lucide-react";

const features = [
  { icon: Bitcoin, title: "Bitcoin-native", body: "Sats, UTXOs, on-chain & Lightning. Built around the asset, not bolted on." },
  { icon: BarChart3, title: "Books ready", body: "Double-entry exports your accountant will accept. Not a tax summary." },
  { icon: Landmark, title: "Bank-connected", body: "Bridge fiat rails alongside Bitcoin without leaking either to a third party." },
  { icon: Plug, title: "Open API spec", body: "Published, versioned, and documented. No surprise breaking changes." },
  { icon: Lock, title: "Zero-knowledge mode", body: "Run end-to-end encrypted by default. We can't read what we don't have." },
  { icon: Wrench, title: "Trojan horse for legacy", body: "QuickBooks & Xero plugins ship Bitcoin into stacks that ignore it." },
];

export function Features() {
  return (
    <section id="features" className="py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">Features</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            Everything a Bitcoin business needs. Nothing it doesn't.
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
