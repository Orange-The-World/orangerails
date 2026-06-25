/**
 * Sentry-compatible client error reporting wired against our self-hosted
 * GlitchTip instance.
 *
 * Why this file exists
 * --------------------
 * Until this lands, runtime errors in the Orange Rails SPA (broken widget
 * popup, failed dashboard fetch, busted admin page) silently happened and
 * disappeared. We learned about prod issues like the BIP-158 WASM dynamic
 * import 404 only when a real user hit Sync and reported a sad popup.
 * This module hooks the Sentry React SDK to GlitchTip (which speaks the
 * Sentry wire protocol) so the next class of silent prod failures shows
 * up as a triageable issue instead of an email.
 *
 * Hosting boundary
 * ----------------
 * GlitchTip is self-hosted by Orange Rails (Apache-2.0). Sentry the SaaS
 * is not in the request path. The Sentry SDK is the open-source MIT
 * client SDK only; it does not phone home to Sentry's hosted backend.
 *
 * Configuration
 * -------------
 * Reads `VITE_SENTRY_DSN` from the Vite build environment. When unset
 * (the default for local dev), `initSentry()` is a no-op and the SDK
 * does not load. Production builds get the DSN injected via the CF
 * Pages dashboard env var. The DSN is a Sentry-convention public
 * client key (embedded in browser bundles by design), not a secret.
 *
 * Privacy posture
 * ---------------
 * The widget's whole privacy story is that xpubs and address sets stay
 * in the user's browser. We must not exfiltrate them to the error
 * tracker. The `beforeSend` hook below scrubs known-sensitive shapes
 * (vault passwords, raw xpubs, sealed envelope bytes) from event
 * payloads before they leave the page. Add new shapes here when new
 * sensitive surfaces ship.
 */
import * as Sentry from "@sentry/react";

let initialized = false;

export function initSentry(): void {
  if (initialized) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn || dsn.trim().length === 0) {
    // No DSN, no init. Keeps local dev quiet and avoids loading the
    // SDK code path entirely when not configured.
    return;
  }

  Sentry.init({
    dsn,
    // Tag every event so the SPA's issues do not get mixed with the
    // future Worker or Edge Function projects when those land.
    release: (import.meta.env.VITE_OR_RELEASE as string | undefined) ?? "dev",
    environment:
      (import.meta.env.VITE_OR_ENV as string | undefined) ??
      (import.meta.env.PROD ? "production" : "development"),
    // First pass: error capture only. Performance tracing and session
    // replay are deliberately off so the bundle stays small and we
    // do not accidentally record sensitive widget UI frames.
    tracesSampleRate: 0,
    // Sample every error in production. We can dial down later if
    // volume spikes; tonight's goal is full visibility on a fresh
    // deploy.
    sampleRate: 1,
    // Strip sensitive widget state before the event leaves the page.
    // Structural deletes of every field that might carry secret
    // material in flight: the URL fragment (legacy cred_key handoff),
    // the URL query string (no-leak even from query-token mistakes),
    // request bodies, cookies, request headers (Authorization,
    // Set-Cookie, custom platform-api-key shapes), the SDK's default
    // IP capture, and breadcrumb payload fields. We never want a
    // Sentry event to be the place a vault password, xpub, or
    // sealed envelope byte first leaves the user's browser.
    beforeSend(event) {
      try {
        if (event.request) {
          if (event.request.url) {
            // Strip both fragment and query string. The path is enough
            // for triage; query-string tokens (?widget_token=, ?cred=)
            // and fragment tokens (#cred_key=) never reach pulse.
            const u = event.request.url.split("#")[0].split("?")[0];
            event.request.url = u;
          }
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.headers;
          delete event.request.query_string;
        }
        if (event.user) {
          // The SDK captures client IP by default. We do not need it
          // for triage and many jurisdictions treat it as PII.
          delete event.user.ip_address;
        }
        // Headers + extra/contexts can carry serialised request state
        // from instrumented fetch wrappers and React error boundaries.
        delete event.extra;
        if (event.contexts) {
          // Keep contexts.browser / contexts.os / contexts.runtime
          // (useful for triage). Drop any custom shape that might
          // have been Sentry.setContext()'d earlier in the page.
          for (const k of Object.keys(event.contexts)) {
            if (!["browser", "os", "runtime", "device"].includes(k)) {
              delete event.contexts[k];
            }
          }
        }
        if (Array.isArray(event.breadcrumbs)) {
          for (const bc of event.breadcrumbs) {
            // Strip query/fragment from any breadcrumb URL.
            if (bc.data && typeof (bc.data as { url?: string }).url === "string") {
              const bcu = (bc.data as { url: string }).url.split("#")[0].split("?")[0];
              (bc.data as { url: string }).url = bcu;
            }
            // Console breadcrumbs can carry stringified payloads when
            // a developer console.log'd state. Drop the message body
            // and keep only the level for triage.
            if (bc.category === "console") {
              delete bc.message;
              if (bc.data) delete (bc.data as { arguments?: unknown }).arguments;
            }
            // Fetch/xhr breadcrumbs: keep status and url (already
            // stripped above), drop everything else.
            if (bc.category === "fetch" || bc.category === "xhr") {
              if (bc.data) {
                const keep = new Set(["url", "method", "status_code"]);
                for (const k of Object.keys(bc.data)) {
                  if (!keep.has(k)) delete (bc.data as Record<string, unknown>)[k];
                }
              }
            }
          }
        }
      } catch {
        // If scrubbing throws for any reason, prefer dropping the event
        // over leaking unscrubbed data.
        return null;
      }
      return event;
    },
  });
  initialized = true;
}
