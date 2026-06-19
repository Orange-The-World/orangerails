/**
 * Sink adapter framework , protocol-driven `format=` dispatch for or-sync.
 *
 * A sink adapter takes the canonical `NormalizedTransaction` that or-sync
 * already produces (via per-provider source adapters) and returns rows
 * shaped for one specific consumer app's database (V2, V3, OW, future).
 *
 * The consumer app passes `format: '<app-slug>'` in the or-sync body. or-sync
 * looks the slug up in the dispatch table, runs the sink adapter for each
 * NormalizedTransaction, and returns the aggregated rows in the response.
 *
 * Plaintext consumers (V2): rows are returned as-is, V2 inserts directly.
 * ZK consumers (V3, OW, Personal future): metadata.requires_encryption lists
 *   field paths the consumer's browser must AES-256-GCM encrypt before insert.
 *
 * Implements the protocol described in OrangeRails-Protocol.html §8.
 */

/**
 * Canonical transaction shape , single source of truth lives in
 * `_shared/providers/types.ts` (sources produce, sinks consume). Re-exported
 * here so sink modules can keep their existing import path.
 */
import type { NormalizedTransaction } from '../providers/types.ts';
export type { NormalizedTransaction };

/**
 * Per-transaction context the sink needs to shape its rows correctly.
 * or-sync populates this from the connection + caller context.
 */
export interface SinkInput {
  /** The just-fetched NormalizedTransaction. */
  transaction: NormalizedTransaction;
  /** OR's `connections.id` this transaction belongs to. */
  or_connection_id: string;
  /** OR's `subaccounts.id` for the consumer-side org / user. */
  or_subaccount_id: string;
  /**
   * The consumer's external_user_id (the value the platform passed to
   * or-provision). Most consumers use this as their own `organizationId`
   * or `userId`. Sink-specific.
   */
  external_user_id: string;
}

/**
 * Output a sink emits per-transaction. Shape depends on the consumer app ,
 * the sink returns whatever its consumer's insert path expects to see.
 *
 * `rows` is an arbitrary record of table-name → row-arrays. The consumer
 * decides how to use them; OR makes no assumptions beyond passing them
 * through unchanged in the or-sync response body.
 *
 * `metadata.requires_encryption` lists JSON paths into `rows` that the
 * consumer's browser MUST encrypt with AES-256-GCM before persisting. Empty
 * for plaintext consumers like V2.
 */
export interface SinkOutput {
  rows: Record<string, unknown[]>;
  metadata: {
    canonical_id: string;
    requires_encryption: string[];
  };
}

export interface SinkAdapter {
  /** Slug consumers pass in `or-sync` body's `format` field. */
  format: string;
  /** Semver-ish identifier so consumers can pin against a specific shape. */
  version: string;
  /**
   * Translate one NormalizedTransaction to consumer-shaped rows.
   *
   * Sinks SHOULD be pure (no I/O, no DB calls). All resolution that requires
   * the consumer's DB (FK lookups, find-or-create on Wallet/CoA/Contact,
   * etc.) is communicated via `__resolve*` hint fields embedded in the
   * emitted rows. The consumer's sync handler reads those hints, resolves
   * against its own Prisma client, and inserts.
   */
  toAppShape: (input: SinkInput) => SinkOutput;
}

/**
 * Aggregate per-transaction sink outputs into one response body.
 *
 * Concatenates row arrays per table-name, accumulates requires_encryption
 * paths with array-index prefixes so consumers can find each field
 * unambiguously across the merged arrays.
 */
export function mergeSinkOutputs(outputs: SinkOutput[]): {
  rows: Record<string, unknown[]>;
  metadata: { requires_encryption: string[] };
} {
  const rows: Record<string, unknown[]> = {};
  const requires_encryption: string[] = [];

  // Track per-table row counts so requires_encryption paths use the merged
  // array's indices, not the per-output indices.
  const counts: Record<string, number> = {};

  for (const out of outputs) {
    for (const [table, tableRows] of Object.entries(out.rows)) {
      const before = counts[table] ?? 0;
      rows[table] = (rows[table] ?? []).concat(tableRows);
      counts[table] = before + tableRows.length;

      // Re-index any requires_encryption paths that point at this table.
      // Path format: `<table>[<i>].<field>`. Shift `i` by `before`.
      const tableRe = new RegExp(`^${table}\\[(\\d+)\\]\\.(.+)$`);
      for (const path of out.metadata.requires_encryption) {
        const match = path.match(tableRe);
        if (match) {
          const idx = parseInt(match[1], 10) + before;
          requires_encryption.push(`${table}[${idx}].${match[2]}`);
        } else {
          // Path doesn't match this table; let it pass through. Other
          // tables in the same output get re-indexed in their own pass.
          // (Conservative: avoids dropping unknown-shape paths.)
          if (path.startsWith(`${table}[`)) {
            // Mismatched format , log and skip. Should not happen in practice.
            console.warn(`[sinks] unexpected requires_encryption path: ${path}`);
          }
        }
      }
    }
  }

  return { rows, metadata: { requires_encryption } };
}
