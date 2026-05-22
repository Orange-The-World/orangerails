import { useCallback, useEffect, useState } from "react";
import {
  fetchRecentAuditEntries,
  formatTimestamp,
  type AuditEntryView,
} from "@/lib/audit-queries";

interface AuditLogSectionProps {
  /** Polling interval in ms. Set to 0 to disable. */
  pollIntervalMs?: number;
  /** How many entries to show. */
  limit?: number;
}

/**
 * Recent history section in /portal — lists the last N audit entries
 * the user is allowed to see (RLS-filtered to their own actions + their
 * agents' actions).
 *
 * Every entry is part of the Merkle-chained audit log; tampering is
 * detectable via verify_audit_chain (future server-side endpoint).
 */
export function AuditLogSection({ pollIntervalMs = 15000, limit = 50 }: AuditLogSectionProps) {
  const [entries, setEntries] = useState<AuditEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await fetchRecentAuditEntries(limit);
      setEntries(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    reload();
    if (pollIntervalMs > 0) {
      const t = setInterval(reload, pollIntervalMs);
      return () => clearInterval(t);
    }
  }, [reload, pollIntervalMs]);

  return (
    <section className="rounded-lg border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">Recent activity</h2>
        <span className="text-xs text-muted-foreground">
          Tamper evident · last {limit}
        </span>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">Error: {error}</p>}

      {!loading && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Nothing yet. Activity appears here as you and your agents work.
        </p>
      )}

      <ol className="space-y-2">
        {entries.map((e) => (
          <li
            key={e.id}
            className="flex items-baseline justify-between gap-4 border-b last:border-b-0 pb-2 last:pb-0"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm">
                <span className="font-medium">{e.actor_label}</span>{" "}
                <span className="text-muted-foreground">{e.action_label}</span>
                {e.resource_type && (
                  <>
                    {" · "}
                    <span className="text-muted-foreground">{e.resource_label}</span>
                  </>
                )}
              </p>
              {e.reason && (
                <p className="mt-0.5 text-xs text-muted-foreground italic">"{e.reason}"</p>
              )}
            </div>
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {formatTimestamp(e.created_at)}
            </span>
          </li>
        ))}
      </ol>

      <p className="mt-4 text-xs text-muted-foreground">
        Each entry is hash-chained to the one before it, so any tampering with old entries is
        mathematically detectable.
      </p>
    </section>
  );
}
