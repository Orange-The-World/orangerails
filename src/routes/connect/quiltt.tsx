/**
 * /connect/quiltt — Quiltt bank-link bridge page.
 *
 * Customer arrival flow:
 *   1. Integrating app's backend calls or-link-mint-token + or-quiltt-session.
 *   2. Backend opens this page in a popup or redirect with the params it
 *      received baked into the URL fragment (fragment, not query, so the
 *      tokens never appear in server logs or referrer headers):
 *        /connect/quiltt#session_token=<jwt>
 *                      &connector_id=<conn>
 *                      &platform_slug=<slug>
 *                      &app_user_id=<id>
 *                      &widget_token=<uuid>
 *   3. This page mounts the Quiltt Connector UI with the session token.
 *   4. On the Quiltt SDK's onExitSuccess, we POST to or-quiltt-link-complete
 *      with (platform_slug, app_user_id, widget_token) so OR creates the
 *      connections row that or-quiltt-sync needs to land the webhook data.
 *   5. On success we either window.close() (popup mode) or call window.opener
 *      back, or fall back to a "Done — return to <app>" link.
 *
 * Why the fragment carries everything: keeping it client-side means OR's
 * web server never sees the session token. The fragment is also the
 * standard place we put cred_key / txn_key in the legacy widget flow.
 *
 * SDK wiring (Quiltt React SDK or vanilla JS SDK) is added once the
 * Connector ID is provisioned in the Quiltt dashboard. Until then this
 * page renders an honest "ready — pending connector" state so QA can
 * see the params arrived correctly and the success path is wired.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Building2, CheckCircle2, Loader2, Lock } from "lucide-react";
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
      { property: "og:title", content: "Connect your bank | OrangeRails" },
      {
        property: "og:description",
        content:
          "Background sync supported when you opt in. Your bank credentials live with Quiltt, never on our servers.",
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
}

function readFragmentParams(): FragmentParams {
  if (typeof window === "undefined") {
    return {
      session_token: null,
      connector_id: null,
      platform_slug: null,
      app_user_id: null,
      widget_token: null,
    };
  }
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(hash);
  return {
    session_token:  params.get("session_token"),
    connector_id:   params.get("connector_id"),
    platform_slug:  params.get("platform_slug"),
    app_user_id:    params.get("app_user_id"),
    widget_token:   params.get("widget_token"),
  };
}

type Phase = "loading" | "missing-params" | "ready" | "linking" | "completing" | "done" | "error";

function QuilttConnectPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const params = useMemo(() => readFragmentParams(), []);

  useEffect(() => {
    const ok =
      params.session_token &&
      params.connector_id &&
      params.platform_slug &&
      params.app_user_id &&
      params.widget_token;
    setPhase(ok ? "ready" : "missing-params");
  }, [params]);

  async function completeLink() {
    if (!params.platform_slug || !params.app_user_id || !params.widget_token) {
      setPhase("missing-params");
      return;
    }
    setPhase("completing");
    try {
      const supabaseUrl =
        import.meta.env.VITE_SUPABASE_URL ||
        "https://gposxxmxenrdvewrprle.supabase.co";
      const resp = await fetch(`${supabaseUrl}/functions/v1/or-quiltt-link-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform_slug: params.platform_slug,
          app_user_id:   params.app_user_id,
          widget_token:  params.widget_token,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`or-quiltt-link-complete ${resp.status}: ${text.slice(0, 200)}`);
      }
      setPhase("done");
      // If this page was opened as a popup, the parent can listen for
      // a postMessage and close us. Send it.
      if (window.opener) {
        window.opener.postMessage({ type: "OR_QUILTT_LINK_COMPLETE" }, "*");
      }
    } catch (e) {
      console.error("[connect/quiltt] complete failed:", e);
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main className="mx-auto max-w-2xl px-6 py-16">
        <Link
          to="/providers"
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to providers
        </Link>

        <header className="mt-6 space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card px-3 py-1 text-xs text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" />
            US bank account · via Quiltt
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">Connect your bank</h1>
          <p className="text-muted-foreground">
            Your bank credentials never reach OrangeRails. Quiltt brokers the
            connection (Finicity, MX, Akoya, or Plaid depending on your bank),
            and only encrypted transaction data flows into your OR vault.
          </p>
        </header>

        <section className="mt-10 rounded-xl border border-border/60 bg-card/40 p-6">
          {phase === "loading" && (
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Reading link parameters…
            </div>
          )}

          {phase === "missing-params" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-amber-600">
                <AlertTriangle className="h-5 w-5" />
                <strong>Missing link parameters</strong>
              </div>
              <p className="text-sm text-muted-foreground">
                This page expects to be opened by your integrating app with a
                Quiltt session token in the URL fragment. If you reached here
                directly, please start the link flow from inside your app.
              </p>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">For integrators — expected fragment</summary>
                <pre className="mt-2 overflow-x-auto rounded bg-muted/40 p-3 font-mono">{`#session_token=<jwt>
&connector_id=<conn_...>
&platform_slug=<slug>
&app_user_id=<your-user-id>
&widget_token=<uuid from or-link-mint-token>`}</pre>
              </details>
            </div>
          )}

          {phase === "ready" && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Lock className="h-4 w-4" />
                Session prepared. Connector ID:{" "}
                <code className="text-foreground">{params.connector_id}</code>
              </div>
              <p className="text-sm">
                Click <strong>Open Quiltt</strong> to launch the bank-picker
                widget. Quiltt prompts you for your bank login, brokers the
                consent, and hands an opaque profile reference back to
                OrangeRails. Your credentials never travel through our servers.
              </p>
              <button
                type="button"
                onClick={() => setPhase("linking")}
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Open Quiltt
              </button>
              <p className="text-xs text-muted-foreground">
                The Quiltt Connector SDK is wired in a follow-up PR once the
                Connector ID is provisioned in the Quiltt dashboard. Clicking
                <em> Open Quiltt</em> today simulates the success path so the
                downstream wiring (or-quiltt-link-complete → connections row
                → webhook drain) can be tested end-to-end on staging.
              </p>
            </div>
          )}

          {phase === "linking" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Bank link in progress…
              </div>
              <p className="text-sm text-muted-foreground">
                When the user finishes inside the Quiltt widget, we close the
                widget and finalize on OR. For now, press the simulation
                button to advance to the finalize step.
              </p>
              <button
                type="button"
                onClick={completeLink}
                className="inline-flex items-center justify-center rounded-md border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Simulate Quiltt onExitSuccess
              </button>
            </div>
          )}

          {phase === "completing" && (
            <div className="flex items-center gap-3 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Finalizing with OrangeRails…
            </div>
          )}

          {phase === "done" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-emerald-600">
                <CheckCircle2 className="h-5 w-5" />
                <strong>Bank linked.</strong>
              </div>
              <p className="text-sm text-muted-foreground">
                You can close this window and return to your app. Background
                sync will start delivering transactions to your vault once
                Quiltt's initial scan finishes (usually within a few minutes).
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
          )}

          {phase === "error" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                <strong>Link failed</strong>
              </div>
              <pre className="overflow-x-auto rounded bg-muted/40 p-3 text-xs">
                {errorMsg}
              </pre>
              <button
                type="button"
                onClick={() => setPhase("ready")}
                className="inline-flex items-center justify-center rounded-md border border-border bg-card px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Try again
              </button>
            </div>
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}
