# OrangeRails Implementation Plan

**Companion to:** [OrangeRails-Architecture.md](./OrangeRails-Architecture.md)
**Version:** 1.0
**Last updated:** 2026-04-18
**Status:** Active. This plan governs the build sequence through the first public launch.

---

## Table of Contents

1. [Guiding Principles](#1-guiding-principles)
2. [Current State Audit](#2-current-state-audit)
3. [Phase 0 — Cleanup (Week 1, Day 1-2)](#3-phase-0--cleanup-week-1-day-1-2)
4. [Phase 1 — OrangeRails Hub Foundation (Week 1-3)](#4-phase-1--orangerails-hub-foundation-week-1-3)
5. [Phase 2 — Link Widget + First Adapter (Week 3-5)](#5-phase-2--link-widget--first-adapter-week-3-5)
6. [Phase 3 — BitBooks V3 Integration (Week 5-6)](#6-phase-3--bitbooks-v3-integration-week-5-6)
7. [Phase 4 — Multi-Adapter Expansion (Week 6-10)](#7-phase-4--multi-adapter-expansion-week-6-10)
8. [Phase 5 — Public Launch Readiness (Week 10-12)](#8-phase-5--public-launch-readiness-week-10-12)
9. [Decisions Still Open](#9-decisions-still-open)
10. [Dependencies and Blockers](#10-dependencies-and-blockers)
11. [Milestone Tracker](#11-milestone-tracker)

---

## 1. Guiding Principles

Every task in this plan traces back to the architecture document. Before any implementation choice, we ask: *does this preserve session-based ZKA? does this keep the server unable to decrypt credentials on its own?* If no, the task is out of scope.

Additional principles:

- **Ship in thin vertical slices.** The first deliverable is a single end-to-end user flow — Sarah connects Blink through BitBooks, sees transactions. Not every Bitcoin provider, not every accounting feature. Just the slice that proves the architecture works.
- **Self-host parity from day one.** The hosted service and the self-hosted Docker deployment run identical code. No hosted-only features.
- **Audit surfaces are public from the first commit.** Credential encryption code is the most security-critical path. It goes into the repo as early and as visibly as possible so community review starts immediately.
- **Roark approves all public marketing claims.** The rename from "Bitcoin Connector" to OrangeRails is pending his review. Until that is signed off, public announcements stay generic.

---

## 2. Current State Audit

**What exists today:**

- `/home/orangerails/` on the Umbrel-Box: Express.js API server (port 3003). Single endpoint `/sync/blink` that proxies to Blink's GraphQL API with an API key passed in the request body. **This is a passthrough, not a hub.** No auth, no storage, no ZKA.
- `api.orangerails.com` DNS + Caddy TLS: working. Endpoint reachable, TLS cert auto-provisioned.
- Marketing site docs in Lovable (OR-01/02/03 prompts) — not yet deployed to Lovable.
- GitHub repo `MorningRevolution/orangerails` with founding documents.
- BitBooks Vault V3 (`MorningRevolution/bitbooks-vault` main branch): a Blink-specific Connections page, a `sync-blink` edge function, and a `connectors` table. **All three were built against the old (wrong) passthrough architecture and must be reworked.**

**What does not exist yet:**

- OrangeRails auth layer.
- OrangeRails database schema for connections and normalized transactions.
- OrangeRails Link widget (the popup that users see when connecting a provider).
- Session-based ZKA encryption pipeline.
- Access-token system for apps (BitBooks, future apps) to call OrangeRails on behalf of users.
- Any adapter other than the minimal Blink proof-of-concept.

**What is wrong and must be fixed (V3):**

- `supabase/functions/sync-blink/index.ts` — Blink-specific, does not belong in BitBooks.
- `src/pages/Connections.tsx` — has a Blink-specific UI, must become generic "OrangeRails Link" launcher.
- `src/components/layout/Sidebar.tsx` — the "Connections" nav item may stay but its target page will change.
- `supabase/migrations/20260416050000_connectors.sql` — the `connectors` table was designed for BitBooks to store credentials. It will be repurposed to store only `or_access_token` (no credentials).

---

## 3. Phase 0 — Cleanup (Week 1, Day 1-2)

**Goal:** revert the V3 code paths that were built against the wrong architecture. Leave V3 in a clean state before building forward.

> **Update 2026-06-16:** Phase 0 partially shipped via a different path.
> `sync-blink/index.ts` was NOT deleted — it was refactored to inline the
> Blink GraphQL adapter directly (cutting bb-support out of the OR
> customer path). The function still exists and is the canonical entry
> point for Blink sync. See commit `95a4d98` / PR #214 for the cut-over.
> Steps 3.1.1 and 3.1.2 below describe the original delete-and-replace
> plan; both are obsolete. Step 3.1.4 (connectors-table migration) is
> still pending V3-side work.

### 3.1 V3 changes

1. ~~**Delete** `supabase/functions/sync-blink/index.ts`~~ — **superseded.** Function refactored in place (commit 95a4d98). Inlined Blink GraphQL call, removed bb-support hop.
2. ~~**Simplify** `src/pages/Connections.tsx`~~ — **superseded.** Frontend re-architected around the canonical OR Link widget at `orangerails.com/connect/quiltt`; V3 frontend code path has changed.
3. **Keep** the Sidebar nav item pointing at `/connections`.
4. **Alter** the `connectors` table migration with a follow-up migration: drop the `config_encrypted` column (we will never store credentials in V3), add `or_access_token` (text, nullable) and `or_user_id` (text, nullable) columns. No migration is strictly required since the table is unused in production — but we do the migration anyway to make the DB schema match the intended design.
5. **Commit and push** to main. Lovable auto-deploys.

### 3.2 OrangeRails server changes

1. **Leave** the `/sync/blink` passthrough endpoint running on `api.orangerails.com`. It's harmless and useful for smoke testing until Phase 1 is ready.
2. **Tag** the current state as `v0.1.0-passthrough` in git so we can reference it historically.

### 3.3 Exit criteria

- V3 `main` branch has no Blink-specific code.
- Visiting `/connections` in V3 shows the "coming soon" placeholder without console errors.
- `sync-blink` edge function is undeployed.
- OrangeRails repo is tagged v0.1.0-passthrough.

**Estimated effort:** half a day.

---

## 4. Phase 1 — OrangeRails Hub Foundation (Week 1-3)

**Goal:** stand up the OrangeRails hub as a real, stateful service with users, sessions, vault key derivation, and a CRUD API for connections. No Link widget yet. No adapters beyond Blink. Just the spine.

### 4.1 Technology selections

| Layer | Choice | Reasoning |
|---|---|---|
| Frontend | React + Vite + shadcn/ui + TailwindCSS | Matches BitBooks V3 stack; shared component patterns |
| Frontend hosting | Lovable (for initial build speed) | Same as V3 |
| Backend | Supabase (Postgres + Auth + Edge Functions) | Matches V3 stack; Row-Level Security lets us enforce user isolation |
| Client-side crypto | Web Crypto API (native) + `@noble/hashes` for HKDF | No dependencies that could introduce supply-chain risk |
| KDF | Argon2id via `hash-wasm` | OWASP 2023 recommended; WASM for browser portability |

### 4.2 Supabase project setup

A separate Supabase project from BitBooks V3. This is important — we want clean separation of databases so the ZKA boundary is architecturally enforced, not just logically promised.

**Steps:**

1. Create new Supabase project `orangerails-prod` (and a separate `orangerails-dev`).
2. Configure auth providers: email + password, email magic link. (Passkey support deferred to Phase 5.)
3. Configure allowed origins for Edge Functions to include `api.orangerails.com` (final domain TBD post-Roark-approval).
4. Generate an OR_API_KEY for BitBooks V3 (used server-to-server for app-level authentication; see §4.6).

### 4.3 Database schema (Phase 1 tables)

```sql
-- Users (managed by Supabase Auth, referenced here)
-- auth.users has id, email, etc.

-- Per-user vault metadata
create table public.user_vault_meta (
  user_id uuid primary key references auth.users(id) on delete cascade,
  vault_salt text not null,            -- base64 random 128-bit, for Argon2id
  vault_verifier_ciphertext text not null,  -- proof of password without storing it
  vault_key_version smallint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Registered apps that can call OrangeRails on behalf of users
create table public.apps (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,             -- 'bitbooks', future: 'taxtool', etc.
  name text not null,
  public_key text not null,              -- for server-to-server auth
  created_at timestamptz not null default now()
);

-- User grants: "I allow app X to call OrangeRails on my behalf"
create table public.user_app_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  app_id uuid not null references public.apps(id) on delete cascade,
  access_token_hash text unique not null,  -- store a hash, not the token itself
  granted_scopes text[] not null default array['read:transactions'],
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);

-- Connections: per-user, per-provider, encrypted credentials
create table public.connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_type text not null,              -- 'blink', 'kraken', 'btcpay', 'xpub', ...
  encrypted_credentials text not null,      -- AES-256-GCM ciphertext, encrypted with user's ORK
  credentials_key_version smallint not null default 1,
  status text not null default 'active',    -- 'active' | 'error' | 'disconnected'
  last_sync_at timestamptz,
  last_sync_cursor text,                    -- provider-specific cursor for incremental sync
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Normalized transactions, encrypted with user's ORT
create table public.encrypted_transactions (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.connections(id) on delete cascade,
  external_id text not null,                -- provider's transaction id
  encrypted_payload text not null,          -- AES-256-GCM, encrypted with user's ORT
  payload_key_version smallint not null default 1,
  -- Plaintext metadata — minimum necessary for efficient querying
  occurred_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  unique (connection_id, external_id)
);

-- All tables have RLS enabled; policies restrict access to auth.uid() = user_id.
```

### 4.4 Client-side vault (React + Web Crypto + Argon2id)

**Library structure (mirrors V3 pattern):**

```
apps/web/src/lib/
├── vault.ts              # Argon2id KDF, AES-256-GCM encrypt/decrypt
├── key-derivation.ts     # HKDF for subkey derivation
└── crypto-fields.ts      # Per-entity encrypt/decrypt (credentials, transactions)

apps/web/src/context/
└── VaultContext.tsx      # React provider exposing encryptCredentials, decryptCredentials, etc.
```

**Key derivation parameters:**

- Argon2id: m=65536 KiB, t=3, p=4 (OWASP 2023 recommended).
- HKDF contexts: `"orangerails-creds-v1"`, `"orangerails-txns-v1"`. Versioned for future migration.
- Minimum password length: 12 characters. zxcvbn score must be >= 3.

**Public API (what the VaultContext exposes to components):**

```typescript
interface VaultContextType {
  isUnlocked: boolean;
  unlock(password: string): Promise<void>;
  lock(): void;
  setupVault(password: string): Promise<void>;
  encryptCredentials(plaintext: string): Promise<string>;
  decryptCredentials(ciphertext: string): Promise<string>;
  encryptTransaction(plaintext: string): Promise<string>;
  decryptTransaction(ciphertext: string): Promise<string>;
  // The raw subkeys — only exposed to code paths that need to hand them to the server in a sync request
  getCredentialsKeyForSync(): Promise<ArrayBuffer>;
  getTransactionsKeyForSync(): Promise<ArrayBuffer>;
}
```

### 4.5 Auth flows (Phase 1 — Supabase defaults)

Auth in Phase 1 uses Supabase's email + password flow augmented with the vault password:

1. **Signup:** user provides email + login password + vault password (separately, clearly labeled).
2. Login password authenticates with Supabase (creates the session).
3. Vault password is used only client-side to derive the MEK.
4. On first login, client calls `setupVault(vaultPassword)` — generates a random salt, derives MEK, encrypts a known verifier string, uploads `vault_salt` and `vault_verifier_ciphertext` to `user_vault_meta`.
5. On subsequent logins, client fetches `user_vault_meta`, re-derives MEK from the entered vault password, decrypts verifier to confirm match.

**Critical UX concern:** users will be confused by two passwords. Mitigations:

- Label them clearly ("Account password — recover via email" vs. "Vault password — unrecoverable, write it down").
- Offer a single-password option using the same password for both (users opt in knowingly — it weakens login security but simplifies the model).
- Magic-link-only login (no account password at all) is a future option once Supabase magic links are verified production-ready in our setup.

### 4.6 App-level authentication (how BitBooks calls OrangeRails)

Two-party auth:

1. **User-level auth (Supabase session):** proves "this is user X."
2. **App-level auth (HMAC signature):** proves "this request is coming from BitBooks, not a random app."

BitBooks gets a `client_secret` (generated when the app is registered in `apps` table). Every request to OrangeRails includes:

```
Authorization: Bearer <user_access_token>
X-OR-App-ID: bitbooks
X-OR-App-Signature: HMAC-SHA256(client_secret, timestamp + request_body)
X-OR-Timestamp: 2026-04-18T17:00:00Z
```

The `user_access_token` is not a Supabase JWT — it is an OrangeRails-issued token tied to a row in `user_app_grants`, created when the user explicitly grants BitBooks permission. We store only the hash (`access_token_hash`), not the token itself.

### 4.7 Sync endpoint (single-provider MVP)

```
POST /api/v1/sync
Headers: (see §4.6)
Body: {
  "connection_ids": [uuid],
  "credentials_key": "<base64 ORK — in-transit only>",
  "transactions_key": "<base64 ORT — in-transit only>"
}
Response: {
  "transactions": [ { "connection_id", "encrypted_payload", "occurred_at" } ],
  "sync_cursors": { "<connection_id>": "<cursor>" }
}
```

Server behavior:
1. Validate HMAC signature and user access token. Load the user's connections.
2. For each connection, decrypt credentials in memory using the credentials_key.
3. Call the provider adapter (e.g., Blink GraphQL), fetch new transactions since last cursor.
4. Normalize each transaction into the OrangeTransaction shape.
5. Encrypt each normalized transaction using transactions_key.
6. Store encrypted payloads in `encrypted_transactions`.
7. Return encrypted payloads to the app.
8. Zero all in-memory keys before the request handler returns.

### 4.8 Phase 1 exit criteria

- OrangeRails-prod Supabase project running with all Phase 1 tables.
- Users can sign up, set up a vault, log in, unlock vault.
- A registered app (BitBooks test credential) can call `POST /api/v1/sync` and receive encrypted transactions.
- Blink adapter working end-to-end: connection stored, sync runs, transactions returned encrypted.
- All credential-handling code in the repo, publicly visible.
- No session-level credential decryption is possible server-side without the client-provided key.

**Estimated effort:** 2 weeks of focused work.

---

## 5. Phase 2 — Link Widget + First Adapter (Week 3-5)

**Goal:** the popup UI that users see when a host app (BitBooks) says "Connect Bitcoin account." This is the user-visible contract of OrangeRails.

### 5.1 Link widget flow

Served at `api.orangerails.com/link`. Opens as a popup or same-window redirect. Parameters passed by the host app (BitBooks):

```
https://api.orangerails.com/link
  ?app_id=bitbooks
  &redirect_uri=https://bitbooks.com/callback
  &state=<CSRF-token>
  &scope=read:transactions
```

The widget:
1. Checks if the user is already logged into OrangeRails (session cookie). If not, prompts login/signup.
2. If signup: user creates account + vault password (see §4.5).
3. Shows the provider catalog: Blink, Kraken, BTCPay, xpub (Phase 2 — more in Phase 4).
4. User picks a provider, enters credentials in an in-widget form.
5. Widget derives ORK from the vault password, encrypts credentials client-side.
6. Widget calls `POST /api/v1/connections` with the ciphertext.
7. Widget shows "App X wants to access your transactions. Allow?"
8. On approval, generates an `access_token` row in `user_app_grants`, redirects back to `redirect_uri` with the token.

### 5.2 Host-app integration API

**From BitBooks V3 code:**

```typescript
import { openOrangeRailsLink } from '@orangerails/link-sdk';

const { accessToken, orUserId } = await openOrangeRailsLink({
  appId: 'bitbooks',
  scope: 'read:transactions',
});

// Store in V3 connectors table
await supabase.from('connectors').insert({
  org_id: currentOrgId,
  or_access_token: accessToken,
  or_user_id: orUserId,
  provider_type: 'orangerails',
});
```

The `@orangerails/link-sdk` npm package handles the popup, redirect back, token extraction. Published from this monorepo.

### 5.3 Phase 2 exit criteria

- `api.orangerails.com/link` is live and serves the widget.
- From a test BitBooks-V3-like app, a user can click "Connect" and complete the flow.
- Access tokens are issued and stored in `user_app_grants`.
- BitBooks can call `POST /api/v1/sync` with the access token and receive transactions.
- Self-hosted Docker deployment also serves `/link`.

**Estimated effort:** 2 weeks.

---

## 6. Phase 3 — BitBooks V3 Integration (Week 5-6)

**Goal:** rewire V3 to consume OrangeRails via the Link widget. This is the end-to-end proof of the architecture.

### 6.1 V3 changes

1. **Update** `supabase/migrations/` — new migration that adds `or_access_token`, `or_user_id`, `or_connection_ids` columns to `connectors`. Drop the old `config_encrypted`, `connector_type` columns (or keep `connector_type` set to `'orangerails'` for forward compat).
2. **Replace** `src/pages/Connections.tsx` with a real Connections page:
   - Shows a list of OrangeRails connections the user has established.
   - Has one big "Connect via OrangeRails" button that opens the Link widget.
   - Shows last sync time per connection.
   - Has a "Sync now" button that triggers a fresh sync.
   - Has a "Disconnect" button that revokes the access token and optionally purges the OrangeRails connection entirely.
3. **Add** `supabase/functions/or-sync/index.ts` — the new edge function that:
   - Accepts `connection_ids` from the client.
   - Pulls the `or_access_token` from the `connectors` table.
   - Calls OrangeRails `/api/v1/sync` with the access token + user's ORK + ORT (in-transit).
   - Returns encrypted transactions to the client for decryption.
4. **Client-side:** after sync, decrypt transactions with ORT, import them as journal entries (wire into the existing V3 JE creation flow).
5. **Vault key sharing:** V3 already has a vault MEK. We derive ORK and ORT from the same MEK using HKDF contexts `"orangerails-creds-v1"` and `"orangerails-txns-v1"`. **This means the same vault password protects both V3 accounting data and OrangeRails credentials.** The user sets up the vault once in V3; it just works for OrangeRails too.

### 6.2 Phase 3 exit criteria

- User opens V3 Connections page, clicks "Connect via OrangeRails", popup opens, user picks Blink, enters API key, returns to V3.
- V3 shows the new connection.
- Clicking "Sync" pulls transactions, decrypts them, displays them.
- User can review transactions and import to journal entries.
- Deletion in V3 cascades to revoke OR access token (and optionally purges credentials).

**Estimated effort:** 1 week.

### 6.3 Special consideration: existing V3 users

V3 already has users (internal testing). Their existing vaults work. The only change on first connection is the new flow. No migration of user data needed.

---

## 7. Phase 4 — Multi-Adapter Expansion (Week 6-10)

**Goal:** expand from one provider (Blink) to the full V1 adapter roster. Each adapter is 2-5 days.

### 7.1 Adapter priority order

Ranked by ecosystem impact + implementation ease:

| Order | Adapter | Provider | Est. days | Notes |
|---|---|---|---|---|
| 1 | `blink` | Blink / Galoy | done | Lightning + USD stablecoin. GraphQL. |
| 2 | `btcpay` | BTCPay Server | 3 | Merchant invoices, webhook signed. |
| 3 | `xpub` | Watch-only wallets | 3 | Bitcoin Core / Sparrow / Coldcard — descriptor-based. |
| 4 | `kraken` | Kraken | 4 | Spot trading + deposits + withdrawals. |
| 5 | `river` | River | 3 | DCA + treasury. |
| 6 | `strike` | Strike | 3 | Lightning + USD banking. |
| 7 | `lnd` | LND | 4 | gRPC + macaroon auth. |
| 8 | `core-lightning` | Core Lightning | 4 | Self-hosted LN node. |
| 9 | `braiins-pool` | Braiins Pool | 3 | Mining payouts. |
| 10 | `ocean-pool` | Ocean Pool | 3 | Non-custodial mining, BOLT12. |
| 11 | `csv` | File import | 2 | Universal fallback for any provider. |

### 7.2 Adapter SDK

Each adapter lives in `adapters/<name>/` and implements:

```typescript
export interface OrangeAdapter {
  id: string;
  displayName: string;
  credentialsSchema: JSONSchema;  // rendered dynamically in the Link widget
  authenticate(credentials: Record<string, string>): Promise<boolean>;
  listAccounts(credentials): Promise<OrangeAccount[]>;
  syncTransactions(credentials, cursor?): AsyncIterable<OrangeTransaction>;
}
```

The adapter SDK is a separate npm package (`@orangerails/adapter-sdk`) so community contributors can write adapters against a stable interface.

### 7.3 Phase 4 exit criteria

- 10+ adapters shipped and documented.
- Each adapter has adapter-level tests (connect, sync, handle errors).
- The Link widget dynamically renders credentials forms from each adapter's `credentialsSchema`.

**Estimated effort:** 3-4 weeks, mostly parallelizable.

---

## 8. Phase 5 — Public Launch Readiness (Week 10-12)

**Goal:** get to a place where we can publicly announce OrangeRails.

### 8.1 Security and operational

- [ ] External security audit of the credential-handling code path (Trail of Bits, Cure53, or similar).
- [ ] Publish the audit report unredacted.
- [ ] Threat model document published.
- [ ] Incident response runbook written.
- [ ] SOC 2 Type II roadmap drafted (not required at launch, but documented for later).

### 8.2 Legal

- [ ] Terms of service drafted and reviewed by counsel.
- [ ] Privacy policy drafted. Must explicitly reference the zero-knowledge architecture and the limits of what OrangeRails can know.
- [ ] Data processing agreement template for business customers.
- [ ] Formal legal opinion on the Tresorit-style GDPR breach-notification argument.

### 8.3 Documentation

- [ ] Public docs site at `docs.orangerails.com` (or `api.orangerails.com/docs` pre-domain swap).
- [ ] Architecture diagram video (3-5 min).
- [ ] "How to audit us" guide for power users.
- [ ] Adapter SDK guide for community contributors.

### 8.4 Hosting and operations

- [ ] Self-hosted Docker Compose deployment tested end-to-end.
- [ ] Hosted production Supabase project sized for expected traffic.
- [ ] Monitoring (Sentry, PostHog) set up with PII scrubbing.
- [ ] Rate limiting configured per app and per user.
- [ ] Backup and disaster recovery tested.

### 8.5 Marketing

- [ ] OR-01/02/03 Lovable prompts deployed. Marketing site live at `orangerails.com` (post-Roark approval + domain registration).
- [ ] Founders' blog post announcing the launch.
- [ ] Developer-focused announcement on Hacker News, r/Bitcoin, r/selfhosted.
- [ ] Outreach to Bitcoin voices (Lopp, Odell, Dorsey) with honest pitch — no hype.

### 8.6 Phase 5 exit criteria

- A non-employee can self-host a working OrangeRails instance in under 30 minutes.
- The hosted service is stable for 100+ concurrent active users.
- External audit findings are resolved (no critical, no high severity).
- We can truthfully claim everything in Section 1 of the architecture document.

**Estimated effort:** 2 weeks (heavy on ops, legal, and polish).

---

## 9. Decisions Still Open

Each of these needs a resolution before the dependent phase begins.

| # | Decision | Owner | Dependent Phase |
|---|---|---|---|
| 1 | Final product name (OrangeRails vs. alternative) | Roark + the maintainer | Phase 5 launch |
| 2 | Final domain (orangerails.com vs. fallback) | the maintainer | Phase 5 |
| 3 | Supabase Auth vs. self-hosted auth (Ory, Zitadel, custom) | the maintainer | Phase 1 |
| 4 | Magic-link-only login vs. email+password | the maintainer | Phase 1 |
| 5 | Single-password mode available? (same password for login + vault) | the maintainer | Phase 1 |
| 6 | Free tier limits (number of connections, sync frequency) | the maintainer + Roark | Phase 5 |
| 7 | Hosted-paid pricing anchors — validate with waitlist | the maintainer | Phase 5 |
| 8 | Passkey support timing (Phase 5 or post-launch) | the maintainer | Phase 5 |
| 9 | Which external auditor | the maintainer | Phase 5 |
| 10 | Company of record for OrangeRails (BitBooks Inc. vs. separate entity) | the maintainer + counsel | Phase 5 |

---

## 10. Dependencies and Blockers

- **Roark approval of the name "OrangeRails"** blocks public marketing (Phase 5). Does not block internal implementation.
- **Domain registration of `orangerails.com`** blocks the final production DNS flip (Phase 5).
- **Supabase project provisioning** must happen before Phase 1 coding begins.
- **Legal counsel engagement** blocks Phase 5 launch, should be initiated in parallel with Phase 1.
- **External security audit** has 4-6 week lead time — should be booked at the start of Phase 3 to be ready by Phase 5.

---

## 11. Milestone Tracker

Updated at the end of each week. Latest status below.

| Date | Milestone | Status |
|---|---|---|
| 2026-04-17 | Session 2026-04-17-DUNE — OrangeRails plan + naming decided | ✅ Done |
| 2026-04-18 | Session 2026-04-18-BIRCH — API server live, V3 Blink passthrough built (wrong arch) | ✅ Done (to be reverted) |
| 2026-04-18 | Session 2026-04-18-BIRCH — Architecture document v1.0 published, repo created, implementation plan written | ✅ Done |
| 2026-04-21 (est.) | Roark meeting — brand approval | Pending |
| Week 1 | Phase 0 cleanup complete | Pending |
| Week 3 | Phase 1 foundation complete | Pending |
| Week 5 | Phase 2 Link widget complete | Pending |
| Week 6 | Phase 3 V3 integration complete — end-to-end working | Pending |
| Week 10 | Phase 4 10+ adapters shipped | Pending |
| Week 12 | Phase 5 public launch | Pending |

---

**End of Implementation Plan v1.0.**

*Amendments follow the same process as the architecture document — written proposal, discussion, version bump.*
