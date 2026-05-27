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
import { useMemo, useState } from "react";
import { QuilttProvider } from "@quiltt/react/providers";
import { QuilttButton } from "@quiltt/react/components";
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  CheckCircle2,
  Loader2,
  Lock,
} from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";

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

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />
      <main className="mx-auto max-w-2xl px-6 py-16">
        <button
          type="button"
          onClick={() => {
            // If the user got here from the inline picker (typical), history.back()
            // returns them with their search term intact. Fallback to /providers
            // when there's no history (direct link from an integrator).
            if (window.history.length > 1) {
              window.history.back();
            } else {
              window.location.assign("/providers");
            }
          }}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>

        <header className="mt-6 space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1 text-xs text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" />
            US bank account · via Quiltt
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">
            Connect your bank
          </h1>
          <p className="text-muted-foreground">
            Your bank credentials never reach OrangeRails. Quiltt brokers the
            connection (Finicity, MX, Akoya, or Plaid depending on your bank),
            and only encrypted transaction data flows into your OR vault.
          </p>
        </header>

        <section className="mt-10 rounded-xl border border-border/60 bg-card/40 p-6">
          {haveAllParams ? (
            <QuilttProvider token={params.session_token!}>
              <ConnectorPanel params={params} />
            </QuilttProvider>
          ) : (
            <MissingParamsView />
          )}
        </section>
      </main>
      <Footer />
    </div>
  );
}

function ConnectorPanel({ params }: { params: FragmentParams }) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function completeLinkOnOR(connectionId: string | undefined) {
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
      setPhase("done");
      if (window.opener) {
        window.opener.postMessage(
          { type: "OR_QUILTT_LINK_COMPLETE", connectionId: connectionId ?? null },
          "*",
        );
      }
    } catch (e) {
      console.error("[connect/quiltt] complete failed:", e);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

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
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-emerald-600">
          <CheckCircle2 className="h-5 w-5" />
          <strong>Bank linked.</strong>
        </div>
        <p className="text-sm text-muted-foreground">
          You can close this window and return to your app. Background sync
          will start delivering transactions to your vault once Quiltt's
          initial scan finishes (usually within a few minutes).
        </p>
        {typeof window !== "undefined" && window.opener && (
          <button
            type="button"
            onClick={() => window.close()}
            className="inline-flex items-center justify-center rounded-md border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Close window
          </button>
        )}
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
          onClick={() => setPhase("ready")}
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
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Lock className="h-4 w-4" />
        Quiltt session prepared. Connector{" "}
        <code className="text-foreground">{params.connector_id}</code>
      </div>
      <p className="text-sm">
        Click <strong>Open Quiltt</strong> to launch the bank-picker widget.
        Quiltt prompts you for your bank login, brokers the consent, and hands
        an opaque profile reference back to OrangeRails. Your credentials
        never travel through our servers.
      </p>
      <QuilttButton
        connectorId={params.connector_id!}
        institution={params.institution ?? undefined}
        onExitSuccess={(metadata) => {
          void completeLinkOnOR(metadata.connectionId);
        }}
        onExitAbort={() => {
          setPhase("aborted");
        }}
        onExitError={(metadata) => {
          setErrorMsg(
            `Quiltt reported an error during link (connectorId=${metadata.connectorId}). Try again or contact support.`,
          );
          setPhase("error");
        }}
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Open Quiltt
      </QuilttButton>
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
