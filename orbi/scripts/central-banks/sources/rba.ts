/**
 * Reserve Bank of Australia (RBA) source — AUD/USD daily reference rate.
 *
 * Why this exists: the Australian Taxation Office (ATO) and Australian
 * Accounting Standards (AASB 121) reference the RBA-published daily
 * exchange rate when converting foreign-currency transactions. Customers
 * in Australia legally need the RBA rate side-by-side with the ORBI
 * VW-median for tax filings.
 *
 * Background — Akamai bot block:
 *   Direct fetches to `https://www.rba.gov.au/statistics/tables/csv/...`
 *   return HTTP 403 from our bb-support cloud IP regardless of headers.
 *   This is RBA's Akamai-fronted IP-class fingerprinting; the same URLs
 *   load fine in a browser and from residential IPs (validated 2026-05-26
 *   in `DEFERRED_SOURCES.md`).
 *
 * Architecture decision (Phase D.3):
 *   We run THIS plug-in's network fetch on jarvis (the maintainer's home server,
 *   residential IP class) via SSH, then stream the raw CSV back over the
 *   pipe. The Supabase write happens from wherever the orchestrator
 *   ultimately runs (which can be jarvis itself, or bb-support reading the
 *   captured CSV from a path) — both reach the OR PROD pooler URL fine
 *   because that endpoint is internet-routed pgbouncer, not Supabase
 *   Management API.
 *
 *   A thin wrapper at `/home/kiwi/bin/run-rba-backfill.sh` packages the
 *   data fetch + upload pipeline so callers don't have to think about it.
 *
 * Endpoints (RBA F11 — Exchange Rates — Daily):
 *   Current data:  https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv
 *   Historical:    https://www.rba.gov.au/statistics/tables/csv/f11hist-1969-2009.csv
 *                  https://www.rba.gov.au/statistics/tables/csv/f11hist-2010-2022.csv
 *
 * CSV format (after RBA's 10-line preamble):
 *   Row 1..10  : Title / Description / Frequency / Type / Units / Series ID / Publication / Source / Mnemonic / blank
 *   Row 11+    : YYYY-MM-DD, <AUD/USD>, <AUD/JPY>, ..., <TWI>
 *
 * The "AUD/USD" column is published as USD per 1 AUD. We invert to land in
 * the canonical USD-base store: source_currency=USD, target_currency=AUD,
 * rate = 1 / (AUD/USD), which is "how many AUD per 1 USD".
 *
 * History: AUD/USD daily from 1969-12-09 (post-decimalisation, pre-float
 * the rate is the official RBA peg; post-1983-12-12 it's the daily 4 pm
 * Sydney fixing).
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

export interface RbaFetchOptions {
  /** Logical dataset: "current" (last ~30 years) or "historical". */
  dataset?: "current" | "historical-1969-2009" | "historical-2010-2022";
  fetchImpl?: typeof fetch;
}

export interface RbaParsedRow {
  date: string;  // YYYY-MM-DD
  audPerUsdInverse: number; // raw "AUD/USD" column value (= USD per 1 AUD)
}

const ENDPOINTS = {
  current:
    "https://www.rba.gov.au/statistics/tables/csv/f11.1-data.csv",
  "historical-1969-2009":
    "https://www.rba.gov.au/statistics/tables/csv/f11hist-1969-2009.csv",
  "historical-2010-2022":
    "https://www.rba.gov.au/statistics/tables/csv/f11hist-2010-2022.csv",
} as const;

export class RbaSource {
  readonly name = "rba";
  readonly userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  urlFor(dataset: keyof typeof ENDPOINTS = "current"): string {
    return ENDPOINTS[dataset];
  }

  async fetch(opts: RbaFetchOptions = {}): Promise<string> {
    const f = opts.fetchImpl ?? fetch;
    const url = this.urlFor(opts.dataset ?? "current");
    const res = await f(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "text/csv,*/*;q=0.8",
        Referer: "https://www.rba.gov.au/statistics/historical-data.html",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `RBA ${res.status}: ${body.slice(0, 200)}. ` +
          "If 403, you are likely running from a cloud IP that Akamai blocks " +
          "— run via /home/kiwi/bin/run-rba-backfill.sh on jarvis instead.",
      );
    }
    return res.text();
  }

  /**
   * Parse the RBA F11 CSV.
   *
   * RBA prefixes the data with ~10 metadata rows (Title, Description,
   * Frequency, Type, Units, Series ID, Publication, Source, Mnemonic,
   * blank). The first row whose first cell matches YYYY-MM-DD or DD-MMM-YYYY
   * is the start of observations.
   *
   * We resolve the AUD/USD column by header (one of the metadata rows is a
   * "Series ID" row whose row before/after labels each column). The first
   * row labelled with "Title" carries the human column names; we look for
   * a column whose label contains "USD" — that's "A$1=US$".
   */
  parseCsv(body: string): RbaParsedRow[] {
    const lines = body.split(/\r?\n/);
    // Find header row labelling columns (the row beginning with "Title").
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
    // Find the column whose title references USD.
    let usdCol = -1;
    for (let c = 1; c < titleRow.length; c++) {
      const t = titleRow[c]!.toUpperCase();
      if (/A\$1=US\$|US DOLLAR|USD/.test(t)) {
        usdCol = c;
        break;
      }
    }
    if (usdCol < 0) throw new Error("RBA CSV missing USD column in title row");

    // Data starts on the first row whose first cell parses as a date.
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

  toInserts(body: string, fetchedAtIso: string): AuthorityRateInsert[] {
    const parsed = this.parseCsv(body);
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
}

export function splitCsv(line: string): string[] {
  // RBA CSV has no embedded commas in the numeric columns; titles are
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
