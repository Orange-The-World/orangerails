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
import { useEffect, useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import { QuilttProvider } from "@quiltt/react/providers";
import { useQuilttInstitutions } from "@quiltt/react/hooks";
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
  /**
   * Optional. Present for CLIENT_SIDE_MANIFESTS providers (Quiltt, Sparrow)
   * whose link flow lives in a dedicated route rather than the generic
   * credential form. When set, the picker routes the click here instead
   * of going to enter-credentials.
   */
  connectUrl?: string;
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
// Inline bank search — Quiltt bundle fetcher
// --------------------------------------------------------------------

/**
 * Bundle shape returned by or-quiltt-session-via-widget. Carries
 * everything the /connect/quiltt route needs in its URL fragment when
 * the user clicks a bank tile.
 */
interface QuilttBundle {
  subaccount_id:  string;
  platform_slug:  string;
  app_user_id:    string;
  session_token:  string;
  connector_id:   string;
  profile_id:     string;
  environment_id: string;
  expires_at:     string;
}

/**
 * Trade the widget_token (UUID minted by or-link-mint-token, carried in
 * the /connect URL by the integrating app's backend) for a fresh Quiltt
 * session bundle. Used by the inline bank search the moment the user
 * starts typing.
 *
 * The widget_token is NOT consumed by this call — only verified.
 * Downstream or-quiltt-link-complete still burns it on successful link.
 */
async function fetchQuilttBundleViaWidget(widgetToken: string): Promise<QuilttBundle> {
  const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  if (!base) throw new Error("VITE_SUPABASE_URL not configured.");
  const res = await fetch(`${base}/functions/v1/or-quiltt-session-via-widget`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ widget_token: widgetToken }),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(text) as Record<string, unknown>; } catch { /* ignore */ }
  if (!res.ok) {
    throw new Error(
      typeof data.error === "string" ? data.error : `Bank search unavailable (${res.status}).`,
    );
  }
  return data as unknown as QuilttBundle;
}

// --------------------------------------------------------------------
// Client-side-manifest routing
// --------------------------------------------------------------------

/**
 * Route the user to a client-side-manifest provider's dedicated page.
 *
 * - Sparrow: navigate to /connect/sparrow with the existing query params
 *   so the page can wire up its own Stealth-Sync flow.
 * - Quiltt: NOT routed from here yet — the picker click would land on a
 *   page that needs a server-minted Quiltt session, and trading the
 *   widget_token for a session is a separate edge function (tracked as
 *   PR #2 in the unified-picker design). Until then, integrating apps
 *   open /connect/quiltt directly with session params they minted
 *   server-side.
 */
async function navigateToClientSideManifest(
  manifest: ProviderManifest,
  search: ConnectSearch,
): Promise<void> {
  if (!manifest.connectUrl) {
    throw new Error(`Provider "${manifest.displayName}" has no connectUrl.`);
  }

  if (manifest.slug === "quiltt") {
    if (!search.widget_token) {
      throw new Error(
        "Bank link requires a widget_token in the /connect URL. Your app's " +
          "backend must mint one via or-link-mint-token before opening this widget.",
      );
    }
    const bundle = await fetchQuilttBundleViaWidget(search.widget_token);
    const fragment = new URLSearchParams({
      session_token: bundle.session_token,
      connector_id:  bundle.connector_id,
      platform_slug: bundle.platform_slug,
      app_user_id:   bundle.app_user_id,
    }).toString();
    window.location.assign(`${manifest.connectUrl}#${fragment}`);
    return;
  }

  // Sparrow + future client-side-manifest providers: navigate with the
  // existing query params so the page can wire up its own flow.
  const params = new URLSearchParams();
  if (search.platform) params.set("platform", search.platform);
  if (search.app_user_id) params.set("app_user_id", search.app_user_id);
  if (search.return_to) params.set("return_to", search.return_to);
  const qs = params.toString();
  window.location.assign(qs ? `${manifest.connectUrl}?${qs}` : manifest.connectUrl);
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
  // User-supplied connection label. Defaults to the platform's display
  // name (mirrors prior behavior); the user can override before clicking
  // Continue. The value is encrypted client-side just like credentials —
  // OR never sees plaintext.
  const [connectionLabel, setConnectionLabel] = useState<string>("");
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
          // Client-side-manifest providers (Quiltt, Sparrow) have a
          // dedicated route rather than the generic credential form.
          // PR #147 wired this for the picker click path; the deep-link
          // path below mirrors that — same code path as if the user had
          // clicked the tile inside OR's picker. Without this, an
          // integrator passing ?provider=quiltt lands on an empty
          // credentials form (no credentialFields).
          if (manifestRes.connectUrl) {
            navigateToClientSideManifest(manifestRes, search).catch((err) =>
              setLoadError(err instanceof Error ? err.message : String(err)),
            );
            return;
          }
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

      // Client-side-manifest providers (Quiltt, Sparrow) have a dedicated
      // connect route rather than the generic credential form. Route there
      // instead of going to enter-credentials.
      if (m.connectUrl) {
        await navigateToClientSideManifest(m, search);
        return;
      }

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
        // User-supplied label (defaulted to the platform display name on
        // mount). Trim and fall back to platform name so an empty input
        // never produces an empty label.
        connectionLabel:
          connectionLabel.trim().length > 0
            ? connectionLabel.trim()
            : platform.display_name,
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
          widgetToken={search.widget_token}
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
          connectionLabel={connectionLabel}
          onConnectionLabelChange={setConnectionLabel}
          onContinue={handleContinueFromCredentials}
          onCancel={handleCancel}
          // Only offer Back when the user actually came from the picker.
          // If the URL deep-linked a provider (?provider=blink) there's
          // no picker to go back to — hide the button.
          onBack={
            search.provider
              ? undefined
              : () => {
                  setError(null);
                  setManifest(null);
                  setFormValues({});
                  setStep("pick-provider");
                }
          }
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
  connectionLabel,
  onConnectionLabelChange,
  onContinue,
  onCancel,
  onBack,
  error,
}: {
  providerLabel: string;
  providerSlug?: string;
  fields: ManifestField[];
  values: Record<string, string>;
  onValueChange: (name: string, value: string) => void;
  connectionLabel: string;
  onConnectionLabelChange: (value: string) => void;
  onContinue: (e: React.FormEvent) => void;
  onCancel: () => void;
  /** Optional. When provided, renders a "Back" button that returns the
   *  user to the picker. Hidden when undefined (deep-linked entry — no
   *  picker step to return to). */
  onBack?: () => void;
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

      <div>
        <label htmlFor="connection-label" className="block text-sm font-medium">
          Label <span className="text-muted-foreground">(optional)</span>
        </label>
        <input
          id="connection-label"
          type="text"
          autoComplete="off"
          value={connectionLabel}
          onChange={(e) => onConnectionLabelChange(e.target.value)}
          placeholder={`My ${providerLabel} account`}
          className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          A name only you see. Encrypted in this browser before it leaves.
        </p>
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

      <p className="text-xs text-slate-500">
        Your information is encrypted with your vault password before it leaves your browser.
        OrangeRails stores only ciphertext — you and only you can decrypt it.
      </p>


      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!allRequiredFilled}
          className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
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

function PickProviderStep({
  platformName,
  providers,
  onPick,
  onCancel,
  submitting,
  error,
  widgetToken,
}: {
  platformName: string;
  providers: ProviderManifest[] | null;
  onPick: (slug: string) => void;
  onCancel: () => void;
  submitting: boolean;
  error: string | null;
  /**
   * When present, the picker lazily trades it for a Quiltt session as
   * soon as the user types ≥2 characters in the search box, then renders
   * matching bank institutions inline alongside Bitcoin providers.
   * Without a widget_token, the inline bank search is disabled (the
   * Bitcoin search keeps working).
   */
  widgetToken?: string;
}) {
  const [search, setSearch] = useState("");

  // ── Inline bank search via Quiltt ───────────────────────────────────
  //
  // Lazy-fetches a Quiltt session bundle the first time the user types
  // 2+ characters. The bundle is cached for the life of this component
  // (no refetch on subsequent searches). Without a widget_token, inline
  // bank search is disabled and only Bitcoin providers render.
  //
  // In-flight tracking lives on a ref (NOT in state) so that updating
  // bundleFetchState mid-fetch doesn't re-trigger the effect, cancel the
  // cleanup, and orphan the promise. Earlier versions of this hook had
  // exactly that bug — the spinner stuck at "Looking up banks…" forever
  // because the .then/.catch saw `cancelled=true` after the rerender.
  const [quilttBundle, setQuilttBundle] = useState<QuilttBundle | null>(null);
  const [bundleFetchState, setBundleFetchState] = useState<
    "idle" | "fetching" | "error"
  >("idle");
  const [bundleError, setBundleError] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!widgetToken) return;
    if (quilttBundle) return;
    if (inFlightRef.current) return;
    if (bundleFetchState === "error") return; // wait for user to retry by clearing + retyping
    if (search.trim().length < 2) return;

    inFlightRef.current = true;
    setBundleFetchState("fetching");
    fetchQuilttBundleViaWidget(widgetToken)
      .then((b) => {
        setQuilttBundle(b);
        setBundleFetchState("idle");
      })
      .catch((err) => {
        setBundleError(err instanceof Error ? err.message : String(err));
        setBundleFetchState("error");
      })
      .finally(() => {
        inFlightRef.current = false;
      });
    // Intentionally exclude bundleFetchState from deps: the inFlightRef
    // already gates re-entry, and depending on the state we're about to
    // set would cause the cancellation race the comment above describes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetToken, quilttBundle, search]);

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

  // Sort: popularity DESC, displayName ASC.
  const sortFn = (a: ProviderManifest, b: ProviderManifest): number => {
    const popDiff = (b.popularity ?? 0) - (a.popularity ?? 0);
    if (popDiff !== 0) return popDiff;
    return a.displayName.localeCompare(b.displayName);
  };

  // Filter by search across name + description + tags + slug.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers.filter((p) => {
      if (!q) return true;
      const haystack = [p.displayName, p.description ?? "", p.slug, ...(p.tags ?? [])]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [providers, search]);

  // Empty search → show top 8 most popular as quick-pick tiles. Plaid /
  // Quiltt-style: an overwhelming flat list is not friendlier than a
  // curated set the user can scan in under a second. When searching,
  // show all matching results (still sorted by popularity).
  const isSearching = search.trim().length > 0;
  const groups = useMemo<Array<{ label: string | null; entries: ProviderManifest[] }>>(() => {
    const sorted = [...filtered].sort(sortFn);
    if (isSearching) {
      return [{ label: null, entries: sorted }];
    }
    return [{ label: "POPULAR", entries: sorted.slice(0, 8) }];
  }, [isSearching, filtered]);

  return (
    <div className="mt-4 space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-semibold text-slate-900">
          {isSearching ? "Search results" : "Securely connect your account"}
        </h2>
        <p className="mt-1 text-xs text-slate-500">
          {isSearching
            ? `${filtered.length} match${filtered.length === 1 ? "" : "es"} for "${search.trim()}"`
            : "Search for your bank or pick a popular option below."}
        </p>
      </div>

      {/* Search */}
      <div className="relative">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search for your bank or Bitcoin source"
          autoFocus
          aria-label="Search for your bank or Bitcoin source"
          className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 pr-10 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-200"
          data-testid="provider-search"
        />
        <svg
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M11 17a6 6 0 100-12 6 6 0 000 12z" />
        </svg>
      </div>

      {/* Tile grid — 4 columns at sm+, 2 on narrow viewports.
          Wave's UX uses 4-up bank tiles in 2 rows = 8 quick-picks.
          When searching, sections collapse into a flat grid. */}
      {filtered.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-6 text-center text-xs text-slate-500">
          No matches for {search ? `"${search}"` : "the current filter"}.
        </div>
      ) : (
        <div data-testid="provider-results">
          {groups.map((g, gi) => (
            <div key={g.label ?? `group-${gi}`}>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {g.entries.map((p) => (
                  <ProviderTile
                    key={p.slug}
                    provider={p}
                    busy={submitting}
                    onPick={onPick}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Inline bank search — appears once the user starts typing AND we have a Quiltt bundle. */}
      {search.trim().length >= 2 && (
        <BankSearchPanel
          searchTerm={search.trim()}
          bundle={quilttBundle}
          fetchState={bundleFetchState}
          fetchError={bundleError}
          widgetToken={widgetToken}
        />
      )}

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Deterministic brand color per provider slug. Hash → palette index.
// Placeholder until per-provider logos ship; gives every tile a visually
// distinct colored square so the grid pops (matches the Wave UX where
// each bank has its own brand color).
const TILE_PALETTE = [
  "bg-orange-500",  // OrangeRails primary
  "bg-blue-600",    // RBC-ish
  "bg-emerald-600", // TD-ish
  "bg-rose-600",    // Scotiabank-ish
  "bg-red-700",     // CIBC-ish
  "bg-indigo-600",
  "bg-amber-500",   // Tangerine-ish
  "bg-slate-800",   // dark fallback
  "bg-teal-600",    // Desjardins-ish
  "bg-purple-600",
  "bg-cyan-600",
  "bg-yellow-500",
];

function tileColor(slug: string): string {
  // Cheap djb2-style hash for stable per-slug color.
  let h = 5381;
  for (let i = 0; i < slug.length; i += 1) h = ((h << 5) + h + slug.charCodeAt(i)) | 0;
  return TILE_PALETTE[Math.abs(h) % TILE_PALETTE.length];
}

function ProviderTile({
  provider,
  busy,
  onPick,
}: {
  provider: ProviderManifest;
  busy: boolean;
  onPick: (slug: string) => void;
}) {
  // First letter of the provider name in a brand-colored square — Wave-style
  // visual punch. Per-provider logos replace these in a future PR; the
  // <ProviderTile> shape stays the same so the rollout is logo-by-logo.
  const initial = provider.displayName.slice(0, 1).toUpperCase();
  return (
    <button
      type="button"
      onClick={() => onPick(provider.slug)}
      disabled={busy}
      data-testid={`provider-tile-${provider.slug}`}
      title={provider.description ?? provider.displayName}
      className="group flex h-24 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-slate-200 bg-white p-2 text-center transition-all hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm disabled:opacity-50"
    >
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-base font-bold text-white shadow-sm ${tileColor(provider.slug)}`}
        aria-hidden
      >
        {initial}
      </span>
      <div className="flex w-full items-center justify-center gap-1">
        <span className="truncate text-xs font-medium text-slate-900">
          {provider.displayName}
        </span>
        {provider.status === "beta" && (
          <span className="shrink-0 rounded-sm bg-amber-100 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-amber-700">
            β
          </span>
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
  // Plaid / Quiltt chrome pattern:
  //   - Top: subtle "{App} uses OrangeRails to connect securely" line — not
  //     a huge accent-color H1. Establishes the co-branding relationship
  //     without overwhelming the actual step content.
  //   - Middle: the step content (picker, credentials form, etc.)
  //   - Bottom: small "Powered by OrangeRails" + privacy note.
  // Hardcoded light tokens so the popup stays light regardless of the
  // embedding page's theme.
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-6 antialiased text-slate-900" style={{ colorScheme: "light" }}>
      <div className="mx-auto w-full max-w-md">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          {platform && (
            <div className="mb-4 text-xs text-slate-500">
              <span className="font-medium text-slate-700">{platform.display_name}</span>
              {" uses OrangeRails to connect securely."}
            </div>
          )}

          {children}

          {/* Plaid/Quiltt pattern: small Terms + Privacy line near the
              card footer so the user sees them at every step. URLs are
              placeholders — swap to real T&C / Privacy pages when they
              ship. */}
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

// --------------------------------------------------------------------
// BankSearchPanel — renders Quiltt institution search results inline.
//
// Conditional: only renders content when bundle is fetched. While the
// bundle is fetching, shows a small loading hint. On error, shows the
// error inline (the rest of the picker keeps working).
// --------------------------------------------------------------------

function BankSearchPanel({
  searchTerm,
  bundle,
  fetchState,
  fetchError,
  widgetToken,
}: {
  searchTerm: string;
  bundle: QuilttBundle | null;
  fetchState: "idle" | "fetching" | "error";
  fetchError: string | null;
  widgetToken?: string;
}) {
  if (fetchState === "fetching" && !bundle) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner small />
        <span>Looking up banks…</span>
      </div>
    );
  }
  if (fetchState === "error") {
    return (
      <div className="mt-2 rounded-md border border-amber-300/40 bg-amber-50/40 px-3 py-2 text-xs text-amber-700">
        Bank search unavailable: {fetchError ?? "unknown error"}
      </div>
    );
  }
  if (!bundle) {
    // No widget_token + 2+ char search: bank search disabled silently.
    return null;
  }

  return (
    <QuilttProvider token={bundle.session_token}>
      <BankSearchResults
        searchTerm={searchTerm}
        bundle={bundle}
        widgetToken={widgetToken}
      />
    </QuilttProvider>
  );
}

interface QuilttInstitutionRow {
  id?: string;
  name?: string;
  logo?: { url?: string };
  providers?: string[];
}

function BankSearchResults({
  searchTerm,
  bundle,
  widgetToken,
}: {
  searchTerm: string;
  bundle: QuilttBundle;
  widgetToken?: string;
}) {
  const { searchResults, isSearching, setSearchTerm } = useQuilttInstitutions(
    bundle.connector_id,
  );

  // Push the parent's search term into the hook's internal state.
  useEffect(() => {
    setSearchTerm(searchTerm);
  }, [searchTerm, setSearchTerm]);

  // Quiltt's InstitutionsData is loosely typed in @quiltt/core. We
  // narrow to what we actually use.
  const institutions = (Array.isArray(searchResults) ? searchResults : []) as QuilttInstitutionRow[];

  if (isSearching && institutions.length === 0) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner small />
        <span>Searching banks…</span>
      </div>
    );
  }
  if (institutions.length === 0) {
    return null;
  }

  function openBank(institutionId: string) {
    const fragment = new URLSearchParams({
      session_token: bundle.session_token,
      connector_id:  bundle.connector_id,
      platform_slug: bundle.platform_slug,
      app_user_id:   bundle.app_user_id,
      institution:   institutionId,
    });
    // /connect/quiltt's completeLinkOnOR call needs widget_token to hit
    // or-quiltt-link-complete. Pipe it through the fragment.
    if (widgetToken) fragment.set("widget_token", widgetToken);
    window.location.assign(`/connect/quiltt#${fragment.toString()}`);
  }

  return (
    <div className="mt-4 space-y-2" data-testid="bank-search-results">
      <div className="text-center text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        Banks
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {institutions.slice(0, 12).map((inst, i) => {
          const id = inst.id ?? "";
          const name = inst.name ?? "Unknown bank";
          const logoUrl = inst.logo?.url;
          return (
            <button
              key={id || `inst-${i}`}
              type="button"
              onClick={() => openBank(id)}
              disabled={!id}
              data-testid={`bank-tile-${id}`}
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
              <span className="w-full truncate text-xs font-medium text-slate-900">
                {name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
