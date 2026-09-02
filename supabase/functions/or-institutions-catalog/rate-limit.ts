/**
 * or-institutions-catalog , anonymous-caller throttle (bound 1 of 2; see the
 * "RATE LIMIT" comment block in index.ts for the other bound, the catalog
 * response memo).
 *
 * Split into its own module (OR-T1140, OR-T1141) so it carries NO Deno.serve
 * call and no side effects: importing it from a test file is safe. Importing
 * index.ts directly is not, because index.ts starts listening the moment the
 * module loads.
 */

export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_PER_WINDOW = 60;
export const RATE_MAX_TRACKED_CLIENTS = 5_000;

/**
 * Exported so a test can reset it between cases (`rateWindows.clear()`) and
 * inspect it directly. Production code never resets the whole map outside
 * pruneRateWindows's own eviction.
 */
export const rateWindows = new Map<string, { windowStart: number; count: number }>();

/**
 * Identify the caller for throttling, preferring the one header a caller
 * cannot write.
 *
 * The precedence is the whole point. x-forwarded-for is caller-supplied: a
 * proxy APPENDS to whatever the client already sent, so its FIRST entry is a
 * value the client chose. Reading that first entry, as this function used to,
 * made the counter bypassable from a single machine: send a different random
 * X-Forwarded-For on every request and each one lands in a fresh bucket, so
 * rateLimitRetryAfter returns 0 forever. Only cf-connecting-ip is trusted: it
 * is written at Cloudflare's true edge and a client cannot forge it there.
 *
 * x-real-ip is NOT read anywhere in this function, at all. An earlier
 * version trusted it and was wrong to: workers/api-gateway (forwardHeaders)
 * strips cf-connecting-ip and every cf-* header on the way to this function,
 * but forwards a caller-supplied x-real-ip through completely unchanged and
 * never sets one itself, so trusting it let a gateway-routed caller forge a
 * fresh bucket every request (OR-C0493).
 *
 * WHAT IS VERIFIED versus WHAT IS NOT, stated separately on purpose
 * (OR-T1140, CTO challenge OR-C0519). workers/api-gateway's forwardHeaders,
 * read directly at its dev head, does not append to x-forwarded-for: it
 * copies whatever the caller sent verbatim (out.set(k, v), no push, no
 * concat). That is checked against the Worker's own source and is fact.
 * What has NOT been checked, because nobody has taken the measurement, is
 * whether anything between the Worker's outbound fetch() and this Deno
 * isolate -- Supabase's own function-invocation layer -- appends a further
 * hop to x-forwarded-for before this handler ever sees the request.
 *   - If it does not: the last entry a gateway-routed caller sees here is
 *     exactly the value the caller sent, i.e. still forgeable, same as the
 *     first entry always was.
 *   - If it does: the last entry is that intermediate layer's own address,
 *     shared by every gateway-routed caller on the isolate, and all of them
 *     land in the SAME xff: bucket below. The 60-per-minute allowance a
 *     single legitimate picker session is meant to get becomes one shared
 *     60-per-minute allowance for every gateway-routed user combined, on a
 *     path the picker calls once per keystroke.
 * Nobody has logged the real header set on a live gateway-routed request to
 * tell these two apart. This comment does not guess which one we are in,
 * and the code does not depend on the answer either way (see the namespace
 * paragraph below).
 *
 * Because of that uncertainty, the bucket KEY is namespaced by which header
 * produced it ('cf:' for the trustworthy edge-set value, 'xff:' for the
 * forgeable fallback). That namespace stops a caller who controls
 * x-forwarded-for from ever spending or exhausting a cf: bucket that
 * belongs to someone else's real address, however many hops they append.
 * It does NOT resolve the unmeasured question above: if the shared-egress
 * case is real, every gateway-routed caller still shares one xff: bucket
 * with every other gateway-routed caller; the namespace only keeps that
 * blast radius from also reaching cf: callers.
 *
 * The structural fix in flight makes this question moot rather than
 * answering it: workers/api-gateway (OR-T1103) now captures the genuine
 * incoming cf-connecting-ip before stripping it and re-injects it under
 * x-gateway-verified-ip, a header only the gateway itself can set. Once
 * this function trusts that header (tracked as OR-T1116), a gateway-routed
 * request carries an edge-verified identity again and neither branch above
 * matters. Until OR-T1103 merges and OR-T1116 lands, the gap described here
 * is live.
 *
 * KNOWN GAP, stated rather than hidden: a request that reaches this function
 * through workers/api-gateway has already lost cf-connecting-ip (stripped
 * there). With no x-forwarded-for either, clientIdOrNull returns null and
 * the request is not throttled at all (fail-open, see below). With an
 * x-forwarded-for present, the request lands in an xff: bucket whose real
 * behaviour is exactly the open question above. A direct call to this
 * function, bypassing the gateway, still carries a genuine cf-connecting-ip
 * and is throttled correctly.
 *
 * When we cannot identify a caller at all we do NOT throttle, deliberately:
 * bucketing every unidentified request under a single key would turn a
 * missing header into a global cap on a hot path the picker calls on each
 * keystroke. Failing open is the safer of the two ways to be wrong here.
 */
export function clientIdOrNull(req: Request): string | null {
  const edgeSet = (req.headers.get('cf-connecting-ip') ?? '').trim();
  if (edgeSet) return `cf:${edgeSet}`;
  const forwarded = req.headers.get('x-forwarded-for') ?? '';
  const hops = forwarded.split(',').map((hop) => hop.trim()).filter((hop) => hop.length > 0);
  return hops.length > 0 ? `xff:${hops[hops.length - 1]}` : null;
}

/**
 * Drop expired windows so the counter map stays bounded. If that is not
 * enough the map is genuinely full of live entries and needs to shrink some
 * other way, and WHICH entries it shrinks matters (OR-T1141).
 *
 * The map can fill in two different ways and they must not be handled the
 * same way. Genuine overflow is many real callers, mostly cf: keyed, hitting
 * the isolate inside one window; that is rare, and forgiving everyone one
 * window is the right direction to be wrong in on an availability-sensitive
 * path. MANUFACTURED overflow is one caller sending ~5,000 requests with
 * ~5,000 distinct x-forwarded-for values inside one window: every one lands
 * as a fresh, live xff: entry, so clearing the whole map wiped every cf:
 * caller's count too. That let a single attacker who can vary one
 * caller-controlled header switch the limiter off for every identified
 * caller on the isolate, just by repeating the burst.
 *
 * The fix evicts the forgeable xff: entries FIRST. A caller manufacturing an
 * overflow can only ever free room by burning through their own disposable
 * xff: buckets; they can never force a cf: bucket out this way, because
 * cf-connecting-ip is edge-set and not theirs to vary. Only if the map is
 * still full after that -- meaning the overflow really is edge-identified
 * traffic, which cannot be manufactured the same way -- does this fall back
 * to clearing everything, which is the original "forgive everyone" behaviour,
 * for the case it was actually written for.
 */
export function pruneRateWindows(now: number): void {
  for (const [id, entry] of rateWindows) {
    if (now - entry.windowStart >= RATE_WINDOW_MS) rateWindows.delete(id);
  }
  if (rateWindows.size >= RATE_MAX_TRACKED_CLIENTS) {
    for (const [id] of rateWindows) {
      if (id.startsWith('xff:')) rateWindows.delete(id);
    }
    if (rateWindows.size >= RATE_MAX_TRACKED_CLIENTS) rateWindows.clear();
  }
}

/**
 * Count this request against the caller's window. Returns 0 when the caller
 * is allowed through, otherwise the seconds until their window resets, which
 * is what goes in retry-after.
 */
export function rateLimitRetryAfter(clientId: string, now: number): number {
  const entry = rateWindows.get(clientId);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    if (rateWindows.size >= RATE_MAX_TRACKED_CLIENTS) pruneRateWindows(now);
    rateWindows.set(clientId, { windowStart: now, count: 1 });
    return 0;
  }
  entry.count += 1;
  if (entry.count > RATE_MAX_PER_WINDOW) {
    return Math.max(1, Math.ceil((entry.windowStart + RATE_WINDOW_MS - now) / 1000));
  }
  return 0;
}
