/**
 * Bank of Japan (BoJ) source — JPY foreign-exchange daily reference rates.
 *
 * Why this exists: the Japanese National Tax Agency (NTA) and Japanese GAAP
 * reference BoJ-published daily exchange rates ("Foreign Exchange Rates,
 * 5:00 PM in Tokyo Market") for converting foreign-currency obligations.
 * ORBI customers in Japan need this row alongside the VW-median for tax
 * filings.
 *
 * BoJ data quirks:
 *   1. The public CSV downloads from `https://www.stat-search.boj.or.jp`
 *      are legacy Shift_JIS encoded (BoJ has never migrated to UTF-8).
 *      We use Node's TextDecoder('shift_jis') which is supported on
 *      Node >= 20 with full ICU (default in Node 20+ binaries and Bun).
 *   2. The site exposes both:
 *        - English download URL: `https://www.stat-search.boj.or.jp/ssi/cgi-bin/famecgi2`
 *          with form parameters cgi=$nme_a000_en&rdmode=zipdownload (zipped CSV).
 *        - Series export URL  : `https://www.stat-search.boj.or.jp/ssi/mtshtml/m_en.html`
 *      The cleanest deterministic endpoint is the `extr_lpt` time-series
 *      export: `https://www.stat-search.boj.or.jp/info/dload_en.html` which
 *      returns CSV (Shift_JIS) when invoked with the right form params.
 *
 * Endpoint (no auth, free public; produces Shift_JIS CSV):
 *   GET https://www.stat-search.boj.or.jp/ssi/cgi-bin/famecgi2
 *       ?cgi=$nme_a000_en
 *       &hdnSeriesResultType=3
 *       &hdnYyyyFrom=YYYY
 *       &hdnYyyyTo=YYYY
 *       &chkFreq=DD            (DD = daily)
 *       &hdnCsvDownload=1
 *       &SeriesCode=FM08'FXERATE@5USD       (USD per 100 JPY at 5pm Tokyo)
 *
 * Series IDs we use:
 *   FM08'FXERATE@5USD  — USD/JPY (USD per 1 JPY × 100; BoJ publishes as
 *                        "100 JPY = $x" — i.e. USD per 100 JPY)
 *   FM08'FXERATE@5EUR  — EUR/JPY
 *   FM08'FXERATE@5GBP  — GBP/JPY
 *
 * History: daily reference back to ~1973 for major pairs.
 *
 * Storage convention:
 *   BoJ's value is "foreign per 100 JPY". We invert + scale to land in the
 *   canonical USD-base direction: source=USD, target=JPY,
 *   rate = 100 / boj_value = JPY per 1 USD. Same shape for EUR/GBP.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

export type BojPair = "USD/JPY" | "EUR/JPY" | "GBP/JPY";

export interface BojParsedRow {
  date: string;             // YYYY-MM-DD
  pair: BojPair;
  /** Foreign per 100 JPY (BoJ's native publication direction). */
  foreignPer100Jpy: number;
}

export interface BojFetchOptions {
  pair: BojPair;
  /** Inclusive year start (BoJ accepts year granularity for the form). */
  yearFrom: number;
  yearTo: number;
  fetchImpl?: typeof fetch;
}

const SERIES: Record<BojPair, string> = {
  "USD/JPY": "FM08'FXERATE@5USD",
  "EUR/JPY": "FM08'FXERATE@5EUR",
  "GBP/JPY": "FM08'FXERATE@5GBP",
};

const ENDPOINT_BASE = "https://www.stat-search.boj.or.jp/ssi/cgi-bin/famecgi2";

export class BojSource {
  readonly name = "boj";
  readonly endpointBase = ENDPOINT_BASE;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  urlFor(pair: BojPair, yearFrom: number, yearTo: number): string {
    const series = SERIES[pair];
    if (!series) throw new Error(`Unsupported BoJ pair: ${pair}`);
    const params = new URLSearchParams({
      cgi: "$nme_a000_en",
      hdnSeriesResultType: "3",
      hdnYyyyFrom: String(yearFrom),
      hdnYyyyTo: String(yearTo),
      chkFreq: "DD",
      hdnCsvDownload: "1",
      SeriesCode: series,
    });
    return `${ENDPOINT_BASE}?${params.toString()}`;
  }

  /**
   * Fetch + decode the BoJ CSV. Returns the decoded UTF-8 string.
   *
   * We read the response as an ArrayBuffer (so the underlying bytes are
   * preserved) then run TextDecoder('shift_jis') over them. If the runtime
   * lacks shift_jis support (very old Node without full ICU), the decoder
   * constructor throws and we surface a clear message.
   */
  async fetch(opts: BojFetchOptions): Promise<string> {
    const f = opts.fetchImpl ?? fetch;
    const url = this.urlFor(opts.pair, opts.yearFrom, opts.yearTo);
    const res = await f(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "text/csv,application/csv,*/*;q=0.8",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`BoJ ${res.status}: ${body.slice(0, 200)}`);
    }
    const bytes = await res.arrayBuffer();
    return decodeShiftJis(bytes);
  }

  /**
   * Parse the BoJ CSV body. The structure (after Shift_JIS decode) is:
   *
   *   "Series code","FM08'FXERATE@5USD"
   *   "Title","Foreign Exchange Rates / 5pm Tokyo / U.S. dollar"
   *   "Unit","Yen per US$"     <- note: yen-per-foreign, not foreign-per-100-yen
   *   "Frequency","Daily"
   *   ...
   *   "Date","FM08'FXERATE@5USD"
   *   "2024/03/01","150.32"
   *   "2024/03/04","150.21"
   *   ...
   *   "2024/03/02","ND"       <- holidays/weekends use "ND" (no data)
   *
   * BoJ's Unit string varies by series — sometimes "Yen per US$", sometimes
   * "US$ per 100 yen". We read it from the Unit row and adjust storage
   * accordingly (see `unitDirection`).
   */
  parseCsv(body: string, pair: BojPair): BojParsedRow[] {
    const lines = body.split(/\r?\n/);
    let unit = "";
    let dataStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const cells = splitCsv(lines[i]!);
      const k = (cells[0] ?? "").toLowerCase();
      if (k === "unit" && cells[1]) unit = cells[1]!;
      if (k === "date") {
        dataStart = i + 1;
        break;
      }
    }
    if (dataStart < 0) {
      throw new Error("BoJ CSV: missing 'Date' header row");
    }
    const direction = unitDirection(unit);
    const rows: BojParsedRow[] = [];
    for (let i = dataStart; i < lines.length; i++) {
      const cells = splitCsv(lines[i]!);
      const dateRaw = cells[0];
      const valueRaw = cells[1];
      if (!dateRaw || !valueRaw) continue;
      if (valueRaw === "ND" || valueRaw === "NA" || valueRaw === "*") continue;
      const date = normaliseDate(dateRaw);
      if (!date) continue;
      const v = Number(valueRaw);
      if (!Number.isFinite(v) || v <= 0) continue;
      // Normalise to "foreign per 100 JPY" for storage consistency.
      // direction === "yen-per-foreign"      => yen per 1 foreign = v.
      //   foreign per 100 yen = 100 / v.
      // direction === "foreign-per-100-yen"  => already in target shape.
      const foreignPer100Jpy =
        direction === "yen-per-foreign" ? 100 / v : v;
      rows.push({ date, pair, foreignPer100Jpy });
    }
    return rows;
  }

  toInserts(rows: BojParsedRow[], fetchedAtIso: string): AuthorityRateInsert[] {
    const out: AuthorityRateInsert[] = [];
    for (const r of rows) {
      // foreignPer100Jpy = foreign-currency-units per 100 JPY.
      // We want rate = JPY per 1 foreign = 100 / foreignPer100Jpy.
      const rate = 100 / r.foreignPer100Jpy;
      if (!Number.isFinite(rate) || rate <= 0) continue;
      const [src] = r.pair.split("/") as [string, string];
      out.push({
        source_currency: src,
        target_currency: "JPY",
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
        source_authority: "BOJ",
        provenance: "historical-backfill",
      });
    }
    return out;
  }
}

/**
 * Decode a Shift_JIS-encoded body to UTF-8.
 *
 * Node 20+ ships with full ICU and supports `TextDecoder('shift_jis')`.
 * Bun also supports it. We throw a clear message if the runtime can't
 * construct the decoder, so callers can install `iconv-lite` as a fallback
 * if it ever fails in CI.
 */
export function decodeShiftJis(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("shift_jis").decode(bytes);
  } catch (err) {
    throw new Error(
      "Shift_JIS decoding not supported in this runtime. " +
        "Run on Node >= 20 with full ICU (the default) or Bun, " +
        "or install iconv-lite as a fallback. Original error: " +
        (err as Error).message,
    );
  }
}

export function splitCsv(line: string): string[] {
  return line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

/** "2024/03/01" or "2024-03-01" → "2024-03-01". */
export function normaliseDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (!m) return null;
  const [, yyyy, mm, dd] = m;
  return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
}

/**
 * BoJ "Unit" strings we expect in the wild:
 *   "Yen per US$"           → yen-per-foreign
 *   "Yen per Euro"          → yen-per-foreign
 *   "U.S. dollar per 100 yen" → foreign-per-100-yen
 *
 * Defaults to "yen-per-foreign" when the string is missing or unrecognised
 * (the most common BoJ publication for USD/JPY).
 */
export function unitDirection(unit: string): "yen-per-foreign" | "foreign-per-100-yen" {
  const u = unit.toLowerCase();
  if (/per\s+100\s+yen/.test(u)) return "foreign-per-100-yen";
  return "yen-per-foreign";
}
