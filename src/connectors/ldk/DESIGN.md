# LDK connector — design doc

Status: **DESIGN, pre-audit.** Scaffold only. Nothing here has passed the
Auditor `(a)-(e)` gate. This document is the artifact that gate reviews.

Owner: Developer · Reviewers: @Sr. Developer, @Auditor · Repo pattern mirrored:
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
user-facing (Auditor msg 917).

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
server-issued salt (Sr. Developer msg 913, Developer msg 915).

**Seal primitives (VERIFIED baseline, Auditor msg 918):** AES-256-GCM, fresh IV
per envelope, client-supplied 32-byte key, HMAC-SHA-256 blind index, zero
server-side key handling.

## 3. The stateful layer — the real divergence from Stealth Sync

Stealth Sync's server is a dumb blob store. LDK is not: LDK's `Persister`
contract requires a `ChannelMonitor` write to be **durable before we ack**. A
lost or stale monitor is a **funds-loss** event (broadcasting old channel state
looks like a cheat and is penalised). So we split the design:

> **Seal for confidentiality, watermark for correctness** (Sr. Developer msg 916).

- **Blind index keyed on the stable channel key** (funding outpoint), not the
  payload — so updates to the same channel collide deterministically.
- **`update_id` is the monotonic watermark.** Restore refuses to operate —
  no chain broadcast, no channel resume — if the loaded monitor is behind the
  client-held watermark. Stale = hard stop, surfaced to the user, never silent
  (Developer msg 909; Auditor criterion (e)).
- **Persist-before-ack:** the `Persist` / `chain::Watch` path acks a monitor
  update to LDK **only after** the encrypted blob is durably stored server-side.

### Persistence spec (VERBATIM from thread, Developer msg 921)

Agreed on all three, none are read-check-write.

**(1) Atomic conditional write** — single statement, row lock held for the whole
upsert so a concurrent restore cannot interleave:

```sql
INSERT INTO channel_state (outpoint_bidx, update_id, sealed_blob)
VALUES (:bidx, :new_id, :blob)
ON CONFLICT (outpoint_bidx) DO UPDATE
  SET update_id = EXCLUDED.update_id,
      sealed_blob = EXCLUDED.sealed_blob,
      updated_at  = now()
  WHERE channel_state.update_id < EXCLUDED.update_id
RETURNING update_id;
```

The `WHERE ... < EXCLUDED.update_id` lives **inside** the ON CONFLICT, so the
compare-and-set is one atomic op, not application logic.

**(2) Idempotent on equal** — the RPC wrapper reads the RETURNING result, no
second write:

- row returned → **ACCEPTED** (new latest)
- no row + stored `= :new_id` → **200 IDEMPOTENT_OK** (legit persist-before-ack retry, never wedges)
- no row + stored `> :new_id` → **409 REJECTED_STALE** (rollback/restore race)

Strictly-less is the only reject. Equal is always success.

> **Classification note (Auditor msg 924):** when `RETURNING` is empty,
> distinguishing `IDEMPOTENT_OK` (stored = :new_id) from `REJECTED_STALE`
> (stored > :new_id) requires a follow-up read of the stored `update_id`. That
> is acceptable — the write outcome is already decided, the read is
> classification only, **not** a second write gate.

**(3) Metadata trade-off (VERBATIM, Developer msg 921):** *the blind index on
the funding outpoint means per-channel update cadence (timing + frequency) is
observable to our servers even though all payloads are sealed. Bounded and
accepted; no channel balances, counterparties, or amounts leak.*

## 4. Auditor gate `(a)-(e)` — how this design answers it

The gate is locked and on record (Auditor msgs 902, 903, 906, 919, 920, 924).
This scaffold closes **(e)**; (a)-(d) are answered here and traced at review
against the implementation.

- **(a) Seed/entropy** — generated client-side in-app; zero transmission across
  the client boundary; never in logs, requests, or backups.
- **(b) Server state** — every persisted blob is client-encrypted; the
  decryption key is HKDF-derived client-side (`'or-ldk-v1'`), never leaves the
  client. Server sees ciphertext + blind index only. No server-issued salt.
- **(c) Signing** — no signer or key material instantiated server-side at any
  point in the persistence path. All signing on-device.
- **(d) Recovery** — full fund recovery from seed alone with Orange Rails infra
  offline. Blind index on funding outpoint → cross-user collision impossible by
  construction.
- **(e) Restore** — atomic compare-and-set (§3), persist-before-ack, stale
  monitor = hard refusal. **PLAUSIBLE PASS** on the three pre-gate items
  (Auditor msg 924); full gate opens when the implementation lands.

## 5. Scaffold in this branch

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
  persist.test.ts    ← watermark/idempotency classification tests  [stub]
supabase/functions/or-ldk-channel-state/
  index.ts           ← edge function carrying the atomic SQL (§3)  [stub]
```

## 6. Open items for review (not blockers to this artifact)

1. Sr. Developer runs the reconciliation diff against `or-stealth-v1` at review.
2. NWC is a **separate** connector project (protocol layer on top), sequenced
   after one node path ships (Product msg 898). Not in this branch.
