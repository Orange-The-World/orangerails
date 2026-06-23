import { useEffect, useState } from "react";
import { Outlet, Link, createRootRoute, HeadContent, useRouterState } from "@tanstack/react-router";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";

import appCss from "../styles.css?url";
import { VaultProvider } from "@/context/VaultContext";

const ANALYTICS_CONSENT_KEY = "or-analytics-consent";

function dntActive() {
  try {
    return typeof navigator !== "undefined" && navigator.doNotTrack === "1";
  } catch {
    return false;
  }
}

// Cookieless PostHog init, matching the Orange Way Me posture. Memory-
// only persistence, no cookies, no person profiles, no session
// recording, no autocapture. Each page load is a fresh anonymous
// pageview. The AnalyticsNotice that ships alongside this is
// informational, not a consent gate, since there is no identifier to
// opt into. DNT users skip init entirely. Guard against double-init
// when the notice mounts on a subsequent marketing-route render.
let posthogInitialized = false;
function initPostHogIfConsented() {
  if (typeof window === "undefined") return;
  if (dntActive()) return;
  if (posthogInitialized) return;
  posthog.init("phc_ufrtHMjamZtq8ZhWA53ALx5KwSd3xKNbiDW9GH8UXNqn", {
    api_host: "https://eu.i.posthog.com",
    persistence: "memory",
    person_profiles: "never",
    capture_pageview: true,
    autocapture: false,
    disable_session_recording: true,
    respect_dnt: true,
  });
  posthogInitialized = true;
}

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#F7931A" },
      { name: "robots", content: "index, follow" },
      { name: "author", content: "OrangeRails" },
      { name: "keywords", content: "Bitcoin, open source, zero-knowledge, financial data API, Bitcoin accounting, Lightning Network, self-hostable, Apache 2.0, BTCPay, Blink, mining payouts" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "OrangeRails" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:site", content: "@orangerails" },
      { name: "twitter:creator", content: "@orangerails" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "OrangeRails",
          url: "https://orangerails.com",
          logo: "https://orangerails.com/favicon.svg",
          description:
            "Open-source, zero-knowledge, Bitcoin-first way to share bank data with your bookkeeper. Apache 2.0.",
          sameAs: ["https://orangerails.com"],
        }),
      },
    ],
  }),
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootComponent() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Cookieless PostHog , privacy stance for the platform.
    // Memory-only persistence, no cookies, no localStorage tracking,
    // no session recording, no person profiles. Each page load is a
    // fresh anonymous event stream. Pageview + explicit captures only.
    // phc_ keys are PostHog "Project API Keys" , write-only, public-safe.
initPostHogIfConsented();
    posthog.register({ app: "orangerails", brand: "orange-rails" });
  }, []);

  return (
    <PostHogProvider client={posthog}>
      <VaultProvider>
        <Outlet />
        <AnalyticsNotice />
      </VaultProvider>
    </PostHogProvider>
  );
}

const NON_MARKETING_ROUTE_PREFIXES = [
  "/connect",
  "/app",
  "/unlock",
  "/signup",
  "/signin",
  "/signout",
  "/api",
  "/admin",
  "/embed",
  "/widget",
  "/_",
];

function isMarketingPathname(pathname: string): boolean {
  if (!pathname) return false;
  for (const prefix of NON_MARKETING_ROUTE_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return false;
    }
  }
  return true;
}

// Lifted from Orange Way Me (orange-way/src/routes/__root.tsx) so the
// analytics notice is consistent across the consuming-app family.
// Auto-dismisses when the user scrolls past 600px so it never becomes a
// nag. PostHog is initialised opportunistically (no opt-in click
// needed) because the deployment is cookieless and does not assign
// stable identifiers; the notice is a heads-up, not a gate.
function AnalyticsNotice() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (dntActive()) {
      setShow(false);
      return;
    }
    if (!isMarketingPathname(pathname)) {
      setShow(false);
      return;
    }
    try {
      setShow(window.localStorage.getItem(ANALYTICS_CONSENT_KEY) !== "1");
    } catch {
      setShow(false);
    }
  }, [pathname]);
  useEffect(() => {
    if (!show) return;
    if (typeof window === "undefined") return;
    const onScroll = () => {
      if (window.scrollY > 600) {
        try {
          window.localStorage.setItem(ANALYTICS_CONSENT_KEY, "1");
        } catch {}
        setShow(false);
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [show]);
  // PostHog itself is initialised once at root mount, not here. The
  // notice is independent UX: visitors who dismissed in a prior visit
  // still get analytics, since cookieless mode has no identifier to
  // opt out of beyond the DNT signal the init helper already honours.
  if (!show) return null;
  const dismiss = () => {
    try {
      window.localStorage.setItem(ANALYTICS_CONSENT_KEY, "1");
    } catch {}
    setShow(false);
  };
  return (
    <div
      style={{
        position: "fixed",
        left: 20,
        bottom: 20,
        zIndex: 9999,
        maxWidth: 320,
        padding: "14px 16px",
        background: "#0F172A",
        color: "#FAFAF9",
        borderRadius: 14,
        boxShadow: "0 12px 32px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.18)",
        font: "12.5px/1.5 -apple-system, 'Plus Jakarta Sans', system-ui, sans-serif",
        animation: "ornotin 260ms cubic-bezier(0.16,1,0.3,1)",
      }}
      role="region"
      aria-label="Analytics notice"
    >
      <style>{`@keyframes ornotin{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Close"
        style={{
          position: "absolute",
          top: 6,
          right: 8,
          background: "transparent",
          color: "#94A3B8",
          border: 0,
          fontSize: 18,
          lineHeight: 1,
          padding: "4px 6px",
          cursor: "pointer",
          borderRadius: 6,
        }}
      >
        ×
      </button>
      <p style={{ margin: "0 0 10px 0", paddingRight: 18 }}>
        Anonymous analytics,{" "}
        <strong style={{ color: "#fff" }}>no tracking, no profiles, no cookies.</strong>{" "}
        A session cookie is set only if you sign in, and is deleted when you sign out.
      </p>
      <button
        type="button"
        onClick={dismiss}
        style={{
          background: "#fb923c",
          color: "#fff",
          border: 0,
          borderRadius: 8,
          padding: "6px 14px",
          font: "inherit",
          fontWeight: 600,
          fontSize: 12.5,
          cursor: "pointer",
        }}
      >
        Got it
      </button>
    </div>
  );
}

