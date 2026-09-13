import { useEffect, useState } from "react";

import {
  chooseBrowserBlockCache,
  chooseDirectoryBlockCache,
  chooseNoBlockCache,
  createActiveBlockCache,
  formatCacheSize,
  getBlockCachePreference,
  supportsDirectoryPicker,
  type BlockCache,
  type BlockCachePreference,
  type BlockCacheStats,
} from "@/stealth/lib/block-cache";

interface StorageChoiceProps {
  onConfigured?: (preference: BlockCachePreference) => void;
  compact?: boolean;
}

function ChoiceButton({
  title,
  description,
  selected,
  onClick,
}: {
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-lg border p-3 text-left transition-colors hover:bg-muted ${
        selected ? "border-primary bg-primary/5" : "border-border bg-background"
      }`}
    >
      <span className="flex items-center justify-between gap-3 text-sm font-medium text-foreground">
        {title}
        {selected && <span className="text-xs text-primary">Current</span>}
      </span>
      <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
    </button>
  );
}

export function StorageChoice({ onConfigured, compact = false }: StorageChoiceProps) {
  const [preference, setPreference] = useState<BlockCachePreference | null>(() =>
    getBlockCachePreference(),
  );
  const [cache, setCache] = useState<BlockCache | null>(null);
  const [stats, setStats] = useState<BlockCacheStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setCache(null);
    setError(null);
    if (!preference || preference.location === "none") return;
    void (async () => {
      try {
        const active = await createActiveBlockCache(preference);
        if (cancelled) return;
        setCache(active);
        if (active) {
          const nextStats = await active.stats();
          if (!cancelled) setStats(nextStats);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [preference]);

  function canChangeLocation(next: BlockCachePreference["location"]): boolean {
    const isNewDirectory = next === "directory";
    const changesBackend = preference?.location !== next;
    if (!isNewDirectory && !changesBackend) return true;
    if (!cache) return true;
    if (!stats) {
      setError("Wait for the current cache size before changing its location.");
      return false;
    }
    if (stats.bytes > 0) {
      setError("Delete the downloaded blocks before changing where they are kept.");
      return false;
    }
    return true;
  }

  async function selectDirectory() {
    if (!canChangeLocation("directory")) return;
    setBusy(true);
    setError(null);
    try {
      const next = await chooseDirectoryBlockCache();
      setPreference(next);
      onConfigured?.(next);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  function selectBrowser() {
    if (!canChangeLocation("opfs")) return;
    try {
      const next = chooseBrowserBlockCache();
      setPreference(next);
      onConfigured?.(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function selectNone() {
    if (!canChangeLocation("none")) return;
    try {
      const next = chooseNoBlockCache();
      setPreference(next);
      onConfigured?.(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function deleteCache() {
    if (!cache) return;
    setBusy(true);
    setError(null);
    try {
      await cache.clear();
      setStats(await cache.stats());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {supportsDirectoryPicker() && (
        <ChoiceButton
          title="A folder I choose"
          description="Keep the public block data in a folder on this device."
          selected={preference?.location === "directory"}
          onClick={() => void selectDirectory()}
        />
      )}
      <ChoiceButton
        title="Browser storage"
        description="Keep it privately inside this browser (OPFS)."
        selected={preference?.location === "opfs"}
        onClick={selectBrowser}
      />
      <ChoiceButton
        title="Do not keep downloaded blocks"
        description="Download what each sync needs again next time."
        selected={preference?.location === "none"}
        onClick={selectNone}
      />

      {preference?.location === "directory" && !cache && !error && (
        <p className="text-xs text-muted-foreground">Opening the selected folder…</p>
      )}
      {cache && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Location</dt>
            <dd className="break-all text-right text-foreground">{cache.displayPath}</dd>
            <dt className="text-muted-foreground">Current size</dt>
            <dd className="text-right text-foreground">
              {stats ? formatCacheSize(stats.bytes) : "Measuring…"}
            </dd>
            <dt className="text-muted-foreground">Wallets using it</dt>
            <dd className="text-right text-foreground">{stats?.walletCount ?? "—"}</dd>
          </dl>
          <button
            type="button"
            disabled={busy || !stats || stats.bytes === 0}
            onClick={() => void deleteCache()}
            className="mt-3 inline-flex w-full items-center justify-center rounded-md border border-destructive/40 px-3 py-2 font-medium text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Working…" : "Delete downloaded blocks"}
          </button>
        </div>
      )}
      {preference?.location === "none" && (
        <p className="rounded-md bg-muted p-3 text-xs text-muted-foreground">
          Nothing is kept after a sync, so current size is 0 B and 0 wallets use a cache.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <p className="text-xs leading-relaxed text-muted-foreground">
        These files are public Bitcoin data, not a copy of your wallet. A matching full block may
        contain one of your transactions among everyone else&apos;s, and the requested range may
        give a network observer a weak hint about wallet age.
      </p>
    </div>
  );
}

export function StorageSetup({ onConfigured }: { onConfigured: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-5">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">
          Where should downloaded Bitcoin blocks go?
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          One shared download can serve every wallet you sync.
        </p>
        <div className="mt-4">
          <StorageChoice onConfigured={() => onConfigured()} compact />
        </div>
      </div>
    </div>
  );
}

export function PostSyncStoragePrompt({
  cache,
  onKeep,
}: {
  cache: BlockCache;
  onKeep: () => void;
}) {
  const [stats, setStats] = useState<BlockCacheStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);

  useEffect(() => {
    void cache
      .stats()
      .then(setStats)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [cache]);

  async function remove() {
    setDeleting(true);
    setError(null);
    try {
      await cache.clear();
      setStats(await cache.stats());
      setDeleted(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  }

  if (deleted) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-left">
        <p className="text-sm font-medium text-foreground">Downloaded blocks deleted</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Current size: {formatCacheSize(stats?.bytes ?? 0)}. Your synced transactions remain saved
          and encrypted.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 text-left">
      <h2 className="text-sm font-semibold text-foreground">Delete downloaded blocks?</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Recommended. Staying current adds about 3 MB a day, roughly 144 blocks. Keep the cache only
        if you are about to add another wallet or reach further back.
      </p>
      <p className="mt-2 text-xs font-medium text-foreground">
        Deleting this never deletes a transaction. Your synced transactions are already saved and
        encrypted.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">
        {cache.displayPath} · {stats ? formatCacheSize(stats.bytes) : "Measuring…"} ·{" "}
        {stats?.walletCount ?? "—"} wallet{stats?.walletCount === 1 ? "" : "s"}
      </p>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={deleting}
          onClick={() => void remove()}
          className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {deleting ? "Deleting…" : "Delete (recommended)"}
        </button>
        <button
          type="button"
          disabled={deleting}
          onClick={onKeep}
          className="inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          Keep
        </button>
      </div>
    </div>
  );
}
