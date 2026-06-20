import { useEffect, useState } from "react";
import { Outlet, Link, createRootRoute, HeadContent } from "@tanstack/react-router";
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

function initPostHogIfConsented() {
  if (typeof window === "undefined") return;
  if (dntActive()) return;
  let consent: string | null = null;
  try {
    consent = window.localStorage.getItem(ANALYTICS_CONSENT_KEY);
  } catch {
    return;
  }
  if (consent !== "accept") return;
      posthog.init("phc_ufrtHMjamZtq8ZhWA53ALx5KwSd3xKNbiDW9GH8UXNqn", {
      api_host: "https://eu.i.posthog.com",
      persistence: "memory",
      person_profiles: "never",
      capture_pageview: true,
      autocapture: false,
      disable_session_recording: true,
      respect_dnt: true,
    });
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
      { name: "keywords", content: "Bitcoin, Plaid alternative, open source, zero-knowledge, financial data API, Bitcoin accounting, Lightning Network, self-hostable, Apache 2.0, BTCPay, Blink, mining payouts" },
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
            "Open-source, zero-knowledge, Bitcoin-first alternative to Plaid. Apache 2.0.",
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


// One-time analytics-notice banner shown once per browser, dismissed via
// localStorage (UI state, not tracking , exempt from consent under
// GDPR Article 6 because it's strictly necessary for the banner not to
// nag). Same wording shipped across every BitBooks-family surface.
function AnalyticsNotice() {
  const [decided, setDecided] = useState(() => {
    if (typeof window === "undefined") return true;
    if (dntActive()) return true;
    try {
      return window.localStorage.getItem(ANALYTICS_CONSENT_KEY) !== null;
    } catch {
      return true;
    }
  });
  if (decided) return null;
  const accept = () => {
    try {
      window.localStorage.setItem(ANALYTICS_CONSENT_KEY, "accept");
    } catch {}
    initPostHogIfConsented();
    setDecided(true);
  };
  const decline = () => {
    try {
      window.localStorage.setItem(ANALYTICS_CONSENT_KEY, "decline");
    } catch {}
    setDecided(true);
  };
  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-xl rounded-lg border border-border bg-card p-4 text-sm shadow-lg">
      <p className="mb-3">
        We use cookieless PostHog to count visits and improve the site. May we count yours? You can change your mind any time in the footer.
      </p>
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={decline}
          className="rounded border border-border px-3 py-1 text-sm hover:bg-muted"
        >
          No thanks
        </button>
        <button
          type="button"
          onClick={accept}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:opacity-90"
        >
          Accept
        </button>
      </div>
    </div>
  );
}
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [show]);
  if (!show) return null;
  const dismiss = () => { localStorage.setItem("bb_notice_dismissed", "1"); setShow(false); };
  return (
    <div
      style={{
        position: "fixed", left: 20, bottom: 20, zIndex: 9999,
        maxWidth: 320, padding: "14px 16px",
        background: "#0F172A", color: "#FAFAF9",
        borderRadius: 14,
        boxShadow: "0 12px 32px rgba(0,0,0,0.28), 0 2px 6px rgba(0,0,0,0.18)",
        font: "12.5px/1.5 -apple-system, 'Plus Jakarta Sans', system-ui, sans-serif",
        animation: "bbnotin 260ms cubic-bezier(0.16,1,0.3,1)",
      }}
      role="region"
      aria-label="Analytics notice"
    >
      <style>{`@keyframes bbnotin{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}`}</style>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Close"
        style={{
          position: "absolute", top: 6, right: 8,
          background: "transparent", color: "#94A3B8", border: 0,
          fontSize: 18, lineHeight: 1, padding: "4px 6px",
          cursor: "pointer", borderRadius: 6,
        }}
      >×</button>
      <p style={{ margin: "0 0 10px 0", paddingRight: 18 }}>
        Anonymous analytics ,{" "}
        <strong style={{ color: "#fff" }}>no tracking, no profiles, no cookies.</strong>{" "}
        A session cookie is set only if you sign in, and is deleted when you sign out.
      </p>
      <button
        type="button"
        onClick={dismiss}
        style={{
          background: "#F7931A", color: "#fff", border: 0, borderRadius: 8,
          padding: "6px 14px", font: "inherit", fontWeight: 600, fontSize: 12.5, cursor: "pointer",
        }}
      >
        Got it
      </button>
    </div>
  );
}
