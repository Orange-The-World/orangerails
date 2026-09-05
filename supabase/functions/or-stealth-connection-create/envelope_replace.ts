/**
 * applyEnvelopeReplacement , the write that makes the documented rescan real.
 *
 * Replacing the sealed envelope is the only full rescan a user can trigger for
 * themselves: re-adding the wallet, or changing the wallet birthday, which is
 * itself an envelope replacement. Everything else needs a production write by
 * hand. The rule the product states, and the invariant this module exists to
 * hold, is one line:
 *
 *   after an envelope replacement, the next sync starts at the wallet birthday.
 *
 * Clearing last_block_scanned used to be enough to hold it, because the start
 * height was max(birthdayHeight, last_block_scanned + 1). It is not enough any
 * more. The start height is scanStartHeight() in src/stealth/lib/ranges.ts and
 * it consults the coverage map first: whenever a recorded range covers the
 * birthday, the cursor arm is never evaluated at all. A connection with
 * coverage therefore kept every block it had already read, so clearing the
 * cursor changed a stored number and changed nothing the user could see. No
 * rescan, no error, no way out.
 *
 * So the reset clears both. Coverage rows for a connection live in
 * stealth_scan_ranges, keyed by connection_id, written only by
 * record_stealth_scan_range().
 *
 * ORDER MATTERS, AND THE INVARIANT IS WHAT TO HOLD ONTO, NOT THE ORDERING:
 * a lost (null) cursor can never cause a skip, a lost coverage row can. So
 * the cursor is cleared first, coverage second, and the new envelope last.
 *
 * scanStartHeight() in src/stealth/lib/ranges.ts consults the coverage map
 * before it ever looks at the cursor: whenever a recorded range covers the
 * birthday, the cursor arm is never evaluated. An intact coverage row is
 * therefore always safe to leave behind no matter what the cursor says, and
 * a null cursor is always safe to leave behind no matter what coverage says.
 * The one state that is NOT safe is a stale, non-null cursor sitting past
 * the birthday with the coverage that justified it gone: that reads as
 * "already scanned to here" with nothing left to contradict it, and the scan
 * silently skips the gap forever.
 *
 * So for each point this function can fail at:
 *   - fails clearing the cursor: nothing else has changed yet.
 *   - fails clearing coverage: the cursor is already null, and the OLD
 *     coverage is still intact and still correct for the OLD envelope, so
 *     the next sync resumes off it exactly as it always would. No skip.
 *   - fails writing the new envelope: cursor null, coverage gone, old
 *     envelope in place, so the next sync falls through to the cursor arm
 *     and rescans from the OLD birthday. Slower than necessary, still
 *     correct.
 *
 * BOTH FAILURES ARE REPORTED. A half applied reset that answers 200 tells the
 * user their wallet is being rescanned when it is not, and that silence is
 * what made the original defect expensive to find. A caller that gets an error
 * can retry the re-add, and the retry is idempotent: the delete of an already
 * empty range set is a no-op, and the update writes the same values again.
 *
 * SCOPING. stealth_scan_ranges rows carry only connection_id and cascade on
 * delete from stealth_connections, so deleting by the connection id the caller
 * already resolved (scoped by platform_id, app_user_id, app_slug and blind
 * index) can reach no other user's rows. The table has no INSERT, UPDATE or
 * DELETE policy: only the service role, which bypasses row level security, can
 * write it, and that is the client this function is handed.
 *
 * COST OF A RESET NOBODY NEEDED. A user whose coverage is legitimately
 * complete, re-adding by accident, gets a full rescan from the wallet
 * birthday. That is a slow sync, not an error and not duplicate data:
 * stealth_transactions carries UNIQUE (connection_id, txid_blind_index_hex)
 * and the store endpoint upserts with ignoreDuplicates, so re-reading a block
 * that was already read produces nothing new. Slow and correct is the intended
 * cost of a recovery lever that actually works.
 */

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

/** The fields an envelope replacement writes onto the connection row. */
export interface EnvelopeReplacementFields {
  sealed_envelope: unknown;
  wallet_birthday_plaintext: string | null;
}

export type EnvelopeReplacementResult =
  | { ok: true }
  | { ok: false; error: string; status: number };

export function isEnvelopeReplacementError(
  r: EnvelopeReplacementResult,
): r is { ok: false; error: string; status: number } {
  return r.ok === false;
}

export async function applyEnvelopeReplacement(
  client: SupabaseClient,
  connectionId: string,
  fields: EnvelopeReplacementFields,
): Promise<EnvelopeReplacementResult> {
  // 1. Clear the cursor first. See the invariant in the module comment: a
  //    lost (null) cursor can never cause a skip.
  const { error: cursorErr } = await client
    .from('stealth_connections')
    .update({
      last_block_scanned: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connectionId);

  if (cursorErr) {
    console.error('[applyEnvelopeReplacement] cursor clear failed:', cursorErr);
    return {
      ok: false,
      error: 'Failed to clear the scan cursor for the replaced envelope',
      status: 500,
    };
  }

  // 2. Coverage rows. The cursor is already null, so if this fails the
  //    connection is left with intact, correct-for-the-OLD-envelope coverage
  //    and no cursor: safe, see the module comment.
  const { error: coverageErr } = await client
    .from('stealth_scan_ranges')
    .delete()
    .eq('connection_id', connectionId);

  if (coverageErr) {
    console.error('[applyEnvelopeReplacement] coverage clear failed:', coverageErr);
    return {
      ok: false,
      error: 'Failed to clear scan coverage for the replaced envelope',
      status: 500,
    };
  }

  // 3. The new envelope and birthday, last, once both arms already agree
  //    this connection has read nothing since the birthday.
  const { error: updateErr } = await client
    .from('stealth_connections')
    .update({
      sealed_envelope: fields.sealed_envelope,
      wallet_birthday_plaintext: fields.wallet_birthday_plaintext,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connectionId);

  if (updateErr) {
    console.error('[applyEnvelopeReplacement] envelope update failed:', updateErr);
    return {
      ok: false,
      error: 'Failed to store the replaced envelope',
      status: 500,
    };
  }

  return { ok: true };
}
