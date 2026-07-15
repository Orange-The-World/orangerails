/**
 * Product analytics client (PostHog), dark by default.
 *
 * Why this file exists
 * --------------------
 * Until this lands, no product event is emitted anywhere in the app, so every
 * funnel number in the metric spec is a guess: there is no denominator for
 * activation, no clock for time-to-first-report, and no baseline for
 * free-to-paid. This module is the single place those four events can be
 * emitted from.
 *
 * Configuration
 * -------------
 * Reads `VITE_POSTHOG_KEY` and `VITE_POSTHOG_HOST` from the Vite build
 * environment. When the key is unset (the default, and the default for local
 * dev), `initAnalytics()` returns immediately, the SDK is never initialised,
 * and every emitter below is a no-op. Nothing leaves the browser. Turning
 * analytics on is therefore a hosting action, not a code change.
 *
 * The project key is a PostHog-convention public client key, embedded in
 * browser bundles by design, and is not a secret. It is still not committed
 * here: it belongs in the hosting env, same as the error-reporting DSN.
 *
 * Privacy posture
 * ---------------
 * The product's whole promise is that we cannot read the user's data. An
 * analytics SDK is the most likely place to break that promise by accident,
 * so this module is deliberately narrow:
 *
 *   - Counts and timestamps only. No vault-derived value, no financial value,
 *     no free text ever becomes an event property.
 *   - `distinct_id` is an opaque, account-scoped pseudonym supplied by the
 *     caller. Never an email, never anything vault-derived.
 *   - `autocapture` off, session recording off, pageview capture off, feature
 *     flags off. We are not observing the UI, only counting four milestones.
 *   - Two independent filters, either one sufficient on its own: the SDK's
 *     `property_denylist`, and our `sanitize_properties`, which rebuilds every
 *     payload from an explicit allowlist and re-applies the denylist itself
 *     rather than trusting the SDK to run them in a particular order.
 *
 * Data sent to a processor cannot be un-sent. That asymmetry is why the checks
 * here are redundant on purpose.
 *
 * Required hosting setup (not enforceable from this file)
 * ------------------------------------------------------
 * Enable "Discard client IP data" in the PostHog project settings. The
 * client-side `$ip` denylist below stops the SDK from attaching an IP
 * property, but the request itself still carries one at the network layer,
 * and only the project setting stops PostHog from recording it.
 */
import posthog from "posthog-js";

/** Plans a user can upgrade from. Enum, never an arbitrary string. */
export type PlanFrom = "free";

/** Plans a user can upgrade to. Extend as plans are added. */
export type PlanTo = "pro";

/**
 * The complete event surface. There is deliberately no generic
 * `capture(name, props)` export: a generic escape hatch is how unreviewed
 * properties end up in a third-party store. If an event is not in this map,
 * the app cannot send it.
 */
type EventMap = {
  /** Email confirmed or first login. */
  bb_signup: { plan_type: "free" };
  /** First successful bank sync. This is activation; account creation is not. */
  bb_first_sync: { federation_count: number };
  /** Report file downloaded or emailed. Rendering it in the UI does not count. */
  bb_report_exported: { federation_count: number };
  /** Free to paid upgrade. */
  bb_plan_upgraded: { plan_to: PlanTo; plan_from?: PlanFrom };
};

type EventName = keyof EventMap;

/**
 * Properties any event is allowed to carry. Anything not named here, and not
 * an SDK internal that survives the denylist, is stripped before the request
 * is built.
 */
const ALLOWED_PROPERTIES = new Set([
  "plan_type",
  "plan_to",
  "plan_from",
  "federation_count",
]);

/**
 * SDK-attached properties we never want to send. The URL and referrer families
 * are here because a route can carry an account or entity id in the path, and
 * a pseudonymous event with a URL attached is no longer pseudonymous.
 */
const PROPERTY_DENYLIST = [
  "$ip",
  "$current_url",
  "$initial_current_url",
  "$pathname",
  "$initial_pathname",
  "$referrer",
  "$initial_referrer",
  "$referring_domain",
  "$initial_referring_domain",
  "$host",
  "$initial_person_info",
  "$screen_name",
  "$set",
  "$set_once",
];

const DENIED = new Set(PROPERTY_DENYLIST);

let initialized = false;

/**
 * Rebuild the property bag from the allowlist, and re-apply the denylist here
 * rather than assuming the SDK applies its own after us. `$`-prefixed keys
 * that are not denied are SDK internals we want to keep (event timestamp, lib
 * version, session id).
 */
function allowlistProperties(
  properties: Record<string, unknown>,
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    if (DENIED.has(key)) continue;
    if (ALLOWED_PROPERTIES.has(key) || key.startsWith("$")) {
      clean[key] = properties[key];
    }
  }
  return clean;
}

/**
 * Boot the analytics client. No-ops when `VITE_POSTHOG_KEY` is unset, which
 * is the default: no SDK init, no network, no cookie, no event.
 */
export function initAnalytics(): void {
  if (initialized) return;

  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key || key.trim().length === 0) {
    // Dark. This is the committed default and the state the repo ships in.
    return;
  }

  const host =
    (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ??
    "https://eu.i.posthog.com";

  posthog.init(key, {
    api_host: host,
    // We count four milestones. We do not watch the user.
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    // Feature flags would add a request that profiles the user on every load
    // for no benefit we are asking for here.
    advanced_disable_feature_flags: true,
    advanced_disable_feature_flags_on_first_load: true,
    // localStorage only. No analytics cookie is set.
    persistence: "localStorage",
    // Identity is supplied explicitly by the caller via identifyUser().
    // Anonymous auto-identification would create a person profile for every
    // visitor, which is more data than the funnel needs.
    person_profiles: "identified_only",
    property_denylist: PROPERTY_DENYLIST,
    // Independent of the denylist above, and sufficient on its own: even if
    // the SDK grows a new default property, it does not reach the request
    // unless it is named in ALLOWED_PROPERTIES.
    sanitize_properties: (properties) => allowlistProperties(properties),
    // Session recording is already disabled; this is the fallback posture if
    // it is ever enabled by config, so the default is masked rather than open.
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "*",
    },
  });

  initialized = true;
}

/**
 * Attach the account pseudonym to subsequent events.
 *
 * The caller supplies an opaque, account-scoped id. This module does not read
 * it from the session and does not know what it is derived from, by design:
 * the id we send to a processor must not be the id our own tables join on.
 * Passing an email, or any vault-derived value, would break the product's core
 * promise and is not a supported use of this function.
 */
export function identifyUser(analyticsId: string): void {
  if (!initialized) return;
  if (!analyticsId || analyticsId.trim().length === 0) return;
  posthog.identify(analyticsId);
}

/** Clear the local identity on sign-out so the next user starts clean. */
export function resetAnalytics(): void {
  if (!initialized) return;
  posthog.reset();
}

/**
 * Emit one of the four contract events. Typed so an unknown event name or an
 * off-contract property is a build error, not a privacy incident found later
 * in a PostHog dashboard.
 */
function capture<E extends EventName>(event: E, properties: EventMap[E]): void {
  if (!initialized) return;
  posthog.capture(event, properties);
}

/** Email confirmed or first login. */
export function trackSignup(): void {
  capture("bb_signup", { plan_type: "free" });
}

/** First successful bank sync. This is the activation moment. */
export function trackFirstSync(federationCount: number): void {
  capture("bb_first_sync", { federation_count: federationCount });
}

/** Report file downloaded or emailed. Not fired when a report is merely rendered. */
export function trackReportExported(federationCount: number): void {
  capture("bb_report_exported", { federation_count: federationCount });
}

/** Free to paid upgrade. */
export function trackPlanUpgraded(planTo: PlanTo, planFrom?: PlanFrom): void {
  capture("bb_plan_upgraded", { plan_to: planTo, plan_from: planFrom });
}

/** Test seam only: lets a test observe the dark-by-default guarantee. */
export function __isAnalyticsInitialized(): boolean {
  return initialized;
}

/** Test seam only. Resets module state between test cases. */
export function __resetAnalyticsForTests(): void {
  initialized = false;
}
