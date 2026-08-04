/**
 * Co-admin emergency access orchestration.
 *
 * Implements the grant / consume / revoke lifecycle described in
 * docs/OrangeRails-CoAdmins.md. All cryptographic work happens in the
 * browser; the server never sees plaintext subkeys.
 *
 * ## Grant flow (owner side)
 *   1. Re-derive MEK raw bytes from the owner's vault password.
 *   2. Run HKDF on the raw bytes to extract credentials + transactions subkeys.
 *   3. Concatenate into a 64-byte blob.
 *   4. Wrap the blob with the admin's hybrid KEM public key (see wrapBlob64).
 *   5. Insert into wrapped_data_keys + workspace_admins.
 *
 * ## Consume flow (admin side, post-unlock)
 *   1. Fetch wrapped_data_keys row for the owner's workspace_key_id.
 *   2. Unwrap with the admin's own PQC secret key (see unwrapBlob64).
 *   3. Split into two 32-byte subkeys; import as AES-GCM CryptoKeys.
 *   4. Return for use in encrypt/decrypt calls.
 *
 * ## Revoke flow (owner side)
 *   1. Delete workspace_admins row (RLS ensures only the owner can do this).
 *   2. Delete the corresponding wrapped_data_keys row.
 *
 * ## Why not KEY_WRAP_STRATEGIES[...].wrapForRecipient?
 *   That function enforces a 32-byte data-key size (it was designed for
 *   per-table AES keys). The co-admin blob is 64 bytes (credentials_subkey ||
 *   transactions_subkey). Rather than relax the existing 32-byte contract,
 *   we implement a co-admin-specific wrap here using the same underlying
 *   PQC primitives (hybridEncapsulate / hybridDecapsulate from pqc.ts)
 *   and the same wire format, just with a larger plaintext.
 *
 * Wire format (co-admin blob wrap):
 *   bytes 0..HYBRID_KEM_CIPHERTEXT_BYTES      : hybrid KEM ciphertext
 *   bytes HYBRID_KEM_CIPHERTEXT_BYTES..+12     : AES-GCM IV
 *   bytes ..end                                : AES-GCM(sharedSecret, blob64) + 16-byte tag
 *
 * MVP limitation: cached subkeys in the admin's browser tab survive
 * revocation until the tab is closed. See docs/OrangeRails-CoAdmins.md.
 */

import { deriveMekRaw, importAesKey } from "./vault";
import { HKDF_CONTEXTS, derivePqcSecretWrapKey } from "./key-derivation";
import { base64ToBytes } from "./key-wrapping";
import { hybridEncapsulate, hybridDecapsulate, HYBRID_KEM_CIPHERTEXT_BYTES } from "./pqc";
import { unwrapPqcSecretKey } from "./pqc-lifecycle";
import { signToBase64, verifyFromBase64 } from "./signatures";

// ------------------------------------------------------------------
// Encoding helpers
// ------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ------------------------------------------------------------------
// HKDF from raw bytes , derives a 32-byte subkey without going through
// a non-extractable CryptoKey, so the raw output can be concatenated.
// ------------------------------------------------------------------

async function hkdfSubkeyRaw(
  mekRaw: Uint8Array,
  context: string,
  saltB64: string,
): Promise<Uint8Array> {
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    mekRaw as BufferSource,
    { name: "HKDF" },
    /* extractable */ false,
    ["deriveBits"],
  );

  const saltBytes = base64ToBytes(saltB64);
  const infoBytes = new TextEncoder().encode(context);

  const rawBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: saltBytes as BufferSource,
      info: infoBytes as BufferSource,
    },
    hkdfKey,
    256,
  );

  return new Uint8Array(rawBits);
}

// ------------------------------------------------------------------
// 64-byte blob wrap / unwrap , co-admin-specific, same wire format as
// key-wrapping.ts but without the 32-byte data-key size restriction.
// ------------------------------------------------------------------

const BLOB64_BYTES = 64;
const AES_IV_BYTES = 12;

/**
 * Wrap a 64-byte blob for a recipient's hybrid KEM public key.
 * Output is opaque bytes; store base64 in wrapped_data_keys.wrapped_ciphertext.
 */
export async function wrapBlob64(
  blob: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  if (blob.length !== BLOB64_BYTES) {
    throw new Error(`blob must be ${BLOB64_BYTES} bytes, got ${blob.length}`);
  }

  const { ciphertext: kemCt, sharedSecret } = hybridEncapsulate(recipientPublicKey);

  const aesKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );

  const iv = new Uint8Array(AES_IV_BYTES);
  crypto.getRandomValues(iv);

  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    blob as BufferSource,
  );

  const out = new Uint8Array(kemCt.length + AES_IV_BYTES + ct.byteLength);
  out.set(kemCt, 0);
  out.set(iv, kemCt.length);
  out.set(new Uint8Array(ct), kemCt.length + AES_IV_BYTES);
  return out;
}

/**
 * Unwrap a blob produced by wrapBlob64 using the recipient's own secret key.
 * Returns the original 64-byte blob.
 */
export async function unwrapBlob64(
  wrapped: Uint8Array,
  ownSecretKey: Uint8Array,
): Promise<Uint8Array> {
  const expectedMin = HYBRID_KEM_CIPHERTEXT_BYTES + AES_IV_BYTES + BLOB64_BYTES + 16;
  if (wrapped.length !== expectedMin) {
    throw new Error(`wrapped blob must be ${expectedMin} bytes, got ${wrapped.length}`);
  }

  const kemCt = wrapped.subarray(0, HYBRID_KEM_CIPHERTEXT_BYTES);
  const iv = wrapped.subarray(
    HYBRID_KEM_CIPHERTEXT_BYTES,
    HYBRID_KEM_CIPHERTEXT_BYTES + AES_IV_BYTES,
  );
  const ciphertext = wrapped.subarray(HYBRID_KEM_CIPHERTEXT_BYTES + AES_IV_BYTES);

  const sharedSecret = hybridDecapsulate(ownSecretKey, kemCt);

  const aesKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret as BufferSource,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    aesKey,
    ciphertext as BufferSource,
  );

  return new Uint8Array(pt);
}

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

/** Narrow Supabase surface needed by the co-admin flows. */
export interface CoAdminSupabaseLike {
  from(table: string): CoAdminTableBuilder;
}

interface CoAdminTableBuilder {
  select(columns: string): CoAdminSelectBuilder;
  insert(
    row: Record<string, unknown>,
  ): Promise<{ data: Record<string, unknown>[] | null; error: unknown }>;
  delete(): CoAdminDeleteBuilder;
  update(values: Record<string, unknown>): CoAdminUpdateBuilder;
}

interface CoAdminSelectBuilder {
  eq(col: string, val: string): CoAdminEqBuilder;
}

interface CoAdminEqBuilder {
  eq(col: string, val: string): CoAdminEqBuilder;
  single(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
  maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }>;
}

interface CoAdminDeleteBuilder {
  eq(col: string, val: string): CoAdminDeleteBuilder;
  then(fn: (v: { error: unknown }) => void): Promise<{ error: unknown }>;
}

interface CoAdminUpdateBuilder {
  eq(col: string, val: string): Promise<{ error: unknown }>;
}

/** Result returned by grantCoAdmin. */
export interface GrantResult {
  workspaceKeyId: string;
}

/** Subkeys returned by loadAdminSubkeysDirect for use in encrypt/decrypt. */
export interface AdminSubkeys {
  credentialsKey: CryptoKey;
  transactionsKey: CryptoKey;
}

// ------------------------------------------------------------------
// Grant flow
// ------------------------------------------------------------------

/**
 * Grant full co-admin access to a target user.
 *
 * The owner must re-confirm their vault password so we can derive
 * subkeys as raw bytes without having access to the non-extractable MEK.
 *
 * @param params.ownerUserId       The authenticated owner's user ID.
 * @param params.ownerSaltB64      The owner's vault salt (from user_vault_meta).
 * @param params.ownerPassword     Re-confirmed vault password (never leaves the browser).
 * @param params.targetUserId      The recipient's user ID (from pqc-lookup-user).
 * @param params.targetKemPubB64   The recipient's KEM public key, base64 (from pqc-lookup-user).
 * @param params.existingKeyId     Current workspace_key_id from user_vault_meta (null if not yet set).
 * @param params.supabase          Authenticated Supabase client for the owner.
 */
export async function grantCoAdmin(params: {
  ownerUserId: string;
  ownerSaltB64: string;
  ownerPassword: string;
  ownerSigSecretWrapped: string;
  targetUserId: string;
  targetKemPubB64: string;
  existingKeyId: string | null;
  supabase: CoAdminSupabaseLike;
}): Promise<GrantResult> {
  const { ownerUserId, ownerSaltB64, ownerPassword, ownerSigSecretWrapped, targetUserId, targetKemPubB64, supabase } =
    params;

  // Step a , derive raw MEK bytes from the re-confirmed password.
  const mekRaw = await deriveMekRaw(ownerPassword, ownerSaltB64);

  // Step b-c , derive both subkeys as raw bytes and concat into 64-byte blob.
  const credsRaw = await hkdfSubkeyRaw(
    mekRaw,
    HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1,
    ownerSaltB64,
  );
  const txnsRaw = await hkdfSubkeyRaw(
    mekRaw,
    HKDF_CONTEXTS.ORANGERAILS_TRANSACTIONS_V1,
    ownerSaltB64,
  );

  const blob = new Uint8Array(64);
  blob.set(credsRaw, 0);
  blob.set(txnsRaw, 32);

  // Step d , allocate workspace_key_id if not yet set.
  let workspaceKeyId = params.existingKeyId;
  if (!workspaceKeyId) {
    workspaceKeyId = crypto.randomUUID();
    const { error: updateErr } = await (
      supabase
        .from("user_vault_meta")
        .update({ workspace_key_id: workspaceKeyId }) as unknown as CoAdminUpdateBuilder
    ).eq("user_id", ownerUserId);
    if (updateErr) throw new Error(`Failed to write workspace_key_id: ${updateErr}`);
  }

  // Step e , wrap the 64-byte blob for the recipient's KEM public key.
  const recipientPub = base64ToBytes(targetKemPubB64);
  const wrappedBytes = await wrapBlob64(blob, recipientPub);
  const wrappedCt = bytesToBase64(wrappedBytes);

  // Step e.1 , ML-DSA-65 sign the grant binding so neither the recipient nor
  // the wrapped ciphertext can be swapped after the fact. The signed payload
  // binds all four fields: context, grantee user id, workspace key id, and the
  // wrapped ciphertext bytes. All four must match at verify time.
  const mekHkdf = await crypto.subtle.importKey(
    "raw",
    mekRaw,
    { name: "HKDF" },
    false,
    ["deriveBits"],
  );
  const pqcWrapKey = await derivePqcSecretWrapKey(mekHkdf, ownerSaltB64);
  const ownerSigSecretBytes = await unwrapPqcSecretKey(pqcWrapKey, ownerSigSecretWrapped);
  const sigPayload = JSON.stringify({
    ctx: "orangerails:add-member:mek-wrap:v1",
    granteeUserId: targetUserId,
    workspaceKeyId,
    wrappedCt,
  });
  const { signature: grantSig } = await signToBase64(ownerSigSecretBytes, sigPayload);

  // Step f , insert wrapped_data_keys row.
  const { error: wdkErr } = await supabase.from("wrapped_data_keys").insert({
    data_key_id: workspaceKeyId,
    recipient_user_id: targetUserId,
    wrapped_ciphertext: wrappedCt,
    algorithm: "hybrid-x25519-mlkem768-blob64",
    grant_sig: grantSig,
  });
  if (wdkErr) throw new Error(`Failed to insert wrapped_data_keys: ${wdkErr}`);

  // Step g , insert workspace_admins row.
  const { error: adminErr } = await supabase.from("workspace_admins").insert({
    owner_user_id: ownerUserId,
    admin_user_id: targetUserId,
  });
  if (adminErr) throw new Error(`Failed to insert workspace_admins: ${adminErr}`);

  return { workspaceKeyId };
}

// ------------------------------------------------------------------
// Consume flow
// ------------------------------------------------------------------

/**
 * Load the owner's subkeys from a pre-fetched wrapped row.
 *
 * Called by the VaultContext wrapper after it fetches the relevant rows
 * from Supabase. Separating the crypto from the data-fetch keeps this
 * function fully unit-testable without a Supabase stub.
 *
 * @param params.wrappedCiphertextB64  Base64 wrapped blob (from wrapped_data_keys).
 * @param params.kemSecretWrapped      Admin's AES-GCM-wrapped PQC secret key (from user_vault_meta).
 * @param params.adminMek              Admin's own MEK (from VaultContext).
 * @param params.adminSaltB64          Admin's own vault salt.
 */
export async function loadAdminSubkeysDirect(params: {
  wrappedCiphertextB64: string;
  kemSecretWrapped: string;
  adminMek: CryptoKey;
  adminSaltB64: string;
  grantSigB64?: string | null;
  ownerSigPubB64?: string;
  granteeUserId?: string;
  ownerWorkspaceKeyId?: string;
}): Promise<AdminSubkeys> {
  const { wrappedCiphertextB64, kemSecretWrapped, adminMek, adminSaltB64,
          grantSigB64, ownerSigPubB64, granteeUserId, ownerWorkspaceKeyId } = params;

  // Step 0 , verify the grant signature before any decryption (fail-closed).
  // Both a missing signature and an invalid signature cause an immediate throw.
  // Decryption only proceeds AFTER a verified signature. Reject is the default
  // branch, not an else.
  if (!grantSigB64) {
    throw new Error(
      "Co-admin grant signature missing: refusing to decrypt wrapped subkeys.",
    );
  }
  if (!ownerSigPubB64 || !granteeUserId || !ownerWorkspaceKeyId) {
    throw new Error(
      "Co-admin grant binding fields missing: ownerSigPubB64, granteeUserId, and ownerWorkspaceKeyId are required.",
    );
  }
  const verifyPayload = JSON.stringify({
    ctx: "orangerails:add-member:mek-wrap:v1",
    granteeUserId,
    workspaceKeyId: ownerWorkspaceKeyId,
    wrappedCt: wrappedCiphertextB64,
  });
  const sigValid = await verifyFromBase64(ownerSigPubB64, verifyPayload, grantSigB64);
  if (!sigValid) {
    throw new Error(
      "Co-admin grant signature invalid: refusing to decrypt wrapped subkeys.",
    );
  }

  // Unwrap the admin's PQC secret key from their own vault.
  const wrapKey = await derivePqcSecretWrapKey(adminMek, adminSaltB64);
  const kemSecretBytes = await unwrapPqcSecretKey(wrapKey, kemSecretWrapped);

  // Unwrap the 64-byte subkey blob using the admin's PQC secret key.
  const wrappedCiphertext = base64ToBytes(wrappedCiphertextB64);
  const blob = await unwrapBlob64(wrappedCiphertext, kemSecretBytes);

  const credentialsKey = await importAesKey(blob.slice(0, 32).buffer);
  const transactionsKey = await importAesKey(blob.slice(32, 64).buffer);

  return { credentialsKey, transactionsKey };
}

// ------------------------------------------------------------------
// Revoke flow
// ------------------------------------------------------------------

/**
 * Revoke a co-admin grant.
 *
 * Deletes both the workspace_admins row and the corresponding
 * wrapped_data_keys row. RLS ensures only the owner can delete either.
 *
 * MVP: cached subkeys in the admin's browser tab remain valid until that
 * tab is closed. True instant revocation requires subkey rotation (v2).
 *
 * @param params.ownerWorkspaceKeyId  The owner's workspace_key_id.
 * @param params.adminUserId          The admin user's ID to revoke.
 * @param params.ownerUserId          The owner's user ID (for the workspace_admins delete).
 * @param params.supabase             Authenticated Supabase client for the owner.
 */
export async function revokeCoAdmin(params: {
  ownerWorkspaceKeyId: string;
  adminUserId: string;
  ownerUserId: string;
  supabase: CoAdminSupabaseLike;
}): Promise<void> {
  const { ownerWorkspaceKeyId, adminUserId, ownerUserId, supabase } = params;

  // Delete workspace_admins row first (RLS: only owner can delete).
  const { error: adminErr } = await (
    supabase
      .from("workspace_admins")
      .delete()
      .eq("owner_user_id", ownerUserId) as unknown as CoAdminDeleteBuilder
  ).eq("admin_user_id", adminUserId);
  if (adminErr) throw new Error(`Failed to delete workspace_admins row: ${adminErr}`);

  // Delete wrapped_data_keys row for this admin (RLS: owner has delete policy).
  const { error: wdkErr } = await (
    supabase
      .from("wrapped_data_keys")
      .delete()
      .eq("data_key_id", ownerWorkspaceKeyId) as unknown as CoAdminDeleteBuilder
  ).eq("recipient_user_id", adminUserId);
  if (wdkErr) throw new Error(`Failed to delete wrapped_data_keys row: ${wdkErr}`);
}
