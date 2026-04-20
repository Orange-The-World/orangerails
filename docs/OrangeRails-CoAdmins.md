# OrangeRails Co-Admin Emergency Access

## 1. MVP Shipped

This PR implements **co-admin emergency access**: a workspace owner can grant
another authenticated OrangeRails user full read/write access to their data so
operations continue even if the owner is unavailable (incapacitated, lost
password, on holiday, etc.).

### What the feature does

**Grant flow (owner side)**

1. Owner opens Settings → "Co-admin emergency access" on `/app`.
2. Clicks "Add co-admin" and enters:
   - Target user's email address.
   - Their own vault password (re-confirmed — never sent to the server).
3. Client calls the `pqc-lookup-user` edge function, which resolves the email to
   `{ userId, kemPublicKey }`. Returns 404 if the target has no account or has
   never unlocked their vault.
4. Client re-runs Argon2id (`deriveMekRaw`) to get 32 raw bytes, then derives
   both HKDF subkeys (`credentials-v1`, `txns-v1`) as raw bytes.
5. The two 32-byte subkeys are concatenated into a **64-byte blob**.
6. The blob is wrapped for the target's hybrid X25519 + ML-KEM-768 public key
   (`wrapBlob64` in `src/lib/co-admin.ts`) using the same KEM primitives as the
   rest of the PQC stack, but without the 32-byte-only restriction of
   `key-wrapping.ts`.
7. Two DB rows are inserted:
   - `wrapped_data_keys` (one per admin, data_key_id = owner's workspace_key_id).
   - `workspace_admins` (owner_user_id, admin_user_id).
8. Toast: "Co-admin added. They'll see your data on their next unlock."

**Consume flow (admin side)**

1. On unlock, the admin's `useEffect` fetches `workspace_admins` rows where
   `admin_user_id = auth.uid()`.
2. For each owner workspace, the client fetches the corresponding
   `wrapped_data_keys` row and the owner's `workspace_key_id`.
3. A workspace switcher appears in the `/app` header: "My data / <owner UUID>'s data".
4. When the admin switches to the owner's workspace:
   - The admin's own MEK is used to decrypt their PQC secret key from
     `user_vault_meta.kem_secret_wrapped`.
   - `unwrapBlob64` recovers the 64-byte blob.
   - The blob is split into two `CryptoKey` objects (credentials + transactions).
   - These replace the vault's own subkeys for all encrypt/decrypt operations.
5. The admin sees and acts on the owner's connections and transactions exactly
   as if they were the owner.

**Revoke flow (owner side)**

1. Owner clicks "Revoke" next to a co-admin row.
2. Client deletes the `workspace_admins` row and the corresponding
   `wrapped_data_keys` row. RLS ensures only the owner can delete.
3. The admin's UI reverts to their own workspace on next page load.

### Data model additions

| Object | What |
|---|---|
| `user_vault_meta.workspace_key_id` | Nullable UUID; lazily allocated on first grant. Used as `data_key_id` in `wrapped_data_keys`. |
| `workspace_admins` | Grant table. `(owner_user_id, admin_user_id)` unique pair. |
| `wrapped_data_keys` row (algorithm `hybrid-x25519-mlkem768-blob64`) | One per admin. `wrapped_ciphertext` is base64 of `kemCt ‖ iv ‖ AES-GCM(sharedSecret, blob64)`. |
| RLS policies | Owner can INSERT/DELETE on both tables; both sides can SELECT. Owner can INSERT/DELETE their own `wrapped_data_keys` rows. Co-admins can SELECT/UPDATE/DELETE on `connections` and `encrypted_transactions` for workspaces they are admin of. |

### Crypto summary

```
Owner:  Argon2id(password, salt) → 32 raw bytes
        HKDF(raw, "orangerails-creds-v1", salt) → credsRaw (32B)
        HKDF(raw, "orangerails-txns-v1", salt)  → txnsRaw  (32B)
        blob = credsRaw ‖ txnsRaw  (64B)

Wrap:   hybridEncapsulate(adminPub)  → (kemCt, sharedSecret)
        AES-256-GCM(sharedSecret, blob) → ct (80B = 64 + 16 tag)
        stored = base64(kemCt ‖ iv ‖ ct)

Unwrap: hybridDecapsulate(adminSecretKey, kemCt) → sharedSecret
        AES-256-GCM-decrypt(sharedSecret, ct) → blob (64B)
        credKey = importAesKey(blob[0:32])
        txnKey  = importAesKey(blob[32:64])
```

The vault password never leaves the browser. The server stores only ciphertext.

---

## 2. Known MVP Limitations

### Cached subkeys survive revocation until tab closes

When an admin loads a workspace, their browser derives two `CryptoKey` objects
and holds them in a `useRef`. Revoking the grant deletes the DB rows, but those
in-memory keys remain valid until the tab is closed.

**Mitigation**: True instant revocation requires MEK/subkey rotation on revoke
(see Roadmap below). Until then, revoke should be followed by asking the admin
to close their tab. For most emergency-access scenarios (incapacitated owner)
this is not a practical concern.

### No delayed-grant wait window

Bitwarden Emergency Access has a configurable wait period (e.g., 7 days) during
which the owner can deny the request. This MVP has no wait window — grants are
immediate. Appropriate for small teams and family use; inappropriate for
high-security corporate deployments until v2 adds the timer.

### Binary permissions (no roles)

Every co-admin gets the same access as the owner. There is no bookkeeper,
accountant, or viewer role. See Roadmap for the multi-role design.

### Target must already have an account with PQC keys

The target must have registered and unlocked their vault at least once (so
their `kem_public_key` is set). Inviting unregistered users is not supported.

### Workspace switcher shows owner UUID, not email

The admin's workspace switcher labels owner workspaces by their UUID. A future
polish pass should use the `pqc-lookup-user` edge function in reverse (or a
new `user-profile` function) to display the owner's email.

---

## 3. Roadmap — Multiple Roles

The current grant wraps the full 64-byte blob (credentials + transactions
subkeys). To support restricted roles, change the wrapped payload per role:

| Role | Wrapped subkeys | What they can do |
|---|---|---|
| `admin` (current) | creds ‖ txns (64B) | Full read/write |
| `bookkeeper` | txns only (32B) | Read all; write memo/category |
| `accountant` | txns only (32B) | Read-only; export |
| `viewer` | txns (scoped; 32B) | Read-only, limited fields |

Implementation steps:

1. Add `role TEXT NOT NULL DEFAULT 'admin'` to `workspace_admins`.
2. Change `grantCoAdmin()` to accept a `role` param and wrap only the subkeys
   appropriate for that role.
3. Add RLS policy checks that compare the admin's role to the operation they're
   attempting (e.g., UPDATE connections requires `role = 'admin'`).
4. Update the workspace switcher to show the role label.

The `wrapBlob64` / `unwrapBlob64` primitives in `co-admin.ts` are already
size-agnostic — wrapping a 32-byte blob (single subkey) requires only a
`BLOB32_BYTES` variant.

---

## 4. Roadmap — Recovery Kit Services

The PQC primitives in `pqc.ts` already support wrapping a key for any recipient
that holds a `kem_public_key`. This makes it straightforward to extend the grant
model to third-party custody / inheritance services.

**Pattern (Unchained Capital / Casa Keymaster style)**:

1. Owner generates a **recovery kit**: wraps their 64-byte blob for a trustee
   service's public key (provided as a QR code or downloadable).
2. The trustee stores the encrypted share in escrow. They cannot decrypt it
   without a valid KEM decapsulation, which requires their private key.
3. Release is triggered by:
   - A dead-man's switch (owner hasn't signed a "still alive" token in N days).
   - A notarized request from the estate.
   - An M-of-N multisig approval from a trustee committee (Shamir's Secret
     Sharing, split across N trustees, require M to reconstruct).

**Shamir's Secret Sharing**:
The `pqc.ts` KEM already supports wrapping for N recipients independently. For
M-of-N, split the 64-byte blob using Shamir's Secret Sharing (e.g.,
`secrets.js-gf2n32` or a Rust WASM port), wrap each share for a different
trustee, and require M trustees to co-sign a release request.

**Work required**:
- Trustee service: server component that holds encrypted shares, implements the
  trigger logic (dead-man's switch, notarized request API, multisig).
- OrangeRails client: "Export recovery kit" dialog that generates and wraps
  shares, shows a checklist of enrolled trustees.
- Legal framework: terms of service for trustee services, jurisdiction-specific
  inheritance law guidance.

The crypto is already there. The work is the escrow contract, UX, and legal.

---

## 5. Roadmap — Audit Signatures

`src/lib/signatures.ts` already exports `SIG_STRATEGIES` with an ML-DSA-65
strategy. Every admin grant and revoke event should be signed by the owner's
signing key and verified by any interested party.

**Implementation**:

1. On grant: owner signs `JSON.stringify({ action: "grant", adminUserId, timestamp })` with their ML-DSA-65 secret key (unwrapped from `user_vault_meta.sig_secret_wrapped`).
2. Store signature in a new `workspace_audit_log` table:
   ```sql
   CREATE TABLE workspace_audit_log (
     id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
     event_type  TEXT        NOT NULL,  -- "grant" | "revoke"
     owner_id    UUID        NOT NULL,
     admin_id    UUID        NOT NULL,
     payload     JSONB       NOT NULL,
     signature   TEXT        NOT NULL,  -- base64 ML-DSA-65 sig
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   ```
3. Any holder of the owner's `sig_public_key` (stored plaintext in
   `user_vault_meta`) can verify the full audit trail.

This gives a cryptographically-verifiable history of who had access, when, and
who authorized it — useful for regulatory compliance and dispute resolution.

---

## 6. Roadmap — Instant Revocation (MEK/Subkey Rotation)

The MVP cached-subkey limitation is inherent to the current design: once the
admin unwraps the blob into `CryptoKey` objects, those live in browser memory
until the tab closes.

True instant revocation requires **key rotation on revoke**:

1. On revoke, the owner re-derives all subkeys as raw bytes.
2. Re-encrypts all `connections.encrypted_credentials` and
   `encrypted_transactions.encrypted_payload` with a **new** set of subkeys
   (derived from a bumped `payload_key_version` or a new HKDF context suffix).
3. Re-wraps the new 64-byte blob for every remaining admin.
4. Atomically replaces all ciphertext in a database transaction.

The admin's cached old keys become unable to decrypt any future writes
immediately after rotation. Historical rows encrypted with old keys remain
readable until the admin's tab closes (or until they are re-encrypted, which
can be done lazily on next read).

**Complexity**: High. A large workspace could have thousands of rows to
re-encrypt. Defer until a paying customer explicitly requests it.
