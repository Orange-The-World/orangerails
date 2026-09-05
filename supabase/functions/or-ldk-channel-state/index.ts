/**
 * Orange Rails, LDK connector — channel-state edge function.
 *
 * SCAFFOLD, pre-audit. Mirrors the `or-stealth-*` functions: it stores a
 * SealedEnvelope + a blind index and NOTHING ELSE. There is deliberately no
 * decrypt path, no key derivation, and no signer here (gate criteria b/c).
 *
 * The whole point of this function is the atomic compare-and-set below. The
 * regression check is a DB-level conditional write, NOT read-check-write in
 * application code — two concurrent restores cannot both pass (Sr. Developer
 * msg 916, Auditor msg 920).
 */

// VERBATIM persistence spec (Developer msg 921 / DESIGN.md §3.2), corrected
// to match the live channel_state schema (OR-T1721): composite conflict
// target on (user_id, outpoint_bidx), the three-column sealed envelope
// (seal_version, sealed_iv, sealed_ct) the table actually has, and user_id
// bound from the verified caller JWT, never from the request body.
// The `WHERE ... < EXCLUDED.update_id` lives INSIDE the ON CONFLICT, so the
// compare-and-set is one atomic op with the row lock held for the whole upsert.
export const UPSERT_CHANNEL_STATE_SQL = `
INSERT INTO channel_state (user_id, outpoint_bidx, update_id, seal_version, sealed_iv, sealed_ct)
VALUES (:user_id, :bidx, :new_id, :seal_version, :sealed_iv, :sealed_ct)
ON CONFLICT (user_id, outpoint_bidx) DO UPDATE
  SET update_id = EXCLUDED.update_id,
      seal_version = EXCLUDED.seal_version,
      sealed_iv = EXCLUDED.sealed_iv,
      sealed_ct = EXCLUDED.sealed_ct
  WHERE channel_state.update_id < EXCLUDED.update_id
RETURNING update_id;
`;

/**
 * Outcome mapping (Developer msg 921):
 *   row returned                 -> 200 ACCEPTED       (new latest)
 *   no row + stored == :new_id   -> 200 IDEMPOTENT_OK  (persist-before-ack retry, never wedges)
 *   no row + stored >  :new_id   -> 409 REJECTED_STALE (rollback/restore race)
 *
 * When RETURNING is empty, a single classification read of the stored
 * update_id distinguishes IDEMPOTENT_OK from REJECTED_STALE. That read is
 * classification only — the write outcome is already decided — NOT a second
 * write gate (Auditor msg 924).
 *
 * TODO(impl): bind the request (bidx, new_id, sealed_blob) and run
 * UPSERT_CHANNEL_STATE_SQL inside a single statement, then map per above.
 * Persist-before-ack is enforced client-side: the client acks to LDK only
 * after this endpoint confirms durability.
 */
export function handler(_req: Request): Response {
  return new Response(
    JSON.stringify({ error: 'or-ldk-channel-state: scaffold only, pending (a)-(e) audit gate.' }),
    { status: 501, headers: { 'content-type': 'application/json' } },
  );
}
