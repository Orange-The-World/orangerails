/**
 * Reading a co-admin's wrapped workspace key, honestly.
 *
 * WHY THIS IS ITS OWN FILE. The read it replaces lived inline inside the
 * workspace loader in src/routes/app.tsx, where nothing could reach it without
 * mounting the page. The defect being fixed is a SILENT one, and a silent
 * defect in unreachable code is a defect nothing can ever fail on. Lifting the
 * read out is what makes it possible to write a test that goes red.
 *
 * WHAT WAS WRONG. The read was:
 *
 *   .from("wrapped_data_keys")
 *   .select("wrapped_ciphertext, grant_sig")
 *   .eq("data_key_id", ownerKeyId)
 *   .maybeSingle()
 *
 * and the caller did `if (!wdk) continue;`. maybeSingle() returns an ERROR when
 * more than one row matches, not a row, and that error was discarded. So the
 * caller read "there are two of these" as "there is none of these" and dropped
 * the workspace out of this co-admin's list with nothing shown to anybody. The
 * owner's own list still showed the co-admin as granted. Nothing errored
 * visibly on either side, which is the whole problem.
 *
 * WHY A SECOND ROW CAN EXIST AT ALL. Nothing enforces one wrapped key row per
 * recipient per workspace key. VERIFIED against the live schema on 2026-08-31:
 * the only unique index on wrapped_data_keys is its primary key on id. So a
 * repeat grant to the same person, or a retry after a grant whose key write
 * returned an error but actually landed, produces a second row. Whether that
 * should be prevented by a constraint is a separate question with its own
 * migration; this file makes the state VISIBLE rather than silent, which is
 * worth doing either way and is safe to do first.
 *
 * WHY THE READ IS NOT SCOPED BY RECIPIENT HERE, which is not an oversight:
 * wrapped_data_keys is behind row level security and a caller sees only the
 * rows addressed to it. The read this replaces carried no recipient filter
 * either, so adding one here would change what is being compared.
 */

/**
 * Structural stand-in for the supabase client, so a test can pass a fake in.
 * The route already reaches this table through `as any` because the generated
 * database types do not cover it; keeping that escape hatch in one named place
 * is what makes the read testable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WrappedKeyClient = { from: (table: string) => any };

export interface WrappedDataKeyRow {
  wrapped_ciphertext: string;
  grant_sig: string | null;
}

/**
 * The four things this read can honestly say. "none" and "ambiguous" are
 * deliberately different answers: collapsing them into one is the defect.
 */
export type WrappedDataKeyRead =
  | { status: "ok"; row: WrappedDataKeyRow }
  | { status: "none" }
  | { status: "ambiguous" }
  | { status: "error"; error: unknown };

/**
 * Shown when a co-admin holds more than one wrapped key for the same workspace.
 *
 * It is deliberately not an apology and not a dead end: it names the state and
 * gives the one action that resolves it. Wording note, and it matters: it does
 * not promise that granting again is harmless, because a repeat grant is how
 * the second row appears in the first place.
 */
export const DUPLICATE_WRAPPED_KEY_MESSAGE =
  "A workspace shared with you could not be opened: more than one key grant is on record for it, " +
  "and opening one of them without knowing which is correct is not safe. Ask the owner to remove " +
  "your access and grant it again, and contact support if it comes back.";

/**
 * Read the wrapped workspace key this user holds for `dataKeyId`.
 *
 * WHY limit(2) AND NOT maybeSingle(). Two rows is a real and different state
 * from zero rows, and maybeSingle() throws that difference away by turning it
 * into an error the caller has to remember to inspect. Asking for at most two
 * costs one row more than the happy path and makes "exactly one" and "more than
 * one" both first class answers that a caller cannot accidentally conflate.
 *
 * WHY "ambiguous" DOES NOT JUST TAKE THE FIRST ROW. Both rows carry a signature
 * binding the grant to this recipient and this key id, so both may verify, and
 * nothing here can tell which one the owner meant. Quietly choosing one on a
 * self custody path is the same class of silent guess as the defect being
 * fixed. Fail closed and say so out loud.
 */
export async function readWrappedDataKey(
  supabase: WrappedKeyClient,
  dataKeyId: string,
): Promise<WrappedDataKeyRead> {
  const { data, error } = await supabase
    .from("wrapped_data_keys")
    .select("wrapped_ciphertext, grant_sig")
    .eq("data_key_id", dataKeyId)
    .limit(2);
  // An error is returned rather than thrown so the caller can carry on with the
  // other workspaces. What it must not do is discard it, which is what the
  // inline read did.
  if (error) return { status: "error", error };
  const rows = (data ?? []) as WrappedDataKeyRow[];
  if (rows.length === 0) return { status: "none" };
  if (rows.length > 1) return { status: "ambiguous" };
  return { status: "ok", row: rows[0] };
}
