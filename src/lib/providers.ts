/**
 * Client-side wrapper around the public `or-providers` edge function.
 *
 * The catalog is the single source of truth for which sources OR supports.
 * Every UI surface that lists providers (the widget picker, the public
 * /providers page, the landing-page live counter, the landing-page
 * Integrations strip) reads from here. No hardcoded provider lists
 * anywhere in the frontend.
 *
 * Module-level promise cache ensures the catalog is fetched at most once
 * per page session, regardless of how many components subscribe.
 */

// ───── Types , mirror of `ProviderManifest` / `CategoryManifest` in the
//       OR backend (supabase/functions/_shared/providers/dispatch.ts).

export type ProviderTier = "t0" | "t1" | "t2" | "t3";
export type ProviderStatus = "live" | "beta" | "coming_soon";

export interface CredentialField {
  name: string;
  type: "string" | "secret";
  label: string;
  placeholder?: string;
  optional?: boolean;
  multiline?: boolean;
  helpLabel?: string;
  helpHref?: string;
}

export interface ProviderManifest {
  slug: string;
  displayName: string;
  description?: string;
  status: ProviderStatus;
  multiWallet: boolean;
  credentialFields: CredentialField[];
  category?: string;
  tags?: string[];
  popularity?: number;
  /** Optional in-app route for providers whose connect flow lives outside
   *  the generic credential dialog (e.g. Sparrow's Stealth Sync popup). */
  connectUrl?: string;
}

export interface CategoryManifest {
  slug: string;
  displayName: string;
  description: string;
  providerCount: number;
}

export interface ProviderCatalog {
  providers: ProviderManifest[];
  categories: CategoryManifest[];
}

// ───── Fetch + cache

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? "";

let cached: Promise<ProviderCatalog> | null = null;

export function fetchProviderCatalog(): Promise<ProviderCatalog> {
  if (cached) return cached;
  if (!SUPABASE_URL) {
    cached = Promise.reject(new Error("VITE_SUPABASE_URL not configured"));
    return cached;
  }
  cached = (async () => {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/or-providers`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      cached = null; // allow retry on next call
      throw new Error(`Provider catalog request failed (${res.status})`);
    }
    const json = (await res.json()) as Partial<ProviderCatalog>;
    return {
      providers: Array.isArray(json.providers) ? json.providers : [],
      categories: Array.isArray(json.categories) ? json.categories : [],
    };
  })();
  return cached;
}

// ───── Helpers

const SELF_CUSTODY_SLUGS = new Set([
  "xpub",
  "bitcoin-core",
  "sparrow",
  "ldk",
  "phoenix",
  "cln",
  "lnd",
]);

const FILE_IMPORT_SLUGS = new Set(["files", "csv", "ofx", "qif"]);

/**
 * Privacy tier for a provider. Reads `t0|t1|t2|t3` from `tags` when set;
 * otherwise falls back: self-custody wallets → T0, file imports → T3,
 * exchanges → T1.
 */
export function getTier(manifest: ProviderManifest): ProviderTier {
  const tags = manifest.tags ?? [];
  for (const t of tags) {
    const lower = t.toLowerCase();
    if (lower === "t0" || lower === "t1" || lower === "t2" || lower === "t3") {
      return lower;
    }
  }
  if (SELF_CUSTODY_SLUGS.has(manifest.slug)) return "t0";
  if (FILE_IMPORT_SLUGS.has(manifest.slug)) return "t3";
  if (manifest.category === "exchange") return "t1";
  return "t1";
}

export function sortByPopularity(list: ProviderManifest[]): ProviderManifest[] {
  return [...list].sort((a, b) => {
    const pa = a.popularity ?? 50;
    const pb = b.popularity ?? 50;
    if (pb !== pa) return pb - pa;
    return a.displayName.localeCompare(b.displayName);
  });
}

export function filterProviders(
  list: ProviderManifest[],
  opts: { categorySlug?: string | null; query?: string },
): ProviderManifest[] {
  let out = list;
  if (opts.categorySlug && opts.categorySlug !== "all") {
    out = out.filter((p) => p.category === opts.categorySlug);
  }
  const q = (opts.query ?? "").trim().toLowerCase();
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean);
    out = out.filter((p) => {
      const haystack = [
        p.displayName,
        p.description ?? "",
        ...(p.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return tokens.every((tok) => haystack.includes(tok));
    });
  }
  return out;
}

/**
 * Count providers that are usable end to end today: live + beta.
 *
 * Beta providers (the CCXT-backed exchanges) ship and connect; the "beta"
 * tag tracks edge-case maturity, not whether the connection works. Treating
 * them as not-counted makes the public landing report 4 connections when
 * the real number is ~100.
 */
export function countUsable(list: ProviderManifest[]): number {
  return list.filter((p) => p.status === "live" || p.status === "beta").length;
}
