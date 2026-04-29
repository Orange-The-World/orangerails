# OrangeRails Consumer Integration Guide

This guide is for any app integrating OrangeRails (OR) as a Bitcoin / financial data provider. It is the authoritative wire-format reference for the consumer side of the protocol. Read it once before you start, refer back when something breaks.

If you are extending OR itself with a new provider adapter, see `Adding a Provider` near the end. The first ten sections describe the consumer's view.

The reference implementation is BitBooks V2 at `DeeJanuz/bitbooks` on the `feat/orange-rails-integration` branch. Every section below links to the V2 file that exercises that part of the contract.

## Table of contents

1. [Quickstart](#quickstart)
2. [Architecture in one page](#architecture-in-one-page)
3. [Authentication: platform vs direct mode](#authentication-platform-vs-direct-mode)
4. [Subaccount provisioning](#subaccount-provisioning)
5. [Vault setup (Path B, zero-knowledge)](#vault-setup-path-b-zero-knowledge)
6. [Connecting a wallet through the Link widget](#connecting-a-wallet-through-the-link-widget)
7. [Syncing transactions: protocol-driven sink mode](#syncing-transactions-protocol-driven-sink-mode)
8. [App Profile (sink configuration)](#app-profile-sink-configuration)
9. [Provider catalog (dynamic discovery)](#provider-catalog-dynamic-discovery)
10. [Wire-format gotchas (read before integrating)](#wire-format-gotchas-read-before-integrating)
11. [Adding a provider (for OR maintainers)](#adding-a-provider-for-or-maintainers)
12. [Reference implementation: V2 file map](#reference-implementation-v2-file-map)


## Quickstart

The five things every consumer does, in order:

1. **Provision a subaccount** for each of your users (or organizations).  
   `POST /functions/v1/or-provision` with `external_user_id = <your-user-id>`.  
   Stores the returned `subaccount_id` against your user.
2. **Set up a vault** for that user (one time).  
   Generate a salt and a 12-word recovery code in the browser. Derive an MEK from the user's chosen vault password using Argon2id. Encrypt the recovery code with the MEK. POST salt + verifier + encrypted recovery code to your own server, never the password.
3. **Connect a wallet** by opening the OR Link widget popup with the user's vault-derived `credentials_key` in the URL fragment. The widget collects the provider API key, locks it with the key from the fragment, posts back via `postMessage` with the connected `source_wallet_ids`.
4. **Save the wallet** in your own database. You now have an OR-side connection plus a per-wallet binding.
5. **Sync** by calling `POST /functions/v1/or-sync` with `subaccount_id`, the same `credentials_key`, and `format: '<your-app-slug>'`. OR returns rows already shaped for your DB plus `metadata` listing which fields (if any) you must encrypt before persisting.

Steps 1, 2, 3, 5 each correspond to a section below.


## Architecture in one page

OR sits in the middle of two N×M problems and turns them into N+M.

```
   sources (N)                  OR                  consumers (M)
  ─────────────                ─────              ────────────────
  Blink ──────┐                                   ┌─────── BitBooks V2
  xpub ───────┤                                   ├─────── BitBooks V3
  Strike ─────┤   provider     sink     App       ├─────── OrangeWay
  BTCPay ─────┼── adapters ─── adapters profiles ─┼─────── BitBooks Personal
  Coinbase ───┤                                   ├─────── (your app)
  Quiltt ─────┤                                   │
  CCXT ───────┘                                   │
```

A **source provider adapter** speaks the upstream API (Blink GraphQL, xpub watch-only, BTCPay Greenfield, etc.) and translates each transaction into a single `NormalizedTransaction` shape. A **sink adapter** translates a `NormalizedTransaction` into the consumer's specific row shape (e.g. V2's `Transaction` + `JournalEntry` + `JournalEntryLine`). An **App Profile** (YAML, embedded as TS) declares the consumer's account-mapping rules and field generation.

Adding a new source helps every consumer. Adding a new consumer helps every source. Neither side cares about the other directly.

Pull-through model. OR stores connections (encrypted credentials, last-sync cursor) but does not store transactions in production. Every sync fetches fresh from upstream and emits rows back to the consumer. The consumer is the system of record.

Webhooks (where supported) are wake-up pings only, never data carriers.


## Authentication: platform vs direct mode

OR's edge functions accept two auth modes through the same `_shared/platform-auth.ts` helper.

### Platform mode

For server-to-server calls from your backend.

```
Header: X-Platform-API-Key: <hex64>
```

You receive your platform API key when you register your app with OR. Treat it like a secret. Never ship it to a browser. Body must include `subaccount_id` (validated to belong to this platform).

### Direct mode

For end-user-direct flows (the OR widget itself, future direct-mode SDK calls).

```
Header: Authorization: Bearer <jwt>
```

The user's Supabase JWT. The platform-auth helper resolves it to that user's direct subaccount automatically; passing `subaccount_id` in the body is rejected to prevent self-impersonation.

The Link widget at `orangerails.com/connect` is currently *unauthenticated* (the widget runs in an arbitrary user's browser with no platform secret). It calls `or-link-complete`, a special endpoint that authenticates by `platform_slug` and trusts the widget to honestly relay the user's intent. A future hardening pass will issue a short-lived widget session token from the integrating app's server.

### Public endpoints

`or-providers` is unauthenticated by design. The provider catalog is public information; deploying it with `verify_jwt = false` is correct.


## Subaccount provisioning

A subaccount is OR's container for one of your users (or organizations). One V2 organization, one V3 user, one OW user, one Personal user, all sit in their own subaccount.

```
POST /functions/v1/or-provision
Header: X-Platform-API-Key: <hex64>
Body:   { external_user_id: string }
200:    { subaccount_id: string, created: boolean }
```

`external_user_id` is **your platform's identifier for this user**. Most consumers pass their organizationId (V2) or userId (V3). It is what the widget will later send as `app_user_id` so OR can find the same subaccount from a different surface.

Idempotent. Same `external_user_id` always returns the same `subaccount_id`. Safe to call on every login.

Store both the `external_user_id` you sent and the `subaccount_id` you got back. They are not interchangeable.

> **Gotcha**: the field on V2's connection table is named `orPlatformUserId` for legacy reasons but actually stores the OR-side `subaccount_id`. Don't confuse the two when wiring URL parameters.

Reference: V2 [`app/api/organizations/[organizationId]/orange-rails/setup/route.ts`](https://github.com/DeeJanuz/bitbooks/blob/feat/orange-rails-integration/app/api/organizations/%5BorganizationId%5D/orange-rails/setup/route.ts).


## Vault setup (Path B, zero-knowledge)

The user's vault password never reaches your server.

### Why Path B

Your server stores the encrypted credentials at OR (technically OR stores them, but you POST them through). A breach of your server should not yield decryptable provider credentials. Argon2id + AES-256-GCM with a key derived in the browser only achieves that.

Path A, where the server holds the key or derives it from a server-known password, is rejected. Even if your data table ends up plaintext later, source credentials must remain end-to-end encrypted. The threat model is "two-breach floor": an attacker needs both your DB and the user's password to read the credential.

### What runs in the browser

```
   user types vault password
            │
            ▼
   Argon2id(password, 32-byte random salt)  ──► MEK (32 bytes)
            │
            ├──► sha256(MEK)              ──► verifier (sent to server)
            ├──► HKDF(MEK, "orangerails-creds-v1")  ──► credentials_key
            └──► AES-GCM(recovery_code, MEK)        ──► encrypted recovery code
```

You generate everything browser-side (salt, MEK, verifier, recovery code, ciphertext), then POST `{ vaultSaltB64, vaultVerifierB64, encryptedRecoveryCodeB64 }` to your own server. Server stores the salt and verifier on its connection row, persists the encrypted recovery code, returns the OR `subaccount_id`.

The plaintext recovery code stays in the browser long enough to display once. The user copies it. After page reload it is gone, recoverable only by re-typing the password to re-derive the MEK and decrypting the ciphertext.

### Argon2id parameters (must match exactly)

```
memorySize:  65536    (KiB)
iterations:  3
parallelism: 4
hashLength:  32        (256-bit MEK)
```

These are OWASP 2023 recommendations. Every consumer derives MEKs with the exact same parameters so a future cross-app handoff (Personal → V3, etc.) can re-derive the same key without needing the password again.

### HKDF info strings (must match exactly)

```
"orangerails-creds-v1"  ──► credentials_key  (locks provider credentials)
"orangerails-txns-v1"   ──► transactions_key (encrypts transaction payloads, ZK consumers only)
```

These string constants define the protocol. Don't add a "v2" suffix unless you mean to break compatibility.

### V2 implementation reference

- `lib/orange-rails/crypto-browser.ts`: Argon2id, HKDF, verifier, salt + recovery generation, AES-GCM encrypt
- `components/admin/add-connection-modal.tsx`: end-to-end vault setup flow

### Recovery code

A 12-word code from a 256-word subset of BIP-39. ~96 bits of entropy. AES-GCM ciphertext stored on your server. The user reads it once, after that the only way back is the password (which re-derives the MEK to decrypt the ciphertext). On password change or forgotten password, the recovery code is the unwrap path.

Wordlist source must match between server and browser; OR uses the same 256 words on both sides so a code generated client-side is interoperable.


## Connecting a wallet through the Link widget

The Link widget is OR's hosted credential collection page. Plaid-hybrid co-branding: your app's name appears prominently, "Powered by OrangeRails" smaller. Provider-specific form fields (Blink: API key; xpub: extended public key + gap limit; BTCPay: server URL + API key; etc.) come from the [provider catalog](#provider-catalog-dynamic-discovery).

### Open the popup

```js
const url = new URL('https://orangerails.com/connect');
url.searchParams.set('platform',     'your-app-slug');     // = your App Profile slug, e.g. 'bitbooks-v2'
url.searchParams.set('app_user_id',  organizationId);       // = the external_user_id you used at provision time
url.searchParams.set('provider',     selectedProvider);     // = a slug from /or-providers
url.searchParams.set('return_to',    window.location.origin);

// Hand off the credentials_key in the URL fragment so it never reaches OR's server logs.
url.hash = `cred_key=${encodeURIComponent(credentialsKeyB64)}`;

window.open(url.toString(), 'or-link', 'width=520,height=720');
```

`credentialsKeyB64` is the HKDF subkey you derived in the browser, base64-encoded.

> **Gotcha 1**: `app_user_id` is YOUR platform's identifier (= the `external_user_id` from provisioning), NOT OR's `subaccount_id`. Passing the OR UUID causes `or-link-complete` to mint a brand new orphan subaccount. The widget posts back successfully, your sync later returns zero connections because the connection landed under a different subaccount than you query.

> **Gotcha 2**: the URL fragment goes into `window.location.hash`. The widget reads it once and immediately strips it from history. Never put the cred_key in a query parameter; it would land in OR's server logs.

> **Gotcha 3**: `txn_key` is OPTIONAL. Plaintext consumers (V2 with sink mode) need only `cred_key`. ZK consumers (V3, OW today) pass both `cred_key` and `txn_key`. The widget reuses cred_key for metadata encryption when txn_key is absent. (Older versions of the widget required both keys and silently fell back to a built-in test password when one was missing, producing unrecoverable ciphertext. Make sure you are running the widget at commit `615614b` or later.)

### Receive the postMessage

```js
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://orangerails.com') return;
  if (event.data?.type !== 'or-link-success') return;

  const { source_wallets, subaccount_id, connection_id } = event.data;
  // Each source_wallet has { id, external_wallet_id, currency, label }.
  // Save them in your DB. Each becomes one of your "Wallet" / "Account" rows.
});
```

The widget closes itself ~1.2s after posting. If the user cancels, you get `{ type: 'or-link-cancel' }`.

### Save the wallet on your side

Per `source_wallet`, create one of your local wallet rows with:
- A foreign key to your "OR connection" row (which holds the salt + verifier)
- `sourceWalletId = source_wallet.id` (OR's source_wallets.id, used as the cross-system anchor)
- `externalId = source_wallet.external_wallet_id` (the upstream provider's stable ID for this wallet)
- Whatever name / metadata the user chooses (the widget sends a default label)

Reference: V2 [`app/api/organizations/[organizationId]/orange-rails/connect-wallet/route.ts`](https://github.com/DeeJanuz/bitbooks/blob/feat/orange-rails-integration/app/api/organizations/%5BorganizationId%5D/orange-rails/connect-wallet/route.ts).

### Wallet name uniqueness

If your DB has a unique-name-per-org constraint on wallets, archived rows still own their name. A user who disconnects "BTC wallet" then reconnects gets the next-available name ("BTC wallet (2)") unless your disconnect path frees the slot by suffixing the archived row.

V2's pattern: on disconnect, append " (disconnected YYYY-MM-DD)" to the archived row's name so the original is free for the next reconnect. On connect-wallet, auto-suffix with `(2)`, `(3)`, ... if the requested name still collides.


## Syncing transactions: protocol-driven sink mode

OR's `or-sync` has two modes selected by the body's `format` field.

### Sink mode (the one you want)

```
POST /functions/v1/or-sync
Header: X-Platform-API-Key: <hex64>
Body: {
  subaccount_id:   string,
  credentials_key: string,    // base64 raw 32 bytes from the browser, just-derived
  format:          string,    // your App Profile slug, e.g. 'bitbooks-v2'
  connection_ids?: string[]   // optional filter; default = all active connections
}
200: {
  synced:      number,
  connections: [{ connection_id, synced, next_cursor, error? }],
  rows: {
    Wallet:       [...],
    Transaction:  [...],
    JournalEntry: [...],
    JournalEntryLine: [...],
    // ...whatever tables your sink emits
  },
  metadata: {
    format:               string,
    requires_encryption:  string[]   // JSON paths into rows[] that the consumer's browser must AES-encrypt before insert
  }
}
```

OR fetches transactions from the upstream provider, runs your sink adapter on each `NormalizedTransaction`, returns app-shaped rows. No transactions are persisted server-side.

The credentials_key is in OR memory only for the duration of the request (used to decrypt the stored API key, then discarded).

`metadata.requires_encryption` is empty for plaintext consumers (V2). For ZK consumers (V3, OW), each entry is a path like `Transaction[3].counterparty` that the browser must AES-GCM-encrypt with a key the user has under password.

### Encrypted-payload mode (legacy, V3 today)

```
Body: {
  subaccount_id, credentials_key, transactions_key,    // no `format` field
  connection_ids?: string[]
}
```

Without `format`, OR runs the upstream fetch but **encrypts** each transaction with `transactions_key` and stores ciphertext in `encrypted_transactions`. Consumer fetches via `or-transactions-list` and decrypts in-browser. This was the only mode before sink dispatch shipped; V3 still uses it. New consumers should use sink mode.

### Resolving `__resolve*` hints

Sink rows contain hint fields prefixed `__resolve*` that the consumer's sync handler resolves against its own DB at insert time. Example from V2:

```
Transaction:
  walletId:      __resolveWalletId: { sourceWalletId: "<OR id>" }
  contactId:     __resolveContactId: { name: "@bob", kind: "VENDOR" }
  chartOfAccountId: (looked up on JournalEntryLine instead)
```

```
JournalEntryLine:
  chartOfAccountId: __resolveCoa: { accountType: 'INCOME', accountSubType: 'SALES', name: 'Sales' }
```

Your handler iterates the rows, replaces each hint with the resolved foreign key from your DB (find-or-create), then inserts. Pure mechanical translation.

Reference: V2 [`lib/orange-rails/sync-handler.ts`](https://github.com/DeeJanuz/bitbooks/blob/feat/orange-rails-integration/lib/orange-rails/sync-handler.ts) handles resolveCoa, resolveWalletId, resolveContactId, resolveSystemUser.

### Idempotency

OR's source adapters return the same canonical `id` for the same upstream transaction every time. Sink-emitted rows include those IDs so your dedup is straightforward (V2 uses `Transaction.refNum @@unique([orgId, refNum])`). Re-syncing the same window is safe.

### Empty connections

If the subaccount has zero non-disconnected connections, `or-sync` returns:

```
{ synced: 0, connections: [], rows: {}, metadata: { format, requires_encryption: [] } }
```

The shape is the same regardless. Your client should treat this as a soft "nothing to sync" rather than an error.


## App Profile (sink configuration)

Each consumer publishes one App Profile that tells OR's sink dispatcher how to translate canonical transactions into that consumer's row shape. The profile is a YAML document, embedded in OR as a TypeScript string export so it travels with the edge-function bundle.

V2's profile lives at `supabase/functions/_shared/sinks/profiles/bitbooks-v2.yaml.ts` and `bitbooks-v2.yaml` (mirror, kept in sync manually).

### What is load-bearing today

```
account_mapping_rules:    canonical type → debit/credit ChartOfAccount hints
status_to_v2:             provider status string → consumer's status enum
```

Editing either of these changes runtime behavior with no TS redeploy needed.

### What is documentary today

```
output_tables:            row field generation (still TS-driven)
identity:                 advisory
accepts_modules:          advisory
```

When the third consumer joins the protocol, output_tables will be lifted to YAML and the runtime sink will become a generic interpreter.

### Adding a new App Profile

1. Create `supabase/functions/_shared/sinks/profiles/<slug>.yaml.ts` exporting a `<SLUG>_PROFILE_YAML` string constant.
2. Register it in `_shared/sinks/profile-loader.ts` under `PROFILE_SOURCES`.
3. Implement the TypeScript sink at `_shared/sinks/<slug>.ts` (see `bitbooks-v2.ts` for the reference pattern).
4. Register the sink in `_shared/sinks/dispatch.ts`.

That is the entire surface area. Once registered, callers can pass `format: '<slug>'` to `or-sync`.


## Provider catalog (dynamic discovery)

Consumer apps render their wallet picker from `/or-providers`, not from a hardcoded list. When OR adds a new provider (Strike, BTCPay, Coinbase, etc.), every consumer picks it up automatically with no redeploy.

```
GET /functions/v1/or-providers
200: {
  providers: [
    {
      slug:             string,
      displayName:      string,
      description?:     string,           // subtitle for the picker tile
      status:           "live" | "beta" | "coming_soon",
      multiWallet:      boolean,
      credentialFields: [{ name, type, label, placeholder?, optional? }, ...]
    },
    ...
  ]
}
```

Public unauthenticated endpoint. Cache for 5 minutes at the edge. Fetch on modal open; safe to refetch on every modal open (response is identical for every caller).

### Status semantics

- `live` — adapter shipped, picker tile clickable
- `beta` — adapter shipped, surface a beta badge but allow connections
- `coming_soon` — placeholder manifest with no adapter yet, picker tile greyed out

Trying to use a `coming_soon` provider with `or-connection-create` returns 400 with the list of registered slugs. UI renders the tile as informational only.

### What to render

```
const tile = provider.status === 'coming_soon'
  ? <DisabledTile name={provider.displayName} subtitle={`${provider.description} · Coming soon`} />
  : <ClickableTile
      name={provider.displayName}
      subtitle={`${provider.description} · via Orange Rails`}
      onClick={() => openWidget(provider.slug)}
    />;
```

Reference: V2 [`components/admin/add-connection-modal.tsx`](https://github.com/DeeJanuz/bitbooks/blob/feat/orange-rails-integration/components/admin/add-connection-modal.tsx) `ProviderTiles` component.


## Wire-format gotchas (read before integrating)

Every error V2's integration hit. Each one is something you can step on too. Each links to the section above where it is documented in context.

### `app_user_id` is your platform's user-id, not OR's UUID

When opening the Link widget, pass the same value you used as `external_user_id` at `or-provision` time. Do NOT pass the `subaccount_id` you got back. The widget calls `or-link-complete` which looks up subaccounts by `external_user_id`; passing the wrong value mints a brand new orphan subaccount. Sync later returns zero connections because they are on a different subaccount than the one your code queries.

Symptom: `Sync failed at Bitcoin Connections: synced 0 / 0 wallets`, no errors logged. → [Connect a wallet](#connecting-a-wallet-through-the-link-widget).

### `cred_key` REQUIRED, `txn_key` OPTIONAL

The widget at orangerails.com/connect (commit 615614b or later) accepts cred_key alone. Older widgets required both and silently fell back to a built-in test password when one was missing, locking the credential with the wrong key. Sync later failed with "decryption failed" with no trail back to the cause.

Make sure your widget deploy is fresh. → [Connecting a wallet](#connecting-a-wallet-through-the-link-widget).

### YAML profiles must be inlined as TS strings

Supabase Edge Function bundling (esbuild) only includes files reachable through TS imports. A `.yaml` sibling never makes it into the deploy. Inline the YAML as a `\`\`\``-template-literal export in a `.yaml.ts` file and import that.

V2's profile lives at `bitbooks-v2.yaml.ts`, mirrored to `bitbooks-v2.yaml` for human review. → [App Profile](#app-profile-sink-configuration).

### YAML flow-mappings need quoted bracket paths

Inside `{ ... }`, square brackets are interpreted as nested flow sequences. `{ from: canonical.fees[0].amount }` parses as `canonical.fees` followed by a flow array `[0]` followed by `.amount`, which the parser rejects.

Quote any string containing `[`: `{ from: "canonical.fees[0].amount" }`. → [App Profile](#app-profile-sink-configuration).

### Default rules need `default: true` literal

Bare `- default:` parses as `{ default: null }`, which the validator's `rule.default === true` check rejects. Always write `- default: true`.

### `verify_jwt` defaults to true on new edge functions

When deploying a public unauthenticated endpoint (like `or-providers`), set `verify_jwt = false` in `supabase/config.toml`:

```
[functions.or-providers]
verify_jwt = false
```

Or pass `--no-verify-jwt` at deploy time. Without this, Supabase's gateway rejects requests before your code runs.

### Empty-connection responses must match mode

When `or-sync` finds zero connections under a subaccount, the response shape must match the mode the caller asked for. Sink-mode callers receive `rows: {}, metadata: {...}` even on empty results; encrypted-payload mode receives `{ synced, connections: [] }`. → [Syncing](#syncing-transactions-protocol-driven-sink-mode).

### Wallet name uniqueness includes archived rows

If your DB has `@@unique([orgId, name])` on wallets, archive does not free the slot. Either rename on archive (V2's pattern) or auto-suffix on create. → [Connecting a wallet](#connecting-a-wallet-through-the-link-widget).

### Setup flow: salt + verifier + ciphertext, not password

Path B requires the browser to generate the salt, derive the MEK, compute the verifier, generate AND encrypt the recovery code, then POST the resulting blobs. Sending the password to the server (Path A) breaks the security guarantee even for one HTTP request. → [Vault setup](#vault-setup-path-b-zero-knowledge).


## Adding a provider (for OR maintainers)

A new provider is a one-file change in `_shared/providers/<slug>.ts` plus one line in `_shared/providers/dispatch.ts`. Once landed, every consumer picks it up automatically through `/or-providers`.

The contract:

```
export interface ProviderAdapter {
  slug:             string;          // matches `connections.provider_type` column
  displayName:      string;          // human label for the picker tile
  description?:     string;          // subtitle (e.g. "Lightning + on-chain")
  status?:          'live' | 'beta' | 'coming_soon';   // defaults to 'live'
  multiWallet:      boolean;         // does the user pick from a list, or is it 1:1?
  credentialFields: CredentialField[];                  // schema for the encrypted credential blob
  discoverWallets:  (creds) => Promise<DiscoveredWallet[]>;
  syncByWallets:    (creds, walletIds[], cursor) => Promise<SyncResult>;
  syncAccountWide:  (creds, cursor) => Promise<SyncResult>;
}
```

Pure pass-through. No DB calls. No platform-auth concerns. Edge functions handle auth and persistence; the adapter just speaks upstream and translates to canonical.

Adapters MUST emit `source_wallet_id` on every `NormalizedTransaction` they return. Plaintext consumers (V2 via sink mode) require per-wallet attribution and throw on null source_wallet_id.

For BTCPay specifically, see the handoff brief in the V2 integration session log. For xpub, see `_shared/providers/xpub.ts` for the BIP44 gap-limit address scanning pattern.

### After your adapter ships

1. Move the placeholder out of `ROADMAP_MANIFESTS` (in `dispatch.ts`) into `PROVIDERS`. Status flips to 'live' from your adapter declaration.
2. Test that the V2 picker shows your tile clickable: `curl https://<your-or-domain>/functions/v1/or-providers`.
3. Test end-to-end through V2's connect flow before declaring done.


## Reference implementation: V2 file map

Use these as templates when integrating a new consumer.

| Concern | V2 file |
|---|---|
| Browser-side crypto (Argon2id, HKDF, AES-GCM, recovery code) | `lib/orange-rails/crypto-browser.ts` |
| Server-side crypto helpers + recovery code wordlist | `lib/orange-rails/crypto.ts`, `lib/orange-rails/recovery-wordlist.ts` |
| OR client (provision, sync) | `lib/orange-rails/client.ts` |
| Sink rows handler (resolves `__resolve*` hints, inserts rows in transaction) | `lib/orange-rails/sync-handler.ts` |
| Vault setup endpoint (Path B) | `app/api/organizations/[organizationId]/orange-rails/setup/route.ts` |
| Connect-wallet endpoint (post-widget save) | `app/api/organizations/[organizationId]/orange-rails/connect-wallet/route.ts` |
| Sync endpoint (browser → V2 → OR → V2 sync handler) | `app/api/organizations/[organizationId]/wallets/[walletId]/sync/route.ts` |
| Disconnect endpoint (free the wallet name slot for re-connect) | `app/api/organizations/[organizationId]/wallets/[walletId]/disconnect/route.ts` |
| Reset endpoint (vault wipe) | `app/api/organizations/[organizationId]/orange-rails/reset/route.ts` |
| Recovery code re-fetch endpoint | `app/api/organizations/[organizationId]/orange-rails/recovery-code/route.ts` |
| UI: dynamic provider picker + vault setup + sync prompt | `components/admin/add-connection-modal.tsx`, `components/admin/sync-password-modal.tsx`, `components/admin/admin-connectors.tsx` |
| Prisma schema (OrangeRailsConnection, OrangeRailsRecoveryCode, Wallet linkage fields) | `prisma/schema.prisma` |

If you copy V2 wholesale, the only consumer-specific things to change are:
- Your DB models (replace V2's Wallet/Transaction/JournalEntry/JournalEntryLine with yours)
- Your sink adapter on the OR side (`supabase/functions/_shared/sinks/<your-slug>.ts`)
- Your App Profile on the OR side (`profiles/<your-slug>.yaml.ts`)
- Your platform slug in the widget URL params

Everything else (browser crypto, vault setup, connect-wallet, disconnect, sync route, recovery code) is mechanically the same regardless of consumer. The deliberate goal is for consumer integration to be ~500 lines of glue plus your DB-specific sink, not 5000.


---

*This document is the authoritative wire-format reference. If you find an integration footgun not listed, please file an issue on the OR repo so we can document it and harden the surface.*
