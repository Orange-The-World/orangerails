/**
 * What a vault recovery does to co-admin emergency access, and what we do
 * about it.
 *
 * THE PROBLEM, in one paragraph. A co-admin grant stores a 64-byte blob that
 * is credentials_subkey || transactions_subkey, both HKDF subkeys of the
 * OWNER's MEK, captured at grant time and never touched again. A recovery
 * mints a fresh random MEK and rewrites every connection and transaction row
 * under the new subkeys. Nothing rewrites the blob. Every existing grant is
 * therefore dead the moment a recovery completes, and it is dead SILENTLY: the
 * recipient's unwrap succeeds, two perfectly well formed AES-GCM keys are
 * imported, and only the decrypts fail.
 *
 * THE CHOICE. Two honest options existed and this file implements the second.
 *
 *   a. Re-wrap on recovery. The owner holds both sets of subkeys during the
 *      flow and every recipient's KEM public key is readable, so the blobs
 *      could be rebuilt with no human step.
 *   b. Invalidate, and tell the owner in plain words that emergency access
 *      must be granted again.
 *
 * (a) was rejected. A grant is ML-DSA signed by the owner and the consume path
 * verifies fail-closed, so re-wrapping is also re-SIGNING: a fresh, live
 * delegation of access to the owner's data, minted automatically, using
 * recipient public keys as served at that moment that nobody has looked at.
 * A swapped public key would be handed live subkeys and nothing would ask. A
 * recovery also frequently follows a lost or compromised credential, which is
 * the worst moment to re-arm every standing grant by default.
 *
 * (b) fails safe and destroys nothing of value: after the rotation those rows
 * already open nothing. Re-granting is one deliberate action by the owner and
 * restores exactly what they meant to give.
 *
 * WHEN THIS RUNS. After the rotated vault meta write is PROVEN to have landed,
 * never before. If a recovery fails part way, the stored wrappers still hold
 * the old MEK and the existing grants are still correct, so destroying them
 * would be pure damage.
 *
 * IT DOES NOT THROW. By the time it runs the recovery has already succeeded.
 * Reporting a cleanup failure as a failed recovery would tell the user
 * something false about their vault. It returns what happened instead, and the
 * caller shows it.
 */

/**
 * Structural stand-in for the supabase client, same escape hatch as
 * vault-persist.ts: the generated types do not cover these tables, and naming
 * the hatch in one place is what lets a test pass a fake client in.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CoAdminRecoveryClient = { from: (table: string) => any };

export interface InvalidateCoAdminGrantsArgs {
  supabase: CoAdminRecoveryClient;
  ownerUserId: string;
  /**
   * The owner's workspace_key_id from user_vault_meta. Null when the owner has
   * never granted co-admin access, in which case there is nothing to do: a
   * wrapped_data_keys row is keyed by this id, so without one none can exist.
   */
  workspaceKeyId: string | null;
}

export type CoAdminInvalidation =
  /** Nothing to do. Either no workspace key or no grants against it. */
  | { status: "none" }
  /** Grants existed and are gone. */
  | { status: "invalidated"; grantsInvalidated: number }
  /**
   * The cleanup did not complete. The recovery itself DID succeed, so this is
   * reported to the owner as an action to take, not as a failure of the
   * recovery.
   */
  | { status: "failed"; reason: string };

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "unknown error";
}

/**
 * Delete every co-admin grant belonging to this owner, because a recovery has
 * just made all of them undecryptable.
 *
 * Deletes wrapped_data_keys first: that is the row carrying the now-dead key
 * material, and it is the one whose continued existence makes a dead grant
 * look alive. workspace_admins follows, so the owner is not left with a list
 * of admins who hold nothing. Both deletes are what revokeCoAdmin does, which
 * is deliberate: the end state here IS a revocation, and it should look like
 * one everywhere else in the product.
 */
export async function invalidateCoAdminGrantsAfterRecovery(
  args: InvalidateCoAdminGrantsArgs,
): Promise<CoAdminInvalidation> {
  const { supabase, ownerUserId, workspaceKeyId } = args;

  if (!workspaceKeyId) return { status: "none" };

  // Count first, so the owner can be told how many people lost access rather
  // than a vague warning. A vague warning is the thing that gets ignored.
  const { data: grants, error: readErr } = await supabase
    .from("wrapped_data_keys")
    .select("recipient_user_id")
    .eq("data_key_id", workspaceKeyId);
  if (readErr) {
    return {
      status: "failed",
      reason: `could not read the existing grants: ${errorText(readErr)}`,
    };
  }

  const grantCount = (grants ?? []).length;
  if (grantCount === 0) return { status: "none" };

  const { error: wdkErr } = await supabase
    .from("wrapped_data_keys")
    .delete()
    .eq("data_key_id", workspaceKeyId);
  if (wdkErr) {
    return {
      status: "failed",
      reason: `could not remove the stale wrapped keys: ${errorText(wdkErr)}`,
    };
  }

  const { error: adminErr } = await supabase
    .from("workspace_admins")
    .delete()
    .eq("owner_user_id", ownerUserId);
  if (adminErr) {
    // The dangerous half succeeded: no dead key material is left. What remains
    // is a stale admin list, which is visible and fixable by hand, so say so
    // precisely rather than pretending nothing happened.
    return {
      status: "failed",
      reason: `the stale wrapped keys were removed but the admin list was not: ${errorText(adminErr)}`,
    };
  }

  return { status: "invalidated", grantsInvalidated: grantCount };
}

/**
 * The plain-words sentence to show the owner, or null when there is nothing
 * worth saying.
 *
 * This lives here rather than in the page so it can be tested. "The owner was
 * told" is half of the property this whole change exists to deliver, and a
 * string built inline in a component is a string no test ever reads.
 */
export function coAdminInvalidationMessage(result: CoAdminInvalidation): string | null {
  if (result.status === "none") return null;

  if (result.status === "invalidated") {
    const people =
      result.grantsInvalidated === 1 ? "1 person" : `${result.grantsInvalidated} people`;
    return `Emergency access was reset. Recovering your vault created new keys, and the old emergency access could not be carried across, so ${people} no longer have it. Grant it again from Settings if you still want them to have it.`;
  }

  return `Emergency access may still be listed but no longer works, and we could not clean it up automatically (${result.reason}). Go to Settings, remove every emergency contact, and add them again.`;
}
