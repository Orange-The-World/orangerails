/**
 * RateLimiter unit tests — token-bucket pacing semantics with injected clock.
 */

import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../scripts/historical-backfill/lib/rate-limiter";

describe("RateLimiter", () => {
  it("permits up to `burst` immediate acquires without waiting", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter({
      ratePerSec: 1,
      burst: 3,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    await rl.acquire();
    await rl.acquire();
    await rl.acquire();
    expect(sleeps).toEqual([]);
  });

  it("forces a wait when the bucket is empty", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const rl = new RateLimiter({
      ratePerSec: 2, // 1 token per 500ms
      burst: 1,
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    await rl.acquire(); // consume the single burst token
    await rl.acquire(); // must wait for refill
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(500);
  });

  it("rejects non-positive ratePerSec", () => {
    expect(() => new RateLimiter({ ratePerSec: 0 })).toThrow();
    expect(() => new RateLimiter({ ratePerSec: -1 })).toThrow();
  });
});
