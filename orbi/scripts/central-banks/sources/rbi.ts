/**
 * Reserve Bank of India (RBI) source — USD/INR daily Reference Rate.
 *
 * Why this exists: Indian customers reporting under Income-Tax Act §43A
 * and Ind AS need the RBI-published daily Reference Rate for converting
 * foreign-currency transactions to INR. This rate is the sovereign-
 * authority signature for INR — Frankfurter (ECB) already provides a
 * USD/INR cross via the ECB euro-reference-rate, but Indian tax/audit
 * filings cite the RBI rate, not the ECB cross.
 *
 * Source: RBI publishes daily Reference Rates (USD, GBP, EUR, JPY) via
 *   https://www.rbi.org.in/Scripts/ReferenceRateArchive.aspx
 * an ASP.NET WebForms archive page. Since 2018-07-10 the underlying rate
 * is computed by Financial Benchmarks India Limited (FBIL) and published
 * on the RBI page with the label "Source: FBIL"; ORBI consumes the RBI
 * surface (sovereign authority) and tags rows as source_authority='RBI'.
 *
 * Transport mechanics:
 *   1. GET the archive page to harvest a session cookie
 *      (ASP.NET_SessionId) plus three form tokens:
 *        __VIEWSTATE, __VIEWSTATEGENERATOR, __EVENTVALIDATION.
 *   2. POST the form with the same cookie + tokens plus checkbox
 *      chkUSD=on and DD/MM/YYYY txtFromDate / txtToDate. Response is
 *      the same archive HTML re-rendered with a results table.
 *   3. Parse the results table: each data row holds `DD/MM/YYYY` and
 *      a USD/INR rate (INR per 1 USD).
 *
 * Server caps each response at ~995 rows. Multi-year ranges therefore
 * chunk by calendar year — see fetchRange below.
 *
 * Coverage: the archive endpoint returns observations from 2022-04-04
 * onward (the FBIL transition + RBI archive re-architecture). Earlier
 * dates return zero rows. The 2021-01-01 → 2022-04-03 gap is documented
 * in DEFERRED_SOURCES.md and the migration header.
 *
 * Authentication / posture: no API key, no permission email, no Akamai
 * fingerprint observed from bb-support during 2026-05-27 validation.
 * The Azure Front Door layer issues a session cookie on the initial
 * GET; the cookie + VIEWSTATE pair survives the subsequent POST.
 *
 * Storage: the published rate is INR per 1 USD which already matches
 * ORBI's USD-base convention (source=USD, target=INR, rate=published —
 * no inversion needed).
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

const ARCHIVE_URL =
  "https://www.rbi.org.in/Scripts/ReferenceRateArchive.aspx";

export interface RbiFetchOptions {
  /** Inclusive ISO-date YYYY-MM-DD. */
  from: string;
  /** Inclusive ISO-date YYYY-MM-DD. */
  to: string;
  fetchImpl?: typeof fetch;
}

export interface RbiParsedRow {
  /** ISO date "YYYY-MM-DD". */
  date: string;
  /** INR per 1 USD. */
  rate: number;
}

/**
 * Convert "YYYY-MM-DD" → "DD/MM/YYYY" (the form's expected input format).
 * Exported for unit testing.
 */
export function isoToDmy(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`isoToDmy: not YYYY-MM-DD: ${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Convert "DD/MM/YYYY" → "YYYY-MM-DD". Returns null for non-matching
 * inputs (callers filter those rows). Exported for unit testing.
 */
export function dmyToIso(dmy: string): string | null {
  const m = dmy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Extract `name="X" value="Y"` from an ASP.NET hidden input. Returns "" if
 * absent. Exported for unit testing.
 */
export function extractHiddenInput(html: string, name: string): string {
  // The ASP.NET render order is `name="X" id="X" value="Y"` OR
  // `id="X" name="X" value="Y"` depending on the control; tolerate both.
  const reA = new RegExp(
    `name="${escapeRegExp(name)}"[^>]*?value="([^"]*)"`,
    "i",
  );
  const reB = new RegExp(
    `value="([^"]*)"[^>]*?name="${escapeRegExp(name)}"`,
    "i",
  );
  return html.match(reA)?.[1] ?? html.match(reB)?.[1] ?? "";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull `(date, rate)` pairs from an RBI archive results HTML response.
 * The results table renders rows as
 *   <td>DD/MM/YYYY</td><td...>NN.NNNN</td>
 * with optional whitespace/newlines and arbitrary attributes on the
 * second td. Exported for unit testing.
 */
export function parseRatesTable(html: string): RbiParsedRow[] {
  const rows: RbiParsedRow[] = [];
  // Loose regex: captures `DD/MM/YYYY</td>` followed by any opening td
  // and a numeric body (decimal with 2+ digits left of point so we
  // don't accidentally capture stray "12 May" style text).
  const re =
    /(\d{2}\/\d{2}\/\d{4})\s*<\/td>\s*<td[^>]*>\s*([0-9]+\.[0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const iso = dmyToIso(m[1]!);
    if (!iso) continue;
    const rate = Number(m[2]!);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    rows.push({ date: iso, rate });
  }
  return rows;
}

export class RbiSource {
  readonly name = "rbi";
  readonly endpointBase = ARCHIVE_URL;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  /**
   * Fetch a single window of rows. The server caps the response at ~995
   * rows, so callers should keep ranges under one calendar year. Use
   * fetchRange below for multi-year backfills.
   */
  async fetch(opts: RbiFetchOptions): Promise<RbiParsedRow[]> {
    const f = opts.fetchImpl ?? fetch;

    // 1) GET — harvest session cookie + ASP.NET form tokens.
    const getRes = await f(ARCHIVE_URL, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
      },
    });
    if (!getRes.ok) {
      throw new Error(
        `RBI GET ${getRes.status}: ${(await getRes.text()).slice(0, 300)}`,
      );
    }
    const setCookieHeaders = collectSetCookie(getRes);
    const cookieHeader = buildCookieHeader(setCookieHeaders);
    const archiveHtml = await getRes.text();

    const viewState = extractHiddenInput(archiveHtml, "__VIEWSTATE");
    const viewStateGen = extractHiddenInput(
      archiveHtml,
      "__VIEWSTATEGENERATOR",
    );
    const eventValidation = extractHiddenInput(
      archiveHtml,
      "__EVENTVALIDATION",
    );
    if (!viewState || !eventValidation) {
      throw new Error(
        "RBI archive GET: __VIEWSTATE / __EVENTVALIDATION missing from response",
      );
    }

    // 2) POST — query for USD over [from, to] (DD/MM/YYYY).
    const body = new URLSearchParams({
      __EVENTTARGET: "btnSubmit",
      __EVENTARGUMENT: "",
      __VIEWSTATE: viewState,
      __VIEWSTATEGENERATOR: viewStateGen,
      __EVENTVALIDATION: eventValidation,
      chkUSD: "on",
      txtFromDate: isoToDmy(opts.from),
      txtToDate: isoToDmy(opts.to),
    });

    const postRes = await f(ARCHIVE_URL, {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9",
        Referer: ARCHIVE_URL,
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
      body: body.toString(),
    });
    if (!postRes.ok) {
      throw new Error(
        `RBI POST ${postRes.status}: ${(await postRes.text()).slice(0, 300)}`,
      );
    }
    const resultsHtml = await postRes.text();
    return parseRatesTable(resultsHtml);
  }

  /** Map parsed rows into AuthorityRateInsert rows tagged source_authority='RBI'. */
  toInserts(
    rows: RbiParsedRow[],
    fetchedAtIso: string,
  ): AuthorityRateInsert[] {
    const out: AuthorityRateInsert[] = [];
    for (const r of rows) {
      if (!Number.isFinite(r.rate) || r.rate <= 0) continue;
      out.push({
        source_currency: "USD",
        target_currency: "INR",
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
        source_authority: "RBI",
        provenance: "historical-backfill",
      });
    }
    return out;
  }

  /**
   * Convenience: fetch + flatten a multi-year window with per-year
   * chunking + dedup-by-date.
   *
   * The RBI archive caps each response at ~995 rows. A multi-year request
   * silently truncates the older end of the window; we chunk by calendar
   * year to keep every response well under that cap. Adjacent chunks
   * never overlap by construction (Jan 1 → Dec 31 per year), but we
   * dedup-by-date as belt + braces in case a future server-side change
   * starts returning boundary rows in two chunks.
   */
  async fetchRange(opts: {
    from: string;
    to: string;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
  }): Promise<RbiParsedRow[]> {
    const log = opts.log ?? (() => {});
    const yearFrom = Number(opts.from.slice(0, 4));
    const yearTo = Number(opts.to.slice(0, 4));
    if (
      !Number.isInteger(yearFrom) ||
      !Number.isInteger(yearTo) ||
      yearFrom > yearTo
    ) {
      throw new Error(`Invalid RBI range: ${opts.from} → ${opts.to}`);
    }
    const byDate = new Map<string, RbiParsedRow>();
    for (let y = yearFrom; y <= yearTo; y++) {
      const chunkFrom = y === yearFrom ? opts.from : `${y}-01-01`;
      const chunkTo = y === yearTo ? opts.to : `${y}-12-31`;
      log(`  [rbi] fetching ${chunkFrom} → ${chunkTo}`);
      const rows = await this.fetch({
        from: chunkFrom,
        to: chunkTo,
        fetchImpl: opts.fetchImpl,
      });
      for (const r of rows) {
        if (r.date >= opts.from && r.date <= opts.to) byDate.set(r.date, r);
      }
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}

// ----------------------------------------------------------------------------
// Cookie helpers
//
// The Fetch API (web spec) exposes Set-Cookie on the response Headers object
// but the read APIs vary by runtime: Bun and Node return a single
// concatenated string from `headers.get("set-cookie")` (which mangles when
// multiple Set-Cookie headers are present), whereas a `getSetCookie()`
// accessor is available on Node 20+. We support both shapes and fall back
// to iterating raw header entries.
// ----------------------------------------------------------------------------
function collectSetCookie(res: Response): string[] {
  // Modern: Node 20.6+, Bun 1.1+ expose getSetCookie() returning string[].
  const headersWithGetter = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof headersWithGetter.getSetCookie === "function") {
    return headersWithGetter.getSetCookie();
  }
  // Fallback: iterate and collect every Set-Cookie entry.
  const out: string[] = [];
  for (const [k, v] of res.headers.entries()) {
    if (k.toLowerCase() === "set-cookie") out.push(v);
  }
  return out;
}

function buildCookieHeader(setCookies: string[]): string {
  const pairs: string[] = [];
  for (const sc of setCookies) {
    // Each Set-Cookie value is `name=value; Path=/; ...`. We only need
    // the leading name=value pair.
    const semi = sc.indexOf(";");
    const nv = semi >= 0 ? sc.slice(0, semi) : sc;
    if (nv.includes("=")) pairs.push(nv.trim());
  }
  return pairs.join("; ");
}
