/**
 * Bank of Canada (BoC) source — USD/CAD daily reference rate via Valet API.
 *
 * Why this exists: Canadian tax (CRA) and IFRS reporting in Canada commonly
 * use the Bank of Canada published USD/CAD daily rate (FXUSDCAD) for foreign-
 * currency conversion. Customers in Canada need this rate side-by-side with
 * our ORBI VW-median for compliance.
 *
 * Endpoint (no auth, free):
 *   GET https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json
 *       ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 *
 * Response:
 *   {
 *     "observations": [
 *       { "d": "2024-03-01", "FXUSDCAD": { "v": "1.3582" } },
 *       ...
 *     ]
 *   }
 *
 * Date range: published series back to 2017-01-03 (Valet API coverage).
 * Older daily-noon rates exist in a different series (IEXE0101 etc.) but
 * the modern FXUSDCAD series is the canonical post-2017 reference.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

export interface BocFetchOptions {
  /** Inclusive start date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date (YYYY-MM-DD). */
  to: string;
  fetchImpl?: typeof fetch;
}

export interface BocObservation {
  d?: string;
  FXUSDCAD?: { v?: string };
}

export interface BocRawResponse {
  observations?: BocObservation[];
}

const SERIES_ID = "FXUSDCAD";
const ENDPOINT_BASE = "https://www.bankofcanada.ca/valet";

export class BankOfCanadaSource {
  readonly name = "bank-of-canada";
  readonly endpointBase = ENDPOINT_BASE;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  urlFor(from: string, to: string): string {
    return (
      `${ENDPOINT_BASE}/observations/${SERIES_ID}/json` +
      `?start_date=${from}&end_date=${to}`
    );
  }

  async fetch(opts: BocFetchOptions): Promise<BocRawResponse> {
    const f = opts.fetchImpl ?? fetch;
    const url = this.urlFor(opts.from, opts.to);
    const res = await f(url, {
      headers: {
        "User-Agent": this.userAgent,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Bank of Canada ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as BocRawResponse;
  }

  /**
   * Map a Valet response to AuthorityRateInsert rows.
   *
   * Skips observations missing a value (Bank of Canada returns rows with
   * empty `v` for non-business-days in some series; FXUSDCAD typically
   * just omits weekends/holidays entirely).
   */
  toInserts(raw: BocRawResponse, fetchedAtIso: string): AuthorityRateInsert[] {
    const obs = raw.observations ?? [];
    const rows: AuthorityRateInsert[] = [];
    for (const o of obs) {
      const date = o.d;
      const v = o.FXUSDCAD?.v;
      if (!date || !v) continue;
      const rate = Number(v);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      rows.push({
        source_currency: "USD",
        target_currency: "CAD",
        bucket_ts: `${date}T00:00:00.000Z`,
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
        source_authority: "BOC",
        provenance: "historical-backfill",
      });
    }
    return rows;
  }
}
