/**
 * /connect — OrangeRails Link widget.
 *
 * Pop-up entry point any integrating app opens when its end user clicks
 * "Connect a Bitcoin wallet." Plaid-hybrid co-branding pattern: the
 * integrating app's name renders prominently up top, "Powered by Orange
 * Rails" smaller below.
 *
 * Three-step flow (matches V3 Connections.tsx):
 *   1. Enter the provider credentials (one or more fields per provider).
 *   2. Discover the wallets / stores those credentials can see.
 *   3. Tick which to track and finish.
 *
 * Provider model: PROVIDER_FORMS below maps each supported provider slug
 * to its credential field schema and a client-side discover function.
 * Adding a new provider is a one-entry change here. The credential JSON
 * shape that ships to OR is `JSON.stringify(formValues)` — the per-
 * provider edge-function adapter (_shared/providers/<slug>.ts) parses
 * those same field names back out.
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
 *   provider     — wallet provider slug. **Optional**. If omitted, the widget shows a provider picker step.
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

import { createFileRoute, Outlet, useChildMatches, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { deriveMEK, encryptString, importAesKey } from "@/lib/vault";
import { deriveSubkey, HKDF_CONTEXTS } from "@/lib/key-derivation";

// --------------------------------------------------------------------
// Locking-key handoff.
//
// Preferred path: the integrating app derives the credentials_key and
// transactions_key in the user's browser (Argon2id of their vault
// password + per-org salt → HKDF) and hands the raw 32-byte keys to
// this widget through the URL fragment as `#cred_key=B64&txn_key=B64`.
// The fragment never reaches OR's server logs and we strip it from
// history-state on first read. This is what BitBooks V2 sends.
//
// Fallback path: when no fragment is present (standalone demo, legacy
// integrators), we fall back to a hardcoded test password + zero salt
// so the widget remains demo-able without a host app. NEVER ship a
// real integration that relies on the fallback — anyone running OR
// would derive the same keys and could decrypt the credential.
// --------------------------------------------------------------------
const LINK_WIDGET_LOCK_PASSWORD = "orangerails-widget-default-lock-password-v1";
const LINK_WIDGET_LOCK_SALT_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

interface HandoffKeys {
  credKey: CryptoKey;
  txnKey: CryptoKey;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Read cred_key (required) and txn_key (optional) from
 * window.location.hash. Each is imported as an AES-256-GCM CryptoKey,
 * then the fragment is wiped from URL state so the raw bytes are never
 * recoverable from history.
 *
 * Contract:
 *   - cred_key REQUIRED. Locks provider credentials (the API key the
 *     end-user pastes). Sync uses this same key on the server to
 *     decrypt and re-encrypt to the upstream API.
 *   - txn_key OPTIONAL. Locks per-wallet metadata (label, currency).
 *     Plaintext consumers (V2) don't need it; ZK consumers (V3, OW)
 *     pass it and store ciphertext at rest. When absent, cred_key is
 *     reused for metadata encryption.
 *
 * Returns null only when NEITHER key is present (= no handoff at all,
 * widget falls back to dev test-password). When cred_key is present
 * but invalid (wrong size, malformed base64), throws so the caller
 * surfaces a visible error instead of silently producing
 * unrecoverable ciphertext.
 */
async function readHandoffKeysFromFragment(): Promise<HandoffKeys | null> {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) {
    return null;
  }
  const params = new URLSearchParams(raw);
  const credB64 = params.get("cred_key");
  const txnB64 = params.get("txn_key");
  if (!credB64) {
    return null;
  }

  // Strip the fragment from the visible URL ASAP. We replace, not push,
  // so the back stack is untouched.
  try {
    history.replaceState(
      history.state,
      "",
      window.location.pathname + window.location.search,
    );
  } catch {
    /* not fatal — the in-memory keys are what matter */
  }

  const credBytes = base64ToBytes(credB64);
  if (credBytes.length !== 32) {
    throw new Error("Handoff cred_key is the wrong size — expected 32 bytes.");
  }
  const credKey = await importAesKey(credBytes.buffer as ArrayBuffer);

  // txn_key is optional. When absent, reuse cred_key for metadata
  // encryption. Plaintext consumers (V2 sink mode) don't read this back
  // anyway — the server decrypts metadata internally during sync and
  // returns plaintext rows.
  let txnKey: CryptoKey;
  if (txnB64) {
    const txnBytes = base64ToBytes(txnB64);
    if (txnBytes.length !== 32) {
      throw new Error("Handoff txn_key is the wrong size — expected 32 bytes.");
    }
    txnKey = await importAesKey(txnBytes.buffer as ArrayBuffer);
  } else {
    txnKey = credKey;
  }
  return { credKey, txnKey };
}

// --------------------------------------------------------------------
// Search-param schema (validated below).
// --------------------------------------------------------------------

interface ConnectSearch {
  // Audit 2026-05-16 High #3: optional widget session token minted by the
  // integrating app's backend via or-link-mint-token. Required once the
  // env flag REQUIRE_WIDGET_TOKEN flips on; ignored when absent today.
  widget_token?: string;
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
    widget_token: typeof search.widget_token === "string" ? search.widget_token : undefined,
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
// Manifest-driven provider forms.
//
// The widget's UX is the same for every provider: enter credential
// fields → discover wallets → pick → save. The fields themselves come
// from the OR backend at /functions/v1/or-providers, so adding a new
// provider on the OR side automatically surfaces here — no widget
// redeploy needed.
//
// The only widget-side per-provider knowledge that remains lives in
// CLIENT_DISCOVERY_OVERRIDES: a small map of providers whose discovery
// step makes a live upstream call from the browser (Blink GraphQL,
// BTCPay REST). Everyone else uses the synthetic-wallet fallback below
// — one wallet entry per connection, sync enumerates assets server-side.
//
// The credential JSON we encrypt and ship to OR is just
// `JSON.stringify(formValues)` — the edge-function adapter parses the
// same field names back out (see _shared/providers/types.ts:parseCredentials).
// --------------------------------------------------------------------

/**
 * Manifest entry for one provider, returned by /or-providers.
 *
 * Mirror of `ProviderManifest` in the OR backend
 * (_shared/providers/dispatch.ts). Kept in lock-step on field names; if
 * the backend adds a field, surface it here.
 */
interface ProviderManifest {
  slug: string;
  displayName: string;
  description?: string;
  status: "live" | "beta" | "coming_soon";
  category?: string;
  tags?: string[];
  popularity?: number;
  multiWallet: boolean;
  credentialFields: ManifestField[];
}

interface ManifestField {
  name: string;
  label: string;
  type: "string" | "secret";
  placeholder?: string;
  optional?: boolean;
  multiline?: boolean;
  helpLabel?: string;
  helpHref?: string;
}

async function fetchAllProviders(): Promise<ProviderManifest[]> {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base) throw new Error("VITE_SUPABASE_URL not configured.");
  const res = await fetch(`${base}/functions/v1/or-providers`, { method: "GET" });
  if (!res.ok) throw new Error(`Could not load provider catalog (status ${res.status}).`);
  const json = (await res.json()) as { providers?: ProviderManifest[] };
  return json.providers ?? [];
}

async function fetchProviderManifest(slug: string): Promise<ProviderManifest> {
  const providers = await fetchAllProviders();
  const found = providers.find((p) => p.slug === slug);
  if (!found) throw new Error(`Provider "${slug}" is not registered with Orange Rails.`);
  if (found.status === "coming_soon") {
    throw new Error(`Provider "${found.displayName}" is not available yet.`);
  }
  return found;
}

/**
 * Synthetic-wallet fallback. Most providers don't need browser-side
 * discovery (CORS blocks most exchange APIs anyway, and CCXT-backed
 * adapters enumerate assets server-side during sync). The widget returns
 * one wallet entry per connection so the existing pick-step UX still
 * applies; OR's adapter handles per-asset discovery on first sync.
 */
function syntheticDiscovery(
  manifest: ProviderManifest,
): (values: Record<string, string>) => Promise<DiscoveredWallet[]> {
  return async (_values) => [
    {
      external_wallet_id: manifest.slug,
      currency: manifest.category === "exchange" ? "USD" : "BTC",
      label: manifest.displayName,
    },
  ];
}

// ---- Blink ---------------------------------------------------------

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

async function discoverBlinkWallets(values: Record<string, string>): Promise<DiscoveredWallet[]> {
  const apiKey = values.api_key;
  if (!apiKey) throw new Error("Enter your Blink API key.");
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
  const mapped: DiscoveredWallet[] = wallets
    .filter((w): w is { id: string; walletCurrency: string } => !!w.id)
    .map((w) => ({
      external_wallet_id: w.id,
      currency: w.walletCurrency,
    }));
  if (mapped.length === 0) {
    throw new Error("Blink returned wallets without IDs. Please try a different API key.");
  }
  return mapped;
}

// ---- xpub ----------------------------------------------------------
// "Discovery" for an xpub is a local-only sanity check. The xpub IS the
// wallet — there's no upstream account to enumerate. We validate the
// prefix + minimum length here so an obviously-bad paste fails before
// the user goes through the rest of the flow; the heavy lifting (BIP44
// gap-limit address derivation + indexer scan) happens server-side
// inside the OR adapter on first sync.

async function discoverXpubWallet(values: Record<string, string>): Promise<DiscoveredWallet[]> {
  const xpub = (values.xpub ?? "").trim();
  if (!/^[xyz]pub[A-Za-z0-9]+$/.test(xpub)) {
    throw new Error(
      "That doesn't look like an extended public key. It should start with xpub, ypub, or zpub.",
    );
  }
  if (xpub.length < 100) {
    throw new Error("Extended public key looks too short — copy the full string.");
  }
  return [
    {
      external_wallet_id: "xpub",
      currency: "BTC",
      label: "Bitcoin (xpub)",
    },
  ];
}

// ---- BTCPay --------------------------------------------------------
// BTCPay's Greenfield API uses `Authorization: token <api_key>` (custom
// format, NOT Bearer). One request to /api/v1/stores returns every store
// the API key can see — each becomes a wallet entry the user can pick.
//
// CORS: BTCPay instances enable CORS for their own merchant SPA, so this
// browser-side fetch generally works. Self-hosted instances behind a
// strict reverse-proxy may need to allowlist orangerails.com. If we hit
// CORS issues in practice, fall back to OR's or-discover-wallets edge
// function which makes the call server-side.

async function discoverBtcpayStores(values: Record<string, string>): Promise<DiscoveredWallet[]> {
  const url = (values.btcpay_url ?? "").trim().replace(/\/+$/, "");
  const apiKey = values.api_key ?? "";
  if (!/^https?:\/\//.test(url)) {
    throw new Error("Enter the full BTCPay URL including https://");
  }
  if (!apiKey) throw new Error("Enter your BTCPay API key.");

  const res = await fetch(`${url}/api/v1/stores`, {
    headers: { Authorization: `token ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "BTCPay rejected that API key. Make sure the key has the btcpay.store.canviewinvoices and btcpay.store.canviewstoresettings permissions.",
      );
    }
    throw new Error(`BTCPay returned ${res.status}. ${detail}`);
  }
  const stores = (await res.json()) as Array<{
    id: string;
    name: string;
    defaultCurrency?: string;
  }>;
  if (!Array.isArray(stores) || stores.length === 0) {
    throw new Error("No stores found on that BTCPay instance for this API key.");
  }
  return stores
    .filter((s): s is { id: string; name: string; defaultCurrency?: string } => !!s.id)
    .map((s) => ({
      external_wallet_id: s.id,
      currency: (s.defaultCurrency ?? "BTC").toUpperCase(),
      label: s.name,
    }));
}

// ---- Client-side discovery overrides -------------------------------
//
// Providers in this map use a custom browser-side discover function
// (live API call to validate the credential and enumerate wallets/stores
// before the user proceeds). Everyone else uses syntheticDiscovery() —
// one wallet entry per connection, validation happens server-side at
// first sync.
//
// What goes in here:
//   blink   — GraphQL discovery returns the user's actual wallet IDs
//             (BTC + USD), so the picker shows real wallets to choose from
//   btcpay  — REST discovery returns the user's BTCPay stores (one wallet
//             per store), so the picker shows real store names
//   xpub    — local format validation (regex on prefix + length) so
//             obvious typos fail fast before any encryption
//
// What does NOT go in here:
//   strike + every CCXT exchange (coinbase, kraken, binance, ...) —
//   their APIs block browser-origin CORS, so live discovery would fail
//   from the widget anyway. Synthetic-wallet fallback used; OR's adapter
//   validates the credential on first sync attempt.

const CLIENT_DISCOVERY_OVERRIDES: Record<
  string,
  (values: Record<string, string>) => Promise<DiscoveredWallet[]>
> = {
  blink: discoverBlinkWallets,
  xpub: discoverXpubWallet,
  btcpay: discoverBtcpayStores,
};

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
  formValues: Record<string, string>;
  connectionLabel: string;
  picks: DiscoveredWallet[];
  handoff: HandoffKeys | null;
}): Promise<LockedConnection> {
  let credKey: CryptoKey;
  let txnKey: CryptoKey;
  if (params.handoff) {
    credKey = params.handoff.credKey;
    txnKey = params.handoff.txnKey;
  } else {
    // Audit H4 (2026-05-21): the hardcoded fallback password/salt below
    // must NEVER run in production. Any prod build that hits this path
    // would derive the same keys every other OR deployment derives,
    // making the credential trivially decryptable. Guard at runtime so
    // a missing fragment in prod fails loudly instead of silently
    // sealing with the demo key.
    if (!import.meta.env.DEV) {
      throw new Error(
        "connect: cred_key missing from URL fragment — refusing demo-fallback in production build. " +
          "The host app must pass #cred_key=...&txn_key=... when launching the widget.",
      );
    }
    const mek = await deriveMEK(LINK_WIDGET_LOCK_PASSWORD, LINK_WIDGET_LOCK_SALT_B64);
    credKey = await deriveSubkey(
      mek,
      HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1,
      LINK_WIDGET_LOCK_SALT_B64,
    );
    txnKey = await deriveSubkey(
      mek,
      HKDF_CONTEXTS.ORANGERAILS_TRANSACTIONS_V1,
      LINK_WIDGET_LOCK_SALT_B64,
    );
  }

  const encrypted_label = await encryptString(params.connectionLabel, credKey);
  // Credential JSON is `JSON.stringify(formValues)` — the per-provider
  // edge-function adapter parses the same field names back out. No
  // provider-specific shaping happens here.
  const encrypted_credentials = await encryptString(JSON.stringify(params.formValues), credKey);

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
  widget_token?: string;
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

type Step =
  | "pick-provider"
  | "enter-credentials"
  | "discovering"
  | "pick-wallets"
  | "saving"
  | "done";

function ConnectPage() {
  // If a child route under /connect is matched (e.g. /connect/stealth),
  // render only its outlet so the child owns the page chrome. The /connect
  // page itself is the credential form for the legacy connect flow.
  const childMatches = useChildMatches();
  if (childMatches.length > 0) {
    return <Outlet />;
  }
  return <ConnectPageInner />;
}

function ConnectPageInner() {
  const search = useSearch({ from: "/connect" }) as ConnectSearch;

  const [platform, setPlatform] = useState<PlatformDisplay | null>(null);
  const [manifest, setManifest] = useState<ProviderManifest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Flow state. When the integrating app deep-links with ?provider=... we
  // start at the credential form; otherwise we open with the in-widget
  // provider picker so the host app never has to maintain its own list.
  const [step, setStep] = useState<Step>(
    search.provider ? "enter-credentials" : "pick-provider",
  );
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [discovered, setDiscovered] = useState<DiscoveredWallet[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [handoffKeys, setHandoffKeys] = useState<HandoffKeys | null>(null);
  // Catalog for the in-widget picker. Loaded lazily when no provider slug
  // arrived in the URL.
  const [providerCatalog, setProviderCatalog] = useState<ProviderManifest[] | null>(null);
  const [pickingProvider, setPickingProvider] = useState(false);

  const providerLabel = manifest?.displayName ?? search.provider ?? "your provider";

  // ---- Validate query params + look up the integrating app + manifest
  useEffect(() => {
    // `provider` is optional — when absent we show the picker step and
    // defer the manifest fetch until the user chooses. Everything else
    // (platform / app_user_id / return_to) is still required.
    if (!search.platform || !search.app_user_id || !search.return_to) {
      setLoadError(
        "This page is missing some details from the app that opened it. Please go back and try again.",
      );
      return;
    }
    if (search.provider) {
      // Deep-linked: resolve platform AND provider manifest in parallel
      // (existing fast path — keeps backward compat with V2 + integrators
      // that already pass ?provider=...).
      Promise.all([
        fetchPlatformDisplay(search.platform),
        fetchProviderManifest(search.provider),
      ])
        .then(([platformRes, manifestRes]) => {
          setPlatform(platformRes);
          setManifest(manifestRes);
        })
        .catch((err) => setLoadError(String(err.message ?? err)));
    } else {
      // No provider in URL — fetch platform display and the full provider
      // catalog so the picker can render.
      Promise.all([fetchPlatformDisplay(search.platform), fetchAllProviders()])
        .then(([platformRes, providers]) => {
          setPlatform(platformRes);
          setProviderCatalog(providers.filter((p) => p.status !== "coming_soon"));
        })
        .catch((err) => setLoadError(String(err.message ?? err)));
    }
  }, [search.platform, search.app_user_id, search.provider, search.return_to]);

  // ---- Picker step: user clicks a provider tile -------------------------
  async function handlePickProvider(slug: string) {
    if (pickingProvider) return;
    setError(null);
    setPickingProvider(true);
    try {
      const m = await fetchProviderManifest(slug);
      setManifest(m);
      setStep("enter-credentials");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickingProvider(false);
    }
  }

  // ---- Read locking keys from URL fragment, once ------------------
  // Fires on first mount only. The fragment is stripped from the URL
  // immediately on read so the raw key bytes don't sit in window.location.
  useEffect(() => {
    let cancelled = false;
    readHandoffKeysFromFragment()
      .then((keys) => {
        if (!cancelled) setHandoffKeys(keys);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error
              ? `Could not read the unlock keys from the page address: ${err.message}`
              : "Could not read the unlock keys from the page address.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Step 1 → 2: submit credential form, discover wallets -------
  async function handleContinueFromCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!manifest) return;
    // Required-field gate. CredentialField.optional=true means blank is OK;
    // anything else (undefined or false) means the field is required.
    for (const field of manifest.credentialFields) {
      if (field.optional === true) continue;
      if (!(formValues[field.name] ?? "").trim()) {
        setError(`${field.label} is required.`);
        return;
      }
    }
    setError(null);
    setStep("discovering");
    try {
      // Use the provider-specific override when one exists; otherwise fall
      // back to a synthetic single-wallet entry (the OR adapter does the
      // real per-asset enumeration server-side at first sync).
      const discover = CLIENT_DISCOVERY_OVERRIDES[manifest.slug] ?? syntheticDiscovery(manifest);
      const result = await discover(formValues);
      if (result.length === 0) {
        throw new Error("That account has no wallets to track yet.");
      }
      setDiscovered(result);
      // Default: every wallet ticked.
      setSelectedIds(new Set(result.map((w) => w.external_wallet_id)));
      setStep("pick-wallets");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStep("enter-credentials");
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
    if (!platform || !manifest || !search.platform || !search.app_user_id) return;
    const picks = discovered.filter((w) => selectedIds.has(w.external_wallet_id));
    if (picks.length === 0) {
      setError("Pick at least one wallet to continue.");
      return;
    }
    setError(null);
    setStep("saving");
    try {
      const locked = await lockEverything({
        formValues,
        connectionLabel: platform.display_name,
        picks,
        handoff: handoffKeys,
      });

      const result = await callLinkComplete({
        platform_slug: search.platform,
        app_user_id: search.app_user_id,
        provider_type: manifest.slug,
        encrypted_label: locked.encrypted_label,
        encrypted_credentials: locked.encrypted_credentials,
        wallets: locked.walletCiphertexts.map((w) => ({
          external_wallet_id: w.external_wallet_id,
          encrypted_metadata: w.encrypted_metadata,
        })),
        // Audit 2026-05-16 High #3: forward the widget session token the
        // integrating app's backend minted before opening this popup. The
        // edge function ignores tokenless requests during the rollout
        // window (warning only) and rejects them once the env flag flips.
        widget_token: search.widget_token,
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

  // Platform display must always resolve before we render the body. The
  // manifest is only required once we leave the picker step.
  if (!platform || (step !== "pick-provider" && !manifest)) {
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
        step={
          step === "pick-provider" || step === "enter-credentials"
            ? 1
            : step === "discovering" || step === "pick-wallets"
              ? 2
              : 3
        }
      />

      {step === "pick-provider" && (
        <PickProviderStep
          platformName={platform.display_name}
          providers={providerCatalog}
          onPick={handlePickProvider}
          onCancel={handleCancel}
          submitting={pickingProvider}
          error={error}
        />
      )}

      {step === "enter-credentials" && manifest && (
        <EnterCredentialsStep
          providerLabel={providerLabel}
          providerSlug={manifest.slug}
          fields={manifest.credentialFields}
          values={formValues}
          onValueChange={(name, value) =>
            setFormValues((prev) => ({ ...prev, [name]: value }))
          }
          onContinue={handleContinueFromCredentials}
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
            setStep("enter-credentials");
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
// Step 1 — enter credential fields
// --------------------------------------------------------------------

function EnterCredentialsStep({
  providerLabel,
  providerSlug,
  fields,
  values,
  onValueChange,
  onContinue,
  onCancel,
  error,
}: {
  providerLabel: string;
  providerSlug?: string;
  fields: ManifestField[];
  values: Record<string, string>;
  onValueChange: (name: string, value: string) => void;
  onContinue: (e: React.FormEvent) => void;
  onCancel: () => void;
  error: string | null;
}) {
  const allRequiredFilled = fields.every(
    (f) => f.optional === true || (values[f.name] ?? "").trim().length > 0,
  );
  return (
    <form onSubmit={onContinue} className="mt-4 space-y-4">
      <div className="flex items-center gap-1.5">
        <h2 className="text-sm font-semibold">Connect your {providerLabel} account</h2>
        {providerSlug === "strike" && (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="About Strike's API"
                  className="text-muted-foreground hover:text-foreground"
                >
                  <Info className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" className="max-w-xs text-xs leading-snug">
                <p className="font-medium">A note on Strike's API</p>
                <p className="mt-1">
                  Strike's public API does not expose a full transaction history endpoint. It does
                  not list Lightning Address tips, and there is no replay window for activity that
                  landed before you connected. This is a well known Strike limitation. Every
                  accounting tool we know of (Koinly, CoinLedger, CoinTracker) hits the same wall.
                </p>
                <p className="mt-2">
                  <span className="font-medium">Going forward:</span> everything syncs. Once
                  connected, Strike sends a real time webhook for every invoice, receive, deposit,
                  payout, payment, and exchange. Fully automatic, no polling.
                </p>
                <p className="mt-2">
                  <span className="font-medium">The past:</span> the only way to recover historical
                  activity is the CSV export from Strike's dashboard. CSV upload from this screen
                  is shipping next. Rows match on Strike's Reference column so anything that also
                  arrives via webhook never double counts.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>

      {fields.map((field) => (
        <div key={field.name}>
          <label htmlFor={field.name} className="block text-sm font-medium">
            {field.label}
          </label>
          {field.multiline ? (
            <textarea
              id={field.name}
              required={field.optional !== true}
              autoComplete="off"
              value={values[field.name] ?? ""}
              onChange={(e) => onValueChange(field.name, e.target.value)}
              placeholder={field.placeholder}
              rows={3}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono break-all"
            />
          ) : (
            <input
              id={field.name}
              type={field.type === "secret" ? "password" : "text"}
              required={field.optional !== true}
              autoComplete="off"
              value={values[field.name] ?? ""}
              onChange={(e) => onValueChange(field.name, e.target.value)}
              placeholder={field.placeholder}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          )}
          {(field.helpHref || field.helpLabel) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {field.helpHref ? (
                <a href={field.helpHref} target="_blank" rel="noreferrer" className="underline">
                  {field.helpLabel ?? field.helpHref}
                </a>
              ) : (
                field.helpLabel
              )}
            </p>
          )}
        </div>
      ))}

      <p className="text-xs text-muted-foreground">
        Your credentials are locked in this browser before they leave. Orange Rails stores only the
        locked version and cannot read them.
      </p>


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
          disabled={!allRequiredFilled}
          className="flex-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------------
// Step 0 — provider picker (shown only when the integrating app did not
// pin a provider in the URL). Lets the end user choose which wallet
// provider to connect, removing the need for the host app to maintain
// its own provider list.
// --------------------------------------------------------------------

// ────────────────────────────────────────────────────────────────────
// PickProviderStep — searchable, category-chip-filtered, grouped picker.
//
// Direct port of V2's `ProviderPicker`
// (DeeJanuz/bitbooks:components/admin/add-connection-modal.tsx:1004-1170).
// Renders the same /or-providers catalog V2 already consumes; V2's
// own header comment explains why this layout beats a flat tile grid:
//
//   "Replaces the flat tile grid that didn't scale past ~10 providers
//    (with CCXT bringing 12 exchanges and ~120 more on the roadmap,
//    tile-per-provider was unmanageable)."
//
// Layout:
//   ┌ Search box ─────────────────────────────────┐
//   ├ [All N] [Wallets n] [Exchanges n] [...]    ┤  ← category chips with counts
//   ├ Lightning wallets ──────────────────────────┤
//   │ • Blink              Lightning + on-chain   │
//   │ • Strike    BETA     Lightning + USD        │
//   ├ Exchanges ─────────────────────────────────┤
//   │ • Coinbase  BETA     US exchange + wallet  │
//   └─────────────────────────────────────────────┘
//
// Search filters across displayName + description + slug + tags,
// case-insensitive. While searching, category headers are hidden and
// results are flat. While a category chip is active, only that
// category's providers show. Sort inside each group: popularity DESC,
// displayName ASC.
//
// Visual design (light theme, borders, spacing) intentionally matches
// OR's existing widget primitives — alignment with V2's white-theme
// styling is a Phase 2 cross-product design pass.
// ────────────────────────────────────────────────────────────────────

const CATEGORY_DISPLAY_NAMES: Record<string, string> = {
  lightning_wallet: "Lightning wallets",
  on_chain_wallet: "On-chain wallets",
  payment_processor: "Payment processors",
  exchange: "Exchanges",
  mining_pool: "Mining pools",
  other: "Other",
};

const CATEGORY_ORDER = [
  "lightning_wallet",
  "on_chain_wallet",
  "payment_processor",
  "exchange",
  "mining_pool",
];

function categoryLabel(slug: string): string {
  if (CATEGORY_DISPLAY_NAMES[slug]) return CATEGORY_DISPLAY_NAMES[slug];
  // Fallback: humanize "some_slug" → "Some slug"
  return slug.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function PickProviderStep({
  platformName,
  providers,
  onPick,
  onCancel,
  submitting,
  error,
}: {
  platformName: string;
  providers: ProviderManifest[] | null;
  onPick: (slug: string) => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  // Loading + empty states.
  if (providers === null) {
    return (
      <div className="mt-6 flex flex-col items-center gap-3 py-6 text-center">
        <Spinner />
        <p className="text-sm text-muted-foreground">Loading providers…</p>
      </div>
    );
  }
  if (providers.length === 0) {
    return (
      <div className="mt-6 py-6 text-center">
        <p className="text-sm text-muted-foreground">
          No providers are available right now.
        </p>
      </div>
    );
  }

  // Chip categories — only categories that have at least one provider
  // in the unfiltered list. Ordered by CATEGORY_ORDER, then anything
  // unknown appended.
  const chipCategories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of providers) {
      if (!p.category) continue;
      counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
    }
    const known = CATEGORY_ORDER.filter((c) => counts.has(c));
    const unknown = [...counts.keys()].filter((c) => !CATEGORY_ORDER.includes(c)).sort();
    return [...known, ...unknown].map((slug) => ({
      slug,
      displayName: categoryLabel(slug),
      providerCount: counts.get(slug) ?? 0,
    }));
  }, [providers]);

  // Apply search + active-category filter.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers.filter((p) => {
      if (activeCategory && p.category !== activeCategory) return false;
      if (!q) return true;
      const haystack = [
        p.displayName,
        p.description ?? "",
        p.slug,
        ...(p.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [providers, search, activeCategory]);

  // Sort: popularity DESC, displayName ASC.
  const sortFn = (a: ProviderManifest, b: ProviderManifest): number => {
    const popDiff = (b.popularity ?? 0) - (a.popularity ?? 0);
    if (popDiff !== 0) return popDiff;
    return a.displayName.localeCompare(b.displayName);
  };

  // While searching: flat. Otherwise group by category in chip order
  // + an "Other" bucket for category-less providers.
  const isSearching = search.trim().length > 0;
  const groups = useMemo<Array<{ label: string | null; entries: ProviderManifest[] }>>(() => {
    if (isSearching || activeCategory) {
      // Flat result list (no headers) when narrowing.
      return [{ label: null, entries: [...filtered].sort(sortFn) }];
    }
    const out: Array<{ label: string | null; entries: ProviderManifest[] }> = [];
    for (const c of chipCategories) {
      const entries = filtered
        .filter((p) => p.category === c.slug)
        .sort(sortFn);
      if (entries.length === 0) continue;
      out.push({ label: c.displayName.toUpperCase(), entries });
    }
    const orphans = filtered.filter((p) => !p.category).sort(sortFn);
    if (orphans.length > 0) out.push({ label: "OTHER", entries: orphans });
    return out;
  }, [isSearching, activeCategory, filtered, chipCategories]);

  return (
    <div className="mt-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold">Choose your wallet provider</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Pick which provider you want {platformName} to connect to.
        </p>
      </div>

      {/* Search */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search providers (Blink, Coinbase, Bitcoin, Canada…)"
        autoFocus
        aria-label="Search providers"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        data-testid="provider-search"
      />

      {/* Category chips */}
      <div className="flex flex-wrap gap-1.5">
        <CategoryChip
          label={`All (${providers.length})`}
          active={activeCategory === null}
          onClick={() => setActiveCategory(null)}
        />
        {chipCategories.map((c) => (
          <CategoryChip
            key={c.slug}
            label={`${c.displayName} (${c.providerCount})`}
            active={activeCategory === c.slug}
            onClick={() => setActiveCategory(c.slug)}
            data-testid={`provider-chip-${c.slug}`}
          />
        ))}
      </div>

      {/* Results */}
      {filtered.length === 0 ? (
        <div className="rounded-md border border-input bg-muted/10 px-3 py-4 text-center text-xs text-muted-foreground">
          No providers match {search ? `"${search}"` : "this filter"}.
        </div>
      ) : (
        <div className="space-y-3" data-testid="provider-results">
          {groups.map((g, gi) => (
            <div key={g.label ?? `group-${gi}`} className="space-y-1.5">
              {g.label && (
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {g.label}
                </div>
              )}
              {g.entries.map((p) => (
                <ProviderRow
                  key={p.slug}
                  provider={p}
                  busy={submitting}
                  onPick={onPick}
                />
              ))}
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="flex-1 rounded-md border border-input bg-background px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
  ...rest
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  "data-testid"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors " +
        (active
          ? "border-primary bg-primary/10 text-primary"
          : "border-input bg-background text-muted-foreground hover:bg-muted/30")
      }
      {...rest}
    >
      {label}
    </button>
  );
}

function ProviderRow({
  provider,
  busy,
  onPick,
}: {
  provider: ProviderManifest;
  busy: boolean;
  onPick: (slug: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(provider.slug)}
      disabled={busy}
      data-testid={`provider-row-${provider.slug}`}
      className="flex w-full items-center gap-2 rounded-md border border-input px-3 py-2 text-left transition-colors hover:bg-muted/30 disabled:opacity-50"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium">{provider.displayName}</span>
          {provider.status === "beta" && (
            <span className="rounded-sm bg-primary/20 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-primary">
              BETA
            </span>
          )}
        </div>
        {provider.description && (
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {provider.description}
          </div>
        )}
      </div>
    </button>
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
