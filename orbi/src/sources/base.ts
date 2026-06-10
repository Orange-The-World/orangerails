/**
 * BaseSource — common operational logic shared by every source plug-in.
 *
 * Plug-ins extend this class. The base handles:
 *  - Rate-limit pacing (per-source cadence cap)
 *  - Exponential backoff on transient failures
 *  - Honoring Retry-After
 *  - Polite User-Agent identification
 *  - Failure capture (returns SourceResponse with success=false, never throws)
 *
 * Plug-in subclasses implement `fetchCandles()` (the source-specific HTTP call
 * + candle parsing) and `healthCheck()`. They never deal with rate-limit pacing
 * or HTTP retries directly.
 */

import type {
  Candle,
  HealthStatus,
  Pair,
  SourceResponse,
} from "./types.ts";
import type { Source } from "./interface.ts";
import { SOURCE_OPERATIONAL_RULES } from "./interface.ts";

export interface BaseSourceConfig {
  readonly name: string;
  readonly role: "primary" | "secondary" | "cross-check" | "cross-rate" | "inactive";
  readonly endpointBase: string;
  readonly userAgent: string;
  readonly rateLimitRps: number;
  readonly pairsSupported: ReadonlyArray<string>;
}

export abstract class BaseSource implements Source {
  readonly name: string;
  readonly role: BaseSourceConfig["role"];
  readonly endpointBase: string;
  readonly userAgent: string;
  readonly rateLimitRps: number;
  readonly pairsSupported: ReadonlyArray<string>;

  private lastRequestAt: number = 0;

  protected constructor(cfg: BaseSourceConfig) {
    this.name = cfg.name;
    this.role = cfg.role;
    this.endpointBase = cfg.endpointBase;
    this.userAgent = cfg.userAgent;
    this.rateLimitRps = cfg.rateLimitRps;
    this.pairsSupported = cfg.pairsSupported;
  }

  /**
   * Subclasses implement the actual HTTP call + candle parsing.
   * They MAY throw — the public `fetch()` catches and converts to a
   * SourceResponse with success=false.
   */
  protected abstract fetchCandles(pair: Pair, from: Date, to: Date): Promise<Candle[]>;

  /**
   * Subclasses implement a cheap health check (ticker / status endpoint).
   */
  abstract healthCheck(): Promise<HealthStatus>;

  /**
   * Public fetch with cadence + backoff + error containment.
   * Never throws; always returns SourceResponse.
   */
  async fetch(pair: Pair, from: Date, to: Date): Promise<SourceResponse> {
    await this.waitForCadence();

    const baseBackoff = SOURCE_OPERATIONAL_RULES.BACKOFF_BASE_MS;
    const maxBackoff = SOURCE_OPERATIONAL_RULES.BACKOFF_MAX_MS;
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt < 5) {
      try {
        const candles = await this.fetchCandles(pair, from, to);
        return {
          source: this.name,
          candles,
          success: true,
          fetchedAt: new Date(),
        };
      } catch (err) {
        lastError = err;
        // Determine if retryable
        const retryable = this.isRetryableError(err);
        if (!retryable || attempt >= 4) {
          break;
        }
        const delay = Math.min(baseBackoff * Math.pow(2, attempt), maxBackoff);
        await sleep(delay);
        attempt++;
      }
    }

    return {
      source: this.name,
      candles: [],
      success: false,
      errorMessage: this.formatError(lastError),
      fetchedAt: new Date(),
    };
  }

  /**
   * Wait between successive requests to honor rateLimitRps.
   */
  protected async waitForCadence(): Promise<void> {
    const minIntervalMs = 1000 / this.rateLimitRps;
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < minIntervalMs) {
      await sleep(minIntervalMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * HTTP request with our standard headers + timeout.
   */
  protected async httpGet(url: string, extraHeaders?: Record<string, string>): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SOURCE_OPERATIONAL_RULES.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": this.userAgent,
          ...SOURCE_OPERATIONAL_RULES.ACCEPT_HEADERS,
          ...(extraHeaders ?? {}),
        },
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get("Retry-After");
        if (retryAfter) {
          const delaySec = parseFloat(retryAfter);
          if (!Number.isNaN(delaySec)) {
            // Cap server-dictated backoff at 60s — an adversarial or buggy
            // Retry-After (e.g. 86400) must not freeze the writer loop.
            // 2026-06-10: iteration #34 hung 80 min in a blocking wait.
            await sleep(Math.min(delaySec, 60) * 1000);
          }
        }
        throw new RetryableHttpError(res.status, `HTTP ${res.status} from ${url}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  protected isRetryableError(err: unknown): boolean {
    if (err instanceof RetryableHttpError) return true;
    if (err instanceof Error) {
      // Network-level / abort errors are retryable
      if (err.name === "AbortError") return true;
      if (err.message.includes("ECONNRESET")) return true;
      if (err.message.includes("ETIMEDOUT")) return true;
      if (err.message.includes("fetch failed")) return true;
    }
    return false;
  }

  protected formatError(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }
}

export class RetryableHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RetryableHttpError";
    this.status = status;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
