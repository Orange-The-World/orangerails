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
 * So the reset clears both, and the order it clears them in is load bearing.
 * Coverage rows for a connection live in stealth_scan_ranges, keyed by
 * connection_id, written only by record_stealth_scan_range().
 *
 * ORDER MATTERS, AND IT FOLLOWS FROM AN INVARIANT RATHER THAN A PREFERENCE:
 * a lost cursor can never cause a skip, a lost coverage row can. So the reset
 * is three writes, cursor first, coverage second, envelope last, and every way
 * it can stop partway through still starts the next sync at or before the
 * first block nobody has read.
 *
 *   fails at step 1   nothing changed at all: old cursor, old coverage, old
 *                     envelope. The retry is the whole reset again.
 *   stops after 1     cursor null, coverage intact, old envelope. The coverage
 *                     arm answers, and it can only return the birthday or a
 *                     to_height that was genuinely scanned, so it cannot skip.
 *   stops after 2     cursor null, no coverage, old envelope. Neither arm can
 *                     point past the birthday, so the start height is the old
 *                     birthday: a rescan nobody needed, slow and correct.
 *
 * Both other orders have a partial outcome that skips blocks, which is why
 * this one is pinned by a test rather than left to a reader's judgement.
 * Deleting the coverage while the original cursor still stands is the
 * dangerous one: the coverage arm goes silent, the cursor arm answers
 * lastBlockScanned + 1, and any block below that cursor which no range covered
 * becomes invisible to every future sync, permanently, with no error and
 * nothing the user can see. Storing the envelope before the coverage is
 * cleared is the original defect this module exists to remove: a new envelope
 * behind stale coverage, and no rescan. See OR-T1256.
 *
 * EVERY FAILURE IS REPORTED. A half applied reset that answers 200 tells the
 * user their wallet is being rescanned when it is not, and that silence is
 * what made the original defect expensive to find. A caller that gets an error
 * can retry the re-add, and the retry is idempotent: the delete of an already
 * empty range set is a no-op, and the updates write the same values again.
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
  /**
   * `undefined` (the request body omitted this key) leaves the stored
   * birthday untouched, so a caller that resends the envelope without
   * resending the birthday cannot silently null out a value it never
   * meant to touch. `null` (the request body included the key with an
   * explicit null, as the widget always does under ZKA) still clears
   * it, unchanged from before this distinction existed. A string still
   * replaces it. See OR-T1242 for why "absent" and "explicit null" must
   * not be collapsed into the same case here.
   */
  wallet_birthday_plaintext: string | null | undefined;
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
  // 1. The cursor first. See ORDER MATTERS above: this is the write whose
  //    loss cannot cause a skip, so it is the one that goes first. On its own
  //    it no longer decides where a scan starts, but it is still the arm that
  //    answers for a connection with no coverage at all, so leaving it
  //    standing after step 2 is what would hide an unscanned gap forever.
  const { error: cursorErr } = await client
    .from('stealth_connections')
    .update({ last_block_scanned: null })
    .eq('id', connectionId);

  if (cursorErr) {
    console.error('[applyEnvelopeReplacement] cursor clear failed:', cursorErr);
    return {
      ok: false,
      error: 'Failed to clear the scan cursor for the replaced envelope',
      status: 500,
    };
  }

  // 2. The coverage rows.
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

  // 3. The envelope itself, last, so it can never be stored behind coverage
  //    that would block the rescan it promises. last_block_scanned is not in
  //    this patch: step 1 already nulled it, and re-sending it here would put
  //    the write that matters back into the one that is allowed to fail.
  //
  //    wallet_birthday_plaintext is included in the patch only when the
  //    caller actually named a value (a string, or an explicit null). When
  //    it is undefined, the key is left out of the patch entirely rather
  //    than sent as null, so the column keeps whatever it already held. See
  //    the field comment on EnvelopeReplacementFields (OR-T1242) for why
  //    that distinction matters.
  const patch: Record<string, unknown> = {
    sealed_envelope: fields.sealed_envelope,
    updated_at: new Date().toISOString(),
  };
  if (fields.wallet_birthday_plaintext !== undefined) {
    patch.wallet_birthday_plaintext = fields.wallet_birthday_plaintext;
  }

  const { error: updateErr } = await client
    .from('stealth_connections')
    .update(patch)
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
