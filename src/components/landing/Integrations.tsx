import { ArrowRight } from "lucide-react";

const integrations = [
  "Bitcoin xpub", "Strike", "Blink", "BTCPay Server",
  "Coinbase", "Kraken", "Binance", "Bybit",
  "OKX", "KuCoin", "Gemini", "Bitstamp",
  "Crypto.com", "NDAX", "Bitbuy", "Gate",
  "MEXC", "Bitget", "HTX", "Bitfinex",
  "Upbit", "Bithumb", "Bitflyer", "Coincheck",
];

export function Integrations() {
  return (
    <section id="integrations" className="py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">Integrations</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            Plays nice with 100+ wallets, exchanges, and payment processors.
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
            View all 100+ connections
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>
    </section>
  );
}
