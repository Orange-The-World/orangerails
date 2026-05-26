/**
 * Batch writer — chunked UPSERT into exchange_rates with retry-on-transient.
 *
 * Why this exists: a single backfill can produce millions of rows. Sending
 * them one-at-a-time would saturate the Supabase Management API. Chunking
 * at ~500 rows and using a single INSERT … VALUES (...), (...), ...
 * ON CONFLICT keeps round-trips down without exceeding API body limits.
 *
 * UPSERT semantics: ON CONFLICT (source_currency, target_currency, bucket_ts,
 * granularity, product) DO UPDATE — same uniqueness as the forward-fill writer.
 * Idempotent: re-running over the same minutes is a no-op (same values).
 *
 * Retry: exponential backoff on transient failures (5xx, network error,
 * timeout). Hard-stops on 4xx (configuration / SQL error — won't fix itself).
 *
 * This is the only place in the backfill stack that stamps
 *   provenance = 'historical-backfill'
 *   status     = 'CONFIRMED'
 * for inserted rows. Existing forward-fill rows are not touched
 * (UPSERT updates rate/tier/provider_count, but provenance is only set
 * via DEFAULT on INSERT — see ON CONFLICT clause below).
 */

export interface ExchangeRateInsert {
  source_currency: string;
  target_currency: string;
  /** ISO-8601. */
  bucket_ts: string;
  granularity: "1m" | "1d";
  product: "ORBI-M" | "ORBI-D";
  rate: number;
  tier: "A" | "B" | "B-single" | "C-composite" | "stable";
  composite: boolean;
  composite_via?: string | null;
  provider_count: number;
  status: "CONFIRMED" | "PENDING" | "CORRECTED";
  fetched_at: string;
  computed_at: string;
}

export interface BatchWriteResult {
  written: number;
  errors: number;
  errorDetails: string[];
}

export interface BatchWriterDeps {
  /** SQL executor — typically the Supabase Management API wrapper. */
  exec: (sql: string) => Promise<unknown>;
  /** Sleep (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Logger sink (injectable for tests). */
  log?: (msg: string) => void;
}

export interface BatchWriterOptions {
  chunkSize?: number;
  maxRetries?: number;
  /** Base backoff in ms. */
  backoffBaseMs?: number;
  /** Provenance tag stamped on every inserted row. */
  provenance?: "forward-fill" | "historical-backfill" | "reconciler-upgrade" | "composite-replay";
}

const DEFAULT_CHUNK = 500;
const DEFAULT_RETRIES = 4;
const DEFAULT_BACKOFF = 1000;

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function sqlValue(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error(`Non-finite numeric value: ${v}`);
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${sqlEscape(v)}'`;
}

export function buildUpsertSql(
  rows: ReadonlyArray<ExchangeRateInsert>,
  provenance: NonNullable<BatchWriterOptions["provenance"]>,
): string {
  if (rows.length === 0) throw new Error("buildUpsertSql: empty rows");
  const valueTuples = rows
    .map((r) => {
      return (
        "(" +
        [
          sqlValue(r.source_currency),
          sqlValue(r.target_currency),
          sqlValue(r.bucket_ts),
          sqlValue(r.granularity),
          sqlValue(r.product),
          sqlValue(r.rate),
          sqlValue(r.tier),
          sqlValue(r.composite),
          sqlValue(r.composite_via ?? null),
          sqlValue(r.provider_count),
          sqlValue(r.status),
          sqlValue(r.fetched_at),
          sqlValue(r.computed_at),
          sqlValue(provenance),
        ].join(",") +
        ")"
      );
    })
    .join(",\n");

  return `
    INSERT INTO exchange_rates (
      source_currency, target_currency, bucket_ts, granularity, product,
      rate, tier, composite, composite_via, provider_count, status,
      fetched_at, computed_at, provenance
    ) VALUES
    ${valueTuples}
    ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product)
    DO UPDATE SET
      rate = EXCLUDED.rate,
      tier = EXCLUDED.tier,
      provider_count = EXCLUDED.provider_count,
      computed_at = EXCLUDED.computed_at
    RETURNING id;
  `;
}

export class BatchWriter {
  private readonly deps: BatchWriterDeps;
  private readonly chunkSize: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly provenance: NonNullable<BatchWriterOptions["provenance"]>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(deps: BatchWriterDeps, opts: BatchWriterOptions = {}) {
    this.deps = deps;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
    this.maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF;
    this.provenance = opts.provenance ?? "historical-backfill";
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? (() => {});
  }

  async write(rows: ReadonlyArray<ExchangeRateInsert>): Promise<BatchWriteResult> {
    const result: BatchWriteResult = { written: 0, errors: 0, errorDetails: [] };

    for (let i = 0; i < rows.length; i += this.chunkSize) {
      const chunk = rows.slice(i, i + this.chunkSize);
      const ok = await this.writeChunkWithRetry(chunk, result);
      if (ok) result.written += chunk.length;
    }

    return result;
  }

  private async writeChunkWithRetry(
    chunk: ReadonlyArray<ExchangeRateInsert>,
    result: BatchWriteResult,
  ): Promise<boolean> {
    const sql = buildUpsertSql(chunk, this.provenance);
    let lastErr: unknown = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.deps.exec(sql);
        return true;
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === this.maxRetries) {
          break;
        }
        const delay = this.backoffBaseMs * Math.pow(2, attempt);
        this.log(`batch-writer: transient error attempt ${attempt + 1}, retrying in ${delay}ms`);
        await this.sleep(delay);
      }
    }

    result.errors += chunk.length;
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    result.errorDetails.push(`chunk[${chunk[0]!.bucket_ts}..${chunk[chunk.length - 1]!.bucket_ts}]: ${msg.slice(0, 200)}`);
    return false;
  }
}

function isTransient(err: unknown): boolean {
  if (err instanceof Error) {
    const m = err.message;
    if (/\b(429|5\d\d)\b/.test(m)) return true;
    if (m.includes("ETIMEDOUT") || m.includes("ECONNRESET") || m.includes("fetch failed")) return true;
    if (m.includes("AbortError")) return true;
  }
  return false;
}
