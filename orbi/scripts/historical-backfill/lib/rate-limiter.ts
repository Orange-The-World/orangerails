/**
 * Token-bucket rate limiter for per-source request pacing during backfill.
 *
 * Why a separate limiter from BaseSource: backfill plug-ins may bypass
 * BaseSource (e.g. raw CSV download is a single big GET, not a candle
 * fetch loop), and orchestration may interleave downloads + parses where
 * we still want a global ceiling on bytes/sec or requests/sec per source.
 *
 * Usage:
 *   const rl = new RateLimiter({ ratePerSec: 1, burst: 2 });
 *   await rl.acquire();   // blocks until a token is available
 *   ...do work...
 */

export interface RateLimiterOptions {
  /** Sustained rate in requests per second. */
  ratePerSec: number;
  /** Burst capacity (max tokens that can accumulate). Default = max(1, ratePerSec). */
  burst?: number;
  /** Injectable now() for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private readonly ratePerSec: number;
  private readonly burst: number;
  private tokens: number;
  private lastRefillAt: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: RateLimiterOptions) {
    if (opts.ratePerSec <= 0) throw new Error("ratePerSec must be > 0");
    this.ratePerSec = opts.ratePerSec;
    this.burst = opts.burst ?? Math.max(1, opts.ratePerSec);
    this.tokens = this.burst;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lastRefillAt = this.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait long enough to earn 1 token.
    const waitMs = Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
    await this.sleep(waitMs);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }

  /** Internal: top up tokens based on elapsed time. */
  private refill(): void {
    const now = this.now();
    const elapsedSec = (now - this.lastRefillAt) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefillAt = now;
  }

  /** Exposed for tests. */
  get availableTokens(): number {
    this.refill();
    return this.tokens;
  }
}
