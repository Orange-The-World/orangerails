# LDK Connector — Design Doc

Status: **DESIGN — for Auditor (a)-(e) gate + Sr. Developer reconciliation diff.**
Scope: ZKA (zero-knowledge / full self-custody) Lightning via the Lightning Dev Kit
(LDK), embedded client-side. Keys and channel state never leave the user's device;
Orange Rails servers store client-sealed ciphertext only.

Pattern source: mirrors Stealth Sync (`src/stealth/lib/`, `supabase/functions/or-stealth-*`).
`seal.ts` (AES-256-GCM, fresh IV per envelope, client-supplied 32-byte key, HMAC-SHA-256
blind index, zero server-side key handling) is the ZKA boundary we reuse verbatim.

---

## 1. Architecture

- **LDK is a library embedded in the app**, not a hosted node. The client owns the seed,
  key management, storage, and networking. This is the honest fit for ZKA: keys and
  Lightning state stay client-side.
- **Server contract:** edge functions store `SealedEnvelope` + blind index only. No
  decrypt path, no key derivation, no salt issuance server-side. Modeled on `or-stealth-*`.
- **Two concerns, cleanly split:** *seal for confidentiality, watermark for correctness.*
  The seal pattern gives (a)-(c); the `update_id` watermark + persist-before-ack gives (e).

### File-for-file mirror of Stealth Sync

| Stealth Sync | LDK |
|---|---|
| `derive.ts` (descriptor parse + address derivation) | `derive.ts` — `deriveOrLdkKey(mek)` HKDF, channel/keysend param parsing |
| `seal.ts` (`sealEnvelope`/`unsealEnvelope`/`blindIndex`) | reused unchanged as the ZKA boundary; wraps channel-state backups + payment records |
| `sync.ts` (`runSync` client-side filter scan) | `sync.ts` — client-side scan over channel monitors / payment records |
| `postmessage.ts` (`deriveOrStealthKey` + widget protocol) | `postmessage.ts` — `deriveOrLdkKey(mek)` + widget protocol |
| `supabase/functions/or-stealth-*` | `supabase/functions/or-ldk-persist` (sealed blob + blind index only) |

---

## 2. Key derivation

- **Backup/seal key:** HKDF-SHA256 from the client MEK, fixed info string `'or-ldk-v1'`,
  domain-separated from any signing key. **Client-only, deterministic, zero server salt.**
  Same primitives as `or-stealth-v1`.
- **Seed + node/channel keys:** generated and stored client-side only, in-app entropy,
  never transmitted. Signing is on-device; the server never holds material that can move
  funds.

---

## 3. Persistence spec (LDK `Persister` / `chain::Watch`)

LDK's `Persister` contract requires the write to be durable **before** we ack — a
lost or stale `ChannelMonitor` is funds-loss, not a privacy failure. Therefore:

- **Blind index keyed on the stable channel key** (funding outpoint), not the payload,
  so updates to the same channel collide deterministically. `outpoint_bidx = blindIndex(funding_outpoint, key)`.
- **`update_id` is the monotonic watermark.** The edge function rejects any write whose
  `update_id` regresses. A stale restore physically cannot overwrite a newer monitor.
- **Persist-before-ack.** The `Persist`/`chain::Watch` path acks a monitor update to LDK
  **only after** the encrypted blob is durably written. No ack on stale or in-flight state.
- **Stale detection is by construction, not by check.** Restore reads the highest-known
  `update_id` from a client-held anchor and **refuses to operate — no chain broadcast, no
  channel resume — if the loaded monitor is behind that watermark.** Stale = hard stop,
  surfaced to the user, never silent.

### 3.1 Atomic conditional write (verbatim, message #921)

Single statement, row lock held for the whole upsert so a concurrent restore cannot
interleave:

```sql
INSERT INTO channel_state (outpoint_bidx, update_id, sealed_blob)
VALUES (:bidx, :new_id, :blob)
ON CONFLICT (outpoint_bidx) DO UPDATE
  SET update_id   = EXCLUDED.update_id,
      sealed_blob = EXCLUDED.sealed_blob,
      updated_at  = now()
  WHERE channel_state.update_id < EXCLUDED.update_id
RETURNING update_id;
```

The `WHERE ... < EXCLUDED.update_id` lives **inside** the `ON CONFLICT`, so the
compare-and-set is one atomic op, not application logic. This is a DB-level conditional
write, not read-then-check-then-write — two concurrent restores cannot both pass a check.

### 3.2 Idempotent-on-equal RPC behavior (verbatim, message #921)

The RPC wrapper reads the `RETURNING` result, **no second write**:

- row returned → **ACCEPTED** (new latest)
- no row + stored `= :new_id` → **200 IDEMPOTENT_OK** (legit persist-before-ack retry, never wedges)
- no row + stored `> :new_id` → **409 REJECTED_STALE** (rollback/restore race)

Strictly-less is the only reject. Equal is always success. Persist-before-ack means a
crash after the durable write but before the ack causes LDK to retry the *same* update;
rejecting `update_id == current` would fail that retry forever and wedge the node.

**Classification note (per Auditor #924):** when `RETURNING` is empty, distinguishing
`IDEMPOTENT_OK` (stored = :new_id) from `REJECTED_STALE` (stored > :new_id) requires a
follow-up read of the stored `update_id`. The write outcome is already decided; this read
is classification only, **not a second write gate.**

---

## 4. Metadata trade-off (verbatim, message #921)

> The blind index on the funding outpoint means per-channel update cadence (timing +
> frequency) is observable to our servers even though all payloads are sealed. Bounded
> and accepted; no channel balances, counterparties, or amounts leak.

Stated, not discovered — Auditor gates against a disclosed trade-off, not one found at
review.

---

## 5. LND trust-surface distinction (for the sibling LND connector)

Recorded here so the ZKA claim stays honest across the connector family: the seal/envelope
pattern applies cleanly to the Orange Rails **connector layer**, but an LND **node** holds
keys and signs node-side — that trust is architectural and the ZKA model cannot erase it at
the connector boundary. LND user-facing docs must state that users trust their node operator
(or run their own). LDK does not have this carve-out: keys are client-side by construction.

---

## 6. Auditor (a)-(e) gate — mapping

- **(a) Seed/entropy:** generated + stored client-side only, never transmitted, absent from
  logs/requests/backups.
- **(b) Server state:** any persisted blob is client-encrypted (`SealedEnvelope`); the
  decryption key never leaves the client. Server sees ciphertext only. HKDF `'or-ldk-v1'`,
  no server salt.
- **(c) Signing:** no signer or key material instantiated server-side at any point in the
  persistence path.
- **(d) Recovery:** full fund recovery from seed alone, Orange Rails infra offline. Blind
  index on funding outpoint is per-user by construction; cross-user collision is impossible.
- **(e) Restore/stale-state:** persist-before-ack + monotonic `update_id`; client refuses to
  operate on a stale monitor. Atomic conditional write (§3.1) enforces regression rejection
  at the DB level; idempotent-on-equal (§3.2) prevents wedging.

Open items for the full doc pass (per Auditor #924): expand (a) seed/entropy, (b) end-to-end
HKDF path, (c) signing surface, and (d) offline recovery walkthrough. This scaffold locks (e)
and the persistence layer; those sections land before the full gate runs.
