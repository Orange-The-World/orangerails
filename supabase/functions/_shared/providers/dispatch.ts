/**
 * Provider dispatch table.
 *
 * or-connection-create / or-discover-wallets / or-sync look up the source
 * adapter for a connection's `provider_type` slug here.
 *
 * Adding a new provider:
 *   1. Implement the ProviderAdapter in _shared/providers/<slug>.ts
 *   2. Import it here
 *   3. Add to the PROVIDERS array below
 *   4. Done — all three edge functions auto-discover it via the registry
 *
 * Provider roadmap (OrangeRails-Protocol.html §18):
 *   blink (live), xpub (this PR), strike, btcpay, flash, lunar-rails,
 *   ccxt-* (100 exchanges via the CCXT wrapper), quiltt-* (banking +
 *   investments), simplefin (US/CA banks).
 */

import type { ProviderAdapter } from './types.ts';
import { blinkAdapter } from './blink.ts';
import { xpubAdapter } from './xpub.ts';
import { btcpayAdapter } from './btcpay.ts';
import { strikeAdapter } from './strike.ts';
import { makeCcxtAdapter } from './_ccxt.ts';

// CCXT-backed exchanges. Each is a thin wrapper around the shared CCXT
// base adapter. Top 10 by global volume + 2 Canadian-focused exchanges
// for testing. Adding the next one is one line.
//
// Roadmap: once these 12 prove out the pattern, expand to all ~120
// CCXT-supported exchanges (auto-loop over `Object.keys(ccxt.exchanges)`).
const ccxtCoinbase = makeCcxtAdapter({
  slug: 'coinbase',
  exchangeId: 'coinbase',
  displayName: 'Coinbase',
  description: 'US exchange + wallet',
  tags: ['us', 'fiat-on-ramp', 'exchange'],
  popularity: 100,
});
const ccxtKraken = makeCcxtAdapter({
  slug: 'kraken',
  exchangeId: 'kraken',
  displayName: 'Kraken',
  description: 'US/EU/CA exchange',
  tags: ['us', 'eu', 'ca', 'fiat-on-ramp', 'exchange'],
  popularity: 95,
});
const ccxtBinance = makeCcxtAdapter({
  slug: 'binance',
  exchangeId: 'binance',
  displayName: 'Binance',
  description: 'Global exchange',
  tags: ['global', 'exchange'],
  popularity: 92,
});
const ccxtBybit = makeCcxtAdapter({
  slug: 'bybit',
  exchangeId: 'bybit',
  displayName: 'Bybit',
  description: 'Global exchange + derivatives',
  tags: ['global', 'exchange', 'derivatives'],
  popularity: 80,
});
const ccxtOkx = makeCcxtAdapter({
  slug: 'okx',
  exchangeId: 'okx',
  displayName: 'OKX',
  description: 'Global exchange',
  tags: ['global', 'exchange'],
  popularity: 78,
});
const ccxtKucoin = makeCcxtAdapter({
  slug: 'kucoin',
  exchangeId: 'kucoin',
  displayName: 'KuCoin',
  description: 'Global exchange',
  tags: ['global', 'exchange'],
  popularity: 70,
});
const ccxtGemini = makeCcxtAdapter({
  slug: 'gemini',
  exchangeId: 'gemini',
  displayName: 'Gemini',
  description: 'US/EU regulated exchange',
  tags: ['us', 'eu', 'fiat-on-ramp', 'exchange'],
  popularity: 75,
});
const ccxtBitstamp = makeCcxtAdapter({
  slug: 'bitstamp',
  exchangeId: 'bitstamp',
  displayName: 'Bitstamp',
  description: 'EU/US exchange',
  tags: ['eu', 'us', 'fiat-on-ramp', 'exchange'],
  popularity: 65,
});
const ccxtBitfinex = makeCcxtAdapter({
  slug: 'bitfinex',
  exchangeId: 'bitfinex',
  displayName: 'Bitfinex',
  description: 'Global exchange',
  tags: ['global', 'exchange'],
  popularity: 60,
});
const ccxtCryptocom = makeCcxtAdapter({
  slug: 'cryptocom',
  exchangeId: 'cryptocom',
  displayName: 'Crypto.com',
  description: 'Global exchange + card',
  tags: ['global', 'exchange', 'card'],
  popularity: 72,
});
// Canadian-focused exchanges for the maintainer's testing.
const ccxtNdax = makeCcxtAdapter({
  slug: 'ndax',
  exchangeId: 'ndax',
  displayName: 'NDAX',
  description: 'Canadian exchange',
  tags: ['ca', 'fiat-on-ramp', 'exchange'],
  popularity: 50,
});
const ccxtBitbuy = makeCcxtAdapter({
  slug: 'bitbuy',
  exchangeId: 'bitbuy',
  displayName: 'Bitbuy',
  description: 'Canadian exchange',
  tags: ['ca', 'fiat-on-ramp', 'exchange'],
  popularity: 50,
});

const PROVIDERS: ReadonlyArray<ProviderAdapter> = [
  // Native (non-CCXT) adapters first
  blinkAdapter,
  xpubAdapter,
  btcpayAdapter,
  strikeAdapter,
  // CCXT-backed exchanges
  ccxtCoinbase,
  ccxtKraken,
  ccxtBinance,
  ccxtBybit,
  ccxtOkx,
  ccxtKucoin,
  ccxtGemini,
  ccxtBitstamp,
  ccxtBitfinex,
  ccxtCryptocom,
  ccxtNdax,
  ccxtBitbuy,
];

const PROVIDER_MAP: ReadonlyMap<string, ProviderAdapter> = new Map(
  PROVIDERS.map(p => [p.slug, p]),
);

/**
 * Look up the registered adapter for a provider slug. Returns null when
 * the slug is unknown — callers should surface this as a 400 listing the
 * supported providers via `listProviderSlugs()`.
 */
export function getProvider(slug: string): ProviderAdapter | null {
  return PROVIDER_MAP.get(slug) ?? null;
}

/** All registered provider slugs. Used in 400 errors for unknown providers. */
export function listProviderSlugs(): string[] {
  return PROVIDERS.map(p => p.slug);
}

/**
 * Public adapter manifest — what platforms (V2, V3, OW) read to render the
 * "add connection" UI. No internal handler functions exposed.
 *
 * The `category` + `tags` + `popularity` fields are designed to drive a
 * picker that scales past ~10 providers: top-level category tiles (Wallets
 * / Exchanges / Payment processors), a search box that filters on
 * displayName + description + tags, and a default within-category sort
 * by popularity DESC. Tile-per-provider doesn't scale once CCXT lands the
 * 100+ exchanges.
 */
export interface ProviderManifest {
  slug: string;
  displayName: string;
  description?: string;
  status: 'live' | 'beta' | 'coming_soon';
  category?: ProviderAdapter['category'];
  tags?: string[];
  popularity?: number;
  multiWallet: boolean;
  credentialFields: ProviderAdapter['credentialFields'];
}

/**
 * Roadmap entries — providers we want to surface as greyed-out tiles
 * before their adapter ships. Keeping them here (not in PROVIDERS) means
 * edge functions still 400 if a caller tries to use them, but the
 * picker UI knows to render them as "Coming soon".
 *
 * Move an entry into PROVIDERS the moment its adapter lands — at that
 * point its `status` flips to 'live' from the adapter declaration.
 */
const ROADMAP_MANIFESTS: ReadonlyArray<ProviderManifest> = [];

export function listProviderManifests(): ProviderManifest[] {
  const live: ProviderManifest[] = PROVIDERS.map(p => ({
    slug: p.slug,
    displayName: p.displayName,
    description: p.description,
    status: p.status ?? 'live',
    category: p.category,
    tags: p.tags,
    popularity: p.popularity,
    multiWallet: p.multiWallet,
    credentialFields: p.credentialFields,
  }));
  return [...live, ...ROADMAP_MANIFESTS];
}

/**
 * High-level category metadata, surfaced separately from providers so the
 * picker can render category tiles even when no provider in that category
 * exists yet (e.g. Mining / Bank tiles greyed out before adapters land).
 *
 * Order here is the canonical display order in the picker.
 */
export interface CategoryManifest {
  slug: NonNullable<ProviderAdapter['category']>;
  displayName: string;
  description: string;
  /** Number of live providers currently in this category. */
  providerCount: number;
}

const CATEGORY_DEFS: ReadonlyArray<Omit<CategoryManifest, 'providerCount'>> = [
  { slug: 'lightning_wallet', displayName: 'Lightning wallets', description: 'Custodial Lightning wallets' },
  { slug: 'on_chain_wallet', displayName: 'On-chain wallets', description: 'Watch-only and self-custody on-chain wallets' },
  { slug: 'payment_processor', displayName: 'Payment processors', description: 'Merchant Bitcoin payment processors' },
  { slug: 'exchange', displayName: 'Exchanges', description: 'Crypto exchanges with fiat on/off-ramps' },
  { slug: 'card', displayName: 'Bitcoin cards', description: 'Bitcoin debit cards and rewards programs' },
  { slug: 'mining', displayName: 'Mining', description: 'Mining pools and payout services' },
  { slug: 'bank', displayName: 'Banks', description: 'Traditional banking aggregators' },
  { slug: 'lender', displayName: 'Bitcoin lenders', description: 'Bitcoin-backed lending services' },
];

export function listCategoryManifests(): CategoryManifest[] {
  const counts = new Map<string, number>();
  for (const p of PROVIDERS) {
    if (!p.category) continue;
    counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  }
  return CATEGORY_DEFS.map(c => ({ ...c, providerCount: counts.get(c.slug) ?? 0 }));
}

// Re-export types so edge functions can import everything from one place.
export type {
  ProviderAdapter,
  DiscoveredWallet,
  NormalizedTransaction,
  SyncResult,
  CredentialField,
} from './types.ts';
export { parseCredentials } from './types.ts';
