/**
 * Banxico (Banco de México) source — USD/MXN FIX daily reference rate.
 *
 * Why this exists: Mexican tax law (SAT) and IFRS use in Mexico require the
 * FIX rate published by Banxico for converting foreign-currency transactions.
 * Customers in Mexico cannot lawfully use a market rate (like ORBI's
 * VW-median) for tax reporting — they must use the Banxico-published number.
 *
 * Endpoint:
 *   GET https://www.banxico.org.mx/SieAPIRest/service/v1/series/SF43718/datos/{from}/{to}
 *
 * Series SF43718 = "Tipo de cambio Pesos por dólar E.U.A., Tipo de cambio
 * para solventar obligaciones denominadas en moneda extranjera pagaderas en
 * la República Mexicana (FIX)". This is the legally-binding daily reference.
 *
 * Auth:   HTTP header `Bmx-Token: <token>`. Free to register at
 *         https://www.banxico.org.mx/SieAPIRest/service/v1/token
 *
 * Date range: full history back to ~1993-01-04 (first FIX publication).
 *
 * Rate limiting: Banxico's documented limit is 100 requests per 5 minutes
 * per token. We self-cap at ~0.3 rps for safety. Each request returns
 * up to many years of daily data, so one or two calls cover the entire
 * historical range.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

export interface BanxicoFetchOptions {
  /** Inclusive start date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date (YYYY-MM-DD). */
  to: string;
  /** Bmx-Token header. Required. */
  token: string;
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

export interface BanxicoRawObservation {
  fecha: string; // "DD/MM/YYYY"
  dato: string;  // numeric string, or "N/E" when no observation (holiday)
}

export interface BanxicoRawResponse {
  bmx?: {
    series?: Array<{
      idSerie?: string;
      titulo?: string;
      datos?: BanxicoRawObservation[];
    }>;
  };
}

const SERIES_ID = "SF43718";
const ENDPOINT_BASE = "https://www.banxico.org.mx/SieAPIRest/service/v1/series";

export class BanxicoSource {
  readonly name = "banxico";
  readonly endpointBase = ENDPOINT_BASE;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  urlFor(from: string, to: string): string {
    return `${ENDPOINT_BASE}/${SERIES_ID}/datos/${from}/${to}`;
  }

  async fetch(opts: BanxicoFetchOptions): Promise<BanxicoRawResponse> {
    if (!opts.token) {
      throw new Error(
        "BANXICO_API_TOKEN missing. Set it in /opt/bb-support/.env before running. " +
          "Register a free token at https://www.banxico.org.mx/SieAPIRest/service/v1/token",
      );
    }
    const f = opts.fetchImpl ?? fetch;
    const url = this.urlFor(opts.from, opts.to);
    const res = await f(url, {
      headers: {
        "Bmx-Token": opts.token,
        "User-Agent": this.userAgent,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Banxico ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as BanxicoRawResponse;
  }

  /**
   * Map a Banxico SIE response into AuthorityRateInsert rows.
   *
   * Skips observations where `dato === "N/E"` (no observation —
   * holidays, weekends). Returns one row per business day with a
   * published FIX value.
   */
  toInserts(raw: BanxicoRawResponse, fetchedAtIso: string): AuthorityRateInsert[] {
    const observations = raw.bmx?.series?.[0]?.datos ?? [];
    const rows: AuthorityRateInsert[] = [];
    for (const obs of observations) {
      if (!obs.fecha || !obs.dato || obs.dato === "N/E") continue;
      const isoDate = parseBanxicoDate(obs.fecha);
      if (!isoDate) continue;
      const rate = Number(obs.dato);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      rows.push({
        source_currency: "USD",
        target_currency: "MXN",
        bucket_ts: `${isoDate}T00:00:00.000Z`,
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
        source_authority: "BANXICO",
        provenance: "historical-backfill",
      });
    }
    return rows;
  }
}

/** Banxico returns dates as "DD/MM/YYYY". Convert to "YYYY-MM-DD". */
export function parseBanxicoDate(s: string): string | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}
