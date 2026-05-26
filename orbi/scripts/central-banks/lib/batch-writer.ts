/**
 * Central-bank batch writer — thin wrapper over the historical-backfill
 * batch writer, but emits rows tagged with a `source_authority` field so the
 * Banxico / BCB / BoC plug-ins can coexist with ORBI rows for the same
 * (pair, bucket).
 *
 * We do NOT import the historical-backfill BatchWriter directly because its
 * UPSERT SQL is hard-coded to the (source_currency, target_currency,
 * bucket_ts, granularity, product) conflict tuple and does not include
 * source_authority. After migration 006, that tuple is no longer the unique
 * key — see orbi/schema/006_multi_authority.sql. So we ship a sibling
 * implementation that explicitly upserts on the 6-tuple including
 * source_authority.
 *
 * Same chunking, same retry-on-transient, same idempotency.
 */

export type SourceAuthority =
  | "ORBI"
  | "ECB"
  | "BANXICO"
  | "BCB"
  | "BOC"
  | "FED"
  | "BOE"
  | "RBA"
  | "SNB"
  | "BOJ"
  | "BLOCKCHAIN_COM";

export interface AuthorityRateInsert {
  source_currency: string;
  target_currency: string;
  /** ISO-8601 UTC, e.g. "2024-03-01T00:00:00.000Z" for a daily rate. */
  bucket_ts: string;
  granularity: "1m" | "1d";
  product: "ORBI-M" | "ORBI-D" | "ORBI-D-authority";
  rate: number;
  tier: "A" | "B" | "B-single" | "C-composite" | "stable";
  composite: boolean;
  composite_via?: string | null;
  provider_count: number;
  status: "CONFIRMED" | "PENDING" | "CORRECTED";
  fetched_at: string;
  computed_at: string;
  source_authority: SourceAuthority;
  provenance:
    | "forward-fill"
    | "historical-backfill"
    | "reconciler-upgrade"
    | "composite-replay";
}

export interface AuthorityBatchWriteResult {
  written: number;
  errors: number;
  errorDetails: string[];
}

export interface AuthorityBatchWriterDeps {
  exec: (sql: string) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

export interface AuthorityBatchWriterOptions {
  chunkSize?: number;
  maxRetries?: number;
  backoffBaseMs?: number;
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

export function buildAuthorityUpsertSql(
  rows: ReadonlyArray<AuthorityRateInsert>,
): string {
  if (rows.length === 0) throw new Error("buildAuthorityUpsertSql: empty rows");
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
          sqlValue(r.provenance),
          sqlValue(r.source_authority),
        ].join(",") +
        ")"
      );
    })
    .join(",\n");

  return `
    INSERT INTO exchange_rates (
      source_currency, target_currency, bucket_ts, granularity, product,
      rate, tier, composite, composite_via, provider_count, status,
      fetched_at, computed_at, provenance, source_authority
    ) VALUES
    ${valueTuples}
    ON CONFLICT (source_currency, target_currency, bucket_ts, granularity, product, source_authority)
    DO UPDATE SET
      rate = EXCLUDED.rate,
      tier = EXCLUDED.tier,
      provider_count = EXCLUDED.provider_count,
      computed_at = EXCLUDED.computed_at
    RETURNING id;
  `;
}

export class AuthorityBatchWriter {
  private readonly deps: AuthorityBatchWriterDeps;
  private readonly chunkSize: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;

  constructor(deps: AuthorityBatchWriterDeps, opts: AuthorityBatchWriterOptions = {}) {
    this.deps = deps;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
    this.maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
    this.backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.log = deps.log ?? (() => {});
  }

  async write(rows: ReadonlyArray<AuthorityRateInsert>): Promise<AuthorityBatchWriteResult> {
    const result: AuthorityBatchWriteResult = { written: 0, errors: 0, errorDetails: [] };
    for (let i = 0; i < rows.length; i += this.chunkSize) {
      const chunk = rows.slice(i, i + this.chunkSize);
      const ok = await this.writeChunkWithRetry(chunk, result);
      if (ok) result.written += chunk.length;
    }
    return result;
  }

  private async writeChunkWithRetry(
    chunk: ReadonlyArray<AuthorityRateInsert>,
    result: AuthorityBatchWriteResult,
  ): Promise<boolean> {
    const sql = buildAuthorityUpsertSql(chunk);
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        await this.deps.exec(sql);
        return true;
      } catch (err) {
        lastErr = err;
        if (!isTransient(err) || attempt === this.maxRetries) break;
        const delay = this.backoffBaseMs * Math.pow(2, attempt);
        this.log(`authority-batch-writer: transient error attempt ${attempt + 1}, retrying in ${delay}ms`);
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
