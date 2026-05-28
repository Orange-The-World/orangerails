/**
 * Indodax source plug-in (BTC/IDR) — ticker-only / B-single-eligible-only.
 *
 * Indodax is Indonesia's largest Bappebti-registered crypto exchange (operated
 * by PT Indodax Nasional Indonesia). Their public API exposes a per-pair
 * ticker but does NOT provide a keyless OHLC or recent-trades endpoint that
 * works without an authenticated session (the /api/btc_idr/trades path
 * returns the marketing site HTML rather than a JSON trade array).
 *
 * Public endpoint used:
 *   - GET https://indodax.com/api/ticker/btc_idr
 *       → { "ticker": { "buy", "high", "last", "low", "sell",
 *                      "server_time", "vol_btc", "vol_idr" } }
 *
 * Bucketing model (mirrors LunoSource):
 *   - Emit ONE candle per fetch, snapped to the minute floor before `to`,
 *     open=high=low=close=last. Volume is set to 0 because `vol_btc` is a
 *     24-hour rolling figure, not per-minute.
 *   - Tier: B-single-eligible-only at the resolver.
 *
 * Per-source posture:
 *   - rate limit: Indodax does not publish a hard public limit; we cap to
 *     1 rps. Their public site polls /api/ticker/* at roughly that cadence.
 *   - User-Agent must be a browser-shaped string — the API host returns an
 *     HTML interstitial to non-browser user agents (curl, wget, etc.).
 *     We send our normal Orange-Rails-ORBI string prefixed with the
 *     Mozilla/5.0 token, which Indodax accepts.
 *   - free, no auth required for /api/ticker/btc_idr.
 *   - tier: primary (B-single-eligible-only at resolver).
 *
 * Validated empirically 2026-05-27 — /api/ticker/btc_idr returned last
 * 1,312,277,000 IDR with 20.88 BTC of 24h base volume.
 *
 * See https://github.com/btcid/indodax-official-api-docs for the
 * unauthenticated endpoint surface.
 */

import { BaseSource, type BaseSourceConfig } from "./base.ts";
import type { Candle, HealthStatus, Pair } from "./types.ts";

const PAIR_MAP: Record<string, string> = {
  "BTC-IDR": "btc_idr",
};

export class IndodaxSource extends BaseSource {
  constructor() {
    const cfg: BaseSourceConfig = {
      name: "indodax",
      role: "primary",
      endpointBase: "https://indodax.com",
      // Indodax filters non-browser UAs; prepend Mozilla/5.0 token so the
      // origin still serves JSON. Contact/identification still preserved.
      userAgent:
        "Mozilla/5.0 (compatible; Orange-Rails-ORBI/1.0; +https://orangerails.com/orbi; contact@orangerails.com)",
      rateLimitRps: 1.0,
      pairsSupported: Object.keys(PAIR_MAP),
    };
    super(cfg);
  }

  protected async fetchCandles(pair: Pair, _from: Date, to: Date): Promise<Candle[]> {
    const ourPair = `${pair.source}-${pair.target}`;
    const idxPair = PAIR_MAP[ourPair];
    if (!idxPair) {
      throw new Error(`Indodax: unsupported pair ${ourPair}`);
    }

    const url = `${this.endpointBase}/api/ticker/${idxPair}`;
    const res = await this.httpGet(url);
    const body = (await res.json()) as IndodaxTickerResponse;
    const last = Number(body?.ticker?.last);
    if (!isFinite(last) || last <= 0) {
      throw new Error(`Indodax: missing/invalid last for ${idxPair}`);
    }

    const bucketMs = Math.floor(to.getTime() / 60_000) * 60_000 - 60_000;
    return [{
      bucketTs: new Date(bucketMs),
      open: last,
      high: last,
      low: last,
      close: last,
      volume: 0,
    }];
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      await this.waitForCadence();
      const url = `${this.endpointBase}/api/ticker/btc_idr`;
      const res = await this.httpGet(url);
      const body = (await res.json()) as IndodaxTickerResponse;
      const last = Number(body?.ticker?.last);
      const reachable = isFinite(last) && last > 0;
      return {
        name: this.name,
        reachable,
        lastSuccessAt: reachable ? new Date() : undefined,
        lastFailureAt: reachable ? undefined : new Date(),
        lastError: reachable ? undefined : "Indodax ticker missing/invalid `last`",
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

interface IndodaxTickerResponse {
  ticker?: {
    buy?: string;
    high?: string;
    last?: string;
    low?: string;
    sell?: string;
    server_time?: number;
    vol_btc?: string;
    vol_idr?: string;
  };
}
