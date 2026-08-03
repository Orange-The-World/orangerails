import posthog from "posthog-js";

/**
 * Referrer attribution for the Hub signup funnel.
 *
 * Two sources, in priority order:
 *   1. A `?ref=` query param on first load, matched against REF_ALLOWLIST.
 *      An unrecognised value is dropped, never forwarded, so a hand-crafted
 *      link cannot write arbitrary text into the event stream.
 *   2. Fallback: the hostname of `document.referrer` only. Never the path,
 *      never the query, because a referring URL can itself carry user data.
 *
 * PostHog is initialised with persistence: "memory", so this super property
 * lives for the tab and dies with it. Attribution is therefore same-session
 * only by design. A visitor who arrives, leaves, and returns later signs up
 * untagged, which makes any `ref` cohort a FLOOR and not a total. That is a
 * known and accepted limit, not a defect: fixing it would require a durable
 * client-side identifier, which is the exact thing the cookieless init is
 * there to avoid.
 */
export const REF_ALLOWLIST: readonly string[] = ["orangeworld", "github", "newsletter"];

/** The one conversion event for the signup funnel. Name is load-bearing: the analytics export matches on it. */
export const HUB_SIGNUP_COMPLETE = "hub_signup_complete";

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

function refFromQuery(search: string): string | null {
  try {
    const raw = new URLSearchParams(search).get("ref");
    if (!raw) return null;
    const candidate = raw.trim().toLowerCase();
    return REF_ALLOWLIST.includes(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function refFromReferrer(referrer: string, currentHost: string): string | null {
  if (!referrer) return null;
  try {
    const host = normalizeHost(new URL(referrer).hostname);
    if (!host) return null;
    // A same-origin referrer is an internal navigation, not an acquisition
    // source. Returning it would let the second pageview of a visit clobber
    // the real source captured on the first.
    if (host === normalizeHost(currentHost)) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * Pure resolver, exported so it can be tested without a browser or a live
 * PostHog client. Returns null when there is nothing safe to record.
 */
export function resolveRef(
  search: string,
  referrer: string,
  currentHost: string,
): string | null {
  return refFromQuery(search) ?? refFromReferrer(referrer, currentHost);
}

/**
 * Register `ref` as a super property for this tab. Call once, after PostHog
 * init. No-ops when nothing resolves, so an untagged session simply carries
 * no `ref` key at all rather than a placeholder that would need filtering
 * out downstream.
 */
export function registerRefSuperProperty(): void {
  if (typeof window === "undefined") return;
  const ref = resolveRef(window.location.search, document.referrer, window.location.hostname);
  if (!ref) return;
  try {
    posthog.register({ ref });
  } catch {
    // Analytics must never break a page render. PostHog is not initialised
    // at all when Do Not Track is set, and that path lands here.
  }
}

/**
 * The single conversion capture. Carries no properties of its own: the `ref`
 * super property does the attribution, and adding anything user-specific
 * here would turn an anonymous event into a profile.
 */
export function captureHubSignupComplete(): void {
  if (typeof window === "undefined") return;
  try {
    posthog.capture(HUB_SIGNUP_COMPLETE);
  } catch {
    // Same reason as above: a failed capture must not fail a signup.
  }
}
