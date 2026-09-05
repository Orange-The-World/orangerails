/**
 * /providers -- Public provider catalog.
 *
 * Fetches the or-providers edge function and renders a browsable tile grid.
 * Clicking a tile opens a side panel with a CTA to the provider's connect
 * page (connectUrl) or the generic widget (/connect) for providers without
 * a dedicated setup flow.
 *
 * Tests: tests/e2e/sparrow.spec.ts (fixme tests 3 and 4 depend on this
 * route; remove .fixme once the route is confirmed live on dev).
 * Spec #430.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import {
  fetchProviderCatalog,
  sortByPopularity,
  type ProviderManifest,
} from "@/lib/providers";

export const Route = createFileRoute("/providers")({
  validateSearch: (search: Record<string, unknown>) => ({
    app_url: typeof search.app_url === "string" ? search.app_url : undefined,
    platform:
      typeof search.platform === "string" ? search.platform : undefined,
    app_user_id:
      typeof search.app_user_id === "string"
        ? search.app_user_id
        : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Providers | OrangeRails" },
      {
        name: "description",
        content:
          "Browse all data sources Orange Rails connects to: Bitcoin wallets, Lightning nodes, and exchanges.",
      },
      { property: "og:title", content: "Providers | OrangeRails" },
      {
        property: "og:description",
        content:
          "Connect your Bitcoin wallets, Lightning nodes, and exchange accounts to OrangeRails.",
      },
      { rel: "canonical", href: "https://orangerails.com/providers" },
    ],
  }),
  component: ProvidersPage,
});

// Deterministic brand color per slug. Matches the palette in connect.tsx so
// the same provider shows the same color in the widget and on this page.
const TILE_PALETTE = [
  "bg-orange-500",
  "bg-blue-600",
  "bg-emerald-600",
  "bg-rose-600",
  "bg-red-700",
  "bg-indigo-600",
  "bg-amber-500",
  "bg-slate-800",
  "bg-teal-600",
  "bg-purple-600",
  "bg-cyan-600",
  "bg-yellow-500",
];

function tileColor(slug: string): string {
  let h = 5381;
  for (let i = 0; i < slug.length; i += 1) h = ((h << 5) + h + slug.charCodeAt(i)) | 0;
  return TILE_PALETTE[Math.abs(h) % TILE_PALETTE.length];
}

// Consuming-app origins registered for Stealth Sync return-to bounce (DL-0426).
// Same allowlist the Stealth widget enforces on OR_STEALTH_INIT and that the
// old /connect/sparrow page used. An unvalidated app_url would be an open redirect.
const ALLOWED_APP_ORIGINS: ReadonlySet<string> = new Set(
  (
    (import.meta.env.VITE_OR_STEALTH_ALLOWED_ORIGINS as string | undefined) ??
    ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

function ProviderTile({
  provider,
  selected,
  onSelect,
}: {
  provider: ProviderManifest;
  selected: boolean;
  onSelect: () => void;
}) {
  const initial = provider.displayName.slice(0, 1).toUpperCase();
  return (
    <button
      type="button"
      data-slug={provider.slug}
      onClick={onSelect}
      aria-pressed={selected}
      title={provider.description ?? provider.displayName}
      className={`group flex h-24 w-full flex-col items-center justify-center gap-1.5 rounded-xl border p-2 text-center transition-all hover:-translate-y-0.5 hover:shadow-sm ${
        selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/30"
          : "border-border bg-card hover:border-border/80"
      }`}
    >
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-bold text-white shadow-sm ${tileColor(provider.slug)}`}
        aria-hidden
      >
        {initial}
      </span>
      <div className="flex w-full items-center justify-center gap-1">
        <span className="truncate text-xs font-medium">{provider.displayName}</span>
        {provider.status === "beta" && (
          <span className="shrink-0 rounded-sm bg-amber-100 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-amber-700">
            beta
          </span>
        )}
      </div>
    </button>
  );
}

function ProviderPanel({
  provider,
  onClose,
}: {
  provider: ProviderManifest;
  onClose: () => void;
}) {
  const connectHref = provider.connectUrl ?? `/connect?provider=${provider.slug}`;
  const initial = provider.displayName.slice(0, 1).toUpperCase();

  return (
    <aside
      className="sticky top-6 rounded-xl border border-border bg-card p-6 shadow-sm"
      aria-label={`${provider.displayName} details`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-lg font-bold text-white shadow-sm ${tileColor(provider.slug)}`}
            aria-hidden
          >
            {initial}
          </span>
          <div>
            <h2 className="font-semibold">{provider.displayName}</h2>
            {provider.category && (
              <p className="text-xs capitalize text-muted-foreground">
                {provider.category.replace(/_/g, " ")}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {provider.description && (
        <p className="mt-4 text-sm text-muted-foreground">{provider.description}</p>
      )}

      <div className="mt-6">
        <a
          href={connectHref}
          className="block w-full rounded-lg bg-primary px-4 py-2.5 text-center text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Open {provider.displayName} setup
        </a>
      </div>
    </aside>
  );
}

function ProvidersPage() {
  const { app_url } = Route.useSearch();
  const [refusedError, setRefusedError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderManifest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ProviderManifest | null>(null);

  // Validate app_url on mount (DL-1007 / DL-0426). Untrusted or malformed origins
  // get a refusal alert immediately so the user sees a clear error rather than the
  // picker silently ignoring the handoff parameter. Trusted origins are preserved
  // in the URL for when the picker completes the Stealth Sync flow (follow-up).
  useEffect(() => {
    if (!app_url) return;
    let origin: string | null = null;
    try {
      origin = new URL(app_url).origin;
    } catch {
      origin = null;
    }
    if (!origin || !ALLOWED_APP_ORIGINS.has(origin)) {
      setRefusedError(
        "We could not open the app that sent you here: its address is not on our allowlist. If you are testing an integration, register its origin first. Otherwise, start Stealth Sync from that app.",
      );
    }
  }, [app_url]);

  useEffect(() => {
    fetchProviderCatalog()
      .then(({ providers: all }) =>
        setProviders(
          sortByPopularity(all.filter((p) => p.status !== "coming_soon")),
        ),
      )
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  const filtered =
    providers !== null
      ? providers.filter((p) => {
          const q = search.trim().toLowerCase();
          if (!q) return true;
          const haystack = [
            p.displayName,
            p.description ?? "",
            ...(p.tags ?? []),
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(q);
        })
      : null;

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        <section className="border-b border-border/60 py-12">
          <div className="mx-auto max-w-6xl px-6">
            <h1 className="text-3xl font-semibold tracking-tight">Providers</h1>
            <p className="mt-2 text-base text-muted-foreground">
              Connect your Bitcoin wallets, Lightning nodes, and exchange
              accounts.
            </p>

            {refusedError && (
              <div
                role="alert"
                className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
              >
                {refusedError}
              </div>
            )}

            <div className="mt-6">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search providers"
                aria-label="Search providers"
                className="w-full max-w-md rounded-xl border border-input bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
            </div>
          </div>
        </section>

        <section className="py-10">
          <div className="mx-auto max-w-6xl px-6">
            {error ? (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
                Could not load providers: {error}
              </div>
            ) : providers === null ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                Loading providers...
              </div>
            ) : (
              <div className="flex items-start gap-6">
                <div className={selected ? "flex-1" : "w-full"}>
                  {(filtered ?? []).length === 0 ? (
                    <div className="py-12 text-center text-sm text-muted-foreground">
                      No providers match your search.
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                      {(filtered ?? []).map((p) => (
                        <ProviderTile
                          key={p.slug}
                          provider={p}
                          selected={selected?.slug === p.slug}
                          onSelect={() =>
                            setSelected((prev) =>
                              prev?.slug === p.slug ? null : p,
                            )
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>

                {selected && (
                  <div className="w-72 shrink-0">
                    <ProviderPanel
                      provider={selected}
                      onClose={() => setSelected(null)}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
