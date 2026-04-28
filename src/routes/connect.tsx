/**
 * /connect — OrangeRails Link widget.
 *
 * Pop-up entry point any integrating app opens when its end user clicks
 * "Connect a Bitcoin wallet." Plaid-hybrid co-branding pattern: the
 * integrating app's name renders prominently up top, "Powered by Orange
 * Rails" smaller below.
 *
 * Three-step flow (matches V3 Connections.tsx):
 *   1. Paste the provider API key.
 *   2. Discover the wallets that key can see.
 *   3. Tick which wallets to track and finish.
 *
 * After the user finishes, the credential is locked browser-side and an
 * array of source_wallet_ids is postMessage'd back to the parent window.
 *
 * Internal note (not shown to users): the locking password is currently a
 * fixed widget-side constant. A future hardening pass will replace it
 * with a password the user picks at first setup or hand off via a
 * short-lived widget session token from the integrating app's server.
 *
 * Query params:
 *   platform     — the integrating app's slug (e.g. 'bitbooks-v2'). Required.
 *   app_user_id  — opaque identifier for the end user, owned by the integrating app. Required.
 *   provider     — wallet provider slug ('blink' for now). Required.
 *   return_to    — origin the widget posts back to. Required.
 *
 * postMessage payload (fired into window.opener):
 *   {
 *     type: 'or-link-success',
 *     source_wallets: [{ id, external_wallet_id, currency, label }, ...],
 *     subaccount_id, connection_id,
 *     // Backward-compat fields (single-wallet v1 widget shape) included
 *     // when exactly one wallet was picked, so older parent listeners
 *     // continue to work during the transition.
 *     sourceWalletId?, currency?, walletName?, externalId?,
 *   }
 *   { type: 'or-link-cancel' }
 *
 * The widget closes itself after a successful post.
 */

import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { deriveMEK, encryptString } from "@/lib/vault";
import { deriveSubkey, HKDF_CONTEXTS } from "@/lib/key-derivation";

// --------------------------------------------------------------------
// Internal locking-password constant. NEVER displayed to users.
// A future hardening pass will replace this with a real per-user secret.
// --------------------------------------------------------------------
const LINK_WIDGET_LOCK_PASSWORD = "orangerails-widget-default-lock-password-v1";
// Fixed salt (base64 of 32 zero bytes) so the locking derivation is
// deterministic across pop-ups for the same user. Future hardening will
// swap in a per-user random salt minted at first setup.
const LINK_WIDGET_LOCK_SALT_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

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
// Provider-agnostic discovered-wallet shape.
// --------------------------------------------------------------------

interface DiscoveredWallet {
  external_wallet_id: string;
  currency: string;
  label?: string;
}

// --------------------------------------------------------------------
// Platform display lookup (co-branding).
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

// --------------------------------------------------------------------
// Per-provider wallet discovery. Runs entirely in the browser — the
// pasted API key never touches our server in plaintext. Blink today;
// new providers register here.
// --------------------------------------------------------------------

const BLINK_API = "https://api.blink.sv/graphql";

const BLINK_DISCOVER_QUERY = `
  query DiscoverWallets {
    me {
      defaultAccount {
        wallets {
          id
          walletCurrency
        }
      }
    }
  }
`;

async function discoverBlinkWallets(apiKey: string): Promise<DiscoveredWallet[]> {
  const res = await fetch(BLINK_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
    body: JSON.stringify({ query: BLINK_DISCOVER_QUERY }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`That key did not work with Blink (${res.status}). ${detail}`);
  }
  const json = (await res.json()) as {
    data?: {
      me?: { defaultAccount?: { wallets?: Array<{ id: string; walletCurrency: string }> } };
    };
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(`Blink rejected the key: ${json.errors[0].message}`);
  }
  const wallets = json.data?.me?.defaultAccount?.wallets;
  if (!Array.isArray(wallets)) {
    throw new Error("Blink returned no wallet data for that key.");
  }
  return wallets.map((w) => ({
    external_wallet_id: w.id,
    currency: w.walletCurrency,
  }));
}

const DISCOVERERS: Record<string, (apiKey: string) => Promise<DiscoveredWallet[]>> = {
  blink: discoverBlinkWallets,
};

// --------------------------------------------------------------------
// Locking helpers — every ciphertext sent to the server is produced here.
// --------------------------------------------------------------------

interface LockedConnection {
  encrypted_label: string;
  encrypted_credentials: string;
  walletCiphertexts: Array<{
    external_wallet_id: string;
    encrypted_metadata: string;
    currency: string;
    label: string;
  }>;
}

async function lockEverything(params: {
  apiKey: string;
  connectionLabel: string;
  picks: DiscoveredWallet[];
}): Promise<LockedConnection> {
  const mek = await deriveMEK(LINK_WIDGET_LOCK_PASSWORD, LINK_WIDGET_LOCK_SALT_B64);
  const credKey = await deriveSubkey(
    mek,
    HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1,
    LINK_WIDGET_LOCK_SALT_B64,
  );
  const txnKey = await deriveSubkey(
    mek,
    HKDF_CONTEXTS.ORANGERAILS_TRANSACTIONS_V1,
    LINK_WIDGET_LOCK_SALT_B64,
  );

  const encrypted_label = await encryptString(params.connectionLabel, credKey);
  const encrypted_credentials = await encryptString(
    JSON.stringify({ api_key: params.apiKey }),
    credKey,
  );

  const walletCiphertexts = await Promise.all(
    params.picks.map(async (w) => {
      const label = w.label ?? defaultWalletLabel(w);
      const encrypted_metadata = await encryptString(
        JSON.stringify({ currency: w.currency, label }),
        txnKey,
      );
      return {
        external_wallet_id: w.external_wallet_id,
        encrypted_metadata,
        currency: w.currency,
        label,
      };
    }),
  );

  return { encrypted_label, encrypted_credentials, walletCiphertexts };
}

function defaultWalletLabel(w: DiscoveredWallet): string {
  if (w.label) return w.label;
  if (w.currency) return `${w.currency} wallet`;
  return "Bitcoin wallet";
}

// --------------------------------------------------------------------
// Server round-trip.
// --------------------------------------------------------------------

async function callLinkComplete(payload: {
  platform_slug: string;
  app_user_id: string;
  provider_type: string;
  encrypted_label: string;
  encrypted_credentials: string;
  wallets: Array<{ external_wallet_id: string; encrypted_metadata: string }>;
}): Promise<{
  subaccount_id: string;
  connection_id: string;
  source_wallets: Array<{ id: string; external_wallet_id: string }>;
}> {
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
        : `Could not save the connection (status ${res.status}).`,
    );
  }
  return data as {
    subaccount_id: string;
    connection_id: string;
    source_wallets: Array<{ id: string; external_wallet_id: string }>;
  };
}

// --------------------------------------------------------------------
// Component
// --------------------------------------------------------------------

type Step = "paste-key" | "discovering" | "pick-wallets" | "saving" | "done";

function ConnectPage() {
  const search = useSearch({ from: "/connect" }) as ConnectSearch;

  const [platform, setPlatform] = useState<PlatformDisplay | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Flow state
  const [step, setStep] = useState<Step>("paste-key");
  const [apiKey, setApiKey] = useState("");
  const [discovered, setDiscovered] = useState<DiscoveredWallet[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const providerLabel = useMemo(() => {
    if (search.provider === "blink") return "Blink";
    return search.provider ?? "your provider";
  }, [search.provider]);

  // ---- Validate query params + look up the integrating app ---------
  useEffect(() => {
    if (!search.platform || !search.app_user_id || !search.provider || !search.return_to) {
      setLoadError(
        "This page is missing some details from the app that opened it. Please go back and try again.",
      );
      return;
    }
    if (!DISCOVERERS[search.provider]) {
      setLoadError(`Provider "${search.provider}" is not supported yet.`);
      return;
    }
    fetchPlatformDisplay(search.platform)
      .then(setPlatform)
      .catch((err) => setLoadError(String(err.message ?? err)));
  }, [search.platform, search.app_user_id, search.provider, search.return_to]);

  // ---- Step 1 → 2: paste key, discover wallets --------------------
  async function handleContinueFromKey(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim() || !search.provider) return;
    setError(null);
    setStep("discovering");
    try {
      const discoverFn = DISCOVERERS[search.provider];
      if (!discoverFn) throw new Error(`Provider "${search.provider}" is not supported yet.`);
      const result = await discoverFn(apiKey.trim());
      if (result.length === 0) {
        throw new Error("That account has no wallets to track yet.");
      }
      setDiscovered(result);
      // Default: every wallet ticked.
      setSelectedIds(new Set(result.map((w) => w.external_wallet_id)));
      setStep("pick-wallets");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("paste-key");
    }
  }

  function toggleWallet(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ---- Step 2 → 3: lock + save ------------------------------------
  async function handleConfirmPicks() {
    if (!platform || !search.platform || !search.app_user_id || !search.provider) return;
    const picks = discovered.filter((w) => selectedIds.has(w.external_wallet_id));
    if (picks.length === 0) {
      setError("Pick at least one wallet to continue.");
      return;
    }
    setError(null);
    setStep("saving");
    try {
      const locked = await lockEverything({
        apiKey: apiKey.trim(),
        connectionLabel: platform.display_name,
        picks,
      });

      const result = await callLinkComplete({
        platform_slug: search.platform,
        app_user_id: search.app_user_id,
        provider_type: search.provider,
        encrypted_label: locked.encrypted_label,
        encrypted_credentials: locked.encrypted_credentials,
        wallets: locked.walletCiphertexts.map((w) => ({
          external_wallet_id: w.external_wallet_id,
          encrypted_metadata: w.encrypted_metadata,
        })),
      });

      // Compose the postMessage payload, attaching the user-facing
      // currency + label for each wallet so the integrating app can
      // render them without re-decrypting.
      const enrichedSourceWallets = result.source_wallets.map((sw) => {
        const meta = locked.walletCiphertexts.find(
          (w) => w.external_wallet_id === sw.external_wallet_id,
        );
        return {
          id: sw.id,
          external_wallet_id: sw.external_wallet_id,
          currency: meta?.currency ?? "",
          label: meta?.label ?? "",
        };
      });

      const targetOrigin = (() => {
        try {
          return new URL(search.return_to ?? "").origin;
        } catch {
          return "*";
        }
      })();

      // New shape — array of source_wallets. Older parent listeners that
      // expect single-wallet fields are still served when N === 1.
      const successPayload: Record<string, unknown> = {
        type: "or-link-success",
        source_wallets: enrichedSourceWallets,
        subaccount_id: result.subaccount_id,
        connection_id: result.connection_id,
      };
      if (enrichedSourceWallets.length === 1) {
        const only = enrichedSourceWallets[0];
        successPayload.sourceWalletId = only.id;
        successPayload.currency = only.currency;
        successPayload.walletName = only.label;
        successPayload.externalId = only.external_wallet_id;
      }

      window.opener?.postMessage(successPayload, targetOrigin);

      setStep("done");
      setTimeout(() => window.close(), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("pick-wallets");
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

  if (step === "done") {
    return (
      <Shell platform={platform}>
        <StepDots step={3} />
        <p className="mt-4 text-sm text-foreground">Connected. You can close this window.</p>
      </Shell>
    );
  }

  return (
    <Shell platform={platform}>
      <StepDots
        step={step === "paste-key" ? 1 : step === "discovering" || step === "pick-wallets" ? 2 : 3}
      />

      {step === "paste-key" && (
        <PasteKeyStep
          providerLabel={providerLabel}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          onContinue={handleContinueFromKey}
          onCancel={handleCancel}
          error={error}
        />
      )}

      {step === "discovering" && <DiscoveringStep providerLabel={providerLabel} />}

      {step === "pick-wallets" && (
        <PickWalletsStep
          providerLabel={providerLabel}
          platformName={platform.display_name}
          discovered={discovered}
          selectedIds={selectedIds}
          onToggle={toggleWallet}
          onBack={() => {
            setError(null);
            setStep("paste-key");
          }}
          onConfirm={handleConfirmPicks}
          error={error}
          submitting={false}
        />
      )}

      {step === "saving" && (
        <PickWalletsStep
          providerLabel={providerLabel}
          platformName={platform.display_name}
          discovered={discovered}
          selectedIds={selectedIds}
          onToggle={() => {}}
          onBack={() => {}}
          onConfirm={() => {}}
          error={null}
          submitting
        />
      )}
    </Shell>
  );
}

// --------------------------------------------------------------------
// Step 1 — paste API key
// --------------------------------------------------------------------

function PasteKeyStep({
  providerLabel,
  apiKey,
  onApiKeyChange,
  onContinue,
  onCancel,
  error,
}: {
  providerLabel: string;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  onContinue: (e: React.FormEvent) => void;
  onCancel: () => void;
  error: string | null;
}) {
  return (
    <form onSubmit={onContinue} className="mt-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Paste your {providerLabel} API key</h2>
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
        <label htmlFor="apiKey" className="block text-sm font-medium">
          {providerLabel} API key
        </label>
        <input
          id="apiKey"
          type="password"
          required
          autoComplete="off"
          value={apiKey}
          onChange={(e) => onApiKeyChange(e.target.value)}
          placeholder="Paste the key you just copied"
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Your key is locked in this browser before it leaves. Orange Rails stores only the locked
          version and cannot read it.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!apiKey.trim()}
          className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------------
// Step 2a — discovering spinner
// --------------------------------------------------------------------

function DiscoveringStep({ providerLabel }: { providerLabel: string }) {
  return (
    <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
      <Spinner />
      <p className="text-sm text-muted-foreground">Looking for your wallets on {providerLabel}…</p>
    </div>
  );
}

// --------------------------------------------------------------------
// Step 2b / 3 — pick wallets + confirm
// --------------------------------------------------------------------

function PickWalletsStep({
  providerLabel,
  platformName,
  discovered,
  selectedIds,
  onToggle,
  onBack,
  onConfirm,
  error,
  submitting,
}: {
  providerLabel: string;
  platformName: string;
  discovered: DiscoveredWallet[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  error: string | null;
  submitting: boolean;
}) {
  const count = selectedIds.size;
  return (
    <div className="mt-4 space-y-4">
      <div>
        <h2 className="text-sm font-semibold">
          Found {discovered.length} {discovered.length === 1 ? "wallet" : "wallets"} on{" "}
          {providerLabel}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick which ones you want {platformName} to track.
        </p>
      </div>

      <div className="space-y-2">
        {discovered.map((w) => {
          const checked = selectedIds.has(w.external_wallet_id);
          return (
            <label
              key={w.external_wallet_id}
              className={[
                "flex cursor-pointer items-center gap-3 rounded-md border p-3 transition-colors",
                checked ? "border-primary/40 bg-primary/5" : "border-input hover:bg-muted/30",
              ].join(" ")}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(w.external_wallet_id)}
                disabled={submitting}
                className="h-4 w-4 accent-primary"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{w.label || `${w.currency} wallet`}</div>
                <div className="text-xs text-muted-foreground">{w.currency || "Wallet"}</div>
              </div>
            </label>
          );
        })}
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="flex-1 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting || count === 0}
          className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {submitting ? (
            <span className="inline-flex items-center justify-center gap-2">
              <Spinner small />
              Saving…
            </span>
          ) : (
            <>
              Connect {count} {count === 1 ? "wallet" : "wallets"} to {platformName}
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Co-branded shell — Plaid-hybrid pattern.
// --------------------------------------------------------------------

function Shell({ platform, children }: { platform?: PlatformDisplay; children: React.ReactNode }) {
  const accent = platform?.display_brand_color ?? "#F7931A";
  return (
    <div className="min-h-screen bg-background px-4 py-6 antialiased">
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          {/* Plaid-hybrid co-branding: integrating app name on top, OR below */}
          <div className="mb-4 border-b border-border pb-4">
            {platform ? (
              <h1 className="text-xl font-semibold tracking-tight" style={{ color: accent }}>
                Connect your wallet to {platform.display_name}
              </h1>
            ) : (
              <h1 className="text-xl font-semibold tracking-tight">Connect your wallet</h1>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Powered by Orange Rails — your wallet credentials never leave this connection.
            </p>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------
// Step indicator + small spinner.
// --------------------------------------------------------------------

function StepDots({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center justify-center gap-2" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={[
            "h-1.5 rounded-full transition-all",
            n === step ? "w-6 bg-primary" : n < step ? "w-3 bg-primary/50" : "w-3 bg-muted",
          ].join(" ")}
        />
      ))}
    </div>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const size = small ? "h-3 w-3" : "h-6 w-6";
  return (
    <span
      className={`inline-block ${size} animate-spin rounded-full border-2 border-muted border-t-primary`}
      aria-hidden
    />
  );
}
