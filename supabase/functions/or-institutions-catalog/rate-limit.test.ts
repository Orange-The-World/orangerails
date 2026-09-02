import { assertEquals, assertNotEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  clientIdOrNull,
  pruneRateWindows,
  rateLimitRetryAfter,
  rateWindows,
  unidentifiedCallerHeaders,
  RATE_MAX_PER_WINDOW,
  RATE_MAX_TRACKED_CLIENTS,
} from './rate-limit.ts';

function req(headers: Record<string, string>): Request {
  return new Request('https://example.orangerails.com/or-institutions-catalog?q=fi', { headers });
}

// --- clientIdOrNull precedence (OR-T1140) -----------------------------------

Deno.test('cf-connecting-ip wins when present, namespaced cf:', () => {
  const id = clientIdOrNull(req({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' }));
  assertEquals(id, 'cf:203.0.113.9');
});

Deno.test('x-real-ip alone yields null: it is not read anywhere in this function', () => {
  // This is the exact regression OR-C0493 caught: an earlier version trusted
  // x-real-ip, which our own gateway forwards unchanged from the caller. It
  // must never come back as a trusted (or any) signal.
  const id = clientIdOrNull(req({ 'x-real-ip': '203.0.113.9' }));
  assertEquals(id, null);
});

Deno.test('x-forwarded-for yields the LAST hop, not the first, namespaced xff:', () => {
  const id = clientIdOrNull(req({ 'x-forwarded-for': '198.51.100.1, 198.51.100.2, 198.51.100.3' }));
  assertEquals(id, 'xff:198.51.100.3');
});

Deno.test('x-forwarded-for with empty hops (trailing comma) does not yield an empty-string bucket', () => {
  const id = clientIdOrNull(req({ 'x-forwarded-for': '198.51.100.1, ' }));
  assertEquals(id, 'xff:198.51.100.1');
});

Deno.test('no identifying header at all yields null (fail open, not a shared bucket)', () => {
  const id = clientIdOrNull(req({}));
  assertEquals(id, null);
});

Deno.test('a caller-controlled x-forwarded-for can never collide with a cf: bucket for the same literal address', () => {
  const cf = clientIdOrNull(req({ 'cf-connecting-ip': '203.0.113.9' }));
  const xff = clientIdOrNull(req({ 'x-forwarded-for': '203.0.113.9' }));
  assertNotEquals(cf, xff);
});

// --- the unidentified-caller log line (OR-T1452) ----------------------------

Deno.test('a request with no identifying header reports every candidate absent', () => {
  const described = unidentifiedCallerHeaders(req({}));
  assertEquals(
    described,
    'cf-connecting-ip=absent x-forwarded-for=absent x-real-ip=absent x-gateway-verified-ip=absent',
  );
});

Deno.test('an empty header is reported as empty, not as absent', () => {
  // These come from different causes and point at different places to look: a
  // header an intermediary stripped, versus one forwarded with nothing in it.
  // Collapsing them would throw away the answer this log exists to get.
  const described = unidentifiedCallerHeaders(req({ 'x-forwarded-for': '   ' }));
  assertEquals(described.includes('x-forwarded-for=empty'), true);
  assertEquals(described.includes('x-forwarded-for=absent'), false);
});

Deno.test('the log line never contains a header VALUE', () => {
  // The values are client IP addresses. A test that only checked the shape of
  // the line would pass just as happily with one in it, so assert the absence
  // directly.
  const described = unidentifiedCallerHeaders(
    req({ 'x-real-ip': '203.0.113.9', 'x-gateway-verified-ip': '198.51.100.7' }),
  );
  assertEquals(described.includes('203.0.113.9'), false);
  assertEquals(described.includes('198.51.100.7'), false);
  assertEquals(described.includes('x-real-ip=present'), true);
});

Deno.test('the case this line describes is exactly the case that skips the throttle', () => {
  // x-real-ip is not read by clientIdOrNull, so a request carrying only that
  // header is unidentified and goes unthrottled while still having a header on
  // it. The log must fire for that request, not only for a bare one.
  const headers = { 'x-real-ip': '203.0.113.9' };
  assertEquals(clientIdOrNull(req(headers)), null);
  assertEquals(unidentifiedCallerHeaders(req(headers)).includes('x-real-ip=present'), true);
});

// --- overflow eviction order (OR-T1141) -------------------------------------

function reset() {
  rateWindows.clear();
}

Deno.test('an overflow manufactured with distinct xff: keys never evicts an already-counted cf: caller', () => {
  reset();
  const now = 1_000_000;

  // A real, identified caller has already made RATE_MAX_PER_WINDOW (60)
  // requests this window, right at the limit: one more and they are
  // throttled, since the check is count > RATE_MAX_PER_WINDOW, not >=. This
  // is the state a manufactured overflow must not be allowed to erase.
  const identified = 'cf:203.0.113.9';
  for (let i = 0; i < RATE_MAX_PER_WINDOW; i++) {
    const retryAfter = rateLimitRetryAfter(identified, now);
    assertEquals(retryAfter, 0, `identified caller should not be throttled on request ${i + 1}`);
  }

  // An attacker who controls x-forwarded-for sends RATE_MAX_TRACKED_CLIENTS
  // requests, each with a distinct value, all inside the same window. Every
  // one is a fresh, live xff: entry, which is exactly what fills the map
  // without anything expiring for pruneRateWindows to reclaim.
  for (let i = 0; i < RATE_MAX_TRACKED_CLIENTS; i++) {
    rateLimitRetryAfter(`xff:manufactured-${i}`, now);
  }

  // The map hit RATE_MAX_TRACKED_CLIENTS partway through that loop and
  // pruneRateWindows ran. On the pre-fix code (a bare .clear()) the
  // identified caller's 59-request count is gone here. On the fix, evicting
  // xff: entries first means it was never touched.
  assertEquals(
    rateWindows.has(identified),
    true,
    'the identified (cf:) caller was evicted by an xff:-manufactured overflow, the exact bug OR-T1141 describes',
  );

  // And the count survived, not just the key: one more request from the
  // identified caller must still trip the limiter.
  const retryAfter = rateLimitRetryAfter(identified, now);
  assertNotEquals(
    retryAfter,
    0,
    'the identified caller\'s 60th request in-window was not throttled: their count was reset by the overflow',
  );
});

Deno.test('overflow of genuinely cf:-keyed entries still falls back to forgiving everyone', () => {
  reset();
  const now = 2_000_000;

  // No xff: entries to evict. Every entry is cf:-keyed, i.e. genuinely
  // edge-identified traffic, which cannot be manufactured by one caller.
  // pruneRateWindows must still bound the map, so it falls back to the
  // original "clear everything" behaviour rather than growing forever.
  for (let i = 0; i < RATE_MAX_TRACKED_CLIENTS; i++) {
    rateLimitRetryAfter(`cf:198.51.100.${i}`, now);
  }
  pruneRateWindows(now);
  assertEquals(rateWindows.size < RATE_MAX_TRACKED_CLIENTS, true, 'the map must not grow without bound');
});

Deno.test('RATE_MAX_PER_WINDOW+1 requests from the same client trips the limiter', () => {
  reset();
  const now = 3_000_000;
  const id = 'cf:203.0.113.50';
  let lastRetryAfter = 0;
  for (let i = 0; i < RATE_MAX_PER_WINDOW + 1; i++) {
    lastRetryAfter = rateLimitRetryAfter(id, now);
  }
  assertNotEquals(lastRetryAfter, 0, `request ${RATE_MAX_PER_WINDOW + 1} in one window should be throttled`);
});
