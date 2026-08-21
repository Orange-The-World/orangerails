# or-sync-key-register: Integration Guide

This document is for **integrator backends** that need to register a user's Owner Public Key
(OPK) so that Orange Rails can seal background-synced transaction data under that key.

---

## What this endpoint does

When a user opts in to background sync, the integrator client derives an X25519 keypair from the
integrator master key held behind the vault (not from the vault password). The client keeps the
private half (OSK) and posts the public half (OPK) to the integrator's backend. The integrator
backend forwards it here.

Once the OPK is registered on the subaccount row, `or-quiltt-sync` (and any future background
writer) can seal new transaction data under the user's key before writing it to the database.
Orange Rails never sees the private key: the private half never leaves the integrator client.

**Any webhook inbox rows that arrived while the subaccount had no OPK are re-admitted to the sync
queue the moment this call succeeds** (see Deferred-row unblock below).

---

## Endpoint

```
POST /functions/v1/or-sync-key-register
```

**Auth:** `X-Platform-API-Key: <your platform API key>`

This endpoint accepts **platform-mode auth only**. A request carrying a user JWT, a widget token,
or no auth header is rejected with 403. The platform API key is the same credential your backend
uses for `or-quiltt-session` and other platform-mode endpoints.

---

## Request body (JSON)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `app_user_id` | string | Yes | Your user ID. Must match `subaccounts.external_user_id`. Max 256 chars. |
| `opk_public` | string | Yes | Base64-encoded X25519 public key (ORIGINAL variant; a 32-byte X25519 key encodes to 44 chars, enforced input max is 128 chars). |
| `opk_alg` | string | Yes | Crypto suite ID. Currently the only accepted value is `libsodium-crypto_box_seal-v1`. |
| `confirm_rotation` | boolean | No | Must be literal `true` when rotating an existing OPK (see Rotation below). Absent or false blocks rotation. |
| `rotation_reason` | string | No | Free-text reason recorded on the rotation audit row. |

### Example

```json
{
  "app_user_id": "usr_abc123",
  "opk_public": "BASE64_ENCODED_X25519_PUBLIC_KEY_44_CHARS==",
  "opk_alg": "libsodium-crypto_box_seal-v1"
}
```

---

## Response (200)

```json
{
  "subaccount_id":      "uuid",
  "status":             "registered" | "unchanged" | "rotated",
  "opk_registered_at":  "2026-08-05T12:00:00.000Z",
  "deferred_unblocked": 3
}
```

| Field | Notes |
|-------|-------|
| `status` | `registered`: first OPK for this subaccount. `unchanged`: identical payload re-sent, idempotent replay. `rotated`: OPK replaced (requires `confirm_rotation: true`). |
| `deferred_unblocked` | Number of webhook inbox rows re-admitted to the sync queue. Non-zero on first registration or on an idempotent retry that clears a previous partial failure. |

---

## When to call this

Call `or-sync-key-register` **once per user, after the user opts in to background sync**:

1. Integrator client derives the X25519 keypair from the integrator master key held behind the vault, not from the vault password (client-side only). Orange Rails receives only the opaque X25519 public key and never sees the private half.
2. Browser posts the public key to your backend over your own authenticated channel.
3. Your backend calls `or-sync-key-register` with the platform API key.

**Timing:** this endpoint can be called at the same moment as `or-link-complete` without a race.
If no subaccount exists for `(platform_id, app_user_id)`, one is created here automatically.

**Idempotency:** sending the identical `(opk_public, opk_alg)` pair twice returns `status:
unchanged` and a 200. It is safe to retry on network failure.

---

## Deferred-row unblock behavior

`or-quiltt-sync` may receive Quiltt webhook events for a subaccount before that subaccount has an
OPK (for example if the user linked an account but has not yet opted in to background sync). When
that happens, sync defers the inbox row by setting `opk_deferred_at` on it rather than dropping it.

When `or-sync-key-register` succeeds (status `registered`, `unchanged`, or `rotated`), it clears
`opk_deferred_at` on all deferred inbox rows for that subaccount. The next `or-quiltt-sync` tick
then picks them up and seals them normally.

`deferred_unblocked` in the response tells you how many rows were re-admitted. A value of 0 on
first registration is normal if no webhooks arrived during the gap.

---

## Rotation protocol

If the subaccount already has an OPK and you send a **different** `opk_public`, the call returns
409 unless you include `confirm_rotation: true`.

```json
{
  "app_user_id": "usr_abc123",
  "opk_public": "NEW_BASE64_PUBLIC_KEY==",
  "opk_alg": "libsodium-crypto_box_seal-v1",
  "confirm_rotation": true,
  "rotation_reason": "periodic key rotation"
}
```

Every rotation (including first registration where the old key is null) writes an append-only row
to `opk_key_rotations`. After a rotation the existing OPK-sealed rows in the database are still
sealed under the old key: the browser-side re-seal flow (`or-sync-key-rotate`) is responsible for
migrating them.

---

## Error codes

| Status | Meaning |
|--------|---------|
| 400 | Missing or malformed field. Body contains `error` describing which field. |
| 401 | Missing, unrecognized, or invalid credentials (missing auth header, invalid platform API key, or bad Supabase JWT). |
| 403 | Credentials valid but not platform mode. Caller authenticated in direct/user mode. Use `X-Platform-API-Key`. |
| 405 | Not a POST request. |
| 409 | OPK rotation attempted without `confirm_rotation: true`. |
| 413 | Request body too large. |
| 500 | Internal error. Retry is safe (endpoint is idempotent on identical payloads). |

---

## Key invariants

- **The private key (OSK) never touches Orange Rails.** Only the public half is registered here.
- **This endpoint is platform-only.** Your frontend cannot call it directly; it will receive a 403.
- **Subaccount creation is safe to race.** Calling this at the same time as `or-link-complete` is
  fine; upsert semantics prevent a double-create.
- **Rotation requires explicit opt-in.** `confirm_rotation: true` prevents a client bug from
  silently overwriting a user's seal key.
