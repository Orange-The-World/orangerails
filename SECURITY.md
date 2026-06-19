# OrangeRails -- Security Architecture

OrangeRails is built on a zero-knowledge architecture: the server stores only
ciphertext. Your API credentials and transaction data are encrypted in your
browser before they ever leave your device, and only your vault password can
decrypt them.

Think of it as a bank vault with a permanent twist: we hand you the vault,
then destroy our copy of the key. We can see the vault exists, hold it, keep
it safe, and hand it back. We cannot open it -- ever -- not even under a court
order, not even if our servers are breached.

---

## Encryption stack, layer by layer

### Layer 1 -- Password to Key (Argon2id)

When you create a vault, OrangeRails runs your password through **Argon2id**,
the memory-hard key derivation function that won NIST's Password Hashing
Competition in 2015 and is recommended by OWASP 2023.

**Parameters used:**

| Setting | Value | Why |
|---------|-------|-----|
| Memory | 64 MiB per attempt | GPU/ASIC parallelism killer |
| Iterations | 3 passes | Time cost multiplier |
| Parallelism | 4 threads | Tuned to modern CPUs |
| Output | 256 bits | AES-256 key size |

**The memory requirement is the key weapon against attackers.**

A modern GPU (RTX 4090) can run roughly 300,000 PBKDF2 guesses per second --
the KDF used by most password managers. The same GPU can run only ~30
Argon2id guesses per second at 64 MiB, because it can only hold ~390
simultaneous guesses in GPU RAM before thrashing. That is a 10,000x reduction.

**Crack-time estimates (all-GPU brute force):**

| Password | Single RTX 4090 | Nation-state (10,000 GPUs) |
|----------|-----------------|----------------------------|
| 4 EFF words ("correct-horse-battery-staple" style) | ~19 years | ~7 days |
| 5 EFF words | ~200 million years | ~20,000 years |
| 6 EFF words | ~2 trillion years | not in this universe |
| 5 words + 1 digit | ~1.2 billion years | ~120,000 years |

These are best-case for the attacker (perfect parallelism, no overhead).
Five EFF words makes brute force mathematically infeasible for any entity
that exists today or in the foreseeable future.

Comparison: PBKDF2 at 310k iterations allows ~300,000 guesses/sec on the same
GPU. The same 4-word password takes ~2 years per GPU -- nation-state reachable
with ~17 hours on 10,000 GPUs.

### Layer 2 -- Data encryption (AES-256-GCM)

Every field stored at rest uses **AES-256-GCM**:

- **Key:** 256-bit, derived from your vault password.
- **IV:** 96-bit random value generated fresh for every single encrypt call.
- **Auth tag:** 128-bit GCM authentication tag appended to every ciphertext.
- **Wire format:** `base64(iv[12] + ciphertext + auth_tag[16])`

A tampered ciphertext throws before any plaintext is returned. There is no
scenario in which you receive silently corrupted data -- AES-GCM is an
authenticated encryption scheme, not just encryption.

AES-256 is what the US government classifies at the Top Secret level.
Brute-forcing a 256-bit key requires more operations than there are atoms
in the observable universe.

### Layer 3 -- HKDF key separation

OrangeRails does not use your Master Encryption Key (MEK) directly for data.
Instead it derives purpose-specific **subkeys** via HKDF-SHA-256:

| Context string | Used for |
|---|---|
| `orangerails-creds-v1` | Provider credentials (Blink API key, etc.) |
| `orangerails-txns-v1` | Normalized transaction payloads |
| `orangerails-verifier-v1` | Vault password-correctness verifier |
| `orangerails-pqc-secret-wrap-v1` | Wrapping PQC secret keys at rest |

This is the same key-separation pattern used by Signal, TLS 1.3, and Noise
Protocol. If one subkey were ever compromised in isolation, the others remain
protected -- the MEK itself is never directly exposed.

### Layer 4 -- Post-quantum key wrapping (Hybrid KEM + ML-DSA-65)

Primitives shipped in v0.x. Consumption by role-scoped-keys ships next.

**The problem: Harvest Now, Decrypt Later (HNDL)**

A well-funded adversary can record your encrypted traffic today, store it,
and decrypt it later once a Cryptographically Relevant Quantum Computer
(CRQC) exists. Industry consensus (NIST, NSA, Global Risk Institute) puts
the first CRQC in the **2035-2045** window.

For OrangeRails, the specific risk is **long-lived wrapped data keys** --
keys that must stay encrypted for years so authorized recipients can read
historical data. Classical key wrapping (RSA, ECDH) is Shor-vulnerable.
Our symmetric data (AES-256-GCM) is not -- Grover's algorithm halves
AES-256 from 256-bit to a still-unbreakable 128-bit effective strength.

**What we built: Hybrid X25519 + ML-KEM-768**

Key wrapping uses a hybrid approach: both a classical break AND a post-quantum
break are required to compromise the key material. A quantum computer running
Shor's algorithm breaks X25519. A breakthrough against Module-LWE breaks
ML-KEM-768. Either alone is not enough -- both have to fail simultaneously.

This is identical to what the industry ships today:
- **Chrome + Cloudflare** -- X25519MLKEM768 (RFC 9794) in TLS 1.3, default since 2024.
- **AWS KMS** -- hybrid key pairs in key wrapping.
- **Signal** -- PQXDH (hybrid ECDH + ML-KEM-768 in session key derivation).

**Key sizes:**

| Material | Raw bytes | Stored as |
|---|---|---|
| KEM public key | 1,216 (32 X25519 + 1,184 ML-KEM-768) | Plaintext in `user_vault_meta` |
| KEM secret key | 2,432 (32 + 2,400) | AES-256-GCM wrapped, MEK-derived subkey |
| KEM ciphertext | 1,120 (32 ephemeral + 1,088 ML-KEM-768 ct) | Per-recipient in `wrapped_data_keys` |
| ML-DSA-65 public key | 1,952 | Plaintext in `user_vault_meta` |
| ML-DSA-65 secret key | 4,032 | AES-256-GCM wrapped, MEK-derived subkey |

**ML-DSA-65 (FIPS 204) -- post-quantum signatures**

Audit log entries will be signed with ML-DSA-65 (previously Dilithium). This
allows verifying authenticity even after a CRQC exists, because ML-DSA is
based on Module-LWE -- a problem Shor's algorithm does not solve.

---

## What the server sees

| Data | Server stores | Server can read |
|---|---|---|
| Your API credentials | AES-256-GCM ciphertext | Never |
| Transaction amounts | AES-256-GCM ciphertext | Never |
| Transaction descriptions | AES-256-GCM ciphertext | Never |
| Your vault password | Never transmitted | Never |
| KEM + signing secret keys | AES-256-GCM wrapped | Never |
| KEM + signing public keys | Plaintext (by design) | Yes -- they are public keys |
| Transaction dates | Plaintext | Yes -- needed for filtering |
| Your user ID | Plaintext | Yes -- needed for routing |

---

## Shipped vs. planned

### Shipped

- Argon2id key derivation (OWASP 2023 parameters)
- AES-256-GCM for all data at rest
- HKDF key separation with versioned context strings
- Per-user hybrid KEM keypair (X25519 + ML-KEM-768), secret keys MEK-wrapped,
  public keys stored plaintext in `user_vault_meta`
- Per-user ML-DSA-65 signing keypair, same storage model
- `wrapped_data_keys` table for per-recipient key wrapping
- Live PQC diagnostic panel (verifies KEM round-trip + sign/verify in-browser)
- Test suite: hybrid KEM, key wrapping, ML-DSA-65 sign/verify/tamper

### Next PR -- role-scoped key wrapping

- Wrap the same AES data key for multiple recipients via their hybrid KEM
  public keys -- each role decrypts only what their role permits
- ML-DSA-65 signatures attached to data mutations for audit log integrity

### Future

- Password strength scorer (zxcvbn) + EFF passphrase generator on vault setup
- Vault password change triggers PQC secret key re-wrap under new MEK
- ML-KEM-1024 upgrade path (one strategy map entry, coordinated migration)
- ML-DSA-87 upgrade path

---

## How contributors can help

**1. PQC cross-library test vectors**
Run `src/lib/__tests__/pqc.test.ts` KEM vectors against an independent
implementation (liboqs, PyCryptodome) to confirm cross-library compatibility.
File results in the test file as comments.

**2. Argon2id benchmarks on mobile**
Measure unlock latency (64 MiB / 3 iter) on mid-range Android (Snapdragon 7
Gen 1) and iOS (A15). If >2 seconds, contribute a Web Worker offload so the
UI thread stays responsive during key derivation.

**3. Password strength gate**
Add `zxcvbn-ts` scoring to the vault setup screen. Require score >= 3 for new
vaults. Include the EFF passphrase generator pattern.

**4. Vault re-key on password change**
When a user changes their vault password, PQC secret keys wrapped under the
old MEK need re-wrapping under the new MEK. Implement an orchestrator analogous
to a vault-migration script in the consuming app.

**5. Security audit**
`src/lib/pqc.ts`, `key-wrapping.ts`, `signatures.ts` implement the layer.
Specific things to verify: IV freshness in `key-wrapping.ts`, byte-length
assertions in `pqc.ts`, HKDF combiner ordering matches ML-KEM NIST spec,
no key material leaking into thrown error messages.

---

## Security disclosure

Found a vulnerability? Please do not open a public GitHub issue.
Email the maintainers directly with a description and reproduction steps.
We target 72-hour acknowledgment and 90-day coordinated disclosure.
