/**
 * DB cross-rate source plug-in — reads USD/X fiat cross-rates from the LOCAL
 * ORBI Postgres instead of an HTTP source.
 *
 * Use case: composite BTC/X resolution where the cross-rate is too thin / too
 * gated to live behind a public HTTP endpoint, but lands in our DB through a
 * separate authoritative loader. As of 2026-06-08:
 *
 *   - OXR (Open Exchange Rates) daily fallback writes USD/{KES,TWD,PKR,BGN,
 *     JMD,KWD,LBP} (source_authority='OXR', granularity='1d',
 *     product='ORBI-D-authority') via /opt/bb-support/scripts/orbi-oxr-fallback.py
 *   - BGN went 404 on Frankfurter post Bulgaria's EUR adoption 2026-01-01,
 *     so OXR is now the only continuous source for that pair.
 *
 * Mirrors the `Source` shape used by Frankfurter so `resolveComposite()` can
 * accept it as the `crossRateSource` without code changes.
 *
 * SAFETY:
 *   - Per-source freshness ceiling (default 26h, enough for daily OXR sync).
 *     A stale row raises (composite emit will skip), never fall-forward
 *     silently. Same pattern as STALE_SUPPRESS_PAIRS in forward-fill.ts.
 *   - Allowlist of acceptable source_authority values per pair, so a thin
 *     experimental authority can't accidentally back a production composite.
 *   - Read-only — no writes from this source.
 *
 * No ZKA concerns: USD/X spot rates are public data; the DB row itself is
 * not customer-derived.
 */

import type { SQL } from "bun";
import type { Source } from "./interface.ts";
import type { Candle, HealthStatus, Pair, SourceResponse } from "./types.ts";

export interface DbCrossPairConfig {
  /** Target fiat code (USD-{target}); always paired with USD source. */
  target: string;
  /** Allowed source_authority values in priority order; first fresh hit wins. */
  authorities: ReadonlyArray<string>;
  /** Granularity to query; defaults to '1d'. */
  granularity?: string;
  /** Max age (ms) of latest row before we treat it as stale (skip composite). */
  freshnessMs: number;
}

export class DbCrossRateSource implements Source {
  readonly name = "db-cross";
  readonly role = "cross-rate" as const;
  readonly pairsSupported: ReadonlyArray<string>;
  readonly rateLimitRps = 100; // local DB; no real ceiling
  readonly userAgent = "ORBI-DbCrossRateSource/1.0";

  private readonly sql: SQL;
  private readonly byTarget: Map<string, DbCrossPairConfig>;

  constructor(sql: SQL, pairs: ReadonlyArray<DbCrossPairConfig>) {
    this.sql = sql;
    this.byTarget = new Map(pairs.map((p) => [p.target.toUpperCase(), p]));
    this.pairsSupported = pairs.map((p) => `USD-${p.target.toUpperCase()}`);
  }

  async fetch(pair: Pair, _from: Date, to: Date): Promise<SourceResponse> {
    const fetchedAt = new Date();
    if (pair.source !== "USD") {
      return {
        source: this.name,
        candles: [],
        success: false,
        errorMessage: `db-cross only supports USD source, got ${pair.source}`,
        fetchedAt,
      };
    }
    const cfg = this.byTarget.get(pair.target.toUpperCase());
    if (!cfg) {
      return {
        source: this.name,
        candles: [],
        success: false,
        errorMessage: `db-cross: USD-${pair.target} not configured`,
        fetchedAt,
      };
    }

    const granularity = cfg.granularity ?? "1d";
    // Find the freshest authority-acceptable row whose bucket_ts <= effectiveAt
    // (`to` from resolveComposite is the effectiveAt boundary).
    // We don't inline values — Bun's tagged template handles binding.
    let row:
      | { bucket_ts: Date; rate: string | number; source_authority: string }
      | undefined;
    try {
      const rows = (await this.sql/* sql */`
        SELECT bucket_ts, rate, source_authority
        FROM exchange_rates
        WHERE source_currency = 'USD'
          AND target_currency = ${pair.target.toUpperCase()}
          AND granularity = ${granularity}
          AND source_authority IN ${this.sql(cfg.authorities as unknown as string[])}
          AND bucket_ts <= ${to}
        ORDER BY bucket_ts DESC
        LIMIT 1
      `) as Array<{ bucket_ts: Date; rate: string | number; source_authority: string }>;
      row = rows[0];
    } catch (err) {
      return {
        source: this.name,
        candles: [],
        success: false,
        errorMessage: `db-cross query error: ${(err as Error).message.slice(0, 200)}`,
        fetchedAt,
      };
    }

    if (!row) {
      return {
        source: this.name,
        candles: [],
        success: false,
        errorMessage: `db-cross: no USD/${pair.target} row found for authorities ${cfg.authorities.join(",")}`,
        fetchedAt,
      };
    }

    const bucketTs = row.bucket_ts instanceof Date ? row.bucket_ts : new Date(row.bucket_ts);
    const ageMs = to.getTime() - bucketTs.getTime();
    if (ageMs > cfg.freshnessMs) {
      return {
        source: this.name,
        candles: [],
        success: false,
        errorMessage: `db-cross: USD/${pair.target} row is stale (age=${Math.round(ageMs / 60_000)}m > ${Math.round(cfg.freshnessMs / 60_000)}m, authority=${row.source_authority})`,
        fetchedAt,
      };
    }

    const rate = typeof row.rate === "number" ? row.rate : Number(row.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      return {
        source: this.name,
        candles: [],
        success: false,
        errorMessage: `db-cross: USD/${pair.target} row has invalid rate`,
        fetchedAt,
      };
    }

    // Synthesize a single Candle whose close == rate. resolveComposite uses
    // close. Volume is set to 1 (non-zero) so resolve() won't drop it if
    // ever used in a VW-median context (it shouldn't — cross-rate role).
    const candle: Candle = {
      bucketTs,
      open: rate,
      high: rate,
      low: rate,
      close: rate,
      volume: 1,
    };
    // Annotate the authority on the response source name so it shows up in
    // the audit log. We append after the base name with a ":" separator.
    return {
      source: `${this.name}:${row.source_authority}`,
      candles: [candle],
      success: true,
      fetchedAt,
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const rows = (await this.sql/* sql */`SELECT 1 AS ok`) as Array<{ ok: number }>;
      return {
        name: this.name,
        reachable: rows.length > 0,
        lastSuccessAt: new Date(),
      };
    } catch (err) {
      return {
        name: this.name,
        reachable: false,
        lastFailureAt: new Date(),
        lastError: (err as Error).message,
      };
    }
  }
}
