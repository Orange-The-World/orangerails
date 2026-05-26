/**
 * Banco Central do Brasil (BCB) source — USD/BRL PTAX daily reference rate.
 *
 * Why this exists: Brazilian tax law (Receita Federal) requires PTAX for
 * currency conversion of foreign-currency transactions. The "venda" (selling)
 * rate is the canonical one used for tax computations.
 *
 * Endpoint (OData, no auth, free):
 *   GET https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/
 *       CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)
 *       ?@dataInicial='MM-DD-YYYY'&@dataFinalCotacao='MM-DD-YYYY'
 *       &$top=10000&$format=json
 *
 * Note BCB's OData endpoint requires the parameter dates in MM-DD-YYYY format
 * with single quotes around them. Easy to get wrong; tested below.
 *
 * Response (one row per intra-day publication; PTAX publishes 4× per day
 * plus a final closing fixing):
 *   {
 *     "value": [
 *       {
 *         "cotacaoCompra": 5.05, "cotacaoVenda": 5.06,
 *         "dataHoraCotacao": "2024-03-01 13:09:23.477",
 *         "tipoBoletim": "Fechamento"
 *       }, ...
 *     ]
 *   }
 *
 * For tax purposes, the daily "Fechamento" (closing) PTAX is canonical.
 * We filter to tipoBoletim='Fechamento' and use the "venda" rate.
 *
 * Date range: full history back to 1984. Weekends/holidays have no row.
 */

import type { AuthorityRateInsert } from "../lib/batch-writer";

export interface BcbFetchOptions {
  /** Inclusive start date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date (YYYY-MM-DD). */
  to: string;
  fetchImpl?: typeof fetch;
}

export interface BcbRawObservation {
  cotacaoCompra?: number;
  cotacaoVenda?: number;
  dataHoraCotacao?: string;
  tipoBoletim?: string;
}

export interface BcbRawResponse {
  value?: BcbRawObservation[];
}

const ENDPOINT_BASE =
  "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata";

export class BcbSource {
  readonly name = "bcb";
  readonly endpointBase = ENDPOINT_BASE;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  urlFor(from: string, to: string): string {
    const fromMdy = toMdy(from);
    const toMdyStr = toMdy(to);
    const path =
      `${ENDPOINT_BASE}/CotacaoDolarPeriodo(` +
      `dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)`;
    const query =
      `?@dataInicial='${fromMdy}'` +
      `&@dataFinalCotacao='${toMdyStr}'` +
      `&$top=10000&$format=json`;
    return path + query;
  }

  async fetch(opts: BcbFetchOptions): Promise<BcbRawResponse> {
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
      throw new Error(`BCB ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as BcbRawResponse;
  }

  /**
   * Map a BCB OData response to AuthorityRateInsert rows.
   *
   * Filters to tipoBoletim='Fechamento' (closing PTAX). Uses cotacaoVenda
   * (selling rate) as the canonical value — that's what Brazilian tax
   * regulation (RFB) specifies for converting foreign-currency obligations.
   *
   * If a day has no "Fechamento" row (very old historical days sometimes
   * only have intra-day boletim), we fall back to the latest available
   * observation for that date.
   */
  toInserts(raw: BcbRawResponse, fetchedAtIso: string): AuthorityRateInsert[] {
    const obs = raw.value ?? [];
    // Group by date; prefer Fechamento; else take the latest by timestamp.
    const byDate = new Map<string, BcbRawObservation>();
    for (const o of obs) {
      if (!o.dataHoraCotacao) continue;
      const date = o.dataHoraCotacao.slice(0, 10); // "YYYY-MM-DD"
      const prev = byDate.get(date);
      if (!prev) {
        byDate.set(date, o);
        continue;
      }
      if (o.tipoBoletim === "Fechamento" && prev.tipoBoletim !== "Fechamento") {
        byDate.set(date, o);
      } else if (
        prev.tipoBoletim !== "Fechamento" &&
        (o.dataHoraCotacao ?? "") > (prev.dataHoraCotacao ?? "")
      ) {
        byDate.set(date, o);
      }
    }

    const rows: AuthorityRateInsert[] = [];
    for (const [date, o] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const rate = o.cotacaoVenda;
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) continue;
      rows.push({
        source_currency: "USD",
        target_currency: "BRL",
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
        source_authority: "BCB",
        provenance: "historical-backfill",
      });
    }
    return rows;
  }
}

/** Convert "YYYY-MM-DD" to "MM-DD-YYYY" for BCB OData. */
export function toMdy(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid ISO date: ${iso}`);
  const [, yyyy, mm, dd] = m;
  return `${mm}-${dd}-${yyyy}`;
}
