import { ArrowRight } from "lucide-react";

const integrations = [
  "Blink", "BTCPay Server", "Kraken", "Lunar Rails", "Ocean Pool",
  "Bitcoin Core", "Sparrow", "River", "Fedi", "LND", "Braiins", "mempool.space",
];

export function Integrations() {
  return (
    <section id="integrations" className="py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">Integrations</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            Plays nice with the Bitcoin stack you already use.
          </h2>
        </div>

        <div className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
          {integrations.map((name) => (
            <div
              key={name}
              className="flex h-20 items-center justify-center bg-background px-3 text-center"
            >
              <span className="font-mono text-sm text-muted-foreground/80 transition-colors hover:text-foreground">
                {name}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-8 text-center">
          <a
            href="#"
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-primary"
          >
            View all 20+ integrations
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>
    </section>
  );
}
