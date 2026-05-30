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
 * because one OR connections row covers all Quiltt links for a Profile (Phase
 * 1 design). The Quiltt connection_id arrives separately via webhook events.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { QuilttProvider } from "@quiltt/react/providers";
import { useQuilttConnector } from "@quiltt/react/hooks";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  Loader2,
} from "lucide-react";

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
    connector_id:  sp.get("connector_id"),
    platform_slug: sp.get("platform_slug"),
    app_user_id:   sp.get("app_user_id"),
    widget_token:  sp.get("widget_token"),
    institution:   sp.get("institution"),
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

  // Tight popup-style chrome matching /connect. No marketing Navbar/Footer
  // — this page is opened inside an integrator's popup window, not browsed
  // to. Light theme hardcoded so it stays consistent regardless of the
  // embedding page's theme.
  return (
    <div
      className="min-h-screen bg-slate-50 px-4 py-6 antialiased text-slate-900"
      style={{ colorScheme: "light" }}
    >
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <button
            type="button"
            onClick={() => {
              if (window.history.length > 1) {
                window.history.back();
              } else {
                window.location.assign("/providers");
              }
            }}
            className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>

          <header className="mt-4 space-y-1.5">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] text-slate-500">
              <Building2 className="h-3 w-3" />
              US bank account · via Quiltt
            </div>
            <h1 className="text-base font-semibold text-slate-900">
              Connect your bank
            </h1>
            <p className="text-xs text-slate-500">
              Your bank credentials never reach OrangeRails. Only encrypted
              transaction data flows into your vault.
            </p>
          </header>

          <section className="mt-4">
            {haveAllParams ? (
              <QuilttProvider token={params.session_token!}>
                <ConnectorPanel params={params} />
              </QuilttProvider>
            ) : (
              <MissingParamsView />
            )}
          </section>

          <div className="mt-6 border-t border-slate-100 pt-4 text-center text-[11px] text-slate-400">
            <p>
              By continuing you agree to OrangeRails's{" "}
              <a
                href="/terms"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-slate-600"
              >
                Terms
              </a>
              {" "}and{" "}
              <a
                href="/privacy"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-slate-600"
              >
                Privacy Policy
              </a>
              .
            </p>
            <p className="mt-2 flex items-center justify-center gap-1.5">
              <span>Powered by</span>
              <span className="font-semibold text-slate-500">OrangeRails</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ConnectorPanel({ params }: { params: FragmentParams }) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const autoOpenedRef = useRef(false);
  const autoCloseTimerRef = useRef<number | null>(null);

  // Imperative open — skip the user clicking "Open Quiltt"; the connector
  // launches as soon as the session is ready. Cuts one window from the flow.
  const { open: openConnector } = useQuilttConnector(params.connector_id!, {
    institution: params.institution ?? undefined,
    onExitSuccess: (metadata) => {
      void completeLinkOnOR(metadata.connectionId);
    },
    onExitAbort: () => {
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
        "https://gposxxmxenrdvewrprle.supabase.co";
      const resp = await fetch(
        `${supabaseUrl}/functions/v1/or-quiltt-link-complete`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform_slug: params.platform_slug!,
            app_user_id:   params.app_user_id!,
            widget_token:  params.widget_token!,
          }),
        },
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(
          `or-quiltt-link-complete ${resp.status}: ${text.slice(0, 200)}`,
        );
      }
      const completeJson = await resp.json().catch(() => ({}));
      const orConnectionId = typeof completeJson?.connection_id === "string"
        ? completeJson.connection_id : null;
      const orSubaccountId = typeof completeJson?.subaccount_id === "string"
        ? completeJson.subaccount_id : null;
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
            appUserId:    params.app_user_id,
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

  if (phase === "completing") {
    return (
      <div className="flex items-center gap-3 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Finalizing with OrangeRails…
      </div>
    );
  }

  if (phase === "done") {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-emerald-600">
          <CheckCircle2 className="h-5 w-5" />
          <strong>Bank linked.</strong>
        </div>
        <p className="text-xs text-slate-500">
          Returning you to your app…
        </p>
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
          <pre className="overflow-x-auto rounded bg-muted/40 p-3 text-xs">
            {errorMsg}
          </pre>
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

  // phase === "ready" — connector auto-opens via useEffect, no button click.
  return (
    <div className="flex items-center gap-3 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" />
      Opening secure bank picker…
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
        This page expects to be opened by your integrating app with a Quiltt
        session token in the URL fragment. If you reached here directly,
        please start the link flow from inside your app.
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          For integrators — expected fragment
        </summary>
        <pre className="mt-2 overflow-x-auto rounded bg-muted/40 p-3 font-mono">{`#session_token=<jwt>
&connector_id=<conn_...>
&platform_slug=<slug>
&app_user_id=<your-user-id>
&widget_token=<uuid from or-link-mint-token>`}</pre>
      </details>
    </div>
  );
}
