# LDK connector — design doc

Status: **DESIGN, pre-audit.** Scaffold only. Nothing here has passed the
Auditor `(a)-(e)` gate. This document is the artifact that gate reviews.

Owner: Developer · Reviewers: Sr. Developer, Auditor · Repo pattern mirrored:
`src/stealth/lib/*` + `supabase/functions/or-stealth-*`.

---

## 1. What LDK is, and why it is the first ZKA mirror

LDK (Lightning Dev Kit) is a **Rust library embedded in the client app**, not a
hosted daemon. The client holds the node seed, derives channel keys, and signs
on-device. Orange Rails servers never hold key material. That is the same
client-derive / server-sealed shape as Stealth Sync, which is why LDK — not LND
— is the first connector we mirror onto the ZKA boundary.

Contrast: **LND** is an authenticated node endpoint (macaroon) that holds keys
and signs node-side. That node is a trust surface the ZKA model does not erase
at the connector boundary; LND ships later with that carve-out documented
user-facing.

## 2. Mirror map (file for file, against Stealth Sync)

| Stealth Sync (`src/stealth/lib/`) | LDK connector (`src/connectors/ldk/`) | Role |
|---|---|---|
| `derive.ts` | `derive.ts` | Client-side seed + channel-key derivation (`deriveOrLdkKey`); no key material leaves the client. |
| `seal.ts`   | `seal.ts`   | The ZKA boundary, **unchanged primitives**: `sealEnvelope` / `unsealEnvelope` / `blindIndex`. Wraps channel-state backups + payment records. |
| `sync.ts`   | `sync.ts`   | `runSync` client-side scan over channel monitors / payment records → sealed payload before upload. |
| `postmessage.ts` | `postmessage.ts` | Widget/app protocol; `deriveOrLdkKey(mek)`. |
| `supabase/functions/or-stealth-*` | `supabase/functions/or-ldk-*` | Edge functions store `SealedEnvelope` + blind index only. **No decrypt path.** |

**Key derivation:** HKDF from the client MEK with a fixed info string
`'or-ldk-v1'` (Stealth uses `'or-stealth-v1'`). Client-only, deterministic, no
server-issued salt.

**Seal primitives (VERIFIED baseline):** AES-256-GCM, fresh IV per envelope,
client-supplied 32-byte key, HMAC-SHA-256 blind index, zero server-side key
handling.

### 2.1 Bytes-native seal, one audited core (MUST-FIX 2)

The stealth seal entry point takes an object and JSON-serializes it. The LDK
payload is not an object: a `ChannelMonitor` is a raw byte blob handed to us by
the library. Round-tripping those bytes through base64-in-JSON bloats the sealed
size and adds an encode/decode failure surface on the funds-critical path, so we
do not do it.

The wiring PR therefore exposes a bytes-native entry point alongside the object
one, both delegating to the **same** audited AES-256-GCM / HMAC-SHA-256 core:

```
sealEnvelope(payload: object, keyB64)   // existing, unchanged
sealBytes(bytes: Uint8Array, keyB64)    // new entry point, same primitive
```

Two entry points, one implementation under audit. A second copy of the seal is
the outcome this rules out.

## 3. The stateful layer — the real divergence from Stealth Sync

Stealth Sync's server is a dumb blob store. LDK is not: LDK's `Persister`
contract requires a `ChannelMonitor` write to be **durable before we ack**. A
lost or stale monitor is a **funds-loss** event (broadcasting old channel state
looks like a cheat and is penalised). So we split the design:

> **Seal for confidentiality, watermark for correctness.**

- **Blind index keyed on the stable channel key** (funding outpoint), not the
  payload — so updates to the same channel collide deterministically.
- **`update_id` is the monotonic watermark.** Restore refuses to operate —
  no chain broadcast, no channel resume — if the loaded monitor is behind the
  client-held watermark. Stale = hard stop, surfaced to the user, never silent
  (Auditor criterion (e)).
- **Persist-before-ack:** the `Persist` / `chain::Watch` path acks a monitor
  update to LDK **only after** the encrypted blob is durably stored server-side.

### 3.1 Row ownership — MUST-FIX 1 (security gate)

Every `channel_state` row is owned by exactly one user. The primary key is the
composite **`(user_id, outpoint_bidx)`**, and **RLS restricts every row to its
owner** (`user_id = auth.uid()`). Rationale: without row ownership at the DB
layer, any auth bug in the edge function opens a write path to another user's
channel row, and a forced `REJECTED_STALE` on someone else's monitor is a
funds-adjacent denial-of-service. Composite key + RLS also makes GDPR / Law-25
right-to-erasure executable per user. This is a **security gate**, not just a
correctness one: it lands before any crypto/DB wiring merges.

**RLS only bites if the caller is inside it.** The composite key + RLS are
inert unless the edge function executes the SQL through a client that carries
the caller's JWT (see §4.1). A `service_role` client bypasses RLS wholesale, so
this gate and the auth contract in §4 are a single unit: neither is real
without the other.

### 3.2 Persistence spec

Agreed on all three, none are read-check-write.

**(1) Atomic conditional write** — single statement, row lock held for the whole
upsert so a concurrent restore cannot interleave. Keyed on the composite
`(user_id, outpoint_bidx)`:

```sql
INSERT INTO channel_state (user_id, outpoint_bidx, update_id, sealed_blob)
VALUES (:user_id, :bidx, :new_id, :blob)
ON CONFLICT (user_id, outpoint_bidx) DO UPDATE
  SET update_id = EXCLUDED.update_id,
      sealed_blob = EXCLUDED.sealed_blob,
      updated_at  = now()
  WHERE channel_state.update_id < EXCLUDED.update_id
RETURNING update_id;
```

The `WHERE ... < EXCLUDED.update_id` lives **inside** the ON CONFLICT, so the
compare-and-set is one atomic op, not application logic. `:user_id` is taken
from the verified JWT (see §4), never from the request body.

**(2) Idempotent on equal** — the RPC wrapper reads the RETURNING result, no
second write:

- row returned → **ACCEPTED** (new latest)
- no row + stored `= :new_id` → **200 IDEMPOTENT_OK** (legit persist-before-ack retry, never wedges)
- no row + stored `> :new_id` → **409 REJECTED_STALE** (rollback/restore race)

Strictly-less is the only reject. Equal is always success.

> **Classification note:** when `RETURNING` is empty, distinguishing
> `IDEMPOTENT_OK` (stored = :new_id) from `REJECTED_STALE` (stored > :new_id)
> requires a follow-up read of the stored `update_id`. That is acceptable — the
> write outcome is already decided, the read is classification only, **not** a
> second write gate.

**(3) Metadata trade-off:** the blind index on the funding outpoint means
per-channel update cadence (timing + frequency) is observable to our servers
even though all payloads are sealed. Bounded and accepted; no channel balances,
counterparties, or amounts leak. **This observable pattern is personal financial
behavior metadata under GDPR / Law-25 and must be disclosed in the privacy
policy before this ships to users** (tracked with Compliance; not a wiring
blocker).

### 3.3 The table is already live: the wiring PR ships zero DDL

`channel_state` and the unique index the upsert binds to, on
`(user_id, outpoint_bidx)`, already exist in the dev database. The wiring PR
therefore does **not** create, alter, or index this table. It writes application
code against a schema that is already there.

Two consequences, both binding:

- `ON CONFLICT (user_id, outpoint_bidx)` binds to the existing unique index and
  is correct. A bare `ON CONFLICT (outpoint_bidx)` has no matching unique index,
  so it fails at runtime, and it would collapse two users' channels onto one row.
  It is never correct here.
- Any `ALTER`, `CREATE INDEX`, or policy change is a **separate migration PR**
  owned by the database steward. The wiring PR does not smuggle schema in.

### 3.4 Retention: close-scoped, not wall-clock

Deleting channel state on a flat timer against `updated_at` is a funds-loss bug,
not a privacy feature: a healthy channel that simply sits quiet for the retention
window would have its **latest** state deleted, and a Lightning node without its
latest monitor cannot safely force-close. That design is rejected.

Retention is scoped to channel close instead:

- **Never delete the latest row of an open channel.** No exception.
- The server cannot detect a close on its own: it holds only ciphertext plus a
  blind index, which is the ZKA boundary working as designed. So **close is
  signaled by the client** on an authenticated call, which stamps a `closed_at`
  column on that row and nothing else.
- The purge job acts **only** on rows carrying a `closed_at`, N days after that
  timestamp. Rows without one are invisible to it.
- N is a policy number, not an engineering one. The job reads it from config, so
  it can move without a code change.

Superseded state needs no separate cleanup: an update to the same channel
collides on the blind index and overwrites in place (§3.2), so there is no
history pile to sweep.

## 4. Auth contract — `or-ldk-channel-state` edge function

Enforced **before** the atomic SQL in §3 executes, so ownership can never land
after the write path:

1. **Verify the JWT.** Reject unauthenticated calls with 401; no anonymous path.
2. **Extract `user_id`** from the verified token claims (`auth.uid()`), never
   from the request body or a client-supplied field.
3. **Scope the SQL** with that `user_id` bound as `:user_id`. RLS is the backstop;
   the function must still scope explicitly (defense in depth).
4. **Fail closed.** Any JWT verification error, missing claim, or RLS denial
   returns an error, never a silent fallthrough to an unscoped write.

### 4.1 Execute as the caller, not `service_role` (MUST-FIX 1, teeth)

The composite `(user_id, outpoint_bidx)` key and RLS in §3.1 protect nothing if
the function runs the upsert with the platform `service_role` key — that key
**bypasses RLS entirely**, so a single body-parsing or scoping bug becomes a
cross-user write. The contract, therefore:

- **The persist SQL runs through a request-scoped client bound to the caller's
  JWT**, so `auth.uid()` inside RLS resolves to the token subject and the policy
  is actually enforced on every row touched. **`service_role` (or any
  RLS-bypassing client) must never touch the `channel_state` write path.**
- **`user_id` is derived from the token, never the request body.** Even with the
  JWT-bound client, no client-supplied `user_id` field is trusted or read; the
  body carries only `outpoint_bidx`, `update_id`, and `sealed_blob`.
- **Defense in depth stacks:** token-derived `user_id` (app layer) + JWT-bound
  execution so RLS evaluates `auth.uid()` (DB layer). Either alone is a single
  point of failure; both is the gate.

**Trade-off (stated):** per-request JWT verification and a request-scoped client
add a small latency cost on the persist path versus a long-lived service-role
client. Acceptable — persist-before-ack is already a server round-trip on the
critical path, so the auth cost is dominated by the durable write it guards.

The current scaffold returns **501** on every call, so there is no live exposure;
this contract is the spec the wiring implements, and Sr. Developer's
reconciliation review runs on the wiring PR (self-scanned per the new process).

## 5. Restore trade-off — fresh-device recovery

Watermark refusal (§3) is strict by design: a monitor behind the client-held
`update_id` is a hard stop. On a **fresh device** the client may not yet hold a
local watermark, so restore trusts the server's stored `update_id` as the
starting point. Trade-off, stated plainly:

- **Same-device / known-watermark restore:** stale monitor → hard refusal, as
  specified. No funds risk.
- **Fresh-device restore:** the client seeds its watermark from the server's
  latest stored `update_id` after seed-only authentication, then resumes. A
  server that served a **stale** blob here would look latest to a fresh client.
  This is bounded by persist-before-ack (the server's latest is always a blob it
  durably stored and acked) and by the seal (the server cannot forge a blob it
  cannot decrypt), but it is a real trust delta versus the same-device path and
  is surfaced to the user on fresh-device recovery. Full fund recovery from seed
  alone with OR infra offline (criterion (d)) is unchanged.

## 6. Auditor gate `(a)-(e)` — how this design answers it

The gate is locked and on record. This scaffold closes **(e)**; (a)-(d) are
answered here and traced at review against the implementation.

- **(a) Seed/entropy** — generated client-side in-app; zero transmission across
  the client boundary; never in logs, requests, or backups.
- **(b) Server state** — every persisted blob is client-encrypted; the
  decryption key is HKDF-derived client-side (`'or-ldk-v1'`), never leaves the
  client. Server sees ciphertext + blind index only. No server-issued salt.
- **(c) Signing** — no signer or key material instantiated server-side at any
  point in the persistence path. All signing on-device.
- **(d) Recovery** — full fund recovery from seed alone with Orange Rails infra
  offline. Blind index on funding outpoint → cross-user collision impossible by
  construction; composite `(user_id, outpoint_bidx)` key + RLS enforces the same
  isolation at the DB layer, provided the persist path runs JWT-bound (§4.1).
- **(e) Restore** — atomic compare-and-set (§3), persist-before-ack, stale
  monitor = hard refusal; fresh-device trade-off documented in §5.
  **PLAUSIBLE PASS** on the three pre-gate items; full gate opens when the
  implementation lands.

## 7. Scaffold in this branch

Interface stubs only — no live crypto, no live DB writes yet. Each file names
the Stealth Sync source it mirrors and the gate criterion it serves.

```
src/connectors/ldk/
  DESIGN.md          ← this doc
  index.ts           ← public surface (mirrors coinbase/index.ts shape)
  types.ts           ← SealedEnvelope, ChannelStateRecord, PersistOutcome
  derive.ts          ← deriveOrLdkKey (HKDF, info='or-ldk-v1')  [stub]
  seal.ts            ← sealEnvelope/unsealEnvelope/blindIndex re-export plan  [stub]
  persist.ts         ← persist-before-ack + watermark classification  [stub]
  persist.test.ts    ← watermark/idempotency classification tests  [real tests]
supabase/functions/or-ldk-channel-state/
  index.ts           ← edge function carrying the atomic SQL (§3) + auth contract (§4);
                       JWT-bound client, no service_role on the write path (§4.1)  [stub]
```

## 8. Open items for review (not blockers to this artifact)

1. Sr. Developer runs the reconciliation diff against `or-stealth-v1` at review.
2. NWC is a **separate** connector project (protocol layer on top), sequenced
   after one node path ships. Not in this branch.
3. The retention window in §3.4 is a policy number, still open. The purge job
   reads it from config, so settling it does not require a code change.
