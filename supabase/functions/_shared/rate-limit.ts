/**
 * Per-(key, scope) one-minute rate limit, backed by public.platform_rate_limits.
 *
 * Designed to be added to a hot path with minimal risk:
 *   - **Fail open** — any error in the rate-limit machinery returns
 *     { allowed: true } so a transient DB issue can't lock callers out.
 *   - **Log-only mode by default** — `RATE_LIMIT_ENFORCE` env var must be
 *     set to "true" to actually reject. Otherwise the throttle just records
 *     the violation in console.error so we can baseline usage before
 *     enforcing.
 *   - **Atomic UPSERT** — one round trip per request; no read-then-write
 *     race window.
 *
 * Caller pattern (or-link-complete is the first integration):
 *
 *   const limit = await checkPlatformRateLimit({
 *     supabase: ctx.serviceClient,
 *     key: ctx.platformId,
 *     scope: 'or-link-complete',
 *     maxPerMinute: 10,
 *   });
 *   if (!limit.allowed) {
 *     return jsonResponse(
 *       { error: 'rate_limited', detail: `Try again in ${limit.retryAfterSeconds}s` },
 *       429,
 *       { ...cors, 'retry-after': String(limit.retryAfterSeconds) },
 *     );
 *   }
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';

export interface RateLimitCheckArgs {
  supabase: SupabaseClient;
  key: string;
  scope: string;
  maxPerMinute: number;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
  mode: 'enforce' | 'log-only';
}

const ENFORCEMENT_ENV = 'RATE_LIMIT_ENFORCE';

/**
 * Bump the (key, scope, current-minute) counter and report whether the
 * caller should be allowed through. Fail-open on any error.
 */
export async function checkPlatformRateLimit(
  args: RateLimitCheckArgs,
): Promise<RateLimitResult> {
  const { supabase, key, scope, maxPerMinute } = args;
  const windowStart = new Date();
  windowStart.setSeconds(0, 0);

  const mode: 'enforce' | 'log-only' =
    (Deno.env.get(ENFORCEMENT_ENV) ?? '').toLowerCase() === 'true'
      ? 'enforce'
      : 'log-only';

  try {
    // ONE round trip. The RPC does INSERT ... ON CONFLICT DO UPDATE SET
    // count = count + 1 and returns the post-increment count, so it creates
    // the bucket row itself.
    //
    // Do NOT write the row from here first. An upsert carrying count: 1 is an
    // UPDATE on conflict, so it reset the window counter on every request:
    // the count could never climb past 2 and no limit above 1 could ever be
    // reached, in log-only mode or in enforce mode.
    const { data: incremented, error: incErr } = await supabase.rpc(
      'increment_platform_rate_limit',
      {
        p_key: key,
        p_scope: scope,
        p_window_start: windowStart.toISOString(),
      },
    );
    if (incErr || incremented === null || incremented === undefined) {
      console.error('[rate-limit] increment RPC failed; failing open:', incErr?.message);
      return {
        allowed: true,
        count: 0,
        limit: maxPerMinute,
        retryAfterSeconds: 0,
        mode,
      };
    }

    const newCount = Number(incremented);
    const secondsRemaining = Math.max(
      0,
      60 - Math.floor((Date.now() - windowStart.getTime()) / 1000),
    );

    if (newCount > maxPerMinute) {
      if (mode === 'log-only') {
        console.error(
          `[rate-limit] OVER LIMIT (log-only) key=${key} scope=${scope} count=${newCount} limit=${maxPerMinute}`,
        );
        return {
          allowed: true,
          count: newCount,
          limit: maxPerMinute,
          retryAfterSeconds: secondsRemaining,
          mode,
        };
      }
      return {
        allowed: false,
        count: newCount,
        limit: maxPerMinute,
        retryAfterSeconds: secondsRemaining,
        mode,
      };
    }

    return {
      allowed: true,
      count: newCount,
      limit: maxPerMinute,
      retryAfterSeconds: 0,
      mode,
    };
  } catch (err) {
    console.error('[rate-limit] unexpected error; failing open:', err);
    return {
      allowed: true,
      count: 0,
      limit: maxPerMinute,
      retryAfterSeconds: 0,
      mode,
    };
  }
}
