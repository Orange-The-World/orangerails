/**
 * Mercado Bitcoin source plug-in (Brazilian exchange — NOT Mercado Pago).
 *
 * Endpoint: GET https://api.mercadobitcoin.net/api/v4/candles
 *   ?symbol={pair}&resolution={1m}&to={unix_sec}&countback={N}
 *
 * Response shape (TradingView UDF convention):
 *   {
 *     "t": [unix_ts, ...],
 *     "o": ["open", ...],
 *     "h": ["high", ...],
 *     "l": ["low", ...],
 *     "c": ["close", ...],
 *     "v": ["volume", ...]
 *   }
 *
 * Per-source posture (verified 2026-05-26):
 *   - rate limit: undocumented; conservative cadence 1 rps
 *   - ToS: public market data EXPLICITLY carved out of Confidential Information
 *   - No "no-indexes" clause. Friction clause "no commercial services" — mitigated
 *     by courtesy notification + attribution
 *   - Courtesy email to contato@mercadobitcoin.com.br (paper trail; does NOT gate launch)
 *   - BCB payment-institution license (2023), SPSAV authorization pending
 *
 * Pairs: BTC-BRL is the flagship; BTC-USDT and BTC-USDC also available.
 */

import { BaseSource, type BaseSourceConfig } from "./base";
import type { Candle, HealthStatus, Pair } from "./types";

const PAIR_MAP: Record<string, string> = {
  "BTC-BRL": "BTC-BRL",
  "BTC-USDT": "BTC-USDT",
  "BTC-USDC": "BTC-USDC",
};

export class MercadoBitcoinSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "mercado_bitcoin",
      role: "primary",
      endpointBase: "https://api.mercadobitcoin.net",
      userAgent: "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const mbPair = PAIR_MAP[ourPair];
    if (!mbPair) {
      throw new Error(`Mercado Bitcoin: unsupported pair ${ourPair}`);
    }

    const fromSec = Math.floor(from.getTime() / 1000);
    const toSec = Math.floor(to.getTime() / 1000);
    const url = `${this.endpointBase}/api/v4/candles?symbol=${mbPair}&resolution=1m&from=${fromSec}&to=${toSec}`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as MercadoBitcoinCandlesResponse;

    if (!Array.isArray(body.t) || !Array.isArray(body.o) || !Array.isArray(body.c)) {
      throw new Error(`Mercado Bitcoin: unexpected response shape`);
    }

    const n = body.t.length;
    const candles: Candle[] = [];
    for (let i = 0; i < n; i++) {
      const ts = body.t[i];
      const o = body.o[i];
      const h = body.h?.[i];
      const l = body.l?.[i];
      const c = body.c[i];
      const v = body.v?.[i];
      if (ts === undefined || o === undefined || c === undefined) continue;
      candles.push({
        bucketTs: new Date(Number(ts) * 1000),
        open: Number(o),
        high: Number(h ?? o),
        low: Number(l ?? o),
        close: Number(c),
        volume: Number(v ?? 0),
      });
    }
    return candles;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/api/v4/symbols`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as { symbol?: string[] };
      const reachable = Array.isArray(body.symbol) && body.symbol.length > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "symbols endpoint returned empty/malformed",
      };
    } catch (err) {
      return {
        name: this.name,
        reachable: false,
        lastFailureAt: new Date(),
        lastError: this.formatError(err),
      };
    }
  }
}

interface MercadoBitcoinCandlesResponse {
  t?: Array<string | number>;
  o?: Array<string | number>;
  h?: Array<string | number>;
  l?: Array<string | number>;
  c?: Array<string | number>;
  v?: Array<string | number>;
}
