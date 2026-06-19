/**
 * Reserve Bank of Australia (RBA) source — AUD/USD reference rate.
 *
 * Why this exists: the Australian Taxation Office (ATO) and Australian
 * Accounting Standards (AASB 121) reference the RBA-published exchange
 * rate when converting foreign-currency transactions. Customers in
 * Australia legally need the RBA rate side-by-side with the ORBI
 * VW-median for tax filings.
 *
 * Background — Akamai bot block:
 *   RBA's web tier is fronted by Akamai. Empirically (2026-05-27) Akamai
 *   403s requests carrying a Mozilla UA + Referer from non-Australian
 *   residential ranges, but accepts the default fetch UA with no Referer.
 *   We therefore keep headers minimal. Even with minimal headers,
 *   datacenter IP ranges (bb-support cloud, jarvis classified as
 *   datacenter) can be rejected — in that case, run via
 *   /home/kiwi/bin/run-rba-backfill.sh on jarvis (residential class).
 *
 * Endpoints (RBA F11 — Exchange Rates):
 *   Daily current (~2023+):
 *     https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv
 *   Monthly historical 1969-07 → 2009-12:
 *     https://www.rba.gov.au/statistics/tables/xls-hist/f11hist-1969-2009.xls
 *   Monthly historical 2010-01 → present (overlaps with the daily CSV):
 *     https://www.rba.gov.au/statistics/tables/xls-hist/f11hist.xls
 *
 * Note on coverage: RBA publishes daily AUD/USD only from ~2023 in the
 * current CSV (post Westpac discontinuation of legacy fix); pre-2023
 * history is monthly (end-of-month observations) in the two XLS files.
 * Combined: ~680 monthly rows (1969-07 → 2026) plus ~850 daily rows
 * (2023-current). The earlier "~14,000 daily back to 1969" target is
 * not achievable from RBA's published F11 series — those daily values
 * are not in the public dataset (RBA only retained monthlies pre-2023).
 *
 * CSV format (after RBA's ~10-line preamble):
 *   Row 1..10  : Title / Description / Frequency / Type / Units / Series ID / Publication / Source / Mnemonic / blank
 *   Row 11+    : YYYY-MM-DD or DD-MMM-YYYY, <AUD/USD>, ...
 *
 * XLS layout (BIFF8, sheet "Data"):
 *   Row 0  : "F11 EXCHANGE RATES"
 *   Row 1  : Title row — "Title", "A$1=USD", ...   (USD column varies by file)
 *   Row 2  : Description
 *   Row 3  : Frequency = "Monthly"
 *   Row 4  : Type
 *   Row 5  : Units
 *   Row 6-7: blank
 *   Row 8  : Source
 *   Row 9  : Publication date
 *   Row 10 : Series ID = "FXRUSD" for the USD column
 *   Row 11+: <Excel serial date>, <AUD/USD>, ...
 *
 * The "AUD/USD" column is published as USD per 1 AUD. We invert to land
 * in the canonical USD-base store: source_currency=USD, target_currency=AUD,
 * rate = 1 / (AUD/USD), i.e. "how many AUD per 1 USD".
 *
 * History: AUD/USD monthly from 1969-07-31 (post-decimalisation, pre-float
 * the rate was the official RBA peg; post-1983-12-12 it's the market rate).
 */

import * as XLSX from "xlsx";
import type { AuthorityRateInsert } from "../lib/batch-writer";

export type RbaDataset =
  | "current"
  | "historical-1969-2009"
  | "historical-recent";

export interface RbaFetchOptions {
  /** Logical dataset to fetch (default "current"). */
  dataset?: RbaDataset;
  fetchImpl?: typeof fetch;
}

export interface RbaParsedRow {
  date: string;  // YYYY-MM-DD
  audPerUsdInverse: number; // raw "AUD/USD" column value (= USD per 1 AUD)
}

const ENDPOINTS: Record<RbaDataset, string> = {
  current:
    "https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv",
  "historical-1969-2009":
    "https://www.rba.gov.au/statistics/tables/xls-hist/f11hist-1969-2009.xls",
  "historical-recent":
    "https://www.rba.gov.au/statistics/tables/xls-hist/f11hist.xls",
};

/** XLS datasets need binary fetch; CSV is text. */
const XLS_DATASETS: ReadonlySet<RbaDataset> = new Set<RbaDataset>([
  "historical-1969-2009",
  "historical-recent",
]);

export class RbaSource {
  readonly name = "rba";

  urlFor(dataset: RbaDataset = "current"): string {
    return ENDPOINTS[dataset];
  }

  isXls(dataset: RbaDataset): boolean {
    return XLS_DATASETS.has(dataset);
  }

  /** Build the minimal-header request init used for all RBA endpoints. */
  private requestInit(dataset: RbaDataset): RequestInit {
    // NOTE: empirically (2026-05-27) Akamai 403s requests carrying a Mozilla
    // UA + Referer from non-Australian residential ranges, but accepts the
    // default fetch UA with no Referer. Keep this minimal.
    return {
      headers: {
        Accept: this.isXls(dataset)
          ? "application/vnd.ms-excel,application/octet-stream,*/*;q=0.8"
          : "text/csv,*/*;q=0.8",
      },
    };
  }

  /** Fetch the CSV body for the "current" daily dataset. */
  async fetch(opts: RbaFetchOptions = {}): Promise<string> {
    const f = opts.fetchImpl ?? fetch;
    const dataset = opts.dataset ?? "current";
    if (this.isXls(dataset)) {
      throw new Error(
        `RbaSource.fetch() is for CSV datasets only; use fetchXls() for "${dataset}".`,
      );
    }
    const res = await f(this.urlFor(dataset), this.requestInit(dataset));
    if (!res.ok) {
      const body = await res.text();
      throw new Error(this.errorMessage(res.status, body));
    }
    return res.text();
  }

  /** Fetch the binary XLS body for one of the historical datasets. */
  async fetchXls(opts: RbaFetchOptions = {}): Promise<ArrayBuffer> {
    const f = opts.fetchImpl ?? fetch;
    const dataset = opts.dataset ?? "historical-recent";
    if (!this.isXls(dataset)) {
      throw new Error(
        `RbaSource.fetchXls() is for XLS datasets only; use fetch() for "${dataset}".`,
      );
    }
    const res = await f(this.urlFor(dataset), this.requestInit(dataset));
    if (!res.ok) {
      const body = await res.text();
      throw new Error(this.errorMessage(res.status, body));
    }
    return res.arrayBuffer();
  }

  private errorMessage(status: number, body: string): string {
    return (
      `RBA ${status}: ${body.slice(0, 200)}. ` +
      "If 403 or HTML challenge body, you are likely running from a cloud/datacenter IP " +
      "that Akamai blocks — run via /home/kiwi/bin/run-rba-backfill.sh on jarvis instead."
    );
  }

  /**
   * Parse the RBA F11 CSV.
   *
   * RBA prefixes the data with ~10 metadata rows (Title, Description,
   * Frequency, Type, Units, Series ID, Publication, Source, Mnemonic,
   * blank). The first row whose first cell matches YYYY-MM-DD or
   * DD-MMM-YYYY is the start of observations.
   *
   * We resolve the AUD/USD column by header (the "Title" row labels each
   * column). The match accepts "A$1=US$" / "A$1=USD" / "US Dollar" / "USD".
   */
  parseCsv(body: string): RbaParsedRow[] {
    const lines = body.split(/\r?\n/);
    let titleIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
      const cells = splitCsv(lines[i]!);
      if (cells[0]?.toLowerCase() === "title") {
        titleIdx = i;
        break;
      }
    }
    if (titleIdx < 0) throw new Error("RBA CSV missing 'Title' header row");
    const titleRow = splitCsv(lines[titleIdx]!);
    let usdCol = -1;
    for (let c = 1; c < titleRow.length; c++) {
      const t = titleRow[c]!.toUpperCase();
      if (/A\$1=US\$|A\$1=USD|US DOLLAR|\bUSD\b/.test(t)) {
        usdCol = c;
        break;
      }
    }
    if (usdCol < 0) throw new Error("RBA CSV missing USD column in title row");

    const rows: RbaParsedRow[] = [];
    for (let i = titleIdx + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      const cells = splitCsv(line);
      const iso = normaliseDate(cells[0] ?? "");
      if (!iso) continue;
      const raw = cells[usdCol];
      if (!raw || raw === "n.a." || raw === "na") continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v <= 0) continue;
      rows.push({ date: iso, audPerUsdInverse: v });
    }
    return rows;
  }

  /**
   * Parse a BIFF8 .xls file (RBA F11 historical layout).
   *
   * Accepts ArrayBuffer / Uint8Array / Buffer. Reads the "Data" sheet,
   * resolves the USD column from the "Title" header row, and yields one
   * RbaParsedRow per data row. Excel serial dates are converted to ISO.
   */
  parseXls(buf: ArrayBuffer | Uint8Array | Buffer): RbaParsedRow[] {
    const wb = XLSX.read(buf, { type: "array" });
    const sheetName = wb.SheetNames.find((n) => n.trim() === "Data") ?? wb.SheetNames[0];
    if (!sheetName) throw new Error("RBA XLS missing 'Data' sheet");
    const ws = wb.Sheets[sheetName]!;
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
    });

    // Locate the title row (first cell === "Title", within first ~15 rows).
    let titleIdx = -1;
    for (let i = 0; i < Math.min(grid.length, 15); i++) {
      const r = grid[i];
      if (Array.isArray(r) && typeof r[0] === "string" && r[0].toLowerCase() === "title") {
        titleIdx = i;
        break;
      }
    }
    if (titleIdx < 0) throw new Error("RBA XLS missing 'Title' header row");

    const titleRow = grid[titleIdx] as unknown[];
    let usdCol = -1;
    for (let c = 1; c < titleRow.length; c++) {
      const t = String(titleRow[c] ?? "").toUpperCase();
      if (/A\$1=US\$|A\$1=USD|US DOLLAR|\bUSD\b/.test(t)) {
        usdCol = c;
        break;
      }
    }
    if (usdCol < 0) throw new Error("RBA XLS missing USD column in title row");

    // Cross-check via Series ID row if present (rows after Title up to ~12).
    // FXRUSD is the canonical RBA series ID for AUD/USD.
    for (let i = titleIdx + 1; i < Math.min(grid.length, titleIdx + 12); i++) {
      const r = grid[i];
      if (Array.isArray(r) && typeof r[0] === "string" && r[0].toLowerCase() === "series id") {
        const id = String(r[usdCol] ?? "").toUpperCase();
        if (id && id !== "FXRUSD") {
          // Header text said "USD" but the series ID column isn't FXRUSD —
          // re-scan by series ID instead.
          for (let c = 1; c < r.length; c++) {
            if (String(r[c] ?? "").toUpperCase() === "FXRUSD") {
              usdCol = c;
              break;
            }
          }
        }
        break;
      }
    }

    const rows: RbaParsedRow[] = [];
    for (let i = titleIdx + 1; i < grid.length; i++) {
      const r = grid[i];
      if (!Array.isArray(r)) continue;
      const dateCell = r[0];
      const iso = excelDateToIso(dateCell);
      if (!iso) continue;
      const v = r[usdCol];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
      rows.push({ date: iso, audPerUsdInverse: v });
    }
    return rows;
  }

  /**
   * Fetch + parse all three datasets and return combined inserts,
   * deduplicated by date. CSV (daily) takes precedence over XLS (monthly)
   * on overlap — the CSV value is the authoritative daily fix.
   *
   * Order of fetch: current CSV first (cheapest, most-likely-to-succeed),
   * then the two historical XLS files. Each is wrapped so a single
   * failing dataset doesn't kill the run; the caller sees a warning in
   * the log instead.
   */
  async fetchAll(opts: { fetchImpl?: typeof fetch; log?: (m: string) => void } = {}): Promise<{
    rows: RbaParsedRow[];
    perDataset: Record<RbaDataset, { rows: number; error?: string }>;
  }> {
    const log = opts.log ?? (() => {});
    const perDataset: Record<RbaDataset, { rows: number; error?: string }> = {
      current: { rows: 0 },
      "historical-1969-2009": { rows: 0 },
      "historical-recent": { rows: 0 },
    };
    // Map date -> row, with later writes only winning if from CSV (current).
    const byDate = new Map<string, { row: RbaParsedRow; fromCsv: boolean }>();

    // 1. Historical 1969-2009 (XLS, monthly)
    try {
      const buf = await this.fetchXls({ dataset: "historical-1969-2009", fetchImpl: opts.fetchImpl });
      const parsed = this.parseXls(buf);
      perDataset["historical-1969-2009"].rows = parsed.length;
      for (const r of parsed) byDate.set(r.date, { row: r, fromCsv: false });
      log(`  [rba] historical-1969-2009: ${parsed.length} monthly rows`);
    } catch (err) {
      perDataset["historical-1969-2009"].error = (err as Error).message;
      log(`  [rba] historical-1969-2009 FAILED: ${(err as Error).message.slice(0, 160)}`);
    }

    // 2. Historical recent 2010-current (XLS, monthly)
    try {
      const buf = await this.fetchXls({ dataset: "historical-recent", fetchImpl: opts.fetchImpl });
      const parsed = this.parseXls(buf);
      perDataset["historical-recent"].rows = parsed.length;
      for (const r of parsed) {
        const existing = byDate.get(r.date);
        if (!existing || !existing.fromCsv) byDate.set(r.date, { row: r, fromCsv: false });
      }
      log(`  [rba] historical-recent: ${parsed.length} monthly rows`);
    } catch (err) {
      perDataset["historical-recent"].error = (err as Error).message;
      log(`  [rba] historical-recent FAILED: ${(err as Error).message.slice(0, 160)}`);
    }

    // 3. Current daily CSV (overrides any monthly value on the same date).
    try {
      const body = await this.fetch({ dataset: "current", fetchImpl: opts.fetchImpl });
      const parsed = this.parseCsv(body);
      perDataset.current.rows = parsed.length;
      for (const r of parsed) byDate.set(r.date, { row: r, fromCsv: true });
      log(`  [rba] current: ${parsed.length} daily rows`);
    } catch (err) {
      perDataset.current.error = (err as Error).message;
      log(`  [rba] current FAILED: ${(err as Error).message.slice(0, 160)}`);
    }

    const rows = Array.from(byDate.values())
      .map((x) => x.row)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { rows, perDataset };
  }

  /**
   * Convert RBA-format parsed rows (USD per 1 AUD) into AuthorityRateInsert
   * rows with the canonical USD-base direction.
   */
  toInsertsFromRows(parsed: ReadonlyArray<RbaParsedRow>, fetchedAtIso: string): AuthorityRateInsert[] {
    const out: AuthorityRateInsert[] = [];
    for (const r of parsed) {
      // RBA publishes "A$1 = US$x" — i.e. USD per 1 AUD. We store the
      // canonical USD-base direction: target=AUD, rate = 1 / x = AUD per 1 USD.
      const rate = 1 / r.audPerUsdInverse;
      if (!Number.isFinite(rate) || rate <= 0) continue;
      out.push({
        source_currency: "USD",
        target_currency: "AUD",
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
        source_authority: "RBA",
        provenance: "historical-backfill",
      });
    }
    return out;
  }

  /** Back-compat helper: CSV body -> inserts (kept for existing tests). */
  toInserts(body: string, fetchedAtIso: string): AuthorityRateInsert[] {
    return this.toInsertsFromRows(this.parseCsv(body), fetchedAtIso);
  }
}

export function splitCsv(line: string): string[] {
  // RBA CSV has no embedded commas in numeric columns; titles are
  // quote-wrapped but our parsing only needs the first cell and the USD
  // column header text. A naive split works.
  return line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
}

/** Accept "YYYY-MM-DD" or "DD-MMM-YYYY" (RBA historical) and return ISO. */
export function normaliseDate(s: string): string | null {
  const trimmed = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const [, dd, mon, yyyy] = m;
  const monKey = mon!.slice(0, 1).toUpperCase() + mon!.slice(1).toLowerCase();
  const mm = months[monKey];
  if (!mm) return null;
  return `${yyyy}-${mm}-${dd!.padStart(2, "0")}`;
}

/**
 * Convert an Excel cell (serial number or string) to ISO YYYY-MM-DD.
 * Excel epoch: 1899-12-30 (the off-by-one accounts for Lotus 1-2-3's
 * fictional 1900-02-29). Returns null for non-date cells.
 */
export function excelDateToIso(cell: unknown): string | null {
  if (typeof cell === "number" && Number.isFinite(cell) && cell > 1000) {
    const ms = Date.UTC(1899, 11, 30) + cell * 86400000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  if (typeof cell === "string") return normaliseDate(cell);
  if (cell instanceof Date) {
    return cell.toISOString().slice(0, 10);
  }
  return null;
}
