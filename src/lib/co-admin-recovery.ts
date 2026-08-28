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
 *
 * WHAT THE OWNER CAN AND CANNOT SEE, because it decides the shape of the code
 * below. public.wrapped_data_keys has exactly one select policy and it is
 * recipient scoped, recipient_user_id = auth.uid(). An owner is not a
 * recipient of their own grants, so an owner reading that table gets zero rows
 * and NO error. Its delete policy is owner scoped, so the owner can remove the
 * rows they cannot read. public.workspace_admins is readable and deletable by
 * the owner. So: the count and the gate come from workspace_admins and from
 * what the deletes give back, never from a select on wrapped_data_keys. An
 * earlier version of this file gated the whole cleanup on that select, which
 * made it do nothing at all while looking like it had found nothing to do.
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
  /**
   * Nothing to do. Either the owner has no workspace key, or nobody is listed
   * as holding emergency access.
   */
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
 *
 * Every step is proven rather than assumed. Both deletes return the rows they
 * removed, and a delete that removed nothing is reported as a failure with the
 * sentence that tells the owner what to do by hand.
 *
 * KNOWN LIMIT, stated rather than hidden: a wrapped_data_keys row whose
 * matching workspace_admins row does not exist, which a grant interrupted
 * between its two inserts would leave, is not seen by the gate below and is
 * left in place. It is inert after the rotation, because the subkeys inside it
 * open nothing.
 */
export async function invalidateCoAdminGrantsAfterRecovery(
  args: InvalidateCoAdminGrantsArgs,
): Promise<CoAdminInvalidation> {
  const { supabase, ownerUserId, workspaceKeyId } = args;

  if (!workspaceKeyId) return { status: "none" };

  // Who currently holds emergency access. This read is on workspace_admins and
  // deliberately NOT on wrapped_data_keys: see the note at the top of the file
  // about which of the two the owner is allowed to read. A read that always
  // returns nothing is not a gate, it is an off switch.
  const { data: admins, error: adminReadErr } = await supabase
    .from("workspace_admins")
    .select("admin_user_id")
    .eq("owner_user_id", ownerUserId);
  if (adminReadErr) {
    return {
      status: "failed",
      reason: `could not read the emergency access list: ${errorText(adminReadErr)}`,
    };
  }

  const listedAdmins = (admins ?? []).length;
  if (listedAdmins === 0) return { status: "none" };

  // Delete under the owner scoped delete policy, and ask for the removed rows
  // back so the count is what the database actually did rather than what a
  // read suggested it would do.
  const { data: removedGrants, error: wdkErr } = await supabase
    .from("wrapped_data_keys")
    .delete()
    .eq("data_key_id", workspaceKeyId)
    .select("recipient_user_id");
  if (wdkErr) {
    return {
      status: "failed",
      reason: `could not remove the stale wrapped keys: ${errorText(wdkErr)}`,
    };
  }

  // A delete that matched no row returns no error, so this is the only place
  // the difference between "removed them" and "removed nothing" exists. People
  // are listed as holding emergency access and the key material behind it is
  // still there, so this is a failure, not nothing to do.
  //
  // The admin list is left alone on this branch on purpose. It is the only
  // record of who has to be removed by hand, and the message below asks the
  // owner to do exactly that.
  const grantsRemoved = (removedGrants ?? []).length;
  if (grantsRemoved === 0) {
    const who = listedAdmins === 1 ? "1 person is" : `${listedAdmins} people are`;
    return {
      status: "failed",
      reason: `${who} still listed as having emergency access and the keys behind it were not removed`,
    };
  }

  const { data: removedAdmins, error: adminErr } = await supabase
    .from("workspace_admins")
    .delete()
    .eq("owner_user_id", ownerUserId)
    .select("admin_user_id");
  if (adminErr) {
    // The dangerous half succeeded: no dead key material is left. What remains
    // is a stale admin list, which is visible and fixable by hand, so say so
    // precisely rather than pretending nothing happened.
    return {
      status: "failed",
      reason: `the stale wrapped keys were removed but the admin list was not: ${errorText(adminErr)}`,
    };
  }

  if ((removedAdmins ?? []).length === 0) {
    // Same standard as the delete above: no error is not proof of a delete.
    return {
      status: "failed",
      reason:
        "the stale wrapped keys were removed but the admin list was not: the delete removed no rows",
    };
  }

  return { status: "invalidated", grantsInvalidated: grantsRemoved };
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
