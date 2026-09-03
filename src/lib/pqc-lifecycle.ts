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
 * Move an already-wrapped PQC secret key from one wrapping key to another.
 *
 * WHY THIS EXISTS. The wrap key here is derived from the MEK
 * (derivePqcSecretWrapKey), so anything that rotates the MEK must carry these
 * secrets across in the same operation or the only key that opens them is gone.
 * There is no way back from that: the vault row still holds a valid-looking
 * kem_public_key, so ensurePqcKeypairs() short-circuits and never regenerates,
 * and anything anyone encrypts to that public key afterwards is undecryptable
 * from the moment it is written.
 *
 * Decrypts and re-encrypts the stored base64 string as-is rather than round
 * tripping through bytes, so the encoding cannot drift here.
 *
 * Throws if the old wrap key does not open the ciphertext. A caller mid-rotation
 * must let that throw and abort: continuing would discard the old key while the
 * secret is still wrapped under it.
 */
export async function rewrapPqcSecretKey(
  oldWrapKey: CryptoKey,
  newWrapKey: CryptoKey,
  secretWrappedB64: string,
): Promise<string> {
  const secretBase64 = await decryptString(secretWrappedB64, oldWrapKey);
  return encryptString(secretBase64, newWrapKey);
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
 * If the user's row in user_vault_meta has no PQC public key yet,
 * generate both keypairs, encrypt the secret halves with an MEK-derived
 * subkey, and publish everything to user_vault_meta.
 *
 * Idempotent: a second call after the row is populated is a no-op.
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
  // Both must be present. buildPqcKeyMaterial always writes all four columns
  // together, so a row with one public key populated and the other cleared
  // (the mixed state a rotation that carries only one PQC secret can leave,
  // see carryPqcSecretsAcrossRotation) is a keypair still waiting on its
  // repair, not a keypair that already exists.
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
