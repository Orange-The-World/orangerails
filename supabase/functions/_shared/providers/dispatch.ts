/**
 * Provider dispatch table.
 *
 * or-connection-create / or-discover-wallets / or-sync look up the source
 * adapter for a connection's `provider_type` slug here.
 *
 * Adding a new native provider:
 *   1. Implement the ProviderAdapter in _shared/providers/<slug>.ts
 *   2. Import it here
 *   3. Add to the PROVIDERS array below
 *   4. Done — all three edge functions auto-discover it via the registry
 *
 * Adding a new CCXT exchange: regenerate _ccxt-manifest.ts (see
 * scripts/generate-ccxt-manifest.mjs). Don't hand-edit dispatch.
 *
 * Provider roadmap (OrangeRails-Protocol.html §18):
 *   blink (live), xpub (live), strike, btcpay, flash, lunar-rails,
 *   ccxt-* (98 exchanges via the CCXT manifest), quiltt-* (banking +
 *   investments), simplefin (US/CA banks).
 */

import type { ProviderAdapter } from './types.ts';
import { blinkAdapter } from './blink/index.ts';
import { xpubAdapter } from './xpub/index.ts';
import { btcpayAdapter } from './btcpay/index.ts';
import { strikeAdapter } from './strike/index.ts';
import { surgeAdapter } from './surge/index.ts';
import { makeCcxtAdapter } from './_ccxt/index.ts';
import { CCXT_MANIFEST } from './_ccxt/manifest.ts';

// CCXT-backed exchanges. Generated from CCXT introspection so the picker
// reflects whatever ccxt@<pinned> supports without per-exchange code.
// Each manifest entry produces one ProviderAdapter via makeCcxtAdapter.
const ccxtAdapters: ProviderAdapter[] = CCXT_MANIFEST.map((entry) =>
  makeCcxtAdapter({
    slug: entry.slug,
    exchangeId: entry.exchangeId,
    displayName: entry.displayName,
    description: entry.description,
    tags: entry.tags,
    popularity: entry.popularity,
  }),
);

const PROVIDERS: ReadonlyArray<ProviderAdapter> = [
  // Native (non-CCXT) adapters first
  blinkAdapter,
  xpubAdapter,
  btcpayAdapter,
  strikeAdapter,
  surgeAdapter,
  // CCXT-backed exchanges (manifest-driven, 98 today)
  ...ccxtAdapters,
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
 * The `category` + `tags` + `popularity` fields drive a picker that scales
 * past ~10 providers: top-level category tiles (Wallets / Exchanges /
 * Payment processors), a search box that filters on displayName +
 * description + tags, and a default within-category sort by popularity
 * DESC. Tile-per-provider doesn't scale once CCXT lands 100+ exchanges.
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
  /**
   * Optional in-app route for providers whose connect flow lives outside
   * the generic credential-entry dialog. When set, pickers should route
   * the tile's "Connect" action to this URL instead of opening the
   * credential form. Used today by Sparrow (Stealth Sync widget popup);
   * future client-side providers can adopt the same pattern.
   */
  connectUrl?: string;
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

/**
 * Client-side manifest entries — providers whose connect flow lives in
 * the browser (e.g. Stealth Sync) rather than as a server adapter under
 * `dispatch.ts`'s PROVIDERS. These appear in the picker with `status:
 * 'live'` and a `connectUrl` that the picker routes to on tile click.
 *
 * Edge functions still 400 if a caller tries to create a server-side
 * connection for these slugs, because no server adapter exists. That is
 * intentional — these providers do not flow through the server adapter
 * dispatch at all.
 */
const CLIENT_SIDE_MANIFESTS: ReadonlyArray<ProviderManifest> = [
  {
    slug: 'quiltt',
    displayName: 'Bank account',
    description:
      'Link any US bank via Quiltt (Finicity, MX, Akoya, Plaid). Background sync supported when you opt in.',
    status: 'live',
    category: 'bank',
    tags: ['bank', 'fiat', 'aggregator', 'us', 'quiltt'],
    popularity: 90,
    multiWallet: true,
    credentialFields: [],
    connectUrl: '/connect/quiltt',
  },
  {
    slug: 'sparrow',
    displayName: 'Sparrow Wallet',
    description:
      'Descriptor watch only via Stealth Sync. Your browser scans BIP 158 filters; the server never sees your addresses.',
    status: 'live',
    category: 'on_chain_wallet',
    tags: ['on-chain', 'watch-only', 'self-custody', 't0', 'sparrow', 'descriptor', 'stealth-sync'],
    popularity: 85,
    multiWallet: false,
    credentialFields: [],
    connectUrl: '/connect/sparrow',
  },
];

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
  return [...live, ...CLIENT_SIDE_MANIFESTS, ...ROADMAP_MANIFESTS];
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
  // Include client-side manifests (Sparrow, future Stealth Sync providers)
  // in category counts so the sidebar reflects the full visible catalog.
  for (const m of CLIENT_SIDE_MANIFESTS) {
    if (!m.category) continue;
    counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
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
