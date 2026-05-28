/**
 * Banco de la República (BANREP) source — USD/COP daily TRM
 * (Tasa Representativa del Mercado).
 *
 * Why this exists: Colombian tax (DIAN), IFRS and contractual reporting in
 * Colombia require the official daily TRM for converting foreign-currency
 * transactions into Colombian pesos. Customers operating in CO need the
 * authority-stamped TRM side-by-side with our ORBI VW-median.
 *
 * Authority vs. transport:
 * - The TRM is calculated and certified by the Superintendencia Financiera
 *   de Colombia (SuperFinanciera) under Resolución 8 de 2000 of the Junta
 *   Directiva del Banco de la República (BANREP); BANREP republishes the
 *   historical series. The number is identical from both publishers.
 * - BANREP's own site (banrep.gov.co) is fronted by Radware Bot Manager
 *   and rejects server-side fetches with HTTP 200 "Bot Manager Block"
 *   responses regardless of UA — same fingerprint pattern that blocked
 *   RBA. SuperFinanciera's portal exposes only an HTML query form.
 * - Datos Abiertos Colombia (datos.gov.co), the MinTIC-run national open
 *   data portal, republishes the SuperFinanciera-attributed series as a
 *   Socrata SODA2 JSON API. Dataset 32sa-8pi3, "Tasa de Cambio
 *   Representativa del Mercado- TRM", coverage 1991-12-02 → present,
 *   license CC BY-SA 4.0, provenance OFFICIAL, attribution
 *   "Superintendencia Financiera de Colombia". No auth, no key, no
 *   anti-scraping — silent-friendly under ORBI's Hybrid Asymmetric
 *   Strategy.
 *
 * This matches the ECB-via-Frankfurter and BCCH-via-mindicador.cl
 * precedents already in production: third-party civic-data transport,
 * sovereign authority signature ('BANREP') on every row.
 *
 * Endpoint (no auth, free public data, JSON):
 *   GET https://www.datos.gov.co/resource/32sa-8pi3.json
 *     ?$where=vigenciadesde>=':from' AND vigenciadesde<=':to'
 *     &$order=vigenciadesde ASC
 *     &$limit=50000
 *
 * Response shape (Socrata SODA2):
 *   [
 *     { "valor": "3631.57",
 *       "unidad": "COP",
 *       "vigenciadesde": "YYYY-MM-DDT00:00:00.000",
 *       "vigenciahasta": "YYYY-MM-DDT00:00:00.000" },
 *     ...
 *   ]
 *
 * Weekend / holiday expansion: each row carries a [vigenciadesde,
 * vigenciahasta] interval. On business days the two match. On Fridays
 * (and the day before holidays) the row covers Friday → Sunday (or
 * through the holiday end). We expand each interval into one row per
 * calendar day so downstream queries can pick the rate by exact date
 * without weekend gaps — the published TRM is legally in force for
 * every covered day, weekends included.
 *
 * Storage: valor is COP per 1 USD, which matches ORBI's USD-base
 * convention (source=USD, target=COP, rate=valor — no inversion).
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

const RESOURCE_ID = "32sa-8pi3";
const ENDPOINT_BASE = `https://www.datos.gov.co/resource/${RESOURCE_ID}.json`;

/** Socrata caps a single SODA2 response at 50000 rows. ~35 years of daily
 *  TRM = ~12-13k rows, so a single call covers any backfill we'd ever do
 *  in one shot; we keep the limit explicit anyway as a guardrail. */
const SODA_PAGE_LIMIT = 50000;

export interface BanrepFetchOptions {
  /** ISO date YYYY-MM-DD, inclusive. */
  from: string;
  /** ISO date YYYY-MM-DD, inclusive. */
  to: string;
  fetchImpl?: typeof fetch;
}

export interface BanrepRawObservation {
  /** Stringified number, e.g. "3631.57". */
  valor?: string | number;
  /** Always "COP" in practice. */
  unidad?: string;
  /** ISO timestamp, e.g. "2026-05-28T00:00:00.000". */
  vigenciadesde?: string;
  /** ISO timestamp, e.g. "2026-05-28T00:00:00.000". */
  vigenciahasta?: string;
}

export interface BanrepParsedRow {
  /** YYYY-MM-DD (UTC). */
  date: string;
  /** COP per 1 USD. */
  value: number;
}

export class BanrepSource {
  readonly name = "banrep";
  readonly endpointBase = ENDPOINT_BASE;
  /**
   * Honest project UA — Socrata is friendly to plain GETs, no need to
   * spoof a browser. Same pattern as the other no-auth CB plug-ins.
   */
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  /** Build a single-call Socrata URL for the [from, to] window. */
  urlFor(from: string, to: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new Error(`Invalid BANREP range: ${from} → ${to}`);
    }
    if (from > to) {
      throw new Error(`Invalid BANREP range: ${from} → ${to}`);
    }
    // We query by vigenciadesde so we also catch the last pre-window row
    // whose interval may extend INTO the window (e.g. Friday before
    // from=Monday). The caller widens `from` by a few days when building
    // the URL via fetchRange; here we just honor whatever range is given.
    const where = encodeURIComponent(
      `vigenciadesde >= '${from}T00:00:00.000' AND vigenciadesde <= '${to}T23:59:59.999'`,
    );
    const order = encodeURIComponent("vigenciadesde ASC");
    return (
      `${ENDPOINT_BASE}?$where=${where}` +
      `&$order=${order}` +
      `&$limit=${SODA_PAGE_LIMIT}`
    );
  }

  async fetch(opts: BanrepFetchOptions): Promise<BanrepRawObservation[]> {
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
      throw new Error(`BANREP/datos.gov.co ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as BanrepRawObservation[];
    if (!Array.isArray(json)) {
      throw new Error(
        `BANREP/datos.gov.co: expected JSON array, got ${typeof json}`,
      );
    }
    return json;
  }

  /**
   * Expand Socrata rows into per-day observations.
   *
   * Each raw row carries (vigenciadesde, vigenciahasta). For a Friday
   * publication that covers the weekend, vigenciadesde=Fri and
   * vigenciahasta=Sun, and the legally-in-force TRM is identical on all
   * three days. We emit one BanrepParsedRow per covered calendar day,
   * clamped to [from, to].
   *
   * Bounds inclusive, YYYY-MM-DD. Bad rows (missing date, non-finite or
   * non-positive valor) are dropped silently. Duplicate dates are
   * deduped (latest wins), defending against the unlikely case of
   * overlapping intervals at the boundary of a SuperFinanciera correction.
   */
  parse(
    raw: BanrepRawObservation[],
    from: string,
    to: string,
  ): BanrepParsedRow[] {
    const byDate = new Map<string, BanrepParsedRow>();
    for (const o of raw) {
      if (!o.vigenciadesde) continue;
      const valueNum = typeof o.valor === "string" ? Number(o.valor) : o.valor;
      if (typeof valueNum !== "number" || !Number.isFinite(valueNum) || valueNum <= 0) {
        continue;
      }
      const desdeIso = isoDateOnly(o.vigenciadesde);
      if (!desdeIso) continue;
      const hastaIso = o.vigenciahasta ? (isoDateOnly(o.vigenciahasta) ?? desdeIso) : desdeIso;
      // Expand interval inclusive on both ends.
      for (const day of iterateDays(desdeIso, hastaIso)) {
        if (day < from || day > to) continue;
        byDate.set(day, { date: day, value: valueNum });
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  toInserts(
    raw: BanrepRawObservation[],
    fetchedAtIso: string,
    opts: { from: string; to: string },
  ): AuthorityRateInsert[] {
    const parsed = this.parse(raw, opts.from, opts.to);
    const out: AuthorityRateInsert[] = [];
    for (const r of parsed) {
      out.push({
        source_currency: "USD",
        target_currency: "COP",
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
        source_authority: "BANREP",
        provenance: "historical-backfill",
      });
    }
    return out;
  }

  /**
   * Convenience: fetch + parse with a small look-back so the first day of
   * the requested window is covered by a TRM whose interval may have
   * started up to ~5 days earlier (long-weekend / holiday case).
   *
   * Dedup-by-date defends against any overlap between adjacent rows in
   * the SODA response (Socrata returns disjoint intervals in practice,
   * but the orchestrator's ON CONFLICT requires single-row uniqueness
   * per (source_authority, bucket_ts) within a batch).
   */
  async fetchRange(opts: {
    from: string;
    to: string;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
  }): Promise<BanrepParsedRow[]> {
    const log = opts.log ?? (() => {});
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.from) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.to)) {
      throw new Error(`Invalid BANREP range: ${opts.from} → ${opts.to}`);
    }
    if (opts.from > opts.to) {
      throw new Error(`Invalid BANREP range: ${opts.from} → ${opts.to}`);
    }
    // Widen the upstream query window by 7 days on the leading edge so we
    // pick up a TRM whose interval started before `from` but is still in
    // force on `from` (e.g. Friday Dec 31 publication covering Jan 1-3).
    const widenedFrom = shiftIsoDay(opts.from, -7);
    log(`  [banrep] querying datos.gov.co TRM ${widenedFrom} → ${opts.to}`);
    const raw = await this.fetch({
      from: widenedFrom,
      to: opts.to,
      fetchImpl: opts.fetchImpl,
    });
    log(`  [banrep] datos.gov.co returned ${raw.length} raw TRM rows`);
    return this.parse(raw, opts.from, opts.to);
  }
}

// ----------------------------------------------------------------------------
// Date helpers — exported for tests
// ----------------------------------------------------------------------------

/**
 * Take a Socrata "YYYY-MM-DDTHH:MM:SS[.SSS]" timestamp and return the
 * date component "YYYY-MM-DD", or null if the input doesn't match.
 */
export function isoDateOnly(s: string): string | null {
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

/**
 * Yield each ISO date from `from` to `to` inclusive. Uses UTC arithmetic
 * to avoid local-timezone DST drift.
 */
export function* iterateDays(from: string, to: string): Generator<string> {
  if (from > to) return;
  const start = isoToUtcMs(from);
  const end = isoToUtcMs(to);
  const DAY_MS = 86_400_000;
  for (let t = start; t <= end; t += DAY_MS) {
    yield utcMsToIso(t);
  }
}

function isoToUtcMs(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function utcMsToIso(t: number): string {
  const d = new Date(t);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Shift an ISO YYYY-MM-DD by N days (negative = back). */
export function shiftIsoDay(iso: string, deltaDays: number): string {
  return utcMsToIso(isoToUtcMs(iso) + deltaDays * 86_400_000);
}
