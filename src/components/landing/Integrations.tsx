import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import {
  fetchProviderCatalog,
  sortByPopularity,
  type ProviderManifest,
} from "@/lib/providers";

const FALLBACK_NAMES = [
  "Coinbase",
  "Kraken",
  "Binance",
  "Blink",
  "BTCPay Server",
  "Strike",
  "Gemini",
  "Bitstamp",
  "Bitfinex",
  "Crypto.com",
  "NDAX",
  "Bitbuy",
];

export function Integrations() {
  const [providers, setProviders] = useState<string[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    fetchProviderCatalog()
      .then((c) => {
        if (!active) return;
        const usable = c.providers.filter(
          (p: ProviderManifest) => p.status === "live" || p.status === "beta",
        );
        const top = sortByPopularity(usable).slice(0, 12).map((p) => p.displayName);
        setProviders(top);
        setTotal(usable.length);
      })
      .catch(() => {
        if (active) {
          setProviders(FALLBACK_NAMES);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const names = providers ?? FALLBACK_NAMES;
  const totalLabel = total ? `${total}+` : "100+";

  return (
    <section id="integrations" className="py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">
            Connections
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            Plays nice with the Bitcoin stack you already use.
          </h2>
        </div>

        <div className="mt-12 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
          {names.map((name) => (
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
          <Link
            to="/providers"
            className="group inline-flex items-center gap-1.5 text-sm font-medium text-primary"
          >
            Browse all {totalLabel} connections
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}
