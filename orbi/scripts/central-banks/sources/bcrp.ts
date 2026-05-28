/**
 * Banco Central de Reserva del Perú (BCRP) source — USD/PEN daily
 * interbank reference rate ("Tipo de Cambio Interbancario - Venta").
 *
 * Transport: BCRPData REST API (free, no auth, no key).
 * Data authority: BCRP (Banco Central de Reserva del Perú), series
 * `PD04638PD` = "Tipo de cambio - TC Interbancario (S/ por US$) - Venta".
 *
 * Why this exists: Peruvian tax (SUNAT) and IFRS reporting in Peru
 * require the BCRP-published daily Sol-per-US-Dollar reference rate for
 * converting foreign-currency transactions. Customers in PE need this
 * rate side-by-side with our ORBI VW-median for compliance.
 *
 * Why the interbank "Venta" series specifically: it is the rate
 * published by BCRP at the close of each business day for interbank
 * USD/PEN spot transactions and is the rate most commonly referenced by
 * SUNAT for FX conversion. The SBS bancario series (PD04640PD) is also
 * available and tracks closely; the interbank rate is the upstream
 * primary.
 *
 * Endpoint (no auth, free public data, JSON):
 *
 *   GET https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04638PD/json/<from>/<to>
 *
 * Response shape (Spanish-month-name dates, decimal values as strings):
 *
 *   {
 *     "config": {
 *       "title":  "Tipo de cambio",
 *       "series": [{ "name": "Tipo de cambio - TC Interbancario (S/ por US$) - Venta", "dec": "3" }]
 *     },
 *     "periods": [
 *       { "name": "04.Ene.21", "values": ["3.62666666666667"] },
 *       { "name": "05.Ene.21", "values": ["3.63366666666667"] },
 *       ...
 *     ]
 *   }
 *
 * Coverage: 1990s onward for the SBS bancario series; the interbank
 * series PD04638PD has full daily coverage from at least 2003 onward
 * (the BCRP API accepts any start date; missing days simply don't
 * appear). ORBI consumes 2021-01-01 → present on first backfill.
 *
 * Storage: published value is PEN per 1 USD, which already matches
 * ORBI's USD-base convention (source=USD, target=PEN, no inversion).
 *
 * Silent-posture: BCRPData is open public data; the endpoint requires
 * no registration, no key, no anti-bot challenge from cloud IPs. The
 * primary www.bcrp.gob.pe site IS behind Incapsula, but the
 * estadisticas subdomain (where the API + ToS live) is not.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

/** BCRP series code for USD/PEN interbank reference rate, "Venta" side. */
export const BCRP_SERIES_INTERBANK_VENTA = "PD04638PD";

const ENDPOINT_BASE =
  "https://estadisticas.bcrp.gob.pe/estadisticas/series/api";

/**
 * Spanish month-name abbreviations as published in BCRP API `periods[].name`.
 * BCRP uses 3-letter Spanish abbreviations with a period suffix in the API
 * (e.g. "Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Set", "Oct",
 * "Nov", "Dic"). "Set" (not "Sep") is the standard BCRP abbreviation for
 * September; we accept both for defensive parsing.
 */
const SPANISH_MONTH_ABBREV: Record<string, number> = {
  Ene: 1, Feb: 2, Mar: 3, Abr: 4, May: 5, Jun: 6,
  Jul: 7, Ago: 8, Set: 9, Sep: 9, Oct: 10, Nov: 11, Dic: 12,
};

export interface BcrpFetchOptions {
  /** ISO date "YYYY-MM-DD" — inclusive lower bound. */
  from: string;
  /** ISO date "YYYY-MM-DD" — inclusive upper bound. */
  to: string;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
  /** Override series code (defaults to PD04638PD). */
  seriesCode?: string;
}

export interface BcrpRawPeriod {
  name?: string;
  values?: string[];
}

export interface BcrpRawResponse {
  config?: {
    title?: string;
    series?: Array<{ name?: string; dec?: string }>;
  };
  periods?: BcrpRawPeriod[];
}

export interface BcrpParsedRow {
  /** YYYY-MM-DD. */
  date: string;
  /** PEN per 1 USD. */
  value: number;
}

export class BcrpSource {
  readonly name = "bcrp";
  readonly endpointBase = ENDPOINT_BASE;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  /**
   * Build the BCRPData API URL for a series + date range.
   *
   * BCRP accepts arbitrary [from, to] windows; the response is naturally
   * filtered, so we don't need year-by-year fan-out like BCCH.
   */
  urlFor(seriesCode: string, from: string, to: string): string {
    if (!/^[A-Z0-9]{6,16}$/.test(seriesCode)) {
      throw new Error(`Invalid BCRP series code: ${seriesCode}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new Error(`BCRP dates must be YYYY-MM-DD; got: ${from} → ${to}`);
    }
    if (from > to) {
      throw new Error(`Invalid BCRP range: ${from} → ${to}`);
    }
    return `${ENDPOINT_BASE}/${seriesCode}/json/${from}/${to}`;
  }

  async fetch(opts: BcrpFetchOptions): Promise<BcrpRawResponse> {
    const f = opts.fetchImpl ?? fetch;
    const series = opts.seriesCode ?? BCRP_SERIES_INTERBANK_VENTA;
    const url = this.urlFor(series, opts.from, opts.to);
    const res = await f(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`BCRP ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as BcrpRawResponse;
  }

  /**
   * Parse a BCRPData JSON response into [{date, value}, ...] ascending
   * by date. Drops malformed / zero / negative observations silently.
   *
   * BCRP returns period names like "04.Ene.21" — day.MonthAbbrev.YY.
   * The two-digit year is unambiguous for our use case (post-2000 only;
   * we treat YY < 50 as 20YY and YY >= 50 as 19YY, but in practice the
   * orchestrator's [from, to] window keeps us in 21st-century territory).
   */
  parse(raw: BcrpRawResponse): BcrpParsedRow[] {
    const periods = raw.periods ?? [];
    const rows: BcrpParsedRow[] = [];
    for (const p of periods) {
      if (!p.name || !Array.isArray(p.values) || p.values.length === 0) continue;
      const date = parseSpanishDayMonthYear(p.name);
      if (!date) continue;
      const valRaw = p.values[0];
      if (typeof valRaw !== "string") continue;
      const value = Number(valRaw);
      if (!Number.isFinite(value) || value <= 0) continue;
      rows.push({ date, value });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
  }

  /**
   * Map raw response → AuthorityRateInsert rows. Filters to [from, to]
   * defensively (BCRP already filters server-side, but the orchestrator
   * relies on the contract).
   */
  toInserts(
    raw: BcrpRawResponse,
    fetchedAtIso: string,
    bounds?: { from?: string; to?: string },
  ): AuthorityRateInsert[] {
    return this.parsedToInserts(this.parse(raw), fetchedAtIso, bounds);
  }

  /**
   * Map already-parsed rows → AuthorityRateInsert. Same field defaults
   * as `toInserts`, but skips the raw-parse step so the orchestrator can
   * consume the deduped output of `fetchRange` directly without paying
   * for a re-decode of Spanish-month period names.
   */
  parsedToInserts(
    parsed: ReadonlyArray<BcrpParsedRow>,
    fetchedAtIso: string,
    bounds?: { from?: string; to?: string },
  ): AuthorityRateInsert[] {
    const from = bounds?.from;
    const to = bounds?.to;
    const out: AuthorityRateInsert[] = [];
    for (const r of parsed) {
      if (from && r.date < from) continue;
      if (to && r.date > to) continue;
      if (!Number.isFinite(r.value) || r.value <= 0) continue;
      out.push({
        source_currency: "USD",
        target_currency: "PEN",
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
        source_authority: "BCRP",
        provenance: "historical-backfill",
      });
    }
    return out;
  }

  /**
   * Convenience: fetch + dedup over an arbitrary [from, to] window.
   *
   * BCRP accepts wide ranges in a single call; this method wraps the
   * single fetch + dedup-by-date to match the BCCH/BSP plug-in shape so
   * the orchestrator's batch UPSERT never sees same-batch dupes.
   */
  async fetchRange(opts: {
    from: string;
    to: string;
    fetchImpl?: typeof fetch;
    seriesCode?: string;
    log?: (msg: string) => void;
  }): Promise<BcrpParsedRow[]> {
    const log = opts.log ?? (() => {});
    log(`  [bcrp] fetching ${opts.from} → ${opts.to} from BCRPData`);
    const raw = await this.fetch({
      from: opts.from,
      to: opts.to,
      fetchImpl: opts.fetchImpl,
      seriesCode: opts.seriesCode,
    });
    const parsed = this.parse(raw);
    // Dedup by date — BCRP responses are normally unique per day, but the
    // orchestrator's batch UPSERT requires a single insert per
    // (source_authority, bucket_ts), so we belt-and-braces.
    const byDate = new Map<string, BcrpParsedRow>();
    for (const r of parsed) {
      if (r.date >= opts.from && r.date <= opts.to) byDate.set(r.date, r);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}

// ----------------------------------------------------------------------------
// Spanish date parser
// ----------------------------------------------------------------------------

/**
 * Parse a BCRP period name like "04.Ene.21" → "2021-01-04".
 *
 * Returns null for any malformed or impossible date so the caller can
 * filter rather than throw mid-stream.
 *
 * Exported for unit testing.
 */
export function parseSpanishDayMonthYear(name: string): string | null {
  const trimmed = name.trim();
  // Accept either "DD.MMM.YY" (daily) or "DD.MMM.YYYY" (defensive).
  const m = trimmed.match(/^(\d{1,2})\.([A-Za-zÁÉÍÓÚáéíóú]{3,4})\.(\d{2}|\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]!);
  const monthAbbrev = capitalize(m[2]!).slice(0, 3);
  const yearRaw = m[3]!;
  const month = SPANISH_MONTH_ABBREV[monthAbbrev];
  if (!month) return null;
  let year: number;
  if (yearRaw.length === 2) {
    const yy = Number(yearRaw);
    // BCRP daily series we ingest is post-2000; window the YY:
    //   00..49 → 2000..2049
    //   50..99 → 1950..1999
    year = yy < 50 ? 2000 + yy : 1900 + yy;
  } else {
    year = Number(yearRaw);
  }
  return isoDateOrNull(year, month, day);
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1).toLowerCase();
}

/** ISO date if (year, month, day) is a real calendar date, else null. */
export function isoDateOrNull(
  year: number,
  month: number,
  day: number,
): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}
