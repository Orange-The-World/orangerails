/**
 * Bank Negara Malaysia (BNM) source — USD/MYR daily reference rate.
 *
 * Why this exists: Malaysian tax (LHDN/IRBM) and IFRS reporting in Malaysia
 * require the BNM-published daily Ringgit-per-US-Dollar reference rate for
 * converting foreign-currency transactions. Customers in MY need this rate
 * side-by-side with our ORBI VW-median for compliance.
 *
 * Source: BNM publishes a free, no-auth Open API (the "Kijang" portal) at
 *   https://api.bnm.gov.my/public/exchange-rate/USD/year/{YYYY}/month/{M}
 * that returns daily observations for a calendar month as JSON. Coverage
 * stretches back several years (2021-01-01 verified live on 2026-05-27).
 *
 * Sovereign authority: the api.bnm.gov.my host is operated directly by
 * BNM as part of their public Open API initiative. No key, no token, no
 * Akamai fingerprint — silent-friendly under ORBI's Hybrid Asymmetric
 * Strategy. The required `Accept: application/vnd.BNM.API.v1+json`
 * header is BNM's documented content-negotiation contract.
 *
 * Sessions: BNM publishes two daily sessions, "0900" (morning, indicative)
 * and "1130" (the official noon reference). When neither `session` query
 * param is sent, the API defaults to the 1130 reference session — which
 * is what tax authorities accept. Two quirks of the 1130 payload:
 *   - `middle_rate` is `null` (only `buying_rate` and `selling_rate` are
 *     populated). The 1200 session, by contrast, reports a non-null
 *     middle_rate.
 *   - For stability across the back-catalog (and consistency with the
 *     BNM-published "Kijang Rate" methodology), we compute the daily
 *     mid as the arithmetic mean of buying and selling — which matches
 *     the 1200-session middle_rate to ≤ 1e-4 on spot-check days.
 *
 * Storage: the published rate is MYR per 1 USD, which already matches
 * ORBI's USD-base convention (source=USD, target=MYR — no inversion).
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

const ENDPOINT_BASE = "https://api.bnm.gov.my/public/exchange-rate";

export interface BnmFetchMonthOptions {
  /** Calendar year, e.g. 2024. */
  year: number;
  /** Calendar month 1..12. */
  month: number;
  fetchImpl?: typeof fetch;
}

export interface BnmRawRateBlock {
  date?: string;
  buying_rate?: number | null;
  selling_rate?: number | null;
  middle_rate?: number | null;
}

export interface BnmRawObservation {
  currency_code?: string;
  unit?: number;
  rate?: BnmRawRateBlock;
}

export interface BnmRawResponse {
  data?:
    | BnmRawObservation
    | BnmRawObservation[]
    | {
        rate?: BnmRawRateBlock | BnmRawRateBlock[];
        currency_code?: string;
        unit?: number;
      };
  meta?: {
    quote?: string;
    session?: string;
    last_updated?: string;
    total_result?: number;
  };
}

export interface BnmParsedRow {
  /** YYYY-MM-DD. */
  date: string;
  /** MYR per 1 USD (computed mid = (buying+selling)/2 when middle_rate is null). */
  rate: number;
}

export class BnmSource {
  readonly name = "bnm";
  readonly endpointBase = ENDPOINT_BASE;
  /**
   * Intentionally minimal headers — api.bnm.gov.my is friendly to plain
   * GETs with the documented vendor Accept header. We identify ourselves
   * honestly with a project-specific UA so the operator can correlate
   * logs if needed.
   */
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";
  readonly acceptHeader = "application/vnd.BNM.API.v1+json";

  urlForMonth(year: number, month: number): string {
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new Error(`Invalid BNM year: ${year}`);
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error(`Invalid BNM month: ${month}`);
    }
    return `${ENDPOINT_BASE}/USD/year/${year}/month/${month}`;
  }

  async fetchMonth(opts: BnmFetchMonthOptions): Promise<BnmRawResponse> {
    const f = opts.fetchImpl ?? fetch;
    const url = this.urlForMonth(opts.year, opts.month);
    const res = await f(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: this.acceptHeader,
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`BNM ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as BnmRawResponse;
  }

  /**
   * Normalize a BNM monthly response into [{date, rate}, ...] ascending
   * by date. Drops malformed / zero / negative observations silently.
   *
   * The API returns `data` as an OBJECT with `rate` = array when the
   * window contains multiple days, or `data` = single object with
   * `rate` = object when only one observation exists. We accept both.
   */
  parse(raw: BnmRawResponse): BnmParsedRow[] {
    const out: BnmParsedRow[] = [];
    const blocks = extractRateBlocks(raw);
    for (const b of blocks) {
      if (!b.date) continue;
      const dateMatch = b.date.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dateMatch) continue;
      const mid = computeMid(b);
      if (mid === null) continue;
      out.push({ date: dateMatch[1]!, rate: mid });
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  toInserts(
    parsed: BnmParsedRow[],
    fetchedAtIso: string,
  ): AuthorityRateInsert[] {
    const rows: AuthorityRateInsert[] = [];
    for (const r of parsed) {
      if (!Number.isFinite(r.rate) || r.rate <= 0) continue;
      rows.push({
        source_currency: "USD",
        target_currency: "MYR",
        bucket_ts: `${r.date}T00:00:00.000Z`,
        granularity: "1d",
        product: "ORBI-D-authority",
        rate: r.rate,
        tier: "B-single",
        composite: false,
        composite_via: null,
        provider_count: 1,
        status: "CONFIRMED",
        fetched_at: fetchedAtIso,
        computed_at: fetchedAtIso,
        source_authority: "BNM",
        provenance: "historical-backfill",
      });
    }
    return rows;
  }

  /**
   * Convenience: walk a [from, to] window month-by-month, dedupe by
   * date, and return ascending parsed rows.
   *
   * BNM's monthly endpoint occasionally returns observations whose date
   * falls in the adjacent month (timezone-boundary entries reported
   * under the wrong calendar key). Dedup by date keeps the orchestrator's
   * batch UPSERT from hitting "ON CONFLICT DO UPDATE command cannot
   * affect row a second time" on dup keys within one batch.
   */
  async fetchRange(opts: {
    from: string;
    to: string;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
    /** Optional throttle between month fetches, ms. Default 250. */
    pauseMs?: number;
    /** Optional sleep impl (for tests). */
    sleep?: (ms: number) => Promise<void>;
  }): Promise<BnmParsedRow[]> {
    const log = opts.log ?? (() => {});
    const sleep =
      opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const pauseMs = opts.pauseMs ?? 250;
    const [fromYear, fromMonth] = parseYM(opts.from);
    const [toYear, toMonth] = parseYM(opts.to);
    if (fromYear * 12 + fromMonth > toYear * 12 + toMonth) {
      throw new Error(`Invalid BNM range: ${opts.from} → ${opts.to}`);
    }

    const byDate = new Map<string, BnmParsedRow>();
    let first = true;
    for (let y = fromYear; y <= toYear; y++) {
      const mStart = y === fromYear ? fromMonth : 1;
      const mEnd = y === toYear ? toMonth : 12;
      for (let m = mStart; m <= mEnd; m++) {
        if (!first) await sleep(pauseMs);
        first = false;
        log(`  [bnm] fetching ${y}-${String(m).padStart(2, "0")}`);
        const raw = await this.fetchMonth({
          year: y,
          month: m,
          fetchImpl: opts.fetchImpl,
        });
        const parsed = this.parse(raw);
        for (const r of parsed) {
          if (r.date >= opts.from && r.date <= opts.to) byDate.set(r.date, r);
        }
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}

// ----------------------------------------------------------------------------
// Helpers (exported for tests)
// ----------------------------------------------------------------------------

/** "YYYY-MM-DD" → [year, month]. Throws on malformed input. */
export function parseYM(d: string): [number, number] {
  const m = d.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) throw new Error(`Invalid BNM date: ${d}`);
  return [Number(m[1]!), Number(m[2]!)];
}

/**
 * Compute the daily mid rate from a BNM rate block.
 *
 * Returns `middle_rate` when populated (1200-session payloads). Falls
 * back to (buying + selling) / 2 — which is the BNM convention and
 * matches the 1200-session middle_rate to ≤ 1e-4 on spot-check days.
 * Returns null when neither path produces a finite positive number.
 */
export function computeMid(b: BnmRawRateBlock): number | null {
  const mid = numberOrNull(b.middle_rate);
  if (mid !== null && mid > 0) return mid;
  const buy = numberOrNull(b.buying_rate);
  const sell = numberOrNull(b.selling_rate);
  if (buy !== null && sell !== null && buy > 0 && sell > 0) {
    return (buy + sell) / 2;
  }
  return null;
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract every {date, buying_rate, selling_rate, middle_rate} block
 * from a BNM response, regardless of whether `data` is a single object
 * or an array, and regardless of whether `data.rate` is a single object
 * or an array.
 *
 * Exported for tests.
 */
export function extractRateBlocks(raw: BnmRawResponse): BnmRawRateBlock[] {
  const blocks: BnmRawRateBlock[] = [];
  const data = raw.data;
  if (!data) return blocks;
  const tops = Array.isArray(data) ? data : [data];
  for (const t of tops) {
    const r = (t as { rate?: BnmRawRateBlock | BnmRawRateBlock[] }).rate;
    if (!r) continue;
    if (Array.isArray(r)) {
      for (const x of r) blocks.push(x);
    } else {
      blocks.push(r);
    }
  }
  return blocks;
}
