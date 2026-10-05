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
        maybeSingle(): Promise<{ data: { kem_public_key: string | null } | null; error: unknown }>;
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
 * THE "dead" READING IS ONLY SOUND IF THIS KEY IS THE KEY THE SECRET WAS
 * WRAPPED UNDER. A tag failure says THIS key did not open THIS ciphertext, and
 * nothing in here can tell that apart from a secret that is genuinely dead:
 * this function sees two opaque CryptoKeys and a string.
 * carryPqcSecretsAcrossRotation() runs assertPqcWrapKeyMatchesSalt() before any
 * secret is touched, which NARROWS that gap and does not close it. That check
 * proves the handed key matches the salt the caller names. It does not prove
 * the handed key is the one this ciphertext was wrapped under. Read the HONEST
 * LIMIT note on that function before you rely on "dead", and call this function
 * directly only if you are asserting the whole of that yourself.
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
 *
 * WHY oldMek AND authenticatedSaltB64 ARE REQUIRED. Nothing downstream can tell
 * a dead secret from a wrong key: both are the same AES-GCM tag failure. So this
 * function will not read a tag failure as "dead" until it has proved the old
 * wrap key is the key that (oldMek, authenticatedSaltB64) produces. They are
 * required rather than optional on purpose, so that adding a caller forces
 * whoever adds it to say where their salt came from.
 *
 * authenticatedSaltB64 means the salt that has been PROVEN to belong to this
 * vault, not merely the salt that was to hand. In recoverWithCode that proof is
 * the verifier check: deriveVerifierKey(oldMek, storedSalt) opened the stored
 * verifier ciphertext, which a wrong salt could not have done.
 */
export async function carryPqcSecretsAcrossRotation(args: {
  oldWrapKey: CryptoKey;
  newWrapKey: CryptoKey;
  oldMek: CryptoKey;
  authenticatedSaltB64: string;
  kemSecretWrapped: string | null;
  sigSecretWrapped: string | null;
}): Promise<CarriedPqcSecrets> {
  const {
    oldWrapKey,
    newWrapKey,
    oldMek,
    authenticatedSaltB64,
    kemSecretWrapped,
    sigSecretWrapped,
  } = args;

  // Prove the old wrap key before a single tag failure is allowed to mean
  // "dead". Unconditional, even when there is nothing to carry: a caller whose
  // salt is wrong is wrong whether or not this particular vault happens to hold
  // PQC keys, and finding out on an empty vault costs nothing.
  await assertPqcWrapKeyMatchesSalt({
    wrapKey: oldWrapKey,
    mek: oldMek,
    saltB64: authenticatedSaltB64,
  });

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

/**
 * A fixed, non-secret probe plaintext. Encrypting it under one key and opening
 * it with another is how two CryptoKeys are compared here without ever pulling
 * key bytes into JavaScript. The value is arbitrary; only its constancy matters.
 */
const PQC_WRAP_KEY_PROBE = "orangerails-pqc-wrap-key-probe-v1";

/**
 * Prove that `wrapKey` really is derivePqcSecretWrapKey(mek, saltB64), and throw
 * loudly if it is not.
 *
 * WHY THIS EXISTS, and it is not about a bug that exists today. rewrapPqcSecretKey
 * turns an AES-GCM tag failure into status "dead", and the caller turns "dead"
 * into "clear the matching public key", which discards a keypair permanently.
 * That reading is correct only when the key handed in is the key the secret was
 * wrapped under. Nothing downstream can check that, so it is checked here,
 * before any of it runs.
 *
 * The realistic way to break it is a salt rotation. Rotating the vault salt
 * during recovery is a reasonable looking hardening and reads as purely
 * additive. The moment the old wrap key is derived from a new salt, EVERY
 * recovery on a vault with PQC keys reports both secrets dead, clears both
 * public keys, and reports it to the user as an expected outcome. Silently, for
 * every user, with no error. This turns that into a thrown error at step 5 of
 * the recovery, where the user has lost nothing yet: every stored wrapper is
 * still valid and the vault still opens.
 *
 * HOW, and why not the obvious way. Two CryptoKeys cannot be compared directly.
 * They could be compared by exporting their raw bytes, and this deliberately
 * does not: pulling key material into JavaScript on a self custody path to win a
 * comparison is a bad trade. Instead a fixed non-secret probe is encrypted under
 * the expected key and opened with the key that was handed in. Same key, same
 * plaintext back. Different key, the tag fails.
 *
 * HONEST LIMIT, and it is narrower than the name suggests. This proves ONE
 * thing: that the handed key is what derivePqcSecretWrapKey(mek, saltB64)
 * produces. That is a self consistency check on the caller. It does NOT prove
 * that the handed key opens the STORED ciphertext, and only that second
 * proposition separates "this secret is dead" from "this key is wrong".
 *
 * So it catches a caller that derives from one salt while naming another, which
 * is the mistake people actually make. It does NOT catch a stored secret that
 * was wrapped under a derivation this code no longer reproduces: a rotation
 * that carries the other ciphertexts across and leaves these two behind, a
 * change to the HKDF context string, or a secret written by an older client. In
 * each of those the probe passes, the rewrap tag fails, and the keypair is
 * discarded as though the secret were dead.
 *
 * A better probe cannot close that. Opening the stored ciphertext IS the
 * rewrap: if it opens, nothing was dead, and if it does not, the tag failure is
 * the same observation either way. Closing it needs either a derivation
 * identifier stored alongside the wrapped secret, or a dead path that a tag
 * failure alone cannot authorise. Neither is here yet, and both are tracked
 * separately. Do not read this function as covering them.
 *
 * It also cannot prove the caller named the right salt, because a caller that
 * derives from salt B and also names salt B is self consistent and wrong. What
 * makes the named salt trustworthy is separate and lives at the call site:
 * recoverWithCode only reaches this point after deriveVerifierKey(oldMek,
 * storedSalt) has opened the stored verifier, which a wrong salt could not have
 * done.
 */
export async function assertPqcWrapKeyMatchesSalt(args: {
  wrapKey: CryptoKey;
  mek: CryptoKey;
  saltB64: string;
}): Promise<void> {
  const { wrapKey, mek, saltB64 } = args;

  const expected = await derivePqcSecretWrapKey(mek, saltB64);
  const probeCiphertext = await encryptString(PQC_WRAP_KEY_PROBE, expected);

  let opened: string;
  try {
    opened = await decryptString(probeCiphertext, wrapKey);
  } catch (err) {
    if (!isAuthenticationTagFailure(err)) throw err;
    throw new Error(
      "PQC wrap key does not match the vault salt it was said to come from. Refusing to " +
        "carry the PQC secrets: under a mismatched key every stored secret looks dead, and " +
        "treating that as dead destroys the keypairs permanently.",
    );
  }

  if (opened !== PQC_WRAP_KEY_PROBE) {
    throw new Error(
      "PQC wrap key probe opened to the wrong plaintext. Refusing to carry the PQC secrets.",
    );
  }
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
    .select("kem_public_key")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing.error) {
    throw existing.error;
  }
  if (existing.data?.kem_public_key) {
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
