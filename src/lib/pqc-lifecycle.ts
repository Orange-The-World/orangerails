/**
 * Vault lifecycle glue for post-quantum key material.
 *
 * Responsibilities:
 *   1. On first unlock (or vault creation), generate the user's hybrid
 *      KEM keypair and ML-DSA-65 signing keypair if they don't exist yet.
 *   2. Encrypt both secret keys with an MEK-derived AES-256-GCM subkey
 *      so they can be stored on the server without the server ever
 *      being able to read them.
 *   3. Publish the public keys and wrapped secret keys to user_vault_meta.
 *
 * This module does NOT consume the PQC keys for anything beyond storage.
 * The role-scoped-keys feature that actually uses them ships in a
 * separate future PR. The scope of this module is "keys exist and are
 * persisted," nothing more.
 *
 * Supabase types are left permissive (SupabaseLike) so this module can
 * be unit-tested with an in-memory stub without pulling in the full
 * generated schema types.
 */

import { encryptString, decryptString } from "./vault";
import { derivePqcSecretWrapKey } from "./key-derivation";
import { generateHybridKemKeyPair, generateSigKeyPair } from "./pqc";

// ------------------------------------------------------------------
// Base64 helpers , kept local to avoid a cross-module dep cycle.
// ------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ------------------------------------------------------------------
// Narrow Supabase surface , we only need from().select().eq().maybeSingle()
// for the existence check and from().update().eq() for the publish.
// ------------------------------------------------------------------

export interface SupabaseLike {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        maybeSingle(): Promise<{
          data: { kem_public_key: string | null; sig_public_key: string | null } | null;
          error: unknown;
        }>;
      };
    };
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): Promise<{ error: unknown }>;
    };
  };
}

// ------------------------------------------------------------------
// Row fields we publish to user_vault_meta.
// ------------------------------------------------------------------

export interface PqcKeyMaterialRow {
  kem_public_key: string;
  kem_secret_wrapped: string;
  sig_public_key: string;
  sig_secret_wrapped: string;
  pqc_key_version: number;
}

/**
 * Build the row fields from a freshly-generated pair of keypairs.
 *
 * Split out from the Supabase-touching path so it can be unit-tested
 * deterministically without a network stub.
 *
 * Secret keys are converted bytes → base64 → AES-GCM(encryptString) →
 * base64 string for storage. This double-base64 path is intentional:
 * encryptString takes and returns strings, which matches the column
 * types and keeps this module consistent with the rest of the crypto
 * layer.
 */
export async function buildPqcKeyMaterial(wrapKey: CryptoKey): Promise<PqcKeyMaterialRow> {
  const kem = generateHybridKemKeyPair();
  const sig = generateSigKeyPair();

  const [kemSecretWrapped, sigSecretWrapped] = await Promise.all([
    encryptString(bytesToBase64(kem.secretKey), wrapKey),
    encryptString(bytesToBase64(sig.secretKey), wrapKey),
  ]);

  return {
    kem_public_key: bytesToBase64(kem.publicKey),
    kem_secret_wrapped: kemSecretWrapped,
    sig_public_key: bytesToBase64(sig.publicKey),
    sig_secret_wrapped: sigSecretWrapped,
    pqc_key_version: 1,
  };
}

/** Inverse of buildPqcKeyMaterial , used by the future role-scoped-keys feature. */
export async function unwrapPqcSecretKey(
  wrapKey: CryptoKey,
  secretWrappedB64: string,
): Promise<Uint8Array> {
  const secretBase64 = await decryptString(secretWrappedB64, wrapKey);
  return base64ToBytes(secretBase64);
}

/**
 * Why a re-wrap did not produce a new ciphertext.
 *
 * "dead" means one specific thing and nothing else: the AES-GCM authentication
 * tag did not validate, so the ciphertext is genuinely not openable by the key
 * it was handed. Every other failure is transient and is reported by throwing,
 * because a transient failure treated as a dead key discards a LIVE keypair.
 */
export type RewrapPqcSecretResult =
  | { status: "rewrapped"; secretWrapped: string }
  | { status: "dead" };

/**
 * Is this error the AES-GCM authentication tag refusing to validate?
 *
 * WebCrypto reports a failed tag check as a DOMException named
 * "OperationError", in browsers and in Node alike. Nothing else on the
 * decryptString path reports itself that way: a base64 decode failure raises
 * "InvalidCharacterError", a key that lacks the decrypt usage raises
 * "InvalidAccessError", and the length guard raises a plain Error.
 *
 * The test is on the error NAME, never on its message. Message text is empty in
 * browsers, differs between engines, and would silently stop matching the day
 * an engine reworded it. A match that silently stops matching turns a dead
 * secret back into a recovery that aborts forever with nothing to say why.
 */
export function isAuthenticationTagFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "OperationError"
  );
}

/**
 * Move an already-wrapped PQC secret key from one wrapping key to another.
 *
 * WHY THIS EXISTS. The wrap key here is derived from the MEK
 * (derivePqcSecretWrapKey), so anything that rotates the MEK must carry these
 * secrets across in the same operation or the only key that opens them is gone.
 * There is no way back from that on its own: the vault row still holds a
 * valid-looking kem_public_key, so ensurePqcKeypairs() short-circuits and never
 * regenerates, and anything anyone encrypts to that public key afterwards is
 * undecryptable from the moment it is written. Clearing the public key when
 * nothing was carried is what breaks that loop, and it is the caller's job.
 *
 * Decrypts and re-encrypts the stored base64 string as-is rather than round
 * tripping through bytes, so the encoding cannot drift here.
 *
 * THREE OUTCOMES, and keeping them apart is the point of this function.
 *   rewrapped: the secret travelled. Store it.
 *   dead:      the old wrap key does not open this ciphertext. Carry nothing
 *              for this key AND clear the matching public key.
 *   thrown:    anything else. Abort the recovery: we do not know the secret is
 *              dead, and discarding a live keypair cannot be undone.
 *
 * Null is deliberately not one of them. Null already means "there was nothing
 * to carry" further up this path.
 *
 * The re-encryption under the new key sits OUTSIDE the try on purpose. A
 * failure there says nothing about whether the old ciphertext was readable, and
 * catching it here would report a secret we had just opened successfully as
 * dead.
 */
export async function rewrapPqcSecretKey(
  oldWrapKey: CryptoKey,
  newWrapKey: CryptoKey,
  secretWrappedB64: string,
): Promise<RewrapPqcSecretResult> {
  let secretBase64: string;
  try {
    secretBase64 = await decryptString(secretWrappedB64, oldWrapKey);
  } catch (err) {
    if (isAuthenticationTagFailure(err)) return { status: "dead" };
    throw err;
  }
  return { status: "rewrapped", secretWrapped: await encryptString(secretBase64, newWrapKey) };
}

/** What a rotation carried across, and whether anything was lost doing it. */
export interface CarriedPqcSecrets {
  /** Re-wrapped kem_secret_wrapped, or null when nothing was carried. */
  newKemSecretWrapped: string | null;
  /** Re-wrapped sig_secret_wrapped, or null when nothing was carried. */
  newSigSecretWrapped: string | null;
  /**
   * True when a stored secret existed and could not be opened, so the keypair
   * it belongs to is being discarded. This is what the recovery screen reads to
   * tell the user what they lost instead of leaving them to find out.
   *
   * NOT set when there was simply nothing stored to carry: nothing was lost in
   * that case and saying so would be a lie.
   */
  pqcKeysReplaced: boolean;
}

/**
 * Carry both stored PQC secrets across an MEK rotation.
 *
 * Lives here rather than inline in the vault context so it can be driven with
 * real key material and real AES-GCM by a unit test. The component that calls
 * it has no test harness in this repo, and this is the branch where being wrong
 * destroys keys silently rather than failing loudly.
 *
 * Throws on any transient failure, so a caller that simply awaits it aborts the
 * recovery by default rather than by remembering to. A caller must NOT wrap
 * this in a bare catch: that is exactly how a transient failure becomes a
 * discarded live keypair.
 */
export async function carryPqcSecretsAcrossRotation(args: {
  oldWrapKey: CryptoKey;
  newWrapKey: CryptoKey;
  kemSecretWrapped: string | null;
  sigSecretWrapped: string | null;
}): Promise<CarriedPqcSecrets> {
  const { oldWrapKey, newWrapKey, kemSecretWrapped, sigSecretWrapped } = args;

  let pqcKeysReplaced = false;

  async function carry(secretWrappedB64: string | null): Promise<string | null> {
    if (!secretWrappedB64) return null;
    const result = await rewrapPqcSecretKey(oldWrapKey, newWrapKey, secretWrappedB64);
    if (result.status === "rewrapped") return result.secretWrapped;
    pqcKeysReplaced = true;
    return null;
  }

  // Sequential on purpose. Both calls write pqcKeysReplaced, and concurrency
  // buys nothing: two AES-GCM operations on a few hundred bytes are not what a
  // recovery costs.
  const newKemSecretWrapped = await carry(kemSecretWrapped);
  const newSigSecretWrapped = await carry(sigSecretWrapped);

  return { newKemSecretWrapped, newSigSecretWrapped, pqcKeysReplaced };
}

// ------------------------------------------------------------------
// High-level entry point , checks, generates, publishes.
// ------------------------------------------------------------------

export interface EnsurePqcKeypairsArgs {
  userId: string;
  mek: CryptoKey;
  saltB64: string;
  supabase: SupabaseLike;
}

export type EnsurePqcKeypairsResult =
  | { generated: false }
  | { generated: true; publicKeys: { kem: string; sig: string } };

/**
 * If the user's row in user_vault_meta is missing EITHER PQC public key,
 * generate both keypairs, encrypt the secret halves with an MEK-derived
 * subkey, and publish everything to user_vault_meta.
 *
 * Idempotent: a second call after the row is fully populated is a no-op.
 *
 * BOTH columns are checked, not just kem_public_key (OR-T1977). A row can
 * have one public key live and the other cleared, most concretely from a
 * vault recovery where one PQC secret carried across the MEK rotation and
 * the other did not (see vault-persist.ts, migrateAndPersistRotatedVault).
 * Gating on kem_public_key alone would let such a row short-circuit forever:
 * the missing sig key would never regenerate because nothing ever looked at
 * it. Checking both is what makes this function repair that row on its own,
 * rather than depending on every write path upstream staying careful.
 *
 * Regenerating discards whichever key WAS still live, because
 * buildPqcKeyMaterial always produces a fresh pair together; there is no
 * partial regeneration. That is a real cost, it is accepted, and it is the
 * same cost either fix for OR-T1977 pays, just at a different moment: this
 * gate pays it lazily, on the next unlock, instead of immediately at write
 * time.
 *
 * Does not block unlock if the publish fails , the caller can retry or
 * surface the error. Errors from the Supabase client are returned via
 * the promise rejection so the UI can decide how loud to be.
 */
export async function ensurePqcKeypairs(
  args: EnsurePqcKeypairsArgs,
): Promise<EnsurePqcKeypairsResult> {
  const { userId, mek, saltB64, supabase } = args;

  const existing = await supabase
    .from("user_vault_meta")
    .select("kem_public_key, sig_public_key")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) {
    throw existing.error;
  }
  if (existing.data?.kem_public_key && existing.data?.sig_public_key) {
    return { generated: false };
  }

  const wrapKey = await derivePqcSecretWrapKey(mek, saltB64);
  const row = await buildPqcKeyMaterial(wrapKey);

  const update = await supabase
    .from("user_vault_meta")
    .update(row as unknown as Record<string, unknown>)
    .eq("user_id", userId);

  if (update.error) {
    throw update.error;
  }

  return {
    generated: true,
    publicKeys: { kem: row.kem_public_key, sig: row.sig_public_key },
  };
}
