/**
 * Bank of England (BoE) source - GBP/USD daily spot reference via the
 * Interactive Statistical Database (IADB).
 *
 * Why this exists: HMRC and UK GAAP both reference Bank of England published
 * daily spot rates for converting foreign-currency amounts. Customers in
 * the UK need this rate side-by-side with our ORBI VW-median for compliance.
 *
 * Series we use (all daily spot rates, no business-day padding):
 *   XUDLGBD - sterling per US dollar (GBP per USD)  <- source=USD, target=GBP
 *   XUDLERD - euro      per US dollar (EUR per USD) optional, target=EUR
 *   XUDLJYD - yen       per US dollar (JPY per USD) optional, target=JPY
 *
 * For Phase D.2 we ship USD/GBP as the canonical UK reference pair. EUR
 * and JPY rates are produced by other authorities (ECB via Frankfurter,
 * BoJ once that source ships).
 *
 * Endpoint (no auth, free; CSV format):
 *   GET https://www.bankofengland.co.uk/boeapps/iadb/fromshowcolumns.asp
 *       ?csv.x=yes
 *       &Datefrom=DD/Mon/YYYY
 *       &Dateto=DD/Mon/YYYY
 *       &SeriesCodes=XUDLGBD
 *       &UsingCodes=Y
 *       &CSVF=TN
 *       &VPD=Y
 *
 * Response (CSV with one header row + one row per business day):
 *   DATE,XUDLGBD
 *   02 Jan 2024,0.7921
 *   03 Jan 2024,0.7919
 *   ...
 *
 * Date format in BoE CSV is "DD Mon YYYY" (English month abbreviation).
 *
 * History: XUDLGBD series covers back to ~1975 daily.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

export interface BoeFetchOptions {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  /** Series code; defaults to XUDLGBD (GBP per USD). */
  seriesCode?: string;
  fetchImpl?: typeof fetch;
}

export interface BoeParsedRow {
  date: string;   // YYYY-MM-DD
  rate: number;
}

const ENDPOINT_BASE = "https://www.bankofengland.co.uk/boeapps/iadb";
const DEFAULT_SERIES = "XUDLGBD";

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

/**
 * Convert "YYYY-MM-DD" -> "DD/Mon/YYYY" (BoE query format).
 */
export function toBoeDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid ISO date: ${iso}`);
  const [, yyyy, mm, dd] = m;
  const monthEntry = Object.entries(MONTHS).find(([, n]) => n === mm);
  if (!monthEntry) throw new Error(`Invalid month in ${iso}`);
  return `${dd}/${monthEntry[0]}/${yyyy}`;
}

/**
 * Convert "DD Mon YYYY" (BoE CSV row) -> "YYYY-MM-DD".
 */
export function fromBoeDate(boeDate: string): string {
  const m = boeDate.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) throw new Error(`Unrecognised BoE date: ${boeDate}`);
  const [, ddRaw, monRaw, yyyy] = m;
  const mon = monRaw!.slice(0, 1).toUpperCase() + monRaw!.slice(1).toLowerCase();
  const mm = MONTHS[mon];
  if (!mm) throw new Error(`Unrecognised month: ${monRaw}`);
  const dd = ddRaw!.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parse the BoE CSV body. Tolerant of:
 *   - blank trailing lines
 *   - empty rate cells (skipped)
 *   - additional whitespace
 */
export function parseBoeCsv(body: string): BoeParsedRow[] {
  const lines = body.split(/\r?\n/);
  const rows: BoeParsedRow[] = [];
  // First line is the header "DATE,XUDLGBD".
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const [dateRaw, rateRaw] = line.split(",");
    if (!dateRaw || !rateRaw) continue;
    const rate = Number(rateRaw);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rows.push({ date: fromBoeDate(dateRaw), rate });
  }
  return rows;
}

export class BankOfEnglandSource {
  readonly name = "bank-of-england";
  readonly endpointBase = ENDPOINT_BASE;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  urlFor(from: string, to: string, seriesCode: string = DEFAULT_SERIES): string {
    const params = new URLSearchParams({
      "csv.x": "yes",
      Datefrom: toBoeDate(from),
      Dateto: toBoeDate(to),
      SeriesCodes: seriesCode,
      UsingCodes: "Y",
      CSVF: "TN",
      VPD: "Y",
    });
    return `${ENDPOINT_BASE}/fromshowcolumns.asp?${params.toString()}`;
  }

  async fetch(opts: BoeFetchOptions): Promise<string> {
    const f = opts.fetchImpl ?? fetch;
    const url = this.urlFor(opts.from, opts.to, opts.seriesCode);
    const res = await f(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "text/csv,text/plain;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bank of England ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.text();
  }

  /**
   * Map the parsed CSV rows to AuthorityRateInsert.
   *
   * For series XUDLGBD the rate value is GBP per USD - exactly what we
   * store as (source_currency=USD, target_currency=GBP).
   */
  toInserts(
    body: string,
    fetchedAtIso: string,
    opts: { seriesCode?: string; target?: "GBP" | "EUR" | "JPY" } = {},
  ): AuthorityRateInsert[] {
    const target = opts.target ?? "GBP";
    const rows = parseBoeCsv(body);
    return rows.map((r) => ({
      source_currency: "USD",
      target_currency: target,
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
      source_authority: "BOE",
      provenance: "historical-backfill",
    }));
  }
}
