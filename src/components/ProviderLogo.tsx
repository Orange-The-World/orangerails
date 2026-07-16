import { useState } from "react";
import { cn } from "@/lib/utils";

const FALLBACK_PALETTE = [
  "bg-orange-500",
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-amber-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-teal-500",
  "bg-fuchsia-500",
];

/**
 * Bundled logo assets for known providers. Values are root-relative
 * public-folder paths served by Vite at runtime. Callers that pass an
 * explicit `src` prop take precedence; anything without an entry here
 * falls through to the colored-initials fallback automatically.
 */
export const PROVIDER_LOGO_SRCS: Record<string, string> = {
  // Tier 1
  blink:          "/logos/blink.svg",
  btcpay:         "/logos/btcpay.svg",
  xpub:           "/logos/xpub.svg",
  strike:         "/logos/strike.svg",
  surge:          "/logos/surge.svg",
  quiltt:         "/logos/quiltt.svg",
  sparrow:        "/logos/sparrow.svg",
  // CCXT batch 2 -- top 40 by popularity (29 with brand marks, 11 use colored-initials fallback)
  coinbase:       "/logos/coinbase.svg",
  binance:        "/logos/binance.svg",
  kraken:         "/logos/kraken.svg",
  bybit:          "/logos/bybit.svg",
  okx:            "/logos/okx.svg",
  gemini:         "/logos/gemini.svg",
  kucoin:         "/logos/kucoin.svg",
  cryptocom:      "/logos/cryptocom.svg",
  bitstamp:       "/logos/bitstamp.svg",
  bitfinex:       "/logos/bitfinex.svg",
  bitget:         "/logos/bitget.svg",
  gate:           "/logos/gate.svg",
  htx:            "/logos/htx.svg",
  mexc:           "/logos/mexc.svg",
  upbit:          "/logos/upbit.svg",
  bingx:          "/logos/bingx.svg",
  bitflyer:       "/logos/bitflyer.svg",
  bithumb:        "/logos/bithumb.svg",
  coincheck:      "/logos/coincheck.svg",
  hitbtc:         "/logos/hitbtc.svg",
  luno:           "/logos/luno.svg",
  poloniex:       "/logos/poloniex.svg",
  btcmarkets:     "/logos/btcmarkets.svg",
  whitebit:       "/logos/whitebit.svg",
  alpaca:         "/logos/alpaca.svg",
  bitcoincom:     "/logos/bitcoincom.svg",
  binanceus:      "/logos/binanceus.svg",
  binancecoinm:   "/logos/binancecoinm.svg",
  binanceusdm:    "/logos/binanceusdm.svg",
};

function hashSlug(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i += 1) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return h;
}

function initials(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 ]/g, "").trim();
  if (!cleaned) return "??";
  const parts = cleaned.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

export interface ProviderLogoProps {
  slug: string;
  displayName: string;
  src?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function ProviderLogo({
  slug,
  displayName,
  src,
  size = "md",
  className,
}: ProviderLogoProps) {
  const [errored, setErrored] = useState(false);
  const dim =
    size === "lg" ? "h-12 w-12 text-base" : size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs";

  // Explicit src prop wins; fall back to the bundled map for known slugs.
  const resolvedSrc = src ?? PROVIDER_LOGO_SRCS[slug];

  if (resolvedSrc && !errored) {
    return (
      <img
        src={resolvedSrc}
        alt=""
        loading="lazy"
        onError={() => setErrored(true)}
        className={cn("rounded-md object-contain bg-card", dim, className)}
      />
    );
  }

  const colour = FALLBACK_PALETTE[hashSlug(slug) % FALLBACK_PALETTE.length];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex items-center justify-center rounded-md font-semibold text-white",
        colour,
        dim,
        className,
      )}
    >
      {initials(displayName)}
    </span>
  );
}
