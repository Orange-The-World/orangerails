/**
 * European Central Bank (ECB) source — euro foreign-exchange daily reference
 * rates via the Statistical Data Warehouse (SDW) Data API.
 *
 * Why this exists: Eurozone tax authorities (and many non-Euro EU members)
 * reference the ECB euro foreign-exchange reference rates published at
 * roughly 16:00 CET every TARGET business day. ORBI currently pulls USD/EUR
 * via Frankfurter (a third-party ECB proxy) and tags the rows with
 * `source_authority='ORBI'`. By wiring the SDW endpoint directly we own the
 * authority chain end-to-end and can confidently retag historic Frankfurter
 * rows to `source_authority='ECB'` after this lands.
 *
 * Endpoint (no auth, free public data):
 *   GET https://data-api.ecb.europa.eu/service/data/EXR/D.<CCY>.EUR.SP00.A
 *       ?format=csvdata&startPeriod=YYYY-MM-DD&endPeriod=YYYY-MM-DD
 *
 * Series key dimensions for the EXR (Exchange Rates) dataflow:
 *   D       — daily frequency
 *   <CCY>   — counter currency (e.g. USD, GBP, JPY, CHF, ...)
 *   EUR     — base currency (always EUR for the ECB reference rates)
 *   SP00    — exchange-rate type "spot"
 *   A       — series variation "average / standardized measure"
 *
 * For pair USD/EUR the SDW value `<USD per EUR>` is the published reference
 * rate. We invert it to store the canonical ORBI direction (USD as
 * source_currency, the foreign currency as target_currency) so the rest of
 * the central-bank plug-ins remain consistent. Therefore for the USD series
 * we store source=USD, target=EUR, rate = 1 / sdw_value.
 *
 * For cross pairs (e.g. EUR series with counter GBP), we store source=EUR,
 * target=GBP, rate = sdw_value directly (ECB publishes EUR-base by design).
 *
 * History: daily reference rates published since 1999-01-04 (euro inception).
 *
 * The CSV response format is far smaller than the JSON SDMX bundle for the
 * same window and is much faster to parse, so we default to CSV.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

export type EcbPair = {
  /** ECB SDW counter currency code (e.g. "USD", "GBP", "JPY"). */
  counter: string;
  /** How the row lands in `exchange_rates`. */
  storeAs: {
    source_currency: string;
    target_currency: string;
    /** If true, rate = 1 / sdw_value. If false, rate = sdw_value. */
    invert: boolean;
  };
};

/**
 * Pair config. ECB always publishes EUR-base. We expose two storage modes:
 *
 *   - For USD/EUR we INVERT so the row lines up with ORBI's USD-base
 *     convention (matches Frankfurter rows already in the table).
 *   - For other Euro-cross pairs (EUR/GBP, EUR/JPY, ...) we store as-is
 *     so the value is human-meaningful without inversion.
 */
export const ECB_PAIRS: Record<string, EcbPair> = {
  "USD/EUR": {
    counter: "USD",
    storeAs: { source_currency: "USD", target_currency: "EUR", invert: true },
  },
  "EUR/GBP": {
    counter: "GBP",
    storeAs: { source_currency: "EUR", target_currency: "GBP", invert: false },
  },
  "EUR/JPY": {
    counter: "JPY",
    storeAs: { source_currency: "EUR", target_currency: "JPY", invert: false },
  },
  "EUR/CHF": {
    counter: "CHF",
    storeAs: { source_currency: "EUR", target_currency: "CHF", invert: false },
  },
};

const ENDPOINT_BASE = "https://data-api.ecb.europa.eu/service/data/EXR";

export interface EcbFetchOptions {
  /** Pair label key (e.g. "USD/EUR"). */
  pair: keyof typeof ECB_PAIRS | string;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  fetchImpl?: typeof fetch;
}

export interface EcbParsedRow {
  date: string; // YYYY-MM-DD
  value: number; // raw SDW value (EUR-base)
}

export class EcbSource {
  readonly name = "ecb";
  readonly endpointBase = ENDPOINT_BASE;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  urlFor(pair: string, from: string, to: string): string {
    const cfg = ECB_PAIRS[pair];
    if (!cfg) throw new Error(`Unsupported ECB pair: ${pair}`);
    const seriesKey = `D.${cfg.counter}.EUR.SP00.A`;
    const params = new URLSearchParams({
      format: "csvdata",
      startPeriod: from,
      endPeriod: to,
    });
    return `${ENDPOINT_BASE}/${seriesKey}?${params.toString()}`;
  }

  async fetch(opts: EcbFetchOptions): Promise<string> {
    const f = opts.fetchImpl ?? fetch;
    const url = this.urlFor(String(opts.pair), opts.from, opts.to);
    const res = await f(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "text/csv,application/csv;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ECB ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.text();
  }

  /**
   * Parse the ECB SDW CSV response.
   *
   * Header columns include (variable order between dataflows, so we resolve
   * by name): KEY, FREQ, CURRENCY, CURRENCY_DENOM, EXR_TYPE, EXR_SUFFIX,
   * TIME_PERIOD, OBS_VALUE, ...
   *
   * We pull TIME_PERIOD (YYYY-MM-DD) and OBS_VALUE (numeric). Missing /
   * suppressed observations have OBS_VALUE empty — skipped silently.
   */
  parseCsv(body: string): EcbParsedRow[] {
    const lines = body.split(/\r?\n/);
    if (lines.length < 2) return [];
    const header = splitCsv(lines[0]!);
    const idxDate = header.indexOf("TIME_PERIOD");
    const idxValue = header.indexOf("OBS_VALUE");
    if (idxDate < 0 || idxValue < 0) {
      throw new Error(
        `ECB CSV missing TIME_PERIOD / OBS_VALUE columns; got: ${header.join(",")}`,
      );
    }
    const rows: EcbParsedRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      const cols = splitCsv(line);
      const date = cols[idxDate];
      const raw = cols[idxValue];
      if (!date || !raw) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) continue;
      rows.push({ date, value });
    }
    return rows;
  }

  toInserts(
    body: string,
    fetchedAtIso: string,
    opts: { pair: string },
  ): AuthorityRateInsert[] {
    const cfg = ECB_PAIRS[opts.pair];
    if (!cfg) throw new Error(`Unsupported ECB pair: ${opts.pair}`);
    const parsed = this.parseCsv(body);
    const out: AuthorityRateInsert[] = [];
    for (const r of parsed) {
      const rate = cfg.storeAs.invert ? 1 / r.value : r.value;
      if (!Number.isFinite(rate) || rate <= 0) continue;
      out.push({
        source_currency: cfg.storeAs.source_currency,
        target_currency: cfg.storeAs.target_currency,
        bucket_ts: `${r.date}T00:00:00.000Z`,
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
        source_authority: "ECB",
        provenance: "historical-backfill",
      });
    }
    return out;
  }
}

/**
 * Minimal CSV splitter sufficient for ECB SDW output (no embedded commas in
 * the columns we read; values are simple ISO dates and decimal numbers).
 */
export function splitCsv(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}
