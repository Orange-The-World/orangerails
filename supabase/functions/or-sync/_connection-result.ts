/**
 * Connection-result helpers, extracted from or-sync/index.ts so they can be
 * unit-tested without importing a module that calls Deno.serve() at import
 * time. Same extraction pattern as _shared/upstream-errors.ts (DL-0421).
 *
 * See or-sync/index.ts for the call site.
 */
import type { SyncResult } from '../_shared/providers/types.ts';

/**
 * Derive the connection health fields from one adapter SyncResult.
 *
 * A denied source forces status='partial' even when the adapter did not set
 * partial: true explicitly. Trusting the flag alone risks writing
 * status='active' over history the key was never allowed to read.
 *
 * Additive contract: a complete sync returns exactly { status: 'active' }
 * with no partial or denied_sources keys, so consumers that only inspect
 * status still get the right answer and nothing in the wire format changes
 * for connections that sync cleanly.
 *
 * Missing fields are treated as complete: adapters written before these
 * fields existed return no partial and no denied_sources, and the default
 * is 'active'. Once an adapter CAN deny a source it is contractually
 * required to declare denied_sources (see Consumer-Integration-Guide.md
 * adapter contract).
 */
export function readSyncCompleteness(result: SyncResult): {
  status: 'active' | 'partial';
  denied_sources?: string[];
} {
  const denied = (result.denied_sources?.length ?? 0) > 0
    ? result.denied_sources
    : undefined;
  const isPartial = (result.partial ?? false) || denied !== undefined;

  if (!isPartial) {
    return { status: 'active' };
  }

  return {
    status: 'partial',
    ...(denied !== undefined ? { denied_sources: denied } : {}),
  };
}
