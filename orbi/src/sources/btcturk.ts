/**
 * BTCTurk source plug-in (BTC/TRY).
 *
 * BTCTurk is Turkey's longest-operating, MASAK-registered exchange. Their
 * graph-api host exposes a TradingView-compatible "klines/history" endpoint
 * with explicit minute resolution.
 *
 * Public endpoint:
 *   GET https://graph-api.btcturk.com/v1/klines/history
 *       ?symbol=BTCTRY&resolution=1&from={unix_s}&to={unix_s}
 *
 *   Columnar response (TradingView UDF):
 *     {
 *       "s": "ok",
 *       "t": [unix_seconds, ...],
 *       "o": [open, ...],
 *       "h": [high, ...],
 *       "l": [low, ...],
 *       "c": [close, ...],
 *       "v": [volume, ...]    // present in real response
 *     }
 *
 *   `resolution=1` = 1-minute bars. `t` is unix seconds.
 *
 * IMPORTANT: do NOT use `https://graph-api.btcturk.com/v1/ohlcs` — empirically
 * it returns DAILY bars regardless of `from`/`to`, NOT minute bars. The
 * klines/history endpoint is the correct one for ORBI-M. Validated 2026-05-26.
 *
 * Per-source posture:
 *   - rate limit: BTCTurk documents 100 req/10s public; we use 1 rps.
 *   - free, no auth required.
 *   - tier: primary.
 *
 * See https://docs.btcturk.com/ (Graph API section).
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-TRY": "BTCTRY",
};

export class BtcTurkSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "btcturk",
      role: "primary",
      endpointBase: "https://graph-api.btcturk.com",
      userAgent:
        "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const btPair = PAIR_MAP[ourPair];
    if (!btPair) {
      throw new Error(`BTCTurk: unsupported pair ${ourPair}`);
    }

    const fromSec = Math.floor(from.getTime() / 1000);
    const toSec = Math.ceil(to.getTime() / 1000);
    const url =
      `${this.endpointBase}/v1/klines/history` +
      `?symbol=${btPair}&resolution=1&from=${fromSec}&to=${toSec}`;

    const res = await this.httpGet(url);
    const body = (await res.json()) as BtcTurkKlinesResponse;
    if (body.s !== "ok") {
      throw new Error(`BTCTurk klines status=${body.s ?? "<missing>"}`);
    }
    if (
      !Array.isArray(body.t) || !Array.isArray(body.o) ||
      !Array.isArray(body.h) || !Array.isArray(body.l) ||
      !Array.isArray(body.c)
    ) {
      throw new Error("BTCTurk klines response missing required columns");
    }

    const fromMs = from.getTime();
    const toMs = to.getTime();
    const candles: Candle[] = [];
    const len = body.t.length;
    for (let i = 0; i < len; i++) {
      const ts = Number(body.t[i]) * 1000;
      if (!isFinite(ts) || ts < fromMs || ts > toMs) continue;
      const open = Number(body.o[i]);
      const high = Number(body.h[i]);
      const low = Number(body.l[i]);
      const close = Number(body.c[i]);
      // Volume column may be absent on illiquid windows; default to 0.
      const volume = Array.isArray(body.v) ? Number(body.v[i]) : 0;
      if (
        !isFinite(open) || !isFinite(high) || !isFinite(low) || !isFinite(close)
      ) continue;
      candles.push({
        bucketTs: new Date(ts),
        open,
        high,
        low,
        close,
        volume: isFinite(volume) ? volume : 0,
      });
    }
    candles.sort((a, b) => a.bucketTs.getTime() - b.bucketTs.getTime());
    return candles;
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = "https://api.btcturk.com/api/v2/ticker?pairSymbol=BTCTRY";
      const res = await this.httpGet(url);
      const body = (await res.json()) as {
        success?: boolean;
        data?: Array<{ last?: number }>;
      };
      const last = body?.data?.[0]?.last;
      const reachable = body.success === true && typeof last === "number" && last > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "ticker missing last",
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

interface BtcTurkKlinesResponse {
  s?: string; // "ok" | "no_data" | error
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
}
