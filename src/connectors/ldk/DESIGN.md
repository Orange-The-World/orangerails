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

### 3.5 Payment records: the amount is sealed before it is written

The mirror map (§2) and `seal.ts` both name payment records alongside
channel-state backups, and no payment record path is implemented yet. When one
is built, this is binding on it:

> **The Lightning payment amount is sealed inside the envelope, client-side,
> before it is written. It is never a column, never an index term, and never a
> field the server can read. The same is true of every value that is a function
> of the amount, including a routing fee, a bucket, a range, or any other
> order-preserving encoding of it. Same envelope and same key custody as the
> fields already sealed on this surface: AES-256-GCM, fresh IV, client-derived
> key (`'or-ldk-v1'`), no server-side decrypt path.**

This is a settled requirement, not an open design question, and it is written
here because the wiring PR is reviewed against this document.

**What is stored today: no Lightning payment amount.** No Lightning payment
amount is stored anywhere in Orange Rails. There is no Lightning payment record
on this connector: no type, table, column, view, function, RPC or edge function
holds one, and every seal and persist entry point on this surface throws
`scaffold only`. Read that as what it is, a claim about Lightning and about this
connector. It is deliberately not a claim that no payment surface of any kind
exists anywhere in the system: billing surfaces do exist, for other purposes and
under other sections, and the reuse consequence in the list below is what keeps
a Lightning amount off them. The user-facing claim that we cannot read your
financial data is therefore not contradicted by anything in the system as it
stands. This section constrains work that has not been built yet. It is not a
fix for a live exposure and should not be cited as evidence of one.

**What that rests on, and how to re-check it.** The database objects were
checked by querying the databases. They were not inferred from this repository,
and a code search is not evidence about a database object in either direction.
§3.3 is why that distinction is load-bearing rather than pedantic:
`channel_state` and its unique index already exist in the database while the
wiring PR ships zero DDL, so schema state runs ahead of the diff, and a document
that says so cannot then make a schema claim out of the diff two sections later.

The claim above reaches over three kinds of object, and one query does not reach
all three. Re-check it kind by kind, in both the dev and the production project,
and report which projects were reached: a project that could not be reached is
not a project that came back clean.

- **Types, tables, views and their columns:** query `information_schema.columns`
  for a column that could hold a Lightning payment value. A composite type
  declares attributes rather than columns and does not appear there, so
  `pg_type` joined to `pg_attribute` covers the `type` half of the sentence.
- **Functions and RPCs:** query `information_schema.routines`, or `pg_proc`.
  `information_schema.columns` does not list a function or an RPC at all, so a
  columns-only sweep cannot confirm this part of the claim however clean it
  comes back.
- **Edge functions:** read the deployed function list for the project. An edge
  function is not a database object, so no catalog query reaches it. That list
  is an inventory of what is deployed rather than a search of this repository,
  and this is the one kind here where the repository is on the evidence path at
  all: the deployed list says which functions exist, and the source of a
  function on that list says what it handles.

**What the claim rests on today, so nobody has to reconstruct it.** In the dev
project the sweep covered types, tables, columns, views, functions and RPCs. In
the production project it covered columns only. Production functions, RPCs and
edge functions have not been enumerated by anyone, so that part of the sentence
above is carried by the dev result and by the fact that no payment record path
is implemented, not by a production query. That is the thin spot in this claim,
and closing it is the first thing the next re-check should do.

Seven consequences, all checkable at review. Read this as the complete list **for
the LDK payment record surface** as it stands: if a proposal touches that surface,
satisfies every bullet, and still lets the server learn a Lightning payment
amount, that is a defect in this list, and the fix is an edit to this section on
the bar set at the close of it (a founder decision plus an Auditor pass), not a
judgement made at review time.

That scope is deliberate and it cuts both ways. A cleartext amount that reaches
the server by some **other** surface is out of this list's reach and is governed
elsewhere, so a green walk of the seven bullets is a statement about the LDK
payment record and not a clean bill of health for the product. What the list does
bind wherever the row lands is the seventh consequence: a Lightning payment
amount is never recorded on a pre-existing payment, billing or invoice surface,
and reusing a table that already exists relaxes nothing. Narrowing the closedness
claim is not licence to route a Lightning amount around it.

- **No amount column.** A payment record row carries a blind index, a seal
  version, the IV and the ciphertext, and nothing that describes value. If a
  reviewer can name the column that holds the amount, the change is wrong.
- **No fee column, and no other derived value in cleartext.** A routing fee is a
  function of the amount, so a readable fee is an amount oracle: no amount
  column plus a cleartext fee still tells the server roughly what was sent.
  Every value derived from the amount, fee, total, balance and running sum
  included, is sealed on exactly the same terms as the amount itself.
- **No amount in a blind index.** The blind index exists to locate a row, and a
  deterministic index over a value is a value oracle. Index terms stay on the
  stable identifiers, as they do for channel state (§3).
- **No bucket, no range, no order-preserving encoding.** A coarse bucket, a
  magnitude band, or any encoding the server can compare or sort, is a value
  oracle even though it is not the amount and describes no total. If the server
  can put two payment records in value order from what it holds, the change is
  wrong.
- **Fixed-width serialization inside the envelope.** AES-256-GCM does not pad,
  so ciphertext length is plaintext length. An amount serialized as decimal text
  makes the sealed blob longer for a larger payment, and the server then reads
  magnitude with no decrypt path at all. The amount is therefore serialized to a
  fixed width, or the whole payment record is sealed as a fixed-size struct, so
  that every payment record ciphertext is the same length whatever the value.
  Until that holds, the claim in §6 (b) is true of the field and not of the
  artifact.
- **No server-side amount arithmetic.** Sums, balances and totals are computed
  client-side after unsealing. A server that can add two amounts can read them.
- **Reusing a table that already exists does not relax any of the above.** The
  test is the same after the change as before it: if the server can read the
  value of a Lightning payment, or put two of them in value order, from what it
  holds, the change is wrong. That test does not ask which table the row landed
  in, what the table is called, when it was built or who owns it. So a Lightning
  payment amount is never recorded on a pre-existing payment, billing or invoice
  surface, and a Lightning rail is never added to a table that carries a
  cleartext amount column. The payment record this section governs is its own
  table on the allowed column set below, and a row written somewhere else is not
  exempt for having avoided a new one.

**How a reviewer checks this, without judgement.** Stated only as above, the
check rests on what counts as describing value, and §3.3 is why that is not
enough: `channel_state` and its unique index already exist in the dev database
and the wiring PR ships zero DDL, so a reviewer holding the wiring PR can have
no schema in the diff to check against. Two requirements turn the check into an
enumeration:

- **The payment record DDL arrives as a migration pull request in this
  repository**, owned by the database steward, so the columns are in a diff a
  reviewer can read. A payment record table that appears in a database without
  one is itself the finding.
- **The allowed column set is exactly** `user_id`, `payment_bidx`,
  `seal_version`, `iv`, `ciphertext`, `created_at`, `updated_at`. Anything
  outside that list fails, whatever it is named and whatever it is said to hold.
  Widening the list is a change to this section, not a reviewer's call.

Both of those requirements describe a table that does not exist yet, and neither
one fires on a table that already does: a write to a surface that is already
there ships no DDL, so it raises no migration pull request, and it adds no
column, so the allowed column set is never consulted. That limit is the reason
the last consequence above is stated on its own rather than left to be read out
of these two.

**Metadata trade-off, on the same terms as §3.2 (3).** Every consequence above
is about **value**, and none of them is about **existence**. A payment record
row on the allowed column set carries a `payment_bidx` and a `created_at`, so
the server can count how many Lightning payments a user made and see when each
row appeared, with every bullet above satisfied and every payload sealed. That
is the same class of exposure §3.2 (3) records for per-channel update cadence,
two subsections earlier in this document, and it is written here rather than
left to be inferred from there. Bounded and accepted: no amount, fee, balance,
counterparty or destination leaks. Reducing it further is a different design,
not a tightening of the bullets above: padding the table with decoy rows,
batching writes so a row's arrival is not a payment's timing, or coarsening
`created_at` to a window. None of those is proposed here, and each carries its
own cost, so the exposure is accepted rather than engineered away. **This
observable pattern is personal financial behavior metadata under GDPR / Law-25
and must be disclosed in the privacy policy before any payment record path
ships to users** (tracked with Compliance; not a blocker on this section or on
the wiring PR). Nothing is observable today: per the paragraph above, no
Lightning payment record exists, so this states what becomes observable the
moment one is built.

The trade-off, stated rather than discovered later: sealing the amount means
the server cannot sort, filter, aggregate or report on value. Any product
surface that appears to need server-side totals is asking for the seal to be
broken, and the answer is a client-side computation, not a cleartext column.

What would make this wrong: nothing in the product. It is a customer-facing
claim about what we can read, so it is not a performance trade to be revisited
by an implementer. Changing it is a founder decision plus an Auditor pass, the
same bar as any other change to the ZKA boundary.

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
  Includes the payment amount specifically (§3.5): it is inside the envelope,
  not a column and not an index term. This is checked against the schema, not
  only against the code.
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
