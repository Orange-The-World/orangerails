/**
 * Federal Reserve (FRED / St. Louis Fed) source — H.10 daily foreign
 * exchange spot reference rates published by the Board of Governors of
 * the Federal Reserve System. FRED proxies the H.10 release as series
 * IDs prefixed DEX*.
 *
 * Why this exists: the FED H.10 noon-buying-rate (now noon-rate
 * replacement) is the most-cited central-bank reference for USD/foreign
 * currency conversion in the United States. US GAAP and IRS guidance
 * both accept H.10 daily rates for foreign-currency translation. This
 * plug-in lets us store FED rates alongside the local-authority rates
 * (Banxico for MXN, BCB for BRL, BoC for CAD, BoE for GBP), so US
 * customers can see the FED reference and non-US customers can see
 * their own central-bank reference for the same pair.
 *
 * Series we use (all daily spot, business days only; "." marks holidays):
 *
 *   ID         direction              start        source / target
 *   --------   -------------------    ---------    ----------------
 *   DEXUSEU    USD per EUR            1999-01-04   EUR -> USD
 *   DEXUSUK    USD per GBP            1971-01-04   GBP -> USD
 *   DEXJPUS    JPY per USD            1971-01-04   USD -> JPY
 *   DEXCAUS    CAD per USD            1971-01-04   USD -> CAD
 *   DEXSZUS    CHF per USD            1971-01-04   USD -> CHF
 *   DEXUSAL    USD per AUD            1971-01-04   AUD -> USD
 *   DEXMXUS    MXN per USD            1993-11-08   USD -> MXN
 *   DEXBZUS    BRL per USD            1995-01-02   USD -> BRL
 *   DEXINUS    INR per USD            1973-01-02   USD -> INR
 *
 * Direction was verified 2026-05-27 by querying the FRED series
 * metadata endpoint (`/fred/series?series_id=...`) and reading the
 * `units` field for each ID. The naming convention is asymmetric
 * (DEX**US** means foreign-per-USD; DEX**USXX** means USD-per-foreign),
 * so do NOT infer direction from the ID alone — always check the units
 * string. A wrong direction silently corrupts the rate column.
 *
 * Storage convention (matches BoE plug-in): `rate` is stored as
 * "target per source", i.e. multiplying a source-currency amount by
 * rate gives the target-currency amount. So for DEXUSEU (USD per EUR)
 * we set source=EUR, target=USD, rate=DEXUSEU value.
 *
 * Endpoint:
 *   GET https://api.stlouisfed.org/fred/series/observations
 *       ?series_id=<ID>
 *       &api_key=<FRED_API_KEY>
 *       &file_type=json
 *       &observation_start=YYYY-MM-DD
 *       &observation_end=YYYY-MM-DD
 *
 * Rate limit: FRED allows 120 requests/minute. We only call ~9 series
 * per backfill, so a 600ms inter-series sleep keeps us well under the
 * limit and polite.
 *
 * Holiday rows: FRED returns `value: "."` for non-business days. We
 * skip those rows entirely.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

export interface FredSeriesSpec {
  /** FRED series ID, e.g. DEXUSEU. */
  id: string;
  /** ISO currency code we store as `source_currency`. */
  source: string;
  /** ISO currency code we store as `target_currency`. */
  target: string;
  /** Human label for logs (e.g. "USD per EUR"). */
  units: string;
}

/**
 * Series catalogue with verified direction. The (source, target) tuple
 * here is the storage tuple: `rate` from FRED is target-per-source.
 */
export const FRED_SERIES: readonly FredSeriesSpec[] = [
  { id: "DEXUSEU", source: "EUR", target: "USD", units: "USD per EUR" },
  { id: "DEXUSUK", source: "GBP", target: "USD", units: "USD per GBP" },
  { id: "DEXJPUS", source: "USD", target: "JPY", units: "JPY per USD" },
  { id: "DEXCAUS", source: "USD", target: "CAD", units: "CAD per USD" },
  { id: "DEXSZUS", source: "USD", target: "CHF", units: "CHF per USD" },
  { id: "DEXUSAL", source: "AUD", target: "USD", units: "USD per AUD" },
  { id: "DEXMXUS", source: "USD", target: "MXN", units: "MXN per USD" },
  { id: "DEXBZUS", source: "USD", target: "BRL", units: "BRL per USD" },
  { id: "DEXINUS", source: "USD", target: "INR", units: "INR per USD" },
] as const;

export interface FredFetchOptions {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  apiKey: string;
  /** Override the series list (used in tests). */
  series?: readonly FredSeriesSpec[];
  /** Sleep between series calls in ms (default 600). */
  sleepMs?: number;
  fetchImpl?: typeof fetch;
  /** Override the sleep impl (used in tests). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Optional logger. */
  log?: (msg: string) => void;
}

interface FredObservation {
  date: string;
  value: string;
}

interface FredObservationsResponse {
  observations?: FredObservation[];
}

const ENDPOINT = "https://api.stlouisfed.org/fred/series/observations";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class FredSource {
  readonly name = "fred";
  readonly endpoint = ENDPOINT;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  urlFor(seriesId: string, from: string, to: string, apiKey: string): string {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: apiKey,
      file_type: "json",
      observation_start: from,
      observation_end: to,
    });
    return `${ENDPOINT}?${params.toString()}`;
  }

  /**
   * Fetch every series in the catalogue and return parsed inserts in
   * a single flat array. Sleeps `sleepMs` between series to respect
   * FRED's 120 req/min limit (we use ~9 calls, so this is courtesy).
   */
  async fetchAll(
    opts: FredFetchOptions,
    fetchedAtIso: string,
  ): Promise<AuthorityRateInsert[]> {
    if (!opts.apiKey) {
      throw new Error("FredSource: apiKey is required (set FRED_API_KEY)");
    }
    const f = opts.fetchImpl ?? fetch;
    const sleep = opts.sleepImpl ?? defaultSleep;
    const sleepMs = opts.sleepMs ?? 600;
    const series = opts.series ?? FRED_SERIES;
    const log = opts.log ?? (() => {});

    const out: AuthorityRateInsert[] = [];
    for (let i = 0; i < series.length; i++) {
      const spec = series[i]!;
      const url = this.urlFor(spec.id, opts.from, opts.to, opts.apiKey);
      const res = await f(url, {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(
          `FRED ${spec.id} ${res.status}: ${body.slice(0, 300)}`,
        );
      }
      const json = (await res.json()) as FredObservationsResponse;
      const rows = this.toInsertsForSeries(json, spec, fetchedAtIso);
      log(
        `  [fred] ${spec.id} (${spec.units}): ${rows.length} obs ` +
          `→ ${spec.source}/${spec.target}`,
      );
      out.push(...rows);
      if (i < series.length - 1) await sleep(sleepMs);
    }
    return out;
  }

  /**
   * Parse one series' observations into AuthorityRateInsert rows.
   * Skips rows where value === "." (FRED null marker for non-business
   * days / holidays) or where the value cannot be parsed as a positive
   * finite number.
   */
  toInsertsForSeries(
    body: FredObservationsResponse,
    spec: FredSeriesSpec,
    fetchedAtIso: string,
  ): AuthorityRateInsert[] {
    const obs = body.observations ?? [];
    const out: AuthorityRateInsert[] = [];
    for (const o of obs) {
      if (!o || !o.date || !o.value) continue;
      if (o.value === ".") continue;
      const rate = Number(o.value);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      out.push({
        source_currency: spec.source,
        target_currency: spec.target,
        bucket_ts: `${o.date}T00:00:00.000Z`,
        granularity: "1d",
        product: "ORBI-D-authority",
        rate,
        tier: "B-single",
        composite: false,
        composite_via: null,
        provider_count: 1,
        status: "CONFIRMED",
        fetched_at: fetchedAtIso,
        computed_at: fetchedAtIso,
        source_authority: "FED",
        provenance: "historical-backfill",
      });
    }
    return out;
  }
}
