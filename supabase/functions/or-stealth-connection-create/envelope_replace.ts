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
 * ORDER MATTERS AND IS DELIBERATE. A lost cursor cannot cause a skip; a lost
 * coverage row can. The cursor is therefore cleared first, then the coverage,
 * and only then is the new envelope stored. If the coverage delete fails, its
 * rows still describe blocks genuinely scanned and the cleared cursor cannot
 * move the connection past them. If the envelope write fails after coverage
 * is gone, the cleared cursor makes the old envelope resume from its old
 * birthday. Neither half-applied state can hide an unscanned gap.
 *
 * EVERY FAILURE IS REPORTED. A half applied reset that answers 200 tells the
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
  // 1. Clear the cursor before coverage. See ORDER MATTERS above.
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

  // 2. Clear coverage only after the legacy cursor can no longer skip ahead.
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

  // 3. Store the replacement only after both sources that could skip blocks
  //    have been cleared.
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
