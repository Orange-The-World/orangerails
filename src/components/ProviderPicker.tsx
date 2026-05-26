import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "@tanstack/react-router";
import { Search, Check, X } from "lucide-react";
import {
  type CategoryManifest,
  type ProviderCatalog,
  type ProviderManifest,
  filterProviders,
  getTier,
  sortByPopularity,
} from "@/lib/providers";
import { PrivacyTierBadge } from "@/components/PrivacyTierBadge";
import { ProviderLogo } from "@/components/ProviderLogo";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ProviderPickerProps {
  catalog: ProviderCatalog;
  /** "browse" = read-only (no Connect button). "connect" = widget mode. */
  mode?: "browse" | "connect";
  onSelect?: (manifest: ProviderManifest) => void;
}

export function ProviderPicker({
  catalog,
  mode = "browse",
  onSelect,
}: ProviderPickerProps) {
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ProviderManifest | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const sortedProviders = useMemo(
    () => sortByPopularity(catalog.providers),
    [catalog.providers],
  );

  const visible = useMemo(
    () =>
      filterProviders(sortedProviders, {
        categorySlug: activeCategory === "all" ? null : activeCategory,
        query,
      }),
    [sortedProviders, activeCategory, query],
  );

  // Auto-select the first visible tile so the preview pane is never empty.
  useEffect(() => {
    if (visible.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !visible.some((p) => p.slug === selected.slug)) {
      setSelected(visible[0]);
    }
  }, [visible, selected]);

  // Global "/" focuses the search box.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/") return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Arrow navigation across the grid.
  const handleGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!selected) return;
    const idx = visible.findIndex((p) => p.slug === selected.slug);
    if (idx < 0) return;
    let next = idx;
    const cols = gridColsForViewport();
    if (e.key === "ArrowRight") next = Math.min(visible.length - 1, idx + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, idx - 1);
    else if (e.key === "ArrowDown") next = Math.min(visible.length - 1, idx + cols);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - cols);
    else if (e.key === "Enter") {
      if (mode === "connect" && selected.status !== "coming_soon") {
        onSelect?.(selected);
      }
      return;
    } else if (e.key === "Escape") {
      setQuery("");
      return;
    } else {
      return;
    }
    e.preventDefault();
    setSelected(visible[next]);
    // Keep the focused tile visible.
    const tile = gridRef.current?.querySelector<HTMLButtonElement>(
      `[data-slug="${visible[next].slug}"]`,
    );
    tile?.focus();
    tile?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div className="grid gap-4 md:grid-cols-[200px_1fr_320px]">
      {/* Sidebar */}
      <aside className="md:border-r md:border-border md:pr-4">
        <h2 className="sr-only">Categories</h2>
        <ul className="flex flex-row gap-1 overflow-x-auto md:flex-col md:gap-0.5">
          <CategoryRow
            label="All"
            count={catalog.providers.length}
            active={activeCategory === "all"}
            onClick={() => setActiveCategory("all")}
          />
          {catalog.categories.map((c) => (
            <CategoryRow
              key={c.slug}
              label={c.displayName}
              count={c.providerCount}
              active={activeCategory === c.slug}
              disabled={c.providerCount === 0}
              onClick={() => setActiveCategory(c.slug)}
            />
          ))}
        </ul>
      </aside>

      {/* Centre: search + grid */}
      <div>
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${catalog.providers.length} connections (press /)`}
            aria-label={`Search ${catalog.providers.length} connections`}
            className="h-10 pl-9"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <p
          aria-live="polite"
          className="mt-2 text-xs text-muted-foreground"
        >
          Showing {visible.length} of {catalog.providers.length} connections
        </p>

        <div
          ref={gridRef}
          role="listbox"
          aria-label="Available connections"
          onKeyDown={handleGridKey}
          className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          {visible.map((p) => (
            <ProviderTile
              key={p.slug}
              manifest={p}
              isActive={selected?.slug === p.slug}
              onSelect={() => setSelected(p)}
              onDoubleSelect={() => {
                if (mode === "connect" && p.status !== "coming_soon") onSelect?.(p);
              }}
            />
          ))}
          {visible.length === 0 && (
            <div className="col-span-full rounded-lg border border-dashed border-border bg-card/40 p-8 text-center text-sm text-muted-foreground">
              No connections match your search. Try a different word.
            </div>
          )}
        </div>
      </div>

      {/* Preview pane */}
      <aside className="md:sticky md:top-4 md:h-fit md:rounded-xl md:border md:border-border md:bg-card md:p-5">
        {selected ? (
          <PreviewPanel
            manifest={selected}
            mode={mode}
            onConnect={() => onSelect?.(selected)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Pick a connection to see the details.
          </p>
        )}
      </aside>
    </div>
  );
}

// ───── Sidebar row

function CategoryRow({
  label,
  count,
  active,
  disabled,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-current={active ? "true" : undefined}
        className={cn(
          "flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
          active
            ? "bg-primary text-primary-foreground"
            : "hover:bg-muted text-foreground",
          disabled && "opacity-40 cursor-not-allowed hover:bg-transparent",
        )}
      >
        <span>{label}</span>
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
            active
              ? "bg-primary-foreground/20 text-primary-foreground"
              : "bg-muted text-muted-foreground",
          )}
        >
          {count}
        </span>
      </button>
    </li>
  );
}

// ───── Tile

function ProviderTile({
  manifest,
  isActive,
  onSelect,
  onDoubleSelect,
}: {
  manifest: ProviderManifest;
  isActive: boolean;
  onSelect: () => void;
  onDoubleSelect: () => void;
}) {
  const tier = getTier(manifest);
  const dim = manifest.status === "coming_soon";
  return (
    <button
      type="button"
      role="option"
      aria-selected={isActive}
      data-slug={manifest.slug}
      onClick={onSelect}
      onDoubleClick={onDoubleSelect}
      onMouseEnter={onSelect}
      className={cn(
        "group relative flex flex-col gap-2 rounded-lg border bg-card p-3 text-left transition-all",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isActive ? "border-primary ring-1 ring-primary" : "border-border hover:border-primary/40",
        dim && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <ProviderLogo
          slug={manifest.slug}
          displayName={manifest.displayName}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{manifest.displayName}</span>
            {manifest.status === "beta" && (
              <span className="rounded bg-tier-t2/15 px-1 text-[9px] font-semibold uppercase text-tier-t2">
                Beta
              </span>
            )}
            {manifest.status === "coming_soon" && (
              <span className="rounded bg-muted px-1 text-[9px] font-semibold uppercase text-muted-foreground">
                Soon
              </span>
            )}
          </div>
          {manifest.description && (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
              {manifest.description}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <PrivacyTierBadge tier={tier} size="sm" showLabel={false} />
      </div>
    </button>
  );
}

// ───── Preview pane

function PreviewPanel({
  manifest,
  mode,
  onConnect,
}: {
  manifest: ProviderManifest;
  mode: "browse" | "connect";
  onConnect: () => void;
}) {
  const tier = getTier(manifest);
  const caps = inferCapabilities(manifest);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <ProviderLogo
          slug={manifest.slug}
          displayName={manifest.displayName}
          size="lg"
        />
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold">{manifest.displayName}</h3>
          {manifest.category && (
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {manifest.category.replace(/_/g, " ")}
            </p>
          )}
        </div>
      </div>

      {manifest.description && (
        <p className="text-sm text-muted-foreground">{manifest.description}</p>
      )}

      <div>
        <PrivacyTierBadge tier={tier} size="md" showLabel />
      </div>

      <div>
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          What you can do
        </p>
        <ul className="space-y-1 text-sm">
          <CapabilityRow on={caps.deposits} label="Deposits and receive" />
          <CapabilityRow on={caps.withdrawals} label="Withdrawals and send" />
          <CapabilityRow on={caps.trades} label="Trades and conversions" />
        </ul>
      </div>

      {manifest.connectUrl ? (
        // Provider with a dedicated landing page (e.g. Sparrow via Stealth
        // Sync). Surface the link in both browse and connect modes — the
        // landing page handles its own flow.
        <Button asChild className="w-full">
          <Link to={manifest.connectUrl}>
            Open {manifest.displayName} setup
          </Link>
        </Button>
      ) : (
        mode === "connect" && (
          <Button
            type="button"
            className="w-full"
            disabled={manifest.status === "coming_soon"}
            onClick={onConnect}
          >
            {manifest.status === "coming_soon"
              ? "Not available yet"
              : `Connect ${manifest.displayName}`}
          </Button>
        )
      )}
    </div>
  );
}

function CapabilityRow({ on, label }: { on: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span
        className={cn(
          "inline-flex h-4 w-4 items-center justify-center rounded-full",
          on ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
        )}
      >
        {on ? <Check className="h-3 w-3" strokeWidth={3} /> : <X className="h-3 w-3" />}
      </span>
      <span className={cn("text-xs", !on && "text-muted-foreground line-through")}>{label}</span>
    </li>
  );
}

// ───── Helpers

function inferCapabilities(m: ProviderManifest): {
  deposits: boolean;
  withdrawals: boolean;
  trades: boolean;
} {
  const tags = (m.tags ?? []).map((t) => t.toLowerCase());
  if (m.category === "exchange") {
    return { deposits: true, withdrawals: true, trades: true };
  }
  if (m.category === "lightning_wallet" || m.category === "on_chain_wallet") {
    return { deposits: true, withdrawals: true, trades: false };
  }
  if (m.category === "payment_processor") {
    return { deposits: true, withdrawals: false, trades: false };
  }
  return {
    deposits: tags.includes("deposits") || true,
    withdrawals: tags.includes("withdrawals") || false,
    trades: tags.includes("trades") || false,
  };
}

function gridColsForViewport(): number {
  if (typeof window === "undefined") return 3;
  if (window.innerWidth >= 1024) return 3;
  if (window.innerWidth >= 640) return 2;
  return 1;
}
