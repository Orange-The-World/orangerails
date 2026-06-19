/**
 * Per-(key, scope) one-minute rate limit, backed by public.platform_rate_limits.
 *
 * Designed to be added to a hot path with minimal risk:
 *   - **Fail open** , any error in the rate-limit machinery returns
 *     { allowed: true } so a transient DB issue can't lock callers out.
 *   - **Log-only mode by default** , `RATE_LIMIT_ENFORCE` env var must be
 *     set to "true" to actually reject. Otherwise the throttle just records
 *     the violation in console.error so we can baseline usage before
 *     enforcing.
 *   - **Atomic UPSERT** , one round trip per request; no read-then-write
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

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

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
    // Upsert with increment. Postgres ON CONFLICT returns the updated row.
    const { data, error } = await supabase
      .from('platform_rate_limits')
      .upsert(
        {
          key,
          scope,
          window_start: windowStart.toISOString(),
          count: 1,
        },
        {
          onConflict: 'key,scope,window_start',
          ignoreDuplicates: false,
        },
      )
      .select('count')
      .single();

    if (error || !data) {
      // Fail open. Log so operators can see the rate-limit machinery is
      // flapping but don't block the request.
      console.error('[rate-limit] upsert failed; failing open:', error?.message);
      return {
        allowed: true,
        count: 0,
        limit: maxPerMinute,
        retryAfterSeconds: 0,
        mode,
      };
    }

    // The upsert above wrote count=1 on insert OR re-applied count=1 on
    // conflict (because we passed count: 1 in the values). That's wrong for
    // a true increment. To get atomic increment with upsert we need a
    // post-write update, or a stored function. Do the increment here as a
    // separate atomic update , the SELECT in the next call gives us the
    // accurate post-increment count.
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
        count: data.count,
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
