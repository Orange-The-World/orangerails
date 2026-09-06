/**
 * /connect/quiltt — Quiltt bank-link bridge page.
 *
 * The integrating app's backend calls or-link-mint-token + or-quiltt-session,
 * then opens this page (popup or redirect) with the resulting params in the
 * URL fragment so the JWT never reaches OR's web server or the referrer:
 *
 *   /connect/quiltt#session_token=<jwt>
 *                 &connector_id=<conn>
 *                 &platform_slug=<slug>
 *                 &app_user_id=<id>
 *                 &widget_token=<uuid>
 *
 * Flow once mounted:
 *   1. QuilttProvider validates the session token with Quiltt's auth API
 *   2. User clicks "Open Quiltt" → QuilttButton mounts the Connector iframe
 *   3. User picks a bank, completes Quiltt's link flow
 *   4. onExitSuccess fires with { connectionId, profileId }
 *   5. We POST to or-quiltt-link-complete to create the OR connections row
 *   6. We close the popup (or surface a "return to app" CTA)
 *
 * The Quiltt connection_id from onExitSuccess is NOT required on our side —
 * or-quiltt-link-complete only needs (platform_slug, app_user_id, widget_token)
 * to create the connections row. or-quiltt-link-complete creates one OR
 * connections row per linked quiltt_connection_id, so a single Profile can
 * host many bank links. The Quiltt connection_id arrives separately via
 * webhook events.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { QuilttProvider } from "@quiltt/react/providers";
import { useQuilttConnector, useQuilttInstitutions } from "@quiltt/react/hooks";
import { AlertTriangle, CheckCircle2, Loader2, Search } from "lucide-react";

interface InstitutionRow {
  id?: string;
  name?: string;
  logo?: { url?: string };
}

// Deterministic brand color for a bank tile when no logo is returned.
function tileColor(seed: string): string {
  const palette = [
    "bg-indigo-500",
    "bg-blue-500",
    "bg-purple-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-cyan-500",
    "bg-orange-500",
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

export const Route = createFileRoute("/connect/quiltt")({
  head: () => ({
    meta: [
      { title: "Connect your bank | OrangeRails" },
      {
        name: "description",
        content:
          "Link any US bank account through Quiltt (Finicity, MX, Akoya, Plaid). OrangeRails never sees your bank credentials.",
      },
    ],
  }),
  component: QuilttConnectPage,
});

interface FragmentParams {
  session_token: string | null;
  connector_id: string | null;
  platform_slug: string | null;
  app_user_id: string | null;
  widget_token: string | null;
  /**
   * Optional. When set (by the upstream picker's bank-tile click), the
   * Quiltt Connector opens pre-selected to this institution — the user
   * skips Quiltt's own picker and lands on the bank's login screen.
   * Accepts either a Quiltt institution ID or a free-text search term
   * per @quiltt/core's ConnectorSDKConnectOptions.institution contract.
   */
  institution: string | null;
}

function readFragmentParams(): FragmentParams {
  if (typeof window === "undefined") {
    return {
      session_token: null,
      connector_id: null,
      platform_slug: null,
      app_user_id: null,
      widget_token: null,
      institution: null,
    };
  }
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const sp = new URLSearchParams(hash);
  return {
    session_token: sp.get("session_token"),
    connector_id: sp.get("connector_id"),
    platform_slug: sp.get("platform_slug"),
    app_user_id: sp.get("app_user_id"),
    widget_token: sp.get("widget_token"),
    institution: sp.get("institution"),
  };
}

type Phase = "ready" | "completing" | "done" | "aborted" | "error";

function QuilttConnectPage() {
  const params = useMemo(() => readFragmentParams(), []);
  const haveAllParams =
    !!params.session_token &&
    !!params.connector_id &&
    !!params.platform_slug &&
    !!params.app_user_id &&
    !!params.widget_token;

  // Scrub the URL fragment immediately after we've captured the params.
  //
  // The fragment carries OWM-side ZKA keys (cred_key, txn_key — both raw
  // MEK-derived AES keys) plus the widget_token. While fragments never
  // reach a server, they DO sit in window.location.href where any script
  // on this origin can read them (including a browser extension with
  // tabs permission, or a stray third-party script we add later). If the
  // popup ever navigates away same-origin, they also land in browser
  // history. history.replaceState rewrites the visible URL to '#' so the
  // sensitive material is gone the moment the React component mounts.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.hash || window.location.hash === "#") return;
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      // Some embeddings (sandboxed iframes) reject replaceState — accept
      // the reduced posture rather than block the flow.
    }
  }, []);
  // Chromeless backdrop. We used to render a full card (header, footer,
  // terms, "Powered by OrangeRails") around Quiltt's iframe — but Quiltt's
  // modal renders ON TOP, leaving our chrome bleeding through behind/around
  // it. Founder feedback (2026-06-16): "Quiltt is inside OR popup" — the
  // intent is that the popup look like Quiltt's own UI, not a frame around
  // it. So the success path renders a blank backdrop and lets the Quiltt
  // connector own the visible surface.
  //
  // OR chrome ONLY appears on:
  //   - missing-params (integrator misconfiguration; needs the diagnostic)
  //   - error / aborted (so the user has a Try again button to act on)
  //   - exit-confirm overlay (Plaid-parity bail-out dialog)
  return (
    <div
      className="min-h-screen bg-white antialiased text-slate-900"
      style={{ colorScheme: "light" }}
    >
      {haveAllParams ? (
        <QuilttProvider token={params.session_token!}>
          <ConnectorPanel params={params} />
        </QuilttProvider>
      ) : (
        <div className="mx-auto w-full max-w-md px-4 py-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <MissingParamsView />
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectorPanel({ params }: { params: FragmentParams }) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Selected bank — set when the user clicks a tile from the inline
  // institution search. The Quiltt Connector receives `institution` so
  // it skips its own picker AND welcome screen, landing directly on the
  // bank's login form. Pre-set via fragment param when the upstream
  // integrator already knew which bank to open.
  const [selectedInstitution, setSelectedInstitution] = useState<InstitutionRow | null>(
    params.institution ? { id: params.institution } : null,
  );
  const autoOpenedRef = useRef(false);
  const autoCloseTimerRef = useRef<number | null>(null);

  const effectiveInstitutionId = selectedInstitution?.id ?? params.institution ?? undefined;

  // Imperative open — connector launches as soon as the user picks a bank
  // (or the integrator pre-selected one via the institution fragment param).
  const { open: openConnector } = useQuilttConnector(params.connector_id!, {
    institution: effectiveInstitutionId,
    onExitSuccess: (metadata) => {
      void completeLinkOnOR(metadata.connectionId);
    },
    onExitAbort: () => {
      // Drop the selection so the user lands back on the search step
      // instead of being stuck waiting for the connector to re-open.
      setSelectedInstitution(null);
      autoOpenedRef.current = false;
      setPhase("aborted");
    },
    onExitError: (metadata) => {
      setErrorMsg(
        `Quiltt reported an error during link (connectorId=${metadata.connectorId}). Try again or contact support.`,
      );
      setPhase("error");
    },
  });

  useEffect(() => {
    // Always auto-open the Quiltt connector when ready. Quiltt's own
    // iframe shows the institution picker — duplicating it in OR was
    // confusing the user (and consumed Quiltt mints on each keystroke).
    if (phase === "ready" && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      openConnector();
    }
  }, [phase, openConnector]);

  async function completeLinkOnOR(quilttConnectionId: string | undefined) {
    setPhase("completing");
    try {
      const supabaseUrl =
        (import.meta.env.VITE_SUPABASE_URL as string | undefined) ||
        "https://fzwmnzmtqidumdqjdddz.supabase.co";
      const resp = await fetch(`${supabaseUrl}/functions/v1/or-quiltt-link-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // keepalive: true keeps the request alive even if the popup window
        // closes before the response arrives (e.g. integrator calls popup.close()
        // immediately after onExitSuccess fires). Without this flag the browser
        // cancels the in-flight POST on page unload and no connection row is written.
        keepalive: true,
        body: JSON.stringify({
          platform_slug: params.platform_slug!,
          app_user_id: params.app_user_id!,
          widget_token: params.widget_token!,
          quiltt_connection_id: quilttConnectionId ?? undefined,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`or-quiltt-link-complete ${resp.status}: ${text.slice(0, 200)}`);
      }
      const completeJson = await resp.json().catch(() => ({}));
      const orConnectionId =
        typeof completeJson?.connection_id === "string" ? completeJson.connection_id : null;
      const orSubaccountId =
        typeof completeJson?.subaccount_id === "string" ? completeJson.subaccount_id : null;
      setPhase("done");
      if (window.opener) {
        // Pass everything the integrating app needs to (a) find the OR
        // connection row, (b) fetch the discovered accounts via
        // or-quiltt-accounts using the Quiltt connection id.
        window.opener.postMessage(
          {
            type: "OR_QUILTT_LINK_COMPLETE",
            quilttConnectionId: quilttConnectionId ?? null,
            orConnectionId,
            orSubaccountId,
            platformSlug: params.platform_slug,
            appUserId: params.app_user_id,
          },
          "*",
        );
        // Auto-close after a brief "Bank linked" beat — saves the user a click
        // and removes the dangling "Close window" CTA from the streamlined flow.
        autoCloseTimerRef.current = window.setTimeout(() => {
          window.close();
        }, 1200);
      }
    } catch (e) {
      console.error("[connect/quiltt] complete failed:", e);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  useEffect(() => {
    return () => {
      if (autoCloseTimerRef.current !== null) {
        window.clearTimeout(autoCloseTimerRef.current);
      }
    };
  }, []);

  // Notify the opener when the popup closes without completing the link.
  //
  // Three cases on unload:
  //   "done"       -- clean auto-close after OR_QUILTT_LINK_COMPLETE was sent; no message needed.
  //   "completing" -- the keepalive POST is guaranteed to be DELIVERED even if the popup closes,
  //                   but it is NOT guaranteed to be PROCESSED: the postMessage that reports
  //                   success runs after await resp.json(), in this same document, and that
  //                   continuation never runs once the document is gone. The link may well have
  //                   succeeded, so we must not claim it failed. Send a distinct message that
  //                   tells the opener the outcome is unknown, and let it reconcile.
  //   anything else -- genuine abandonment or error; opener cannot distinguish from silent failure,
  //                   so we send OR_QUILTT_POPUP_CLOSED_INCOMPLETE.
  useEffect(() => {
    function onPageHide() {
      if (phase === "done" || !window.opener) {
        return;
      }
      try {
        if (phase === "completing") {
          window.opener.postMessage(
            { type: "OR_QUILTT_POPUP_CLOSED_WHILE_COMPLETING" },
            "*",
          );
        } else {
          window.opener.postMessage(
            { type: "OR_QUILTT_POPUP_CLOSED_INCOMPLETE" },
            "*",
          );
        }
      } catch {
        // opener may be cross-origin in some embeddings; swallow silently.
      }
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [phase]);

  if (phase === "completing") {
    return (
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Saving your connection…
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-emerald-600">
          <CheckCircle2 className="h-5 w-5" />
          <strong>Bank connected!</strong>
        </div>
        <p className="text-xs text-slate-500">Returning you to your app…</p>
      </div>
    );
  }

  if (phase === "aborted") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-amber-600">
          <AlertTriangle className="h-5 w-5" />
          <strong>Link cancelled.</strong>
        </div>
        <p className="text-sm text-muted-foreground">
          You exited Quiltt before finishing. Click below to try again.
        </p>
        <button
          type="button"
          onClick={() => {
            autoOpenedRef.current = false;
            setPhase("ready");
          }}
          className="inline-flex items-center justify-center rounded-md border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Try again
        </button>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <strong>Link failed.</strong>
        </div>
        {errorMsg && (
          <pre className="overflow-x-auto rounded bg-muted/40 p-3 text-xs">{errorMsg}</pre>
        )}
        <button
          type="button"
          onClick={() => {
            autoOpenedRef.current = false;
            setErrorMsg(null);
            setPhase("ready");
          }}
          className="inline-flex items-center justify-center rounded-md border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Try again
        </button>
      </div>
    );
  }

  // phase === "ready"
  // Always show a loader — the Quiltt connector auto-opens above. The
  // inline OR search (BankSearchStep) has been retired because Quiltt's
  // own iframe shows the institution picker.
  return (
    <div className="flex items-center gap-3 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" />
      {selectedInstitution?.name ? `Opening ${selectedInstitution.name}…` : "Opening bank picker…"}
    </div>
  );
}

function BankSearchStep({
  connectorId,
  onPick,
}: {
  connectorId: string;
  onPick: (inst: InstitutionRow) => void;
}) {
  const [term, setTerm] = useState("");
  const { searchResults, isSearching, setSearchTerm } = useQuilttInstitutions(connectorId);

  useEffect(() => {
    setSearchTerm(term);
  }, [term, setSearchTerm]);

  const results = (Array.isArray(searchResults) ? searchResults : []) as InstitutionRow[];

  return (
    <div className="space-y-3">
      <label htmlFor="bank-search" className="block text-xs font-medium text-slate-600">
        Search your bank
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          id="bank-search"
          type="text"
          autoFocus
          autoComplete="off"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Chase, Bank of America, FinBank…"
          className="w-full rounded-md border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
        />
      </div>

      {term.trim().length < 2 && (
        <p className="text-[11px] text-slate-400">
          Type at least 2 characters to search Quiltt's institution catalog.
        </p>
      )}

      {term.trim().length >= 2 && isSearching && results.length === 0 && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Searching banks…
        </div>
      )}

      {term.trim().length >= 2 && !isSearching && results.length === 0 && (
        <p className="text-xs text-slate-500">
          No banks match "{term}". Try a shorter or different name.
        </p>
      )}

      {results.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {results.slice(0, 12).map((inst, i) => {
            const id = inst.id ?? "";
            const name = inst.name ?? "Unknown bank";
            const logoUrl = inst.logo?.url;
            // Quiltt's `institution` connector option accepts either an
            // institution id or a free-text search term per @quiltt/core's
            // ConnectorSDKConnectOptions.institution contract. Search
            // results from useQuilttInstitutions sometimes don't include
            // an id (Finicity Sandbox Bank is a known case), so fall
            // back to the name — Quiltt re-resolves it server-side.
            const pickValue = id || name;
            return (
              <button
                key={id || `inst-${i}`}
                type="button"
                onClick={() => pickValue && onPick({ id: pickValue, name, logo: inst.logo })}
                disabled={!pickValue}
                title={name}
                className="group flex h-24 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white p-2 text-center transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm disabled:opacity-50"
              >
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt=""
                    aria-hidden
                    className="h-10 w-10 shrink-0 rounded-lg object-contain shadow-sm"
                  />
                ) : (
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-bold text-white shadow-sm ${tileColor(id || name)}`}
                    aria-hidden
                  >
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="w-full truncate text-xs font-medium text-slate-900">{name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MissingParamsView() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-amber-600">
        <AlertTriangle className="h-5 w-5" />
        <strong>Missing link parameters</strong>
      </div>
      <p className="text-sm text-muted-foreground">
        This page expects to be opened by your integrating app with a Quiltt session token in the
        URL fragment. If you reached here directly, please start the link flow from inside your app.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">For integrators: expected fragment</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-muted/40 p-3 font-mono">{`#session_token=<jwt>
&connector_id=<conn_...>
&platform_slug=<slug>
&app_user_id=<your-user-id>
&widget_token=<uuid from or-link-mint-token>`}</pre>
      </details>
    </div>
  );
}
