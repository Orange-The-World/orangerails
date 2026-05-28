/**
 * South African Reserve Bank (SARB) source — USD/ZAR daily indicative rate.
 *
 * Why this exists: South African tax (SARS) and IFRS reporting in South
 * Africa require the SARB-published daily Rand-per-US-Dollar reference
 * rate for converting foreign-currency transactions. Customers in ZA need
 * this rate side-by-side with our ORBI VW-median for compliance.
 *
 * We already have USD/ZAR via Frankfurter cross-rate; this plug-in adds
 * the sovereign-authority signature on the same pair — more defensible
 * for South African customer audits. The orchestrator's authority tag is
 * what differentiates the rows.
 *
 * Source: SARB Web API (the public side of SARB's Online Statistical
 * Query System / OSQS). The "Rand per US Dollar" timeseries code is
 * EXCX135D, described by SARB as: "Weighted average of the banks' daily
 * rates at approximately 10:30 am. Weights are based on the banks'
 * foreign exchange transactions." That is the official SARB indicative
 * USD/ZAR daily reference rate.
 *
 * Endpoint (no auth, free public data, JSON):
 *   GET https://custom.resbank.co.za/SarbWebApi/WebIndicators/Shared/
 *       GetTimeseriesObservations/EXCX135D/{startDate}/{endDate}
 *
 * Response shape (array, ordered newest-first):
 *   [
 *     {
 *       "Period":      "YYYY-MM-DDT00:00:00",
 *       "Timeseries":  "Rand per US Dollar",
 *       "Description": "Weighted average of the banks' daily rates ...",
 *       "Value":       16.3551,
 *       "FormatNumber":"0.0000",
 *       "FormatDate":  "yyyy-MM-dd"
 *     },
 *     ...
 *   ]
 *
 * Coverage verified 2026-05-27: 2021-01-04 → present (1,348 daily rows
 * over the brief's 5-year window). Weekends and ZA bank holidays have no
 * entry. The series is ZAR per 1 USD, which matches ORBI's USD-base
 * convention directly (source=USD, target=ZAR, rate=Value — no inversion).
 *
 * ToS note: SARB's disclaimer at
 *   https://www.resbank.co.za/en/home/quick-links/disclaimer
 * prohibits redistribution without written consent. ORBI uses this as an
 * authoritative reference signal for compliance (auditor-facing
 * provenance), not for bulk republication, matching the silent-posture
 * stance we apply to RBA and other restrictive central banks.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

const ENDPOINT_BASE =
  "https://custom.resbank.co.za/SarbWebApi/WebIndicators/Shared/GetTimeseriesObservations";
const TIMESERIES_CODE = "EXCX135D";

export interface SarbFetchOptions {
  /** Inclusive YYYY-MM-DD. */
  from: string;
  /** Inclusive YYYY-MM-DD. */
  to: string;
  fetchImpl?: typeof fetch;
}

export interface SarbRawObservation {
  Period?: string;
  Timeseries?: string;
  Description?: string;
  Value?: number;
  FormatNumber?: string;
  FormatDate?: string;
}

export interface SarbParsedRow {
  /** YYYY-MM-DD (UTC date component of the Period timestamp). */
  date: string;
  /** ZAR per 1 USD. */
  value: number;
}

export class SarbSource {
  readonly name = "sarb";
  readonly endpointBase = ENDPOINT_BASE;
  /**
   * Honest project-specific UA so the SARB operator can correlate logs
   * if they ever care. SARB's custom.resbank.co.za is friendly to plain
   * GETs — no Akamai-style WAF observed during verification.
   */
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  urlFor(from: string, to: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new Error(`Invalid SARB date range: ${from} → ${to}`);
    }
    if (from > to) {
      throw new Error(`SARB range inverted: ${from} > ${to}`);
    }
    return `${ENDPOINT_BASE}/${TIMESERIES_CODE}/${from}/${to}`;
  }

  async fetch(opts: SarbFetchOptions): Promise<SarbRawObservation[]> {
    const f = opts.fetchImpl ?? fetch;
    const url = this.urlFor(opts.from, opts.to);
    const res = await f(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SARB ${res.status}: ${body.slice(0, 300)}`);
    }
    const raw = (await res.json()) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error(
        `SARB ${url}: expected JSON array, got ${typeof raw}`,
      );
    }
    return raw as SarbRawObservation[];
  }

  /**
   * Parse a SARB Web API response into [{date, value}, ...] ascending by
   * date. Drops malformed / zero / negative observations silently.
   * Exported for unit testing.
   */
  parse(raw: SarbRawObservation[]): SarbParsedRow[] {
    const rows: SarbParsedRow[] = [];
    for (const o of raw) {
      if (typeof o?.Period !== "string") continue;
      if (typeof o?.Value !== "number") continue;
      if (!Number.isFinite(o.Value) || o.Value <= 0) continue;
      const m = o.Period.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      rows.push({ date: m[1]!, value: o.Value });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
  }

  /**
   * Convenience: fetch + parse + filter to [from, to] in one call, with
   * dedup-by-date. Dedup is belt-and-braces against the rare possibility
   * of the SARB API surfacing a repeated Period at year boundaries;
   * (source_authority, bucket_ts) is the UPSERT key and the batch writer
   * cannot tolerate duplicate keys within a single batch.
   */
  async fetchRange(opts: {
    from: string;
    to: string;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
  }): Promise<SarbParsedRow[]> {
    const log = opts.log ?? (() => {});
    log(`  [sarb] fetching ${opts.from} → ${opts.to} from custom.resbank.co.za`);
    const raw = await this.fetch({
      from: opts.from,
      to: opts.to,
      fetchImpl: opts.fetchImpl,
    });
    const parsed = this.parse(raw);
    const byDate = new Map<string, SarbParsedRow>();
    for (const r of parsed) {
      if (r.date >= opts.from && r.date <= opts.to) byDate.set(r.date, r);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Map parsed rows into AuthorityRateInsert rows. */
  toInserts(
    rows: SarbParsedRow[],
    fetchedAtIso: string,
  ): AuthorityRateInsert[] {
    const out: AuthorityRateInsert[] = [];
    for (const r of rows) {
      if (!Number.isFinite(r.value) || r.value <= 0) continue;
      out.push({
        source_currency: "USD",
        target_currency: "ZAR",
        bucket_ts: `${r.date}T00:00:00.000Z`,
        granularity: "1d",
        product: "ORBI-D-authority",
        rate: r.value,
        tier: "B-single",
        composite: false,
        composite_via: null,
        provider_count: 1,
        status: "CONFIRMED",
        fetched_at: fetchedAtIso,
        computed_at: fetchedAtIso,
        source_authority: "SARB",
        provenance: "historical-backfill",
      });
    }
    return out;
  }
}
