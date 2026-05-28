/**
 * Banco Central de Chile (BCCH) source — USD/CLP "Dólar Observado" daily.
 *
 * Transport: mindicador.cl (free public proxy).
 * Data authority: BCCH (Banco Central de Chile) F073.TCO.PRE.Z.D series.
 *
 * Why a proxy: BCCH's own Siete REST API requires a registered account +
 * authenticated calls, which breaks ORBI's silent-posture rule (no
 * permission email, no central-bank fingerprint). mindicador.cl is a free
 * public Chilean civic-data project that republishes the same official
 * BCCH series as JSON with no auth, no anti-scraping, and no documented
 * commercial restriction. Founder approved this transport on 2026-05-27
 * (Option 1 in DEFERRED_SOURCES.md).
 *
 * This matches the ECB-via-Frankfurter precedent already in production:
 * third-party transport, sovereign authority signature on the row.
 *
 * Endpoint (no auth, free public data, JSON):
 *   GET https://mindicador.cl/api/dolar/<YYYY>
 *
 * Response shape:
 *   {
 *     "version": "1.7.0",
 *     "autor":   "mindicador.cl",
 *     "codigo":  "dolar",
 *     "nombre":  "Dólar observado",
 *     "unidad_medida": "Pesos",
 *     "serie": [
 *       { "fecha": "YYYY-MM-DDTHH:MM:SS.000Z", "valor": 911.18 },
 *       ...
 *     ]
 *   }
 *
 * Coverage: 2003-01-02 onward; weekends/holidays have no entry. The series
 * is returned newest-first; we sort ascending before inserting so the
 * orchestrator's checkpoint logic sees monotonic bucket_ts.
 *
 * Storage: the published valor is CLP per 1 USD, which already matches
 * ORBI's USD-base convention (source=USD, target=CLP, rate=valor — no
 * inversion needed).
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

const ENDPOINT_BASE = "https://mindicador.cl/api/dolar";

export interface BcchFetchOptions {
  /** Calendar year, e.g. 2024. */
  year: number;
  fetchImpl?: typeof fetch;
}

export interface BcchRawObservation {
  fecha?: string;
  valor?: number;
}

export interface BcchRawResponse {
  version?: string;
  autor?: string;
  codigo?: string;
  nombre?: string;
  unidad_medida?: string;
  serie?: BcchRawObservation[];
}

export interface BcchParsedRow {
  /** YYYY-MM-DD (UTC date component of the fecha timestamp). */
  date: string;
  /** CLP per 1 USD. */
  value: number;
}

export class BcchSource {
  readonly name = "bcch";
  readonly endpointBase = ENDPOINT_BASE;
  /**
   * Intentionally minimal headers — mindicador.cl is friendly to plain
   * GETs; sending a Mozilla UA from cloud IPs is more likely to trip
   * Akamai-style WAFs than to help. We identify ourselves honestly with
   * a project-specific UA so the operator can correlate logs if needed.
   */
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  urlFor(year: number): string {
    if (!Number.isInteger(year) || year < 2003 || year > 2100) {
      throw new Error(`Invalid BCCH year: ${year}`);
    }
    return `${ENDPOINT_BASE}/${year}`;
  }

  async fetch(opts: BcchFetchOptions): Promise<BcchRawResponse> {
    const f = opts.fetchImpl ?? fetch;
    const url = this.urlFor(opts.year);
    const res = await f(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`BCCH/mindicador ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as BcchRawResponse;
  }

  /**
   * Parse a mindicador.cl response into [{date, value}, ...] ascending
   * by date. Drops malformed / zero / negative observations silently.
   */
  parse(raw: BcchRawResponse): BcchParsedRow[] {
    const serie = raw.serie ?? [];
    const rows: BcchParsedRow[] = [];
    for (const o of serie) {
      if (!o.fecha || typeof o.valor !== "number") continue;
      if (!Number.isFinite(o.valor) || o.valor <= 0) continue;
      const m = o.fecha.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      rows.push({ date: m[1]!, value: o.valor });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
  }

  toInserts(
    raw: BcchRawResponse,
    fetchedAtIso: string,
  ): AuthorityRateInsert[] {
    const parsed = this.parse(raw);
    const out: AuthorityRateInsert[] = [];
    for (const r of parsed) {
      out.push({
        source_currency: "USD",
        target_currency: "CLP",
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
        source_authority: "BCCH",
        provenance: "historical-backfill",
      });
    }
    return out;
  }

  /**
   * Convenience: fetch + flatten a multi-year window.
   *
   * mindicador.cl is keyed by calendar year; ORBI backfills span arbitrary
   * date ranges. This walks the year range, fetches each year, filters to
   * the [from, to] window, and concatenates ascending.
   */
  async fetchRange(opts: {
    from: string;
    to: string;
    fetchImpl?: typeof fetch;
    log?: (msg: string) => void;
  }): Promise<BcchParsedRow[]> {
    const log = opts.log ?? (() => {});
    const yearFrom = Number(opts.from.slice(0, 4));
    const yearTo = Number(opts.to.slice(0, 4));
    if (!Number.isInteger(yearFrom) || !Number.isInteger(yearTo) || yearFrom > yearTo) {
      throw new Error(`Invalid BCCH range: ${opts.from} → ${opts.to}`);
    }
    // mindicador.cl occasionally returns observations from adjacent
    // years in a single year-keyed response (timezone-boundary entries),
    // so we dedupe by date to keep the orchestrator's batch UPSERT from
    // hitting "ON CONFLICT DO UPDATE command cannot affect row a second
    // time" on dup keys within one batch.
    const byDate = new Map<string, BcchParsedRow>();
    for (let y = yearFrom; y <= yearTo; y++) {
      log(`  [bcch] fetching ${y} from mindicador.cl`);
      const raw = await this.fetch({ year: y, fetchImpl: opts.fetchImpl });
      const parsed = this.parse(raw);
      for (const r of parsed) {
        if (r.date >= opts.from && r.date <= opts.to) byDate.set(r.date, r);
      }
    }
    const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    return all;
  }
}
