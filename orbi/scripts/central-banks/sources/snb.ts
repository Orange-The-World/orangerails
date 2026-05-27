/**
 * Swiss National Bank (SNB) source — CHF reference rates, daily.
 *
 * Why this exists: Swiss tax authorities (ESTV / FTA) and customers
 * reporting under Swiss GAAP / IFRS-in-Switzerland reference SNB-published
 * exchange rates. The SNB publishes a daily reference cube but does NOT
 * expose it as a clean JSON/CSV endpoint — only the SPA at
 * https://data.snb.ch/en/topics/ziredev/cube/devkua and the underlying
 * cube codes deliver clean machine-readable rows for daily data.
 *
 * Validated 2026-05-26 (see DEFERRED_SOURCES.md):
 *   - `devkum` cube returns MONTHLY rates (we DO use it for back-history).
 *   - `devkua` cube returns ANNUAL averages.
 *   - There IS a daily cube but the listing endpoint is SPA-fronted; the
 *     working approach is Playwright on bb-support (already installed for
 *     E2E tests) to render the page and extract the visible table.
 *
 * Endpoint strategy (in priority order):
 *   1. Try the well-known SNB SDMX-style CSV endpoint for the daily cube:
 *        https://data.snb.ch/api/cube/devkud/data/csv/en
 *      As of 2026-05-26 this returns 404, but SNB rotates cube names; the
 *      plug-in attempts it first because it's free and structured.
 *   2. Fallback to Playwright on bb-support, navigating to
 *        https://data.snb.ch/en/topics/ziredev/cube/devkua
 *      and extracting the daily-rates table that the SPA renders client-side.
 *
 * The Playwright path is invoked separately by the runner (it requires a
 * browser context); this module exposes the parser so unit tests can verify
 * row mapping against captured HTML/CSV fixtures.
 *
 * Pairs we ship: USD/CHF, EUR/CHF, GBP/CHF, JPY/CHF. SNB publishes them all
 * as <foreign> per 1 CHF; we INVERT to land in the canonical USD-base /
 * EUR-base / GBP-base / JPY-base direction with CHF as target_currency.
 *
 * Range: SNB daily series back to 1980-01-04.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

export type SnbPair = "USD/CHF" | "EUR/CHF" | "GBP/CHF" | "JPY/CHF";

export interface SnbParsedRow {
  date: string;                   // YYYY-MM-DD
  pair: SnbPair;
  /** Foreign per 1 CHF (SNB's native publication direction). */
  foreignPerChf: number;
}

export interface SnbFetchOptions {
  fetchImpl?: typeof fetch;
}

const CSV_DAILY_CANDIDATES = [
  "https://data.snb.ch/api/cube/devkud/data/csv/en",
  "https://data.snb.ch/api/cube/devkutag/data/csv/en",
];

export class SnbSource {
  readonly name = "snb";
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  /**
   * Try the SDMX CSV endpoints first. Returns the body of the first
   * successful response; throws if all candidates fail (caller should then
   * fall back to the Playwright path).
   */
  async fetchCsv(opts: SnbFetchOptions = {}): Promise<string> {
    const f = opts.fetchImpl ?? fetch;
    let lastErr = "";
    for (const url of CSV_DAILY_CANDIDATES) {
      try {
        const res = await f(url, {
          headers: {
            "User-Agent": this.userAgent,
            Accept: "text/csv,application/csv;q=0.9,*/*;q=0.8",
          },
        });
        if (res.ok) return await res.text();
        lastErr = `${url} -> ${res.status}`;
      } catch (err) {
        lastErr = `${url} -> ${(err as Error).message}`;
      }
    }
    throw new Error(
      `SNB CSV candidates exhausted: ${lastErr}. ` +
        "Fall back to Playwright path against data.snb.ch (see scripts/central-banks/playwright/snb-scrape.ts).",
    );
  }

  /**
   * Parse the SNB SDMX CSV. SNB's cube CSV layout (when the endpoint exists):
   *
   *   Date,D0,D1,Value
   *   1980-01-04,USD1,2.5400
   *   1980-01-04,EUR1,...
   *   ...
   *
   * Where D0/D1 encode the currency. We resolve the currency column by
   * matching common SNB tags: "USD1", "EUR1", "GBP1", "JPY100". JPY is
   * always per-100 in SNB tables (since the absolute value is small).
   */
  parseCsv(body: string): SnbParsedRow[] {
    const lines = body.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const header = splitCsv(lines[0]!);
    const idxDate = header.findIndex((h) => /date|period|time/i.test(h));
    const idxValue = header.findIndex((h) => /value/i.test(h));
    // SNB encodes the currency identifier in one of the "Dn" columns.
    const dnIdxs = header
      .map((h, i) => ({ h, i }))
      .filter((x) => /^D\d+$/i.test(x.h))
      .map((x) => x.i);
    if (idxDate < 0 || idxValue < 0 || dnIdxs.length === 0) {
      throw new Error(
        `SNB CSV: unexpected header layout: ${header.join(",")}`,
      );
    }
    const rows: SnbParsedRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = splitCsv(lines[i]!);
      const date = cells[idxDate];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const dimTags = dnIdxs.map((j) => cells[j] ?? "").join("/");
      const pairInfo = matchSnbPair(dimTags);
      if (!pairInfo) continue;
      const valueRaw = cells[idxValue];
      if (!valueRaw) continue;
      const v = Number(valueRaw);
      if (!Number.isFinite(v) || v <= 0) continue;
      const foreignPerChf = pairInfo.per100 ? v / 100 : v;
      rows.push({ date, pair: pairInfo.pair, foreignPerChf });
    }
    return rows;
  }

  /**
   * Parse the Playwright-extracted table (caller passes the
   * { headers, rows } tuple after evaluating the page).
   */
  parseTable(headers: string[], dataRows: string[][]): SnbParsedRow[] {
    const idxDate = headers.findIndex((h) => /date|datum/i.test(h));
    if (idxDate < 0) throw new Error("SNB table: missing date column");
    const colMap: Array<{ idx: number; pair: SnbPair; per100: boolean }> = [];
    for (let i = 0; i < headers.length; i++) {
      const pi = matchSnbPair(headers[i]!);
      if (pi) colMap.push({ idx: i, pair: pi.pair, per100: pi.per100 });
    }
    const rows: SnbParsedRow[] = [];
    for (const row of dataRows) {
      const dateRaw = row[idxDate] ?? "";
      const date = normaliseDate(dateRaw);
      if (!date) continue;
      for (const c of colMap) {
        const raw = (row[c.idx] ?? "").replace(/[,\s]/g, "");
        if (!raw) continue;
        const v = Number(raw);
        if (!Number.isFinite(v) || v <= 0) continue;
        const foreignPerChf = c.per100 ? v / 100 : v;
        rows.push({ date, pair: c.pair, foreignPerChf });
      }
    }
    return rows;
  }

  toInserts(parsed: SnbParsedRow[], fetchedAtIso: string): AuthorityRateInsert[] {
    const out: AuthorityRateInsert[] = [];
    for (const r of parsed) {
      // SNB publishes "USD per 1 CHF" (or JPY per 100 CHF, normalised above).
      // We store the canonical direction source=<foreign>, target=CHF, with
      // rate = CHF per 1 <foreign> = 1 / foreignPerChf.
      const rate = 1 / r.foreignPerChf;
      if (!Number.isFinite(rate) || rate <= 0) continue;
      const [src] = r.pair.split("/") as [string, string];
      out.push({
        source_currency: src,
        target_currency: "CHF",
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
        source_authority: "SNB",
        provenance: "historical-backfill",
      });
    }
    return out;
  }
}

/**
 * Map a string like "USD1" / "JPY100" / "EUR1" / "A$1=US$" to the canonical
 * pair label used in our store, and whether the published value is
 * per-100-units (true for JPY).
 */
export function matchSnbPair(
  s: string,
): { pair: SnbPair; per100: boolean } | null {
  const u = s.toUpperCase();
  if (/(^|[^A-Z])USD([^A-Z0-9]|1\b|$)/.test(u)) return { pair: "USD/CHF", per100: false };
  if (/(^|[^A-Z])EUR([^A-Z0-9]|1\b|$)/.test(u)) return { pair: "EUR/CHF", per100: false };
  if (/(^|[^A-Z])GBP([^A-Z0-9]|1\b|$)/.test(u)) return { pair: "GBP/CHF", per100: false };
  if (/(^|[^A-Z])JPY/.test(u)) return { pair: "JPY/CHF", per100: true };
  return null;
}

export function splitCsv(line: string): string[] {
  // SNB CSV exports use ";" as the delimiter (SDMX convention); other
  // central-bank feeds use ",". Pick whichever yields more columns on this
  // line — both delimiters never coexist in a single SNB row.
  const semi = line.split(";");
  const comma = line.split(",");
  const cols = semi.length >= comma.length ? semi : comma;
  return cols.map((c) => c.trim().replace(/^"|"$/g, ""));
}

export function normaliseDate(s: string): string | null {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
  }
  return null;
}
