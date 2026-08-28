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
 *
 * WHY THE NAMES ARE RESOLVED BEFORE ANYTHING IS DELETED. The owner is asked to
 * grant emergency access again, so they have to be told WHO lost it, and this
 * function is what destroys the only record of that. Names come from the
 * get_coadmin_emails RPC, which the co-admin list in Settings already uses.
 * That function returns a row only while a workspace_admins row still links the
 * caller to that user: read its body, the WHERE clause requires one. Calling it
 * after the cleanup therefore returns an empty set with no error, which is the
 * same shape of mistake as the select above. So the resolve happens while the
 * list still exists, and the map it produces is used afterwards.
 */

/**
 * Structural stand-in for the supabase client, same escape hatch as
 * vault-persist.ts: the generated types do not cover these tables, and naming
 * the hatch in one place is what lets a test pass a fake client in.
 *
 * rpc is OPTIONAL on purpose. It is used only to turn user ids into something
 * a person recognises, and a cleanup that removes dead key material must not
 * depend on being able to pretty-print a name.
 */
export type CoAdminRecoveryClient = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any;
  rpc?: (
    fn: string,
    args: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

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
  /**
   * Grants existed and are gone. `people` names who lost access, in the same
   * form the co-admin list in Settings shows them.
   */
  | { status: "invalidated"; grantsInvalidated: number; people: string[] }
  /**
   * The cleanup did not complete. The recovery itself DID succeed, so this is
   * reported to the owner as an action to take, not as a failure of the
   * recovery. `people` is who is affected, and is empty when we could not find
   * out, which is itself information: an empty list means do not trust a name.
   */
  | { status: "failed"; reason: string; people: string[] };

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : "unknown error";
}

/**
 * How this product names a co-admin when it has no email for them: the first
 * eight characters of their id. This is not invented here. It is exactly what
 * the co-admin list in Settings renders, so the two surfaces agree.
 */
export function shortUserId(userId: string): string {
  return `${userId.slice(0, 8)}…`;
}

/**
 * Best-effort user id to email. Never throws, never blocks the cleanup.
 *
 * MUST be called before the deletes: see the note at the top of the file about
 * what get_coadmin_emails requires to return a row.
 */
async function resolveCoAdminNames(
  supabase: CoAdminRecoveryClient,
  userIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (userIds.length === 0 || typeof supabase.rpc !== "function") return names;

  try {
    const { data, error } = await supabase.rpc("get_coadmin_emails", {
      user_ids: userIds,
    });
    if (error) return names;
    for (const row of (data ?? []) as { user_id?: unknown; email?: unknown }[]) {
      const id = row?.user_id;
      const email = row?.email;
      if (typeof id === "string" && typeof email === "string" && email.length > 0) {
        names.set(id, email);
      }
    }
  } catch {
    // A name is a nicety. Losing it must not stop dead key material being
    // removed, so this swallows deliberately rather than propagating.
    return names;
  }

  return names;
}

function nameFor(userId: string, names: Map<string, string>): string {
  return names.get(userId) ?? shortUserId(userId);
}

/** "a", "a and b", "a, b and c". */
function joinNames(people: string[]): string {
  if (people.length === 0) return "";
  if (people.length === 1) return people[0];
  return `${people.slice(0, -1).join(", ")} and ${people[people.length - 1]}`;
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
 * open nothing. Such a row also has no name to resolve, for the same reason,
 * so if the delete does return one it is named by its short id.
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
      people: [],
    };
  }

  const listedIds = (admins ?? [])
    .map((row) => (row as { admin_user_id?: unknown }).admin_user_id)
    .filter((id): id is string => typeof id === "string");
  if (listedIds.length === 0) return { status: "none" };

  // Names first, while the rows that make the lookup possible still exist.
  const names = await resolveCoAdminNames(supabase, listedIds);

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
      people: listedIds.map((id) => nameFor(id, names)),
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
  const removedIds = (removedGrants ?? [])
    .map((row) => (row as { recipient_user_id?: unknown }).recipient_user_id)
    .filter((id): id is string => typeof id === "string");
  if (removedIds.length === 0) {
    const who = listedIds.length === 1 ? "1 person is" : `${listedIds.length} people are`;
    return {
      status: "failed",
      reason: `${who} still listed as having emergency access and the keys behind it were not removed`,
      people: listedIds.map((id) => nameFor(id, names)),
    };
  }

  const affected = removedIds.map((id) => nameFor(id, names));

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
      people: affected,
    };
  }

  if ((removedAdmins ?? []).length === 0) {
    // Same standard as the delete above: no error is not proof of a delete.
    return {
      status: "failed",
      reason:
        "the stale wrapped keys were removed but the admin list was not: the delete removed no rows",
      people: affected,
    };
  }

  return { status: "invalidated", grantsInvalidated: removedIds.length, people: affected };
}

/**
 * The plain-words sentence to show the owner, or null when there is nothing
 * worth saying.
 *
 * This lives here rather than in the page so it can be tested. "The owner was
 * told" is half of the property this whole change exists to deliver, and a
 * string built inline in a component is a string no test ever reads.
 *
 * It names people wherever it can. The owner is being asked to grant emergency
 * access again to a list this code has just deleted, and a bare count leaves
 * them guessing at who. The count wording is kept as the fallback for the one
 * case where no name survived, because "2 people" is still better than nothing.
 */
export function coAdminInvalidationMessage(result: CoAdminInvalidation): string | null {
  if (result.status === "none") return null;

  if (result.status === "invalidated") {
    if (result.people.length > 0) {
      const verb = result.people.length === 1 ? "no longer has" : "no longer have";
      return `Emergency access was reset. Recovering your vault created new keys, and the old emergency access could not be carried across, so ${joinNames(result.people)} ${verb} it. Grant it again from Settings if you still want them to have it.`;
    }
    const people =
      result.grantsInvalidated === 1 ? "1 person" : `${result.grantsInvalidated} people`;
    return `Emergency access was reset. Recovering your vault created new keys, and the old emergency access could not be carried across, so ${people} no longer have it. Grant it again from Settings if you still want them to have it.`;
  }

  const affected =
    result.people.length > 0 ? ` This affects ${joinNames(result.people)}.` : "";
  return `Emergency access may still be listed but no longer works, and we could not clean it up automatically (${result.reason}).${affected} Go to Settings, remove every emergency contact, and add them again.`;
}
