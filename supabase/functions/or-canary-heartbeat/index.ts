import { wrapSentryHandler } from '../_shared/sentry.ts';

/**
 * or-canary-heartbeat
 *
 * A synthetic canary for the GlitchTip error-reporting pipeline (OR-T2400,
 * child of OR-T0934 / OR-T0931). It has one job: fail, every single time it
 * is invoked, so a scheduled caller can prove the whole error-reporting path
 * is alive end to end (DSN configured, DSN parses, HTTP delivery succeeds,
 * GlitchTip ingest accepts it) instead of assuming it because nothing has
 * been seen to fail lately.
 *
 * This deliberately reuses wrapSentryHandler from _shared/sentry.ts rather
 * than posting to GlitchTip directly, so the canary exercises the exact
 * same scrubbing and delivery code every other function relies on. If that
 * shared path breaks, the canary is what notices.
 *
 * The caller (a scheduled GitHub Actions workflow) generates its own
 * correlation tag and passes it as ?tag=..., which is echoed into the
 * thrown error's message. The workflow already knows the tag, so it can
 * search GlitchTip for that exact string after invoking this function; the
 * function does not need to hand anything back in its (never-seen, always
 * 500) HTTP response.
 *
 * No customer data, no database access, no side effects. Safe to invoke on
 * any schedule.
 */
Deno.serve(
  wrapSentryHandler(async (req) => {
    const url = new URL(req.url);
    const tag = url.searchParams.get('tag') ?? 'no-tag-provided';
    // Deliberate failure. The tag is a caller-generated correlation string
    // (see the workflow in .github/workflows/canary-heartbeat.yml), not
    // user input from a real request, so it is safe to fold into the
    // message that gets reported.
    throw new Error(`or-canary-heartbeat scheduled failure marker ${tag}`);
  }, 'or-canary-heartbeat'),
);
