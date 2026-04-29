# V2 ↔ OrangeRails Integration, Build Plan (Path B, Protocol-Driven)

**Status:** Internal · Draft v3 · 2026-04-29 (LARK)
**Scope:** First protocol-driven implementation of the OrangeRails Protocol. Path B (true zero-knowledge for credentials, mirror of V3's pattern) + new sync contract (`format=bitbooks-v2`).
**Target consumer:** BitBooks V2, the live customer-facing accounting product. Repo is `DeeJanuz/bitbooks` (private, on Daenon's GitHub profile). Local clone at `C:\CLAUDE\BitBooks\v2-legacy\`.
**First source:** Blink (live in OR).
**V2-side owner:** Daenon Janis.
**OR-side owner:** Orange Rails.
**Reference spec:** `OrangeRails-Protocol.html` (in this same folder), protocol design source of truth.
**Audience:** BitBooks team only, internal handoff doc, not for partners.

> **Path B confirmed.** V2's customers type a vault password, the browser derives the keys, V2's server never sees the password or any derived key. Source-provider credentials (Blink API keys, Strike OAuth secrets, Flash long-lived tokens) are encrypted at OR with a key the customer's browser controls. The V3 vault pattern, applied to V2 verbatim, simplified to a single password mode and renamed "vault password" everywhere.

> **YAML is load-bearing.** Account-mapping rules and status translations live in `_shared/sinks/profiles/bitbooks-v2.yaml`. The runtime parses, validates, and applies them on every sync. Editing the YAML changes runtime behavior, no TypeScript redeploy required for rule edits. Output row shape stays in TypeScript for now.

---

## 0. Inventory, what V2 has today and what changes

V2 is **not greenfield for OR**. Seven OR-related commits already shipped, plus uncommitted WIP on the current branch. Under Path B, most of that existing code is RIGHT. The Path A draft of this plan said otherwise; that draft was wrong and is superseded.

### Existing OR commits in V2

| Commit | Title | Path B verdict |
|---|---|---|
| `5b0f846` | feat(orange-rails): schema for Bitcoin Connections thin slice | KEEP |
| `536d2b5` | feat(orange-rails): API routes for setup, connect, and sync | KEEP, modify sync only |
| `ae50071` | feat(orange-rails): UI page for connecting and syncing Bitcoin wallets | KEEP, simplify mode picker |
| `2579b65` | fix(or): plug Orange Rails into existing Connectors tab | KEEP |
| `dcd19d9` | fix(orange-rails): match OR's real edge-function contract | KEEP, then update for `format=` contract |
| `c465b54` | feat(orange-rails): real sync via or-sync endpoint, ported from V3 | KEEP, then update for `format=` contract |
| `49b2b4d` | feat(orange-rails): real password design, vault mode choice, recovery code, MEK derivation | KEEP, simplify to single mode |

Plus uncommitted WIP on `fix/qb-import-grouping-and-bs-net-income` (separate from the OR rework, that is QB-import work). The OR work continues on the existing `feat/orange-rails-integration` branch.

### Existing OR file inventory in V2 (Path B verdicts)

| Path | What it does today | Verdict under Path B |
|---|---|---|
| `prisma/schema.prisma` → `OrangeRailsConnection` model with `vaultMode`, `vaultSaltB64`, `vaultVerifierB64` | V3-style ZK setup per org | **KEEP** the salt + verifier (still needed). Drop the `vaultMode` enum field after we collapse to a single mode. Optionally rename `orPlatformUserId` → `orSubaccountId` to match OR's terminology. |
| `prisma/schema.prisma` → `OrangeRailsRecoveryCode` model | 12-word recovery code encrypted under MEK | **KEEP**. The recovery code is part of Path B's "lose your password, recover via 12 words" UX. |
| `prisma/schema.prisma` → `OrangeRailsVaultMode` enum | SIGNIN_PASSWORD vs WALLET_PASSWORD picker | **DROP** the enum. Single mode going forward, called "vault password". |
| `prisma/schema.prisma` → `Wallet.sourceWalletId`, `Wallet.orConnectionId` | Link V2 wallets to OR-side source wallets | **KEEP** (already correct). |
| `lib/orange-rails/client.ts` | Server-to-server client: `or-provision`, `or-sync` (with `transactions_key`), `or-transactions-list` | **REWORK**. Drop `transactions_key` parameter on `or-sync`, drop `listOrTransactions` entirely, add `format: 'bitbooks-v2'` to the sync payload. New response shape returns rows directly. |
| `lib/orange-rails/crypto-browser.ts` | Browser Argon2id KDF + key derivation + AES-GCM helpers | **KEEP** the KDF and credentials-key derivation. Drop the transaction-payload decryption helpers (no encrypted payloads come back any more). |
| `lib/orange-rails/crypto.ts` | Server crypto helpers | **REVIEW** with Daenon. Path B does most crypto in the browser. Server crypto helpers may exist for legitimate non-OR reasons; keep what is unrelated to OR, drop OR-specific server crypto. |
| `app/api/.../orange-rails/setup/route.ts` | Provisions OR subaccount + sets up vault password + recovery code | **KEEP**. Already the right shape under Path B. Confirm it does not forward the password through V2 server (browser must derive locally). |
| `app/api/.../orange-rails/connect-wallet/` | Returns Link widget URL, browser passes credentials_key in-transit | **KEEP**. |
| `app/api/.../orange-rails/recovery-code/` | Recovery code re-fetch / acknowledge | **KEEP** (Path B uses recovery codes). |
| `app/api/.../orange-rails/reset/` | Reset vault password flow | **KEEP** (re-wraps MEK with new password). |
| `app/api/.../wallets/[walletId]/sync/route.ts` | Triggers or-sync with user-derived keys + decrypts payloads + inserts | **REWORK**. Sends `format: 'bitbooks-v2'`, drops `transactions_key`. Inserts the returned `rows` directly. No payload-decryption pass. |
| `app/api/.../wallets/[walletId]/disconnect/` | Disconnect a wallet | **KEEP**. |
| `components/admin/add-connection-modal.tsx` | Modal with vault-mode picker + password setup + Link widget | **SIMPLIFY**. Drop the vault-mode picker. Single password field labeled "vault password". Recovery-code reveal screen on first setup stays. |
| `components/admin/admin-connectors.tsx` | Connectors list with sync button + password modal | **SIMPLIFY**. The vault unlock prompt stays (browser derives keys per session). Add multi-connection bulk sync: one password entry, all connections sync together until refresh or close. |
| `TESTING-OR.md` | Manual QA checklist for the thin slice | **UPDATE** for the new flow (single password, format=bitbooks-v2, multi-sync). |
| `business-docs/V2-OR-INTEGRATION-PR-SPEC.md` | Detailed PR spec (predates this build plan) | **DEPRECATE**. This build plan supersedes. Move to `business-docs/archive/` with a header note. |

### What this rework changes for the V2 customer

| Today | After rework |
|---|---|
| User picks SIGNIN_PASSWORD vs WALLET_PASSWORD at setup | Single password field, labeled "vault password". One mode, no picker. |
| User shown a 12-word recovery code at setup | Same. Recovery code is part of the "you control the keys" model. |
| User enters vault password on every sync | User enters vault password once per browser session. Multi-connection sync uses the in-memory keys until refresh or close. |
| User decrypts transaction payloads in the browser before they are inserted | No browser decryption pass. OR returns V2-shaped rows directly. |
| Three OR roundtrips per sync (provision once, or-sync, or-transactions-list) | One OR roundtrip per sync (`or-sync` with `format=bitbooks-v2` returns rows). Provision still one-time. |
| Tile grid of providers (Blink as the only active tile) | Search and typeahead pattern, ready for hundreds of providers. Day one is still Blink only. |

### Why Path B is right for V2 even though V2 stores transactions plaintext

The source-provider credential (Blink API key, Strike OAuth refresh token, Flash long-lived secret) is sensitive in its own right. An attacker who reads it can impersonate the customer at the source provider, drain a Lightning balance, post to a payment processor, etc. That risk exists independently of how V2 stores the transaction history.

Path B encrypts the credential at OR with a key the customer's browser holds. A breach of OR alone returns ciphertext that needs the customer's password. A breach of V2 alone returns plaintext transactions but not the source credential. Both are required for an attacker to impersonate the customer at the source. That two-breach floor is the right privacy ceiling for the source credential.

Path A would have V2's server hold the encryption key, and any V2 breach exposes the source credential alongside the transaction history. Path A trades real privacy for one-click connect UX. the maintainer chose Path B because the privacy property matters and the UX cost (vault password prompt once per session, 12-word recovery code) is small enough to absorb.

---

## 1. Why V2 first

V2 is the right place to land the protocol's first proof point:

- **V2 is live.** Customers use it now. A working Blink → V2 sync ships real value to real merchants on day one.
- **V2 is roughly 80% there already** under Path B. The existing thin slice already mirrors V3's vault pattern. The gap is the protocol contract: V2 is still using the encrypted-payload-store flow (sends `transactions_key`, calls `or-transactions-list`, decrypts in browser) instead of the new `format=bitbooks-v2` flow that returns rows in the response.
- **The rework is small on V2 side.** Most of the work is OR-side (the V2 sink adapter, the YAML profile, the format parameter on or-sync). All of that is already DONE as of this build plan. V2-side work is adapting `client.ts` and the sync route + simplifying the vault-mode picker.
- **V3 is the next reference.** After V2 lands, V3 migrates to the same `format=bitbooks-v3` pattern, retires its local `orImportBridge.ts`, and stops calling `or-transactions-list` for transactions.
- **Daenon owns V2.** Clean handoff: this doc describes the V2-side rework, he executes on V2 timing.

The protocol promise is "publish your App Profile, OR delivers ready-to-insert rows, your insert path stays thin." V2 is the first proof.

---

## 2. Architecture recap (one page)

| Piece | Lives in | Owner | Status |
|---|---|---|---|
| **OrangeRails Protocol spec** | `MorningRevolution/orangerails-docs` (`OrangeRails-Protocol.html`) | the maintainer | Drafted |
| **YAML profile loader + rule engine** | `MorningRevolution/orangerails`, `_shared/sinks/profile-loader.ts` + `profile-engine.ts` | the maintainer | DONE 2026-04-29 |
| **V2 App Profile YAML (load-bearing)** | `MorningRevolution/orangerails`, `_shared/sinks/profiles/bitbooks-v2.yaml` | the maintainer | DONE 2026-04-29 |
| **OR sink adapter for V2** | `MorningRevolution/orangerails`, `_shared/sinks/bitbooks-v2.ts` | the maintainer | DONE 2026-04-29 |
| **`or-sync` `format=` parameter handling** | `MorningRevolution/orangerails`, `supabase/functions/or-sync/index.ts` | the maintainer | DONE 2026-04-29 |
| **V2 platform record + API key in OR** | OR's `platforms` table | the maintainer | Already in place from thin-slice work |
| **V2 client refactor (`client.ts`, sync route)** | `DeeJanuz/bitbooks`, `lib/orange-rails/` + `app/api/.../sync/` | Daenon | TODO |
| **V2 vault-mode picker simplification** | `DeeJanuz/bitbooks`, `components/admin/add-connection-modal.tsx` | Daenon | TODO |
| **V2 multi-connection bulk sync** | `DeeJanuz/bitbooks`, `components/admin/admin-connectors.tsx` | Daenon | TODO |
| **V2 provider search UX (replace tile grid)** | `DeeJanuz/bitbooks`, connectors UI | Daenon | TODO (day-one Blink-only is fine, just don't lock the UI to tiles) |

**Sync model:** pull-through. V2 customer unlocks vault → browser derives MEK and OR subkeys → V2 calls `or-sync` with the credentials key in-transit and `format: 'bitbooks-v2'` → OR decrypts source-provider credentials in memory, calls Blink, runs the V2 sink adapter, returns V2-shaped rows in the response → V2 inserts.

**OR holds nothing between requests** except encrypted credentials (ciphertext that needs the customer's password) and routing metadata (subaccount IDs, last-sync cursors). Webhooks from sources, when supported, are wake-up pings that trigger a V2-initiated sync, never data carriers.

---

## 3. The V2 App Profile (load-bearing YAML)

Lives at `MorningRevolution/orangerails`, path `supabase/functions/_shared/sinks/profiles/bitbooks-v2.yaml`. Loaded at runtime by `profile-loader.ts`, validated against the schema, cached for the lifetime of the edge-function instance.

The YAML drives two runtime decisions per transaction:

1. **`account_mapping_rules`**, first-match-wins. Each rule has either a `when` clause (matched against the canonical transaction's `type` and `direction` today) or `default: true`. The first match returns its `debit` and `credit` CoA hints. The engine resolves any `from: canonical.X` / `from: derived.X` / `from: input.X` references at runtime.
2. **`status_to_v2`**, provider status string → V2's `TransactionStatus` enum, with the `default` key as fallback.

Editing either of these in the YAML and redeploying changes runtime behavior. No TypeScript edit needed for rule edits.

A snippet of the YAML (the full file is in OR repo):

```yaml
app: bitbooks-v2
version: 2026.04.29
canonical_version: v0
accepts_modules: [bitcoin]

account_mapping_rules:
  - when: { type: lightning, direction: in }
    debit:
      accountType: ASSET
      accountSubType: WALLETS
      isWallet: true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency: { from: derived.asset }
    credit:
      accountType: INCOME
      accountSubType: SALES
      name: "Sales"

  - when: { type: lightning, direction: out }
    debit:
      accountType: EXPENSE
      accountSubType: OTHER_EXPENSES
      name: "Lightning Payments"
    credit:
      accountType: ASSET
      accountSubType: WALLETS
      isWallet: true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency: { from: derived.asset }

  # ... onchain in/out, default fallback to SUSPENSE ...

status_to_v2:
  SUCCESS: COMPLETE
  PENDING: PENDING
  FAILED: FAILED
  REVERSED: REVERSED
  default: INCOMPLETE
```

What stays in TypeScript (per the YAML loader trade-off): row construction. The `Wallet`, `Transaction`, `JournalEntry`, `JournalEntryLine` field shapes live in `_shared/sinks/bitbooks-v2.ts`. Lifts to YAML when the protocol gets a third consumer.

---

## 4. OR-side deliverables (DONE)

All OR-side files are in `MorningRevolution/orangerails`, on `main` per the Lovable rule. Confirm the merge before V2 starts integration testing.

| Path | Lines | Role |
|---|---|---|
| `supabase/functions/_shared/sinks/types.ts` | 160 | `SinkAdapter` interface, `NormalizedTransaction` shape, `mergeSinkOutputs` helper. |
| `supabase/functions/_shared/sinks/profile-loader.ts` | 240 | Parses YAML via `std/yaml`, validates structure, caches per format slug. Fail-closed on malformed YAML. |
| `supabase/functions/_shared/sinks/profile-engine.ts` | 226 | `findMatchingRule(profile, tx, derived, input)` walks `account_mapping_rules` with `from:` reference resolution. `mapStatus(profile, providerStatus)` walks `status_to_v2`. |
| `supabase/functions/_shared/sinks/bitbooks-v2.ts` | 280 | V2 sink: derived-context builder, row construction for Wallet / Transaction / JournalEntry / JournalEntryLine, embeds `__resolveCoa` / `__resolveWalletId` / `__resolveContactId` / `__resolveSystemUser` hints for V2 to resolve at insert time. |
| `supabase/functions/_shared/sinks/dispatch.ts` | 66 | Format slug → SinkAdapter map, `ensureProfileForFormat(format)` async loader. |
| `supabase/functions/_shared/sinks/profiles/bitbooks-v2.yaml` | 235 | Load-bearing rules + status mapping. |
| `supabase/functions/_shared/sinks/profiles/README.md` | 54 | Documents YAML-as-runtime, what's load-bearing, what stays in TS. |
| `supabase/functions/or-sync/index.ts` | 628 | Two-mode handler. `format` absent = legacy encrypted-payload path (untouched, V3 still uses it). `format` present = sink dispatch, returns rows in response, no encrypted_transactions storage, transactions_key not required. |

**The protocol contract V2 calls:**

```http
POST /functions/v1/or-sync
X-Platform-API-Key: <V2 platform key>
Content-Type: application/json

{
  "subaccount_id": "<V2 org's OR subaccount UUID>",
  "credentials_key": "<base64 raw 32 bytes, the orCredsKey browser-derived from vault password>",
  "format": "bitbooks-v2"
}
```

**Response (success):**

```json
{
  "synced": 5,
  "connections": [{ "connection_id": "...", "synced": 5, "next_cursor": "..." }],
  "rows": {
    "Wallet":            [{ "sourceWalletId": "...", "__resolveCoa": {...}, ... }],
    "Transaction":       [{ "id": "...", "__resolveWalletId": {...}, "amount": "0.00045000", ... }],
    "JournalEntry":      [{ "id": "...", "refNum": "JE-OR-...", ... }],
    "JournalEntryLine":  [{ "journalEntryId": "...", "__resolveCoa": {...}, "debit": "0.00045000", ... }]
  },
  "metadata": {
    "format": "bitbooks-v2",
    "requires_encryption": []
  }
}
```

**Backward-compatible.** When `format` is absent, the existing encrypted-payload path runs unchanged. V3 stays on that path until it migrates.

---

## 5. V2-side rework (Daenon)

Three concrete changes plus UI simplification. Most of the existing OR code stays.

### 5.1 `lib/orange-rails/client.ts`, switch to `format=` and drop `transactions_key`

```typescript
// Before
export async function syncWalletFromOr(args: {
  subaccountId: string;
  credentialsKeyB64: string;
  transactionsKeyB64: string;        // DROP under Path B + new contract
}): Promise<OrSyncResponse> {
  // ...
  body: JSON.stringify({
    subaccount_id: args.subaccountId,
    credentials_key: args.credentialsKeyB64,
    transactions_key: args.transactionsKeyB64,
  })
  // ...
}

// After
export async function syncOrgFromOr(args: {
  subaccountId: string;
  credentialsKeyB64: string;
}): Promise<OrSyncFormattedResponse> {
  const url = `${OR_BASE_URL}/functions/v1/or-sync`;
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({
      subaccount_id: args.subaccountId,
      credentials_key: args.credentialsKeyB64,
      format: 'bitbooks-v2',         // <-- the protocol contract change
    }),
  });
  if (!res.ok) throw new OrangeRailsClientError(res.status, await res.text());
  return orSyncFormattedResponseSchema.parse(await res.json());
}

// DELETE: listOrTransactions and the OrEncryptedTxRow type, no longer used.
```

New response schema:

```typescript
const orSyncFormattedResponseSchema = z.object({
  synced: z.number().int(),
  connections: z.array(z.object({
    connection_id: z.string(),
    synced: z.number().int(),
    next_cursor: z.string().nullable(),
    error: z.string().optional(),
  })),
  rows: z.object({
    Wallet: z.array(z.unknown()).optional(),
    Transaction: z.array(z.unknown()),
    JournalEntry: z.array(z.unknown()),
    JournalEntryLine: z.array(z.unknown()),
  }),
  metadata: z.object({
    format: z.literal('bitbooks-v2'),
    requires_encryption: z.array(z.string()),
  }),
});
```

### 5.2 `app/api/.../wallets/[walletId]/sync/route.ts`, insert returned rows directly

```typescript
import { syncOrgFromOr } from '@/lib/orange-rails/client';
import { applyOrSyncResponse } from '@/lib/orange-rails/sync-handler';

export async function POST(req: Request, { params }) {
  const { organizationId, walletId } = params;
  await assertMember(req, organizationId);

  // Browser-derived credentials key arrives in the request body
  const { credentials_key } = await req.json();
  if (!credentials_key) return badRequest('credentials_key required');

  const conn = await prisma.orangeRailsConnection.findUnique({
    where: { organizationId },
  });
  if (!conn) return notFound();

  const result = await syncOrgFromOr({
    subaccountId: conn.orPlatformUserId,    // OR's subaccount UUID
    credentialsKeyB64: credentials_key,
  });

  // Insert the returned V2-shaped rows. Resolver helpers find or create
  // ChartOfAccount / Wallet / Contact / system user as needed.
  const stats = await applyOrSyncResponse(organizationId, conn.id, result);

  return Response.json({ ok: true, ...stats });
}
```

### 5.3 New file: `lib/orange-rails/sync-handler.ts`, resolves `__resolve*` hints, inserts

```typescript
import { prisma } from '@/lib/prisma';

export async function applyOrSyncResponse(
  orgId: string,
  orConnectionId: string,
  response: OrSyncFormattedResponse,
) {
  // V2 stores plaintext at rest. requires_encryption should be empty.
  if (response.metadata.requires_encryption.length > 0) {
    throw new Error(
      `Unexpected encryption fields for V2 sink: ${response.metadata.requires_encryption.join(', ')}`,
    );
  }

  const resolvers = makeResolvers(orgId, orConnectionId);

  await prisma.$transaction(async (tx) => {
    // Order matters: Wallet must exist before Transaction references it
    for (const w of response.rows.Wallet ?? []) {
      await resolvers.resolveAndUpsertWallet(tx, w);
    }
    for (const je of response.rows.JournalEntry) {
      await resolvers.resolveAndCreateJE(tx, je);
    }
    for (const line of response.rows.JournalEntryLine) {
      await resolvers.resolveAndCreateLine(tx, line);
    }
    for (const t of response.rows.Transaction) {
      await resolvers.resolveAndCreateTransaction(tx, t);
    }
  });

  return { synced: response.rows.Transaction.length };
}

function makeResolvers(orgId: string, orConnectionId: string) {
  // Read __resolveCoa, __resolveWalletId, __resolveContactId, __resolveSystemUser
  // hints from each row. For each, find or create against V2's Prisma client.
  // Auto-create a "Suspense" CoA on first encounter. Auto-create the
  // OrangeRails system user (createdById / postedById on JournalEntry) on
  // first sync. Full implementation in the V2 PR, pattern follows V2's
  // existing CoA seed logic + Contact find-or-create paths.
  return { /* ... */ } as any;
}
```

### 5.4 Schema simplifications

```sql
-- Drop the vault-mode enum (single-mode now)
ALTER TABLE "OrangeRailsConnection" DROP COLUMN "vaultMode";
DROP TYPE "OrangeRailsVaultMode";

-- Optional rename for clarity (matches OR's `subaccount_id` terminology)
ALTER TABLE "OrangeRailsConnection" RENAME COLUMN "orPlatformUserId" TO "orSubaccountId";
```

Both safe migrations: no production OR connections yet, only thin-slice test data which can be wiped.

### 5.5 UI simplifications

**`components/admin/add-connection-modal.tsx`**, drop the SIGNIN_PASSWORD vs WALLET_PASSWORD picker. Single password field labeled "vault password". Recovery-code reveal screen on first setup stays, with clear copy: "Save these 12 words. If you forget your vault password, this is the only way back into your data. Lose both, lose your bookkeeping for connected accounts."

**`components/admin/admin-connectors.tsx`**, vault unlock prompt stays (browser derives keys per session). Add multi-connection bulk sync: "Sync all connections" button that, with the keys already in browser memory, syncs every connection sequentially without re-prompting for the password.

**Provider discovery**, replace the tile grid in `add-connection-modal` with a search and typeahead pattern. Day-one Blink only is fine, just structure the UI to grow. When the protocol picks up Strike, Flash, Lunar Rails, Quiltt, the grid would not scale; search does.

### 5.6 Files that DROP under the simplification

- `OrangeRailsVaultMode` enum (single mode now)
- `vaultMode` field on `OrangeRailsConnection`
- The vault-mode picker UI in `add-connection-modal.tsx`
- The `listOrTransactions` function in `client.ts` (no longer used)
- The transaction-payload decryption helpers in `crypto-browser.ts` (no encrypted payloads come back)

### 5.7 Files that STAY (under Path B these are correct)

- `OrangeRailsRecoveryCode` model (recovery is part of Path B)
- `OrangeRailsConnection` salt + verifier fields
- `lib/orange-rails/crypto-browser.ts` (KDF + key derivation, just trim the unused decryption helpers)
- `app/api/.../orange-rails/setup/route.ts` (provisions vault, generates recovery code)
- `app/api/.../orange-rails/recovery-code/` route (re-fetch + acknowledge flow)
- `app/api/.../orange-rails/reset/` route (re-wrap MEK with new password)
- `app/api/.../orange-rails/connect-wallet/` route
- All Wallet linkage fields

---

## 6. The user flow under Path B + new sync contract

| Step | Customer action | What happens behind the scenes |
|---|---|---|
| 1 | Logs into V2 at `app.bitbooks.com` | Standard Better Auth flow |
| 2 | Goes to Admin → Connectors. Clicks "+ Add Connection" | V2 calls `setup` route. First-time customer: a vault is provisioned (random MEK, password-derived KEK wraps it, 12-word recovery code generated). Recovery code shown once; customer saves it. OR subaccount provisioned. |
| 3 | Picks "Blink", pastes Blink API key | Browser derives the OR credentials subkey from the MEK. Browser AES-GCM encrypts the API key locally. Posts ciphertext to OR's `or-connection-create`. The API key never leaves the browser unencrypted. |
| 4 | Returns to Connectors list with the new connection visible | OR confirms storage. V2 displays the connection row (status, last_sync_at). |
| 5 | Clicks "Sync now" (or first sync runs automatically) | Vault unlock prompt if locked; otherwise the in-memory keys are already there. Browser exports the credentials key as base64. V2 server route forwards it (in-transit only, no persistence) to OR's `or-sync` with `format=bitbooks-v2`. |
| 6 | Sees Blink transactions in V2's transactions list | OR fetches from Blink, runs V2 sink, returns V2-shaped rows. V2 inserts. Customer's books update. |
| 7 | Closes the browser tab | Vault locks. MEK and subkeys cleared from memory. Effective disconnect from data view. |
| 8 | Returns later, reopens V2, unlocks vault | Same in-memory keys. Sync All button uses one password entry to sync every connection. |

---

## 7. Sync flow (technical sequence)

```
[V2 browser]                  [V2 server route]                [OR or-sync]                [Blink]
     |                              |                                |                       |
     | unlock vault                 |                                |                       |
     | derive MEK + orCredsKey      |                                |                       |
     |                              |                                |                       |
     | POST sync (credentials_key)  |                                |                       |
     |----------------------------->|                                |                       |
     |                              | POST or-sync                   |                       |
     |                              |  X-Platform-API-Key            |                       |
     |                              |  format=bitbooks-v2            |                       |
     |                              |  credentials_key               |                       |
     |                              |------------------------------->|                       |
     |                              |                                | load profile YAML     |
     |                              |                                | decrypt creds w/ key  |
     |                              |                                | (in memory only)      |
     |                              |                                |---------------------->|
     |                              |                                |    Blink transactions |
     |                              |                                |<----------------------|
     |                              |                                | normalize → canonical |
     |                              |                                | engine: rules + status|
     |                              |                                | sink: build V2 rows   |
     |                              |                                | wipe RAM              |
     |                              |   { rows, metadata, synced }   |                       |
     |                              |<-------------------------------|                       |
     |                              | applyOrSyncResponse: resolve   |                       |
     |                              | __resolve* hints, prisma upsert|                       |
     |   { ok: true, synced: 5 }    |                                |                       |
     |<-----------------------------|                                |                       |
     | refresh transactions list    |                                |                       |
```

OR persists nothing about this transaction batch beyond an updated cursor and a one-line access log. The credentials key existed in OR memory for the duration of one HTTP request, then was wiped.

---

## 8. Test plan (manual end-to-end)

| # | Step | Expected | Pass criteria |
|---|---|---|---|
| 1 | OR-side: confirm `platforms` row for `bitbooks-v2` is present and active | `SELECT * FROM platforms WHERE slug='bitbooks-v2'` returns one row, `is_internal=false`, `tier='production'` | Row present |
| 2 | OR-side: curl `or-sync` with `format=bitbooks-v2` against test subaccount | Response has `rows.Wallet`, `rows.Transaction`, `rows.JournalEntry`, `rows.JournalEntryLine` populated; `metadata.format='bitbooks-v2'`; `metadata.requires_encryption=[]` | All four arrays present, no exceptions |
| 3 | OR-side: malformed YAML test (rename a required field, redeploy) | First sync request returns 500 with `Profile load failed for format=bitbooks-v2: ...` | Fail-closed verified |
| 4 | V2-side: Daenon deploys client + sync-handler refactor on `feat/orange-rails-integration` | `npm run dev` succeeds, no TS errors | Clean compile |
| 5 | V2-side: New customer signs up, opens Admin → Connectors | Connectors page renders, "+ Add Connection" enabled | UI works |
| 6 | V2-side: Click + Add Connection. Single password field shown (no mode picker) | Vault setup runs, recovery code reveal screen shown once | Recovery code displayed, saved by user |
| 7 | V2-side: Pick Blink, paste API key. Connection appears in list | OR connection row created. V2 connection row links to it via `orConnectionId` | Row in V2's `OrangeRailsConnection` |
| 8 | V2-side: Click Sync now. Vault unlock prompt appears | Customer types vault password. Browser derives keys. Sync runs. | "Synced N transactions" toast |
| 9 | V2-side: Check `Transaction` table has rows with correct `walletId`, `journalEntryId` | Each Transaction has `journalEntryId` populated, JE has matching lines, JE Lines balance to zero | Sum(debit) = Sum(credit) per JE |
| 10 | V2-side: Check `Wallet` table has the Blink wallet upserted with `sourceWalletId` | One Wallet row, `sourceWalletId` matches Blink's external id | Row exists |
| 11 | V2-side: Click Sync now again | "No new transactions" or correctly handles only the new ones (no duplicate inserts) | refNum-based dedup works (UNIQUE constraint holds) |
| 12 | V2-side: Refresh the browser tab, return | Vault is locked, transactions still visible (plaintext storage), Sync requires unlock | Behavior matches |
| 13 | V2-side: Reset vault password via the recovery-code flow | Customer enters 12-word code, picks new password, MEK re-wraps | New password unlocks, old does not |
| 14 | OR-side: rule edit. Change a rule in `bitbooks-v2.yaml` (e.g., `lightning_payment.in.credit` from `SALES` to `OTHER_INCOME`), redeploy edge function | Next sync routes to the new account | Rule edit lands without TypeScript change |

---

## 9. Build checklist + estimates (V2-side only; OR-side is DONE)

Branch: `feat/orange-rails-integration` on `DeeJanuz/bitbooks`. Daenon owns the PR.

| # | Task | Estimate |
|---|---|---|
| 1 | Update `lib/orange-rails/client.ts`: drop `transactions_key`, drop `listOrTransactions`, add `format='bitbooks-v2'`, update response schema | 1 hour |
| 2 | Write `lib/orange-rails/sync-handler.ts`: resolves `__resolve*` hints, runs Prisma upserts in a transaction | 3 hours |
| 3 | Update `app/api/.../wallets/[walletId]/sync/route.ts`: receive credentials_key from browser, call `syncOrgFromOr`, run `applyOrSyncResponse` | 1 hour |
| 4 | Prisma migration: drop `OrangeRailsVaultMode` enum + `vaultMode` column, optional rename `orPlatformUserId` → `orSubaccountId` | 30 min |
| 5 | Simplify `add-connection-modal.tsx`: drop vault-mode picker, single password field, recovery-code reveal stays | 1.5 hours |
| 6 | Add multi-connection bulk sync to `admin-connectors.tsx`: "Sync All" button, single password entry per browser session | 2 hours |
| 7 | Replace tile grid in connection picker with search/typeahead. Day-one Blink only is fine; structure for growth | 1.5 hours |
| 8 | Drop `crypto-browser.ts` transaction-payload decryption helpers; keep KDF and credentials-key derivation | 30 min |
| 9 | Update `TESTING-OR.md` checklist for the new flow | 30 min |
| 10 | Move `business-docs/V2-OR-INTEGRATION-PR-SPEC.md` → `business-docs/archive/` with deprecation header | 15 min |
| 11 | End-to-end manual QA against the test plan in §8 | 2 hours |

**Total V2-side: roughly 13.5 hours.** Two-day push for one engineer.

---

## 10. Open questions before kickoff

| # | Question | Suggested answer | Decide by |
|---|---|---|---|
| Q1 | Single PR on `feat/orange-rails-integration`, or split? | Single. The schema migration, client refactor, sync-handler write, and UI simplification are tightly coupled. | Build kickoff |
| Q2 | Do we keep both SIGNIN_PASSWORD and WALLET_PASSWORD modes, or collapse to one? | Collapse to one. Single mode named "vault password". Confirmed by the maintainer 2026-04-29. | Settled |
| Q3 | Rename `orPlatformUserId` → `orSubaccountId` in the migration? | Yes. Clarifies the column matches OR's terminology and reduces future confusion. | Daenon's call on whether to bundle with this PR or defer |
| Q4 | Should V2 use service-role from sync-handler, or pass through user JWT? | Service-role inside the route after RLS check on the org. Matches V2's existing patterns. | Implementation detail, Daenon picks |
| Q5 | Suspense handling: separate UI badge or auto-classify? | Land in `accountSubType: SUSPENSE`, V2's existing review UI surfaces them. | Settled (see YAML default rule) |
| Q6 | Webhook from Blink as wake-up ping? | Confirm with Galoy team. If supported, wire later. Hourly cron is fine for V1. | Sprint kickoff (not blocking) |
| Q7 | Multi-connection bulk sync error handling: stop on first error or continue? | Continue, surface a per-connection error in the response, badge the failed connections. | Day-of |
| Q8 | What happens when a customer forgets their vault password and loses the recovery code? | Bookkeeping for connected accounts is unrecoverable. V2 surfaces a clear warning on setup. The customer can disconnect-and-reconnect from sources to start fresh. | Settled |

---

## 11. Out of scope for this PR

- **V3 migration to `format=bitbooks-v3`.** Separate plan after V2 lands. Larger because V3 is fully ZK end-to-end and the migration touches V3's local `orImportBridge.ts`.
- **OW (OrangeWay) integration.** Similar to V2 but with browser-side encryption pass on insert. Separate plan.
- **BitBooks Personal integration.** Similar to V3. Separate plan.
- **Quiltt source adapter.** Separate build doc; once it ships, V2 picks up Quiltt connections automatically because the protocol is module-based.
- **Webhook wake-up plumbing.** When sources support webhooks (Blink, Strike, Flash), OR receives the event metadata, sends a Web Push to the V2 service worker, and V2 calls `or-sync`. The wake-up mechanism is a follow-up to this build.
- **Per-org account-mapping override UI.** YAML rules cover the org-default mapping. When a specific V2 customer wants to remap, V2 surfaces the override in its existing CoA-mapping UI, sent to OR via `override_path` from the profile. Build that after the base mapping ships.

---

## 12. After V2 lands, the template applies to every other consumer

V2 is the proof. Every subsequent consumer follows the same recipe:

1. **Author the App Profile YAML** at `_shared/sinks/profiles/<slug>.yaml`. Account-mapping rules, status mapping, identity hints. Half a day per consumer.
2. **Implement the SinkAdapter TypeScript** at `_shared/sinks/<slug>.ts`. Derived-context builder + row construction for the consumer's schema. Two to three hours.
3. **Register in `dispatch.ts`.** One line.
4. **Add the platform API key + edge proxy + Connections page on the consumer side.** Half a day.
5. **For ZK consumers (V3, OW, Personal): add the browser-encryption pass before insert.** The only delta vs V2.

V2 ↔ OR is the proof of pattern. Once it ships, the build-time per consumer drops below one engineer-day.

---

**End of build plan.** Sign-off requested from Daenon (V2 side) and the maintainer (OR side) before kickoff.
