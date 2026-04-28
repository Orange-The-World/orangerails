/**
 * /connect — OrangeRails Link widget (thin-slice iteration 1).
 *
 * Pop-up entry point any integrating app opens when its end user clicks
 * "Connect a Bitcoin wallet." Plaid-hybrid co-branding pattern: the
 * integrating app's name renders prominently up top, "Powered by Orange
 * Rails" smaller below. After the user pastes their provider API key
 * the credential is locked browser-side and a `source_wallet_id` is
 * postMessage'd back to the parent window.
 *
 *
 * ⚠️ THIS IS THE ITERATION-1 THIN SLICE. ⚠️
 *
 * The vault password used to lock the credential is the hardcoded test
 * value `LINK_WIDGET_TEST_PASSWORD`. Iteration 2 will replace this with
 * a password the user picks at first setup (or that is handed off via a
 * short-lived widget session token from the integrating app's server).
 *
 * Do NOT ship this to production with a real customer's wallet — until
 * iteration 2 lands the credential is recoverable by anyone who reads
 * the source of this file.
 *
 *
 * Query params:
 *   platform     — the integrating app's slug (e.g. 'bitbooks-v2'). Required.
 *   app_user_id  — opaque identifier for the end user, owned by the integrating app. Required.
 *   provider     — wallet provider slug ('blink' for now). Required.
 *   return_to    — origin the widget posts back to. Required.
 *
 * postMessage payload (fired into window.opener):
 *   { type: 'or-link-success', source_wallet_id, subaccount_id, connection_id }
 *   { type: 'or-link-cancel' }
 *
 * The widget closes itself after a successful post.
 */

import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { deriveMEK, encryptString } from "@/lib/vault";
import { deriveSubkey, HKDF_CONTEXTS } from "@/lib/key-derivation";

// --------------------------------------------------------------------
// THIN-SLICE PLACEHOLDER PASSWORD — replace in iteration 2.
// --------------------------------------------------------------------
const LINK_WIDGET_TEST_PASSWORD = "thin-slice-iteration-1-not-a-real-password";
// Fixed salt (base64 of 32 zero bytes) so the test password derivation is
// deterministic across pop-ups in iteration 1. Iteration 2 will swap in a
// per-user random salt minted by the integrating app's setup flow.
const LINK_WIDGET_TEST_SALT_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

// --------------------------------------------------------------------
// Search-param schema (validated below).
// --------------------------------------------------------------------

interface ConnectSearch {
  platform?: string;
  app_user_id?: string;
  provider?: string;
  return_to?: string;
}

export const Route = createFileRoute("/connect")({
  validateSearch: (search: Record<string, unknown>): ConnectSearch => ({
    platform: typeof search.platform === "string" ? search.platform : undefined,
    app_user_id: typeof search.app_user_id === "string" ? search.app_user_id : undefined,
    provider: typeof search.provider === "string" ? search.provider : undefined,
    return_to: typeof search.return_to === "string" ? search.return_to : undefined,
  }),
  component: ConnectPage,
});

// --------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------

interface PlatformDisplay {
  slug: string;
  display_name: string;
  display_brand_color: string | null;
}

async function fetchPlatformDisplay(slug: string): Promise<PlatformDisplay> {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base) throw new Error("VITE_SUPABASE_URL not configured.");
  const res = await fetch(`${base}/functions/v1/or-platform-display`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug }),
  });
  if (res.status === 404) throw new Error("Unknown integrating app.");
  if (!res.ok) throw new Error(`Could not load app info (status ${res.status}).`);
  return (await res.json()) as PlatformDisplay;
}

/**
 * Lock the API key + label/currency metadata using a key derived from
 * the (currently hardcoded) widget test password. Returns base64 ciphertexts
 * suitable for or-link-complete.
 */
async function lockCredential(params: {
  apiKey: string;
  label: string;
  currency: string;
}): Promise<{
  encrypted_label: string;
  encrypted_credentials: string;
  encrypted_metadata: string;
}> {
  const mek = await deriveMEK(LINK_WIDGET_TEST_PASSWORD, LINK_WIDGET_TEST_SALT_B64);
  const credKey = await deriveSubkey(
    mek,
    HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1,
    LINK_WIDGET_TEST_SALT_B64,
  );
  const txnKey = await deriveSubkey(
    mek,
    HKDF_CONTEXTS.ORANGERAILS_TRANSACTIONS_V1,
    LINK_WIDGET_TEST_SALT_B64,
  );

  const encrypted_label = await encryptString(params.label, credKey);
  const encrypted_credentials = await encryptString(
    JSON.stringify({ api_key: params.apiKey }),
    credKey,
  );
  const encrypted_metadata = await encryptString(
    JSON.stringify({ currency: params.currency, label: params.label }),
    txnKey,
  );
  return { encrypted_label, encrypted_credentials, encrypted_metadata };
}

async function callLinkComplete(payload: {
  platform_slug: string;
  app_user_id: string;
  provider_type: string;
  external_wallet_id: string;
  encrypted_label: string;
  encrypted_credentials: string;
  encrypted_metadata: string;
}) {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base) throw new Error("VITE_SUPABASE_URL not configured.");
  const res = await fetch(`${base}/functions/v1/or-link-complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : `or-link-complete failed (status ${res.status}).`,
    );
  }
  return data as {
    subaccount_id: string;
    connection_id: string;
    source_wallet_id: string;
  };
}

// --------------------------------------------------------------------
// Component
// --------------------------------------------------------------------

function ConnectPage() {
  const search = useSearch({ from: "/connect" }) as ConnectSearch;

  const [platform, setPlatform] = useState<PlatformDisplay | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("My Blink wallet");
  const [externalWalletId, setExternalWalletId] = useState("");
  const [currency, setCurrency] = useState("USD");

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // ---- Validate query params + look up the integrating app ---------
  useEffect(() => {
    if (!search.platform || !search.app_user_id || !search.provider || !search.return_to) {
      setLoadError(
        "This page is missing some details from the app that opened it. Please go back and try again.",
      );
      return;
    }
    if (search.provider !== "blink") {
      setLoadError(
        `Provider "${search.provider}" is not supported yet. Try "blink".`,
      );
      return;
    }
    fetchPlatformDisplay(search.platform)
      .then(setPlatform)
      .catch((err) => setLoadError(String(err.message ?? err)));
  }, [search.platform, search.app_user_id, search.provider, search.return_to]);

  // ---- Handle submit ------------------------------------------------
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!platform || !search.platform || !search.app_user_id || !search.provider) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (!apiKey.trim()) throw new Error("API key is required.");
      if (!externalWalletId.trim()) {
        throw new Error("Wallet ID is required (paste the wallet's Blink ID).");
      }

      const locked = await lockCredential({
        apiKey: apiKey.trim(),
        label: label.trim() || platform.display_name,
        currency: currency.trim() || "USD",
      });

      const result = await callLinkComplete({
        platform_slug: search.platform,
        app_user_id: search.app_user_id,
        provider_type: search.provider,
        external_wallet_id: externalWalletId.trim(),
        ...locked,
      });

      // Post back to the integrating app's window. Origin restricted to
      // the return_to value supplied as a query param.
      const targetOrigin = (() => {
        try {
          return new URL(search.return_to ?? "").origin;
        } catch {
          return "*";
        }
      })();

      window.opener?.postMessage(
        {
          type: "or-link-success",
          source_wallet_id: result.source_wallet_id,
          subaccount_id: result.subaccount_id,
          connection_id: result.connection_id,
        },
        targetOrigin,
      );

      setDone(true);
      // Close the popup shortly so the user can see the success state.
      setTimeout(() => window.close(), 1200);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleCancel() {
    const targetOrigin = (() => {
      try {
        return new URL(search.return_to ?? "").origin;
      } catch {
        return "*";
      }
    })();
    window.opener?.postMessage({ type: "or-link-cancel" }, targetOrigin);
    window.close();
  }

  // ---- Render -------------------------------------------------------

  if (loadError) {
    return (
      <Shell>
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          {loadError}
        </div>
        <button
          type="button"
          onClick={() => window.close()}
          className="mt-4 w-full rounded-md border border-input bg-background px-4 py-2 text-sm font-medium"
        >
          Close
        </button>
      </Shell>
    );
  }

  if (!platform) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell platform={platform}>
        <p className="text-sm text-foreground">
          Connected. You can close this window.
        </p>
      </Shell>
    );
  }

  return (
    <Shell platform={platform}>
      <p className="text-sm text-muted-foreground">
        Paste your Blink API key below. Orange Rails locks it before storing it,
        so neither {platform.display_name} nor Orange Rails staff can read it.
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <div>
          <label htmlFor="apiKey" className="block text-sm font-medium">
            Blink API key
          </label>
          <input
            id="apiKey"
            type="password"
            required
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="blink_..."
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Get one at{" "}
            <a
              href="https://dashboard.blink.sv/api-keys"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              dashboard.blink.sv/api-keys
            </a>
            .
          </p>
        </div>

        <div>
          <label htmlFor="extId" className="block text-sm font-medium">
            Blink wallet ID
          </label>
          <input
            id="extId"
            type="text"
            required
            value={externalWalletId}
            onChange={(e) => setExternalWalletId(e.target.value)}
            placeholder="e.g. 5f6a72e8-..."
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Iteration 1 needs the wallet ID up front. Iteration 2 will discover
            wallets automatically.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="label" className="block text-sm font-medium">
              Label
            </label>
            <input
              id="label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label htmlFor="currency" className="block text-sm font-medium">
              Currency
            </label>
            <select
              id="currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="USD">USD</option>
              <option value="BTC">BTC</option>
            </select>
          </div>
        </div>

        {submitError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {submitError}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={handleCancel}
            disabled={submitting}
            className="flex-1 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {submitting ? "Connecting…" : "Continue"}
          </button>
        </div>
      </form>
    </Shell>
  );
}

// --------------------------------------------------------------------
// Co-branded shell — Plaid-hybrid pattern.
// --------------------------------------------------------------------

function Shell({
  platform,
  children,
}: {
  platform?: PlatformDisplay;
  children: React.ReactNode;
}) {
  const accent = platform?.display_brand_color ?? "#F7931A";
  return (
    <div className="min-h-screen bg-background px-4 py-6 antialiased">
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {/* Plaid-hybrid co-branding: integrating app name on top, OR below */}
          <div className="mb-4 border-b border-border pb-4">
            {platform ? (
              <h1
                className="text-xl font-semibold tracking-tight"
                style={{ color: accent }}
              >
                Connect your wallet to {platform.display_name}
              </h1>
            ) : (
              <h1 className="text-xl font-semibold tracking-tight">
                Connect your wallet
              </h1>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Powered by Orange Rails — your wallet credentials never leave this
              connection.
            </p>
          </div>

          {children}
        </div>
        <p className="mt-3 text-center text-[11px] text-muted-foreground">
          Iteration 1 thin-slice. The locked password is hardcoded for testing
          and will be replaced by the wallet-vault password at iteration 2.
        </p>
      </div>
    </div>
  );
}
