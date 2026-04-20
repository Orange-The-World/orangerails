# OrangeRails post-quantum cryptography layer

**Status:** primitives + orchestrators + storage schema landed. Not yet
consumed by any feature. The upcoming role-scoped-keys PR wires them in.

**Files:**
- `src/lib/pqc.ts` — hybrid X25519 + ML-KEM-768 KEM + ML-DSA-65 signer.
- `src/lib/key-wrapping.ts` — per-recipient data-key wrapping strategy map.
- `src/lib/signatures.ts` — signature strategy map + base64 helpers.
- `src/lib/pqc-lifecycle.ts` — generate + MEK-wrap + publish to Supabase.
- `src/context/VaultContext.tsx` — exposes `ensurePqcKeypairs(supabase, userId)`.
- `supabase/migrations/20260420120000_pqc_keys.sql` — columns + table.

---

## 1 · Threat model

### The CRQC horizon

A **Cryptographically Relevant Quantum Computer (CRQC)** is one large
enough to run Shor's algorithm against deployed key sizes. Current
industry estimates from Global Risk Institute / NIST / NSA quantum
working groups put the first CRQC in the **2035–2045** window. Conservative
security budgeting treats the 2030s as the relevant planning horizon.

### What Shor's algorithm breaks

- **RSA** — integer factorization.
- **ECDSA / ECDH** — elliptic-curve discrete log.
- **Diffie-Hellman** — discrete log over ℤ/pℤ.

All three underlie most of today's key-exchange and signing. A CRQC
reduces each from exponential to polynomial time, so today's 3072-bit
RSA keys become recoverable in hours once a CRQC exists.

### What Grover's algorithm weakens (but doesn't break)

Grover halves the effective strength of symmetric primitives:

| Primitive     | Pre-Grover | Post-Grover | Status for OrangeRails          |
|---------------|-----------:|------------:|---------------------------------|
| AES-256       |      256 b |       128 b | ✅ Still safe                     |
| AES-128       |      128 b |        64 b | ❌ Would be weakened              |
| SHA-256       |      128 b |        85 b | ✅ Still above any real threshold |

OrangeRails uses AES-256-GCM everywhere. Grover does not force any change.

### Harvest-now, decrypt-later (HNDL)

The active threat today is: **a well-funded adversary captures
today's ciphertext and wrapped keys, stores them, and decrypts them
in 2040**. Any long-lived secret we publish today on RSA/ECDH rails
is already at risk.

For OrangeRails specifically, that means: wrapped data keys for
role-scoped access (which have to be stored long-term so future
recipients can read historical data) cannot safely ship on classical
key wrapping. This is the single motivating reason for the layer
documented here.

---

## 2 · Why hybrid mode

The hybrid KEM combines **X25519** (classical) and **ML-KEM-768**
(post-quantum) shared secrets via HKDF-SHA-256, and uses that output
32-byte value as an AES-256-GCM key.

Two independent assumptions have to fail for the combined output
to leak:

- X25519 elliptic-curve discrete log is broken (Shor on a CRQC).
- ML-KEM-768 Module-LWE is broken (independent cryptanalysis).

A CRQC alone breaks only X25519. A breakthrough against Module-LWE
alone breaks only ML-KEM-768. Either way, the HKDF-SHA-256 combiner
still produces an indistinguishable-from-random 32-byte output.

This belt-and-suspenders posture matches what the industry already
ships at the TLS layer today:

- **Chrome** and **Cloudflare**: `X25519MLKEM768` hybrid, RFC 9794
  codepoint, default in TLS 1.3 since 2024.
- **AWS KMS** and **Signal** X3DH/PQXDH: hybrid ECDH + PQC KEM in
  session-key derivation.

OrangeRails inherits all of TLS's hybrid posture for free via
Cloudflare / Lovable's hosted TLS termination. This module is about
data-at-rest key wrapping, one layer below TLS.

---

## 3 · Why @noble/post-quantum

| Option                        | Pros                                                                  | Cons                                                     |
|-------------------------------|-----------------------------------------------------------------------|----------------------------------------------------------|
| **@noble/post-quantum** (this PR) | Pure TypeScript. Zero native bindings. ~50 KB gzipped total with @noble/curves. Works inside Lovable's Vite build without extra toolchain. Single-author (Paul Miller) with an established audit track record across the @noble/\* suite. | Single-implementation risk; we pin a regression test to catch silent behavioural changes. |
| `liboqs-wasm`                 | Same underlying reference implementations; broad algorithm coverage.  | WASM glue, extra build plumbing, larger bundle, tighter coupling to Emscripten toolchain. |
| `oqs-provider` (native)       | Production-grade.                                                     | Not usable in a browser/Edge runtime. Server-only.       |
| Rolling our own               | —                                                                     | Do not do this.                                          |

The trade is in our favour: at the browser / Edge-function layer
we want a small, inspectable, pure-TS library, and we want the same
module in both places. `@noble/post-quantum` gives us that.

> **Audit citations pending.** The `@noble/*` suite has a history of
> third-party audits, but the exact audit reports for the
> `@noble/post-quantum` release used here should be linked from the
> package README before relying on audit claims in customer-facing
> copy. This file will be updated as that reference lands.

---

## 4 · What the PR changes (and what it doesn't)

### Changes

- New TypeScript modules listed at the top.
- New migration that adds four nullable TEXT columns to
  `user_vault_meta` (`kem_public_key`, `kem_secret_wrapped`,
  `sig_public_key`, `sig_secret_wrapped`), a `pqc_key_version`
  INTEGER, and a new `wrapped_data_keys` table with RLS scoped to
  the recipient.
- A new VaultContext method, `ensurePqcKeypairs(supabase, userId)`,
  idempotent. Not yet called from any route.

### Does NOT change

- Argon2id KDF parameters (`src/lib/vault.ts`) are untouched. Those
  parameters are correct.
- AES-256-GCM data-at-rest encryption is untouched. Post-Grover,
  AES-256 still provides 128-bit margin. The rest of the stack
  continues to use it.
- TLS negotiation is untouched. Cloudflare / Lovable already offer
  `X25519MLKEM768` hybrid TLS automatically — there is nothing for
  this app to configure.
- No existing flow calls the new PQC methods yet; this PR only ships
  the primitives and storage.

---

## 5 · Future migration path

The registry pattern in `key-wrapping.ts` and `signatures.ts` is
designed so that stepping up algorithm strength is a one-line patch
plus a `pqc_key_version` bump:

| Change                 | Files touched                                              | Data migration                                               |
|------------------------|------------------------------------------------------------|--------------------------------------------------------------|
| ML-KEM-768 → ML-KEM-1024 (Cat 5) | new entry in `KEY_WRAP_STRATEGIES` + constant sizes | re-run `ensurePqcKeypairs` per user; old rows stay readable until re-wrap |
| ML-DSA-65 → ML-DSA-87 (Cat 5)    | new entry in `SIG_STRATEGIES`                      | re-sign on next write; old signatures verify under v1 strategy |

No schema change needed. The `algorithm` column on
`wrapped_data_keys` and the `pqc_key_version` on `user_vault_meta`
carry the forward-compatibility marker.

---

## 6 · Follow-ups tracked against this layer

- **Independent NIST ACVP KATs.** Current tests pin library-behaviour
  regression vectors rather than independent NIST ACVP KAT vectors —
  see the caveat in `src/lib/__tests__/pqc.test.ts`. Reproducing
  ACVP requires a small helper that drives the AES-CTR_DRBG used in
  the NIST submission package. Worth adding but not a gate for
  shipping this layer.
- **Route integration.** Wiring `ensurePqcKeypairs` into the
  `unlock.tsx` / `signup.tsx` post-unlock paths is deliberately not
  part of this PR — it belongs with the role-scoped-keys feature
  that actually consumes the generated keys.
- **Audit-report citations** for the `@noble/*` suite version pinned
  here.
