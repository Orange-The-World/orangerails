/**
 * or-canary-heartbeat -- synthetic dead-man's-switch for edge-function error
 * visibility (DL-0603, OR-T0934, spec from OR-T0931).
 *
 * This function does exactly one thing on every invocation: it deliberately
 * throws, wrapped in the same wrapSentryHandler every other OR edge function
 * uses (_shared/sentry.ts). A scheduled caller invokes this on a fixed
 * interval with a fresh correlation tag, waits, then checks GlitchTip for an
 * event carrying that tag. A missed window means the SENTRY_DSN / GlitchTip
 * ingest chain broke on that run, discovered on schedule rather than the
 * next time a real customer error happens to need it.
 *
 * Why this deliberately throws (rather than catching and calling reportError
 * directly, the way or-sync's per-connection handler now does): most OR edge
 * functions rely on wrapSentryHandler's fire-and-forget `void reportError(...)`
 * fallback net, not an explicit call site. That path can silently drop a
 * report if the edge worker is torn down before the fetch completes (see the
 * cold-stop comment in sentry.ts). This canary exercises exactly that path,
 * on purpose, because that is the path most of the fleet is actually relying
 * on and the one a passive "any events lately?" check cannot distinguish
 * from a genuinely quiet period.
 *
 * The tag is caller-supplied (query param `tag`) rather than generated here,
 * so the scheduled caller can know the exact tag to search for without
 * depending on this function's response body -- which, once it throws, is a
 * generic 500 with no custom content.
 *
 * Always fails. That is correct, not a defect: the alarm is a missed death,
 * not a live one.
 */

import { wrapSentryHandler } from '../_shared/sentry.ts';

Deno.serve(wrapSentryHandler(async (req: Request) => {
  const url = new URL(req.url);
  const tag = url.searchParams.get('tag') ?? crypto.randomUUID();
  throw new Error(`or-canary-heartbeat deliberate synthetic failure, tag=${tag}`);
}, 'or-canary-heartbeat'));
