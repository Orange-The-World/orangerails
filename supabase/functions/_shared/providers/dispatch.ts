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

const PROVIDERS: ReadonlyArray<ProviderAdapter> = [
  blinkAdapter,
  xpubAdapter,
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
 */
export interface ProviderManifest {
  slug: string;
  displayName: string;
  multiWallet: boolean;
  credentialFields: ProviderAdapter['credentialFields'];
}

export function listProviderManifests(): ProviderManifest[] {
  return PROVIDERS.map(p => ({
    slug: p.slug,
    displayName: p.displayName,
    multiWallet: p.multiWallet,
    credentialFields: p.credentialFields,
  }));
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
