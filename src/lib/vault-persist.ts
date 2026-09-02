/**
 * The database half of vault recovery and of a vault password change.
 *
 * WHY THIS FILE EXISTS. src/lib/vault.ts is the crypto and it is well covered
 * by unit tests. The code that PERSISTS what the crypto returns had no test at
 * all, because it lived inline inside two route components and nothing could
 * reach it without mounting a page. Every irreversible key-loss defect found on
 * this path so far has been in that second category: the ordering and the
 * result handling around the user_vault_meta write, never in the wrapping and
 * unwrapping. A green unit suite therefore said nothing at all about the part
 * that actually broke.
 *
 * These are plain async functions with every dependency passed in, so a test
 * can drive them with a fake supabase client and pin the property that matters
 * here: nothing irreversible happens until the write is PROVEN to have landed.
 * Lifting them out of the components changed no behaviour.
 */

/**
 * Structural stand-in for the supabase client.
 *
 * The route components already reach these tables through `as any`, because the
 * generated database types do not cover them. Keeping that escape hatch in one
 * named place is what lets a test pass a fake client in.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VaultPersistClient = { from: (table: string) => any };

/**
 * Shown when the rotated vault meta write did not land. By the time this can
 * happen every ciphertext the user owns is already under the new MEK, and the
 * only copies of that MEK are in the write that just failed. That is why the
 * message tells the user not to close the page rather than to try again.
 */
export const RECOVERY_META_NOT_SAVED_MESSAGE =
  "Vault recovery did not save. Your data has been re-encrypted but the new keys were not stored. Do not close or reload this page, and contact support with this message.";

/** Shown when the compare-and-swap on a password change matched no row. */
export const PASSWORD_CHANGE_CONFLICT_MESSAGE =
  "Vault was changed from another session. Reload the page and try again.";

/**
 * Shown when the number of rows this run re-encrypted does not match the number
 * of rows the table actually holds. It names both numbers on purpose: a run
 * that reconciled nothing must not read the same as a run that reconciled
 * cleanly, and support cannot act on a bare "recovery failed".
 *
 * WHY IT NO LONGER STOPS AT "your stored keys were not changed by this step".
 * That sentence is true and it was dangerously incomplete. At the moment this
 * fires, every row the run already rewrote is under the NEW MEK while the
 * stored wrappers still point at the OLD one, and the only copy of the new MEK
 * is in this page. Read as "nothing happened, safe to start over" it is exactly
 * backwards: starting over mints another fresh MEK and cannot read those rows.
 * RECOVERY_META_NOT_SAVED_MESSAGE already described this state honestly and the
 * three messages here now agree with it.
 */
export function rowCountMismatchMessage(table: string, migrated: number, total: number): string {
  return (
    `Vault recovery stopped before saving: migrated ${migrated} of ${total} ${table} rows. ` +
    "Your stored keys are unchanged, but any rows this run already re-encrypted are now under " +
    "a new key that has not been saved anywhere. Do not close or reload this page, and contact " +
    "support with this message."
  );
}

/**
 * Shown when the row count could not be read at all. A missing count is a
 * failure and not a pass: reading "I could not check" as "everything is fine"
 * is the exact shape of the defect this reconciliation exists to catch.
 */
export function rowCountUnreadableMessage(table: string): string {
  return (
    `Vault recovery stopped before saving: could not count the ${table} rows after several ` +
    "attempts, so there is no way to tell whether every row was re-encrypted. Your stored keys " +
    "are unchanged, but any rows this run already re-encrypted are now under a new key that has " +
    "not been saved anywhere. Do not close or reload this page, and contact support with this " +
    "message."
  );
}

/**
 * Shown when a row update returned no error and no row.
 *
 * An update that matches nothing is a SUCCESS: no error is raised on any path.
 * So the rows the update hands back are the only proof the re-encrypted
 * ciphertext was actually written. A write that is refused at the row layer
 * looks exactly like a write that changed a row, apart from those rows.
 */
export function rowNotWrittenMessage(table: string, rowId: string): string {
  return (
    `Vault recovery stopped before saving: the ${table} row ${rowId} was not written when it was ` +
    "re-encrypted, so it is still under the old key. Your stored keys are unchanged, but any " +
    "rows this run already re-encrypted are now under a new key that has not been saved " +
    "anywhere. Do not close or reload this page, and contact support with this message."
  );
}

/** Transactions are re-encrypted in pages of this size. */
export const TRANSACTION_PAGE_SIZE = 500;

/** Connections are re-encrypted in pages of this size. */
export const CONNECTION_PAGE_SIZE = 500;

/**
 * How many times the reconciliation reads a row count before it gives up.
 *
 * WHY THIS IS NOT ONE. The count read happens after every ciphertext has been
 * rewritten and before the meta write, which is the worst instant in the whole
 * function: the only copy of the new MEK is in this page. Throwing on the first
 * 502, dropped connection or rate limit would turn a transient network error
 * into permanent key loss for a user who then reloads, and before this guard
 * existed that recovery would simply have completed. The read is pure and
 * idempotent, so retrying it costs nothing and closes that window.
 *
 * A MISMATCH IS NOT RETRIED. A count that was read successfully and disagrees
 * is a decision, not a flake. Only a failed or unreadable count comes back here.
 *
 * WHY THE BUDGET IS TENS OF SECONDS, NOT UNDER ONE (OR-T1342). The original
 * budget here summed to about three quarters of a second (3 attempts, a
 * 250ms base, linear backoff), which a single 429 with a multi-second
 * Retry-After, or a gateway restart, exhausts outright. The alternative to
 * waiting is a lost vault on a page the user has already been told not to
 * close, so tens of seconds of waiting costs nothing anyone will notice.
 * COUNT_READ_ATTEMPTS and COUNT_READ_RETRY_MS together sum to at least 30
 * seconds of backoff. A test sums them from the constants themselves rather
 * than a hardcoded number, so this comment cannot drift out of date with the
 * values below it.
 */
export const COUNT_READ_ATTEMPTS = 6;

/**
 * Base delay between count read attempts, in milliseconds. Backs off linearly
 * (attempt * COUNT_READ_RETRY_MS), so 6 attempts sum to 33 seconds of waiting
 * before giving up: 2200 * (1+2+3+4+5) = 33000ms.
 */
export const COUNT_READ_RETRY_MS = 2200;

/** Waits between count read attempts. */
export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The longest a single Retry-After style hint is allowed to stretch one wait,
 * regardless of what an error object claims. Without a ceiling a hostile or
 * malformed value could stall the whole recovery indefinitely; this keeps a
 * bad hint no worse than a few extra rounds of the plain backoff.
 */
const MAX_HONOURED_RETRY_AFTER_MS = 20000;

/**
 * Read an optional retry-after hint off a count-read error, in milliseconds.
 *
 * WHY THIS EXISTS BUT DOES LITTLE TODAY. VaultPersistClient is a narrow,
 * structural stand-in for the supabase client (see the type above) and it
 * does not carry HTTP response headers, so there is no live Retry-After for
 * this function to read off the wire right now. This is the extension point
 * for the day something upstream does surface it, a supabase error wrapper or
 * a fetch interceptor, so the retry loop already knows what to do with it
 * rather than only ever falling back to the fixed backoff. Bounded below by
 * the base backoff and above by MAX_HONOURED_RETRY_AFTER_MS, so neither a
 * missing value nor a bad one can produce a worse wait than the plain
 * schedule already gives.
 */
function retryAfterMsFromError(error: unknown, attempt: number): number {
  const fallback = COUNT_READ_RETRY_MS * attempt;
  if (error && typeof error === "object" && "retryAfterMs" in error) {
    const hint = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof hint === "number" && Number.isFinite(hint) && hint > 0) {
      return Math.min(Math.max(hint, COUNT_READ_RETRY_MS), MAX_HONOURED_RETRY_AFTER_MS);
    }
  }
  return fallback;
}

export interface RotateVaultArgs {
  supabase: VaultPersistClient;
  userId: string;
  /**
   * recovery_ciphertext as read at the start of this submit. It is the
   * compare-and-swap guard: if another session rotated in the meantime the
   * update matches no row and this fails loudly instead of overwriting.
   */
  priorRecoveryCiphertext: string;
  newEncMekCiphertext: string;
  newRecoveryCiphertext: string;
  newVerifierCiphertext: string;
  vaultKeyVersion: number;
  migrateCredentialsCiphertext: (ciphertext: string) => Promise<string>;
  migrateTransactionCiphertext: (ciphertext: string) => Promise<string>;
  clearMigrationKeys: () => void;
  /**
   * Optional. Waits between retries of the row count read. Defaults to a real
   * timer; a test passes a no-op so the suite does not sit through the backoff.
   */
  sleep?: SleepFn;
}

/**
 * Re-encrypt every ciphertext this user owns under the new MEK, then persist
 * the rotated vault meta, then zero the old key material.
 *
 * Throws if anything fails. The caller must not treat the recovery as done
 * unless this resolves.
 */
export async function migrateAndPersistRotatedVault(args: RotateVaultArgs): Promise<void> {
  const {
    supabase,
    userId,
    priorRecoveryCiphertext,
    newEncMekCiphertext,
    newRecoveryCiphertext,
    newVerifierCiphertext,
    vaultKeyVersion,
    migrateCredentialsCiphertext,
    migrateTransactionCiphertext,
    clearMigrationKeys,
    sleep = realSleep,
  } = args;

  // Re-encrypt connections first, then transactions, then meta.
  // Meta is written last so a partial failure leaves the STORED wrappers still
  // pointing at the old MEK: the user can still unlock, and every row that has
  // not moved yet still reads. That is the only property this ordering buys.
  // It does NOT make a retry safe. See the note on the meta write below before
  // relying on it.
  // credentials subkey changes with the MEK.
  //
  // WHY THIS READ IS PAGED. It used to be a single unpaged select. PostgREST
  // caps a select at a server-side maximum row count, and a capped read is a
  // SUCCESSFUL read: no error is raised on any path. A user holding more
  // connection rows than that cap therefore had every row past it left wrapped
  // under the OLD MEK while the meta write at the bottom of this function still
  // landed. Nothing in that sequence reports a problem, and because
  // recoverWithCode() mints a fresh MEK on every call, the key those rows are
  // still wrapped under is gone. Silent and permanent.
  //
  // WHY THE ORDER CLAUSE IS LOAD BEARING. Postgres guarantees no row order
  // without ORDER BY, and the update inside this loop writes a new tuple
  // version, which can change the order a later scan returns. Without it a row
  // can be skipped between pages, which strands it exactly as above, or
  // returned twice, in which case migrateCredentialsCiphertext is handed
  // ciphertext that is already under the new MEK, throws, and aborts the
  // rotation partway with no safe retry.
  //
  // Residual, stated rather than hidden: offset paging over a stable order is
  // still not immune to another session INSERTing or DELETing a row while this
  // loop runs, which shifts the window. Keyset pagination on id would close
  // that too. It is deliberately out of scope here and is not a regression.
  // Both of those residuals are now caught by the reconciliation below rather
  // than only described here.
  //
  // Counted only when the update hands back the row it changed. The absence of
  // an error is NOT proof that a row moved: an update matching nothing, or one
  // filtered out at the row layer, returns no error and no rows. Counting
  // attempts instead would let a run that rewrote nothing reconcile as clean
  // against the row count below, which is the one thing that check exists to
  // make impossible.
  let connectionsMigrated = 0;
  let connOffset = 0;
  for (;;) {
    const { data: conns, error: connsErr } = await supabase
      .from("connections")
      .select("id, encrypted_credentials, encrypted_label")
      .order("id", { ascending: true })
      .range(connOffset, connOffset + CONNECTION_PAGE_SIZE - 1);
    if (connsErr) throw connsErr;

    const connPage = (conns ?? []) as Array<{
      id: string;
      encrypted_credentials: string;
      encrypted_label: string | null;
    }>;
    if (connPage.length === 0) break;

    for (const conn of connPage) {
      const newCreds = await migrateCredentialsCiphertext(conn.encrypted_credentials);
      const connUpdate: Record<string, unknown> = { encrypted_credentials: newCreds };
      if (conn.encrypted_label) {
        try {
          connUpdate.encrypted_label = await migrateCredentialsCiphertext(conn.encrypted_label);
        } catch {
          try {
            connUpdate.encrypted_label = await migrateTransactionCiphertext(conn.encrypted_label);
          } catch {
            // Label migration failed with both keys. Leave the stale ciphertext.
            // encrypted_label is cosmetic and the connection remains usable.
            //
            // WHAT THIS COSTS, stated rather than hidden. The row is still
            // counted as migrated a few lines below, so the reconciliation
            // passes and that one label is permanently unreadable, silently.
            // That is a deliberate trade: making it fatal would block recovery
            // outright for a user whose label cannot be migrated at all, which
            // is far worse for them than losing a display string. What is NOT
            // acceptable is a completeness check that claims more than it
            // does, so assertEveryRowMigrated now says plainly that it counts
            // rows and not fields.
          }
        }
      }
      const { data: connWritten, error: connErr } = await supabase
        .from("connections")
        .update(connUpdate)
        .eq("id", conn.id)
        .select("id");
      if (connErr) throw connErr;
      if (!connWritten || (connWritten as unknown[]).length !== 1) {
        throw new Error(rowNotWrittenMessage("connections", conn.id));
      }
      connectionsMigrated += 1;
    }

    // End on a short page, not on the absence of an error. A capped or empty
    // read is not an error, so the row count is the only honest signal.
    if (connPage.length < CONNECTION_PAGE_SIZE) break;
    connOffset += CONNECTION_PAGE_SIZE;
  }

  // Re-encrypt transactions in pages of 500, in a deterministic id order.
  // encrypted_payload uses the transactions subkey, which changes with the MEK.
  // The order clause carries the same weight it does on the connections read
  // above: this loop UPDATEs the rows of each page as it goes, so an unordered
  // scan may skip a row (stranded under the old MEK, silently and permanently)
  // or return one twice (decryption throws and the rotation aborts partway).
  let transactionsMigrated = 0;
  let offset = 0;
  for (;;) {
    const { data: txns, error: txnsErr } = await supabase
      .from("encrypted_transactions")
      .select("id, encrypted_payload")
      .order("id", { ascending: true })
      .range(offset, offset + TRANSACTION_PAGE_SIZE - 1);
    if (txnsErr) throw txnsErr;
    if (!txns || (txns as unknown[]).length === 0) break;

    // SEQUENTIAL, DELIBERATELY, and it now matches the connections loop above.
    // This was a Promise.all over the whole page: up to 500 concurrent
    // PostgREST updates. Two things were wrong with that and neither is about
    // speed. A rejection part way through does not stop the other in-flight
    // updates, so writes kept landing AFTER this function had already thrown,
    // which is the one thing a fail-closed path must not do. And the burst
    // itself is what makes a 429 or a 5xx likely, and on this path a transient
    // error is the failure that strands a vault.
    //
    // CORRECTED CLAIM (OR-T1342): an earlier version of this comment argued
    // that bounding the concurrency "would still leave writes landing after
    // the throw". That is not right. A bounded pool with a shared abort flag
    // checked before each update issues no write once the flag is set, exactly
    // as this sequential loop does, and returns most of the throughput. The
    // sequential loop stays as written because nothing has measured this as
    // slow at current volumes, not because a pool cannot preserve the
    // fail-closed property. Reconsider a bounded pool if this is ever measured
    // as slow.
    for (const txn of txns as Array<{ id: string; encrypted_payload: string }>) {
      const newPayload = await migrateTransactionCiphertext(txn.encrypted_payload);
      const { data: txnWritten, error: txnErr } = await supabase
        .from("encrypted_transactions")
        .update({ encrypted_payload: newPayload })
        .eq("id", txn.id)
        .select("id");
      if (txnErr) throw txnErr;
      if (!txnWritten || (txnWritten as unknown[]).length !== 1) {
        throw new Error(rowNotWrittenMessage("encrypted_transactions", txn.id));
      }
      transactionsMigrated += 1;
    }

    if ((txns as unknown[]).length < TRANSACTION_PAGE_SIZE) break;
    offset += TRANSACTION_PAGE_SIZE;
  }

  // From the first rewritten row until the meta write below lands, the only
  // copy of the new MEK is in the page's memory. Closing or reloading the tab
  // anywhere in that window strands every row that already moved, and the
  // migration loop above is therefore the dangerous stretch, not the write.

  // RECONCILE BEFORE THE POINT OF NO RETURN.
  // Both loops above end on a short page. That is the honest signal for "this
  // read returned everything it was asked for", and it is not a signal that the
  // table held nothing more. Counting the rows and comparing them against what
  // this run actually wrote turns every way of ending early, including ones not
  // yet thought of, into a loud stop at the last moment where stopping is safe.
  await assertEveryRowMigrated(supabase, "connections", connectionsMigrated, sleep);
  await assertEveryRowMigrated(supabase, "encrypted_transactions", transactionsMigrated, sleep);

  // All ciphertexts migrated. Persist rotated vault meta now that every row is
  // under the new MEK.
  //
  // WHAT WRITING META LAST ACTUALLY BUYS, and what it does not.
  // If a row migration above threw, the stored enc_mek_ciphertext and
  // recovery_ciphertext still wrap the OLD MEK, so the user can still unlock
  // and every un-migrated row still reads. That is real and it is why this
  // order stays.
  //
  // It does NOT mean nothing was invalidated. Every row this run already
  // rewrote is stored, is under the NEW MEK, and cannot be read by the
  // wrappers that remain. An earlier version of this comment said "Nothing
  // stored is invalidated", which contradicted the paragraph a few lines above
  // it and was simply false. The user-facing copy carried the same overclaim
  // and was corrected with it: see rowCountMismatchMessage.
  //
  // It does NOT make a retry safe. recoverWithCode() generates a FRESH random
  // MEK on every call and nothing records which rows already moved, so after a
  // partial failure the rows are split across two MEKs. A retry unwraps the old
  // MEK again and cannot read the rows the first attempt already rewrote: it
  // throws on the first of them. Recovering from a partial migration needs a
  // resumable or per-row-keyed rotation, which does not exist yet. Do not
  // describe this path as retryable.
  // vault_verifier_ciphertext MUST be updated: it is derived from the MEK.
  // This write has to be PROVEN to have landed, not assumed. Every row above is
  // now under the new MEK and the only copies of that MEK are the wrappers in
  // this statement. An update that matches zero rows comes back without an
  // error, so the row count is the only signal that it actually happened.
  // The compare-and-swap on recovery_ciphertext (read at the top of the submit)
  // makes a concurrent rotation fail loudly rather than be overwritten.
  // WHY THIS IS A RECONCILING RETRY AND NOT A SINGLE ATTEMPT (OR-T1342). This
  // write happens at the exact instant the count-read retry above exists for:
  // every ciphertext is already under the new MEK and the only copy of that
  // MEK is on this page. See updateVaultMetaWithReconcile for how a lost
  // response is told apart from a write that never landed, without ever
  // risking a double write: the compare-and-swap on recovery_ciphertext makes
  // a second attempt safe by construction, and the reconcile read is what
  // tells a safe retry apart from a genuine conflict.
  await updateVaultMetaWithReconcile(
    supabase,
    userId,
    priorRecoveryCiphertext,
    {
      enc_mek_ciphertext: newEncMekCiphertext,
      recovery_ciphertext: newRecoveryCiphertext,
      vault_verifier_ciphertext: newVerifierCiphertext,
      vault_key_version: vaultKeyVersion,
    },
    sleep,
  );

  // Zero old key material. Only reached once the meta write above is proven to
  // have landed.
  // clearMigrationKeys is deliberately NOT called when anything above throws:
  // after a partial failure these stashed subkeys are the only thing that can
  // still read data left under the old MEK in this session. Keeping them is
  // worth doing on its own; it is not the same as the migration being
  // retryable, and it does not make it so.
  clearMigrationKeys();
}

/** How many times the meta write is retried after a TRANSPORT failure (a
 * thrown error: a dropped connection, a gateway timeout) before giving up.
 * Not used for a structured error response, see updateVaultMetaWithReconcile.
 */
export const META_WRITE_ATTEMPTS = 4;

/** Base delay between meta write retries, in milliseconds. Backs off linearly,
 * same shape as COUNT_READ_RETRY_MS.
 */
export const META_WRITE_RETRY_MS = 1000;

interface VaultMetaValues {
  enc_mek_ciphertext: string;
  recovery_ciphertext: string;
  vault_verifier_ciphertext: string;
  vault_key_version: number;
}

type MetaReconcileOutcome = "written" | "pending" | "conflict";

/**
 * Re-read user_vault_meta and decide what a lost response actually meant.
 *
 * Three answers, and only three:
 *   "written"  , the stored row already matches what we were writing. Our
 *                update landed; only the response was lost. Nothing left to do.
 *   "pending"  , the stored row still matches the PRIOR values (or could not
 *                be read at all). Nothing has landed yet; the write is safe
 *                to retry, because the compare-and-swap on recovery_ciphertext
 *                means a retry can only ever match the row once.
 *   "conflict" , the stored row matches neither ours nor the prior values. A
 *                different session won the race. This is a real conflict and
 *                must not be retried.
 *
 * A read failure is folded into "pending" rather than treated as its own
 * outcome: the caller's retry loop is what re-attempts it, bounded by
 * META_WRITE_ATTEMPTS, so an unreadable row still ends in a loud throw rather
 * than a silent pass, it just takes one more lap to get there.
 */
async function reconcileVaultMetaWrite(
  supabase: VaultPersistClient,
  userId: string,
  priorRecoveryCiphertext: string,
  values: VaultMetaValues,
): Promise<MetaReconcileOutcome> {
  let data: unknown;
  let error: unknown;
  try {
    const result = await supabase
      .from("user_vault_meta")
      .select(
        "enc_mek_ciphertext, recovery_ciphertext, vault_verifier_ciphertext, vault_key_version",
      )
      .eq("user_id", userId);
    data = (result as { data?: unknown }).data;
    error = (result as { error?: unknown }).error;
  } catch (err) {
    error = err;
  }
  if (error) return "pending";

  const row = (data as Array<Record<string, unknown>> | null)?.[0];
  if (!row) return "pending";

  if (
    row.recovery_ciphertext === values.recovery_ciphertext &&
    row.enc_mek_ciphertext === values.enc_mek_ciphertext &&
    row.vault_verifier_ciphertext === values.vault_verifier_ciphertext
  ) {
    return "written";
  }
  if (row.recovery_ciphertext === priorRecoveryCiphertext) {
    return "pending";
  }
  return "conflict";
}

/**
 * Write the rotated vault meta, and survive a LOST RESPONSE on that write.
 *
 * THE PROBLEM. The update below is a compare-and-swap on recovery_ciphertext:
 * it can land once and only once, because a second attempt no longer matches
 * priorRecoveryCiphertext. That makes RETRYING it safe by construction against
 * a double write. What it does not do on its own is tell a safe retry apart
 * from a genuine conflict: both come back as zero rows updated, no error. A
 * blind retry after a dropped connection would report
 * RECOVERY_META_NOT_SAVED_MESSAGE on a write that actually succeeded, which is
 * the wrong message at the worst possible moment: the user is told their
 * recovery failed when their data is safe.
 *
 * THE FIX. A TRANSPORT failure (the await throws: a dropped connection, a
 * gateway timeout, a 502) is not taken as a failure to write. It is taken as
 * an UNKNOWN outcome, and reconcileVaultMetaWrite re-reads the row to find out
 * which of three things happened, then either returns, retries, or throws.
 *
 * A STRUCTURED error response (the server responded and refused the write) is
 * different: the server told us definitively what happened, so there is
 * nothing to reconcile, and this throws immediately exactly as it always did.
 */
async function updateVaultMetaWithReconcile(
  supabase: VaultPersistClient,
  userId: string,
  priorRecoveryCiphertext: string,
  values: VaultMetaValues,
  sleep: SleepFn,
): Promise<void> {
  for (let attempt = 1; attempt <= META_WRITE_ATTEMPTS; attempt += 1) {
    let transportFailed = false;
    let updatedRows: unknown[] | null = null;
    let updateErr: unknown = null;
    try {
      const result = await supabase
        .from("user_vault_meta")
        .update(values)
        .eq("user_id", userId)
        .eq("recovery_ciphertext", priorRecoveryCiphertext)
        .select("user_id");
      updatedRows = (result as { data: unknown[] | null }).data;
      updateErr = (result as { error: unknown }).error;
    } catch (err) {
      transportFailed = true;
      updateErr = err;
    }

    if (!transportFailed) {
      // The server responded. Whatever it said is the whole answer; there is
      // nothing ambiguous left to reconcile.
      if (updateErr) throw updateErr;
      if (updatedRows && updatedRows.length === 1) return;
      throw new Error(RECOVERY_META_NOT_SAVED_MESSAGE);
    }

    const outcome = await reconcileVaultMetaWrite(
      supabase,
      userId,
      priorRecoveryCiphertext,
      values,
    );
    if (outcome === "written") return;
    if (outcome === "conflict") throw new Error(RECOVERY_META_NOT_SAVED_MESSAGE);
    // outcome === "pending": nothing has landed yet (or could not be read).
    // Retry the same conditional update.
    if (attempt < META_WRITE_ATTEMPTS) await sleep(META_WRITE_RETRY_MS * attempt);
  }

  throw new Error(RECOVERY_META_NOT_SAVED_MESSAGE);
}

/**
 * Refuse to continue unless the number of rows this run WROTE equals the number
 * of rows the table currently holds.
 *
 * WHAT THIS DOES NOT CHECK, first, because the previous wording said "every row
 * the table holds" and that overclaimed. It compares ROW COUNTS, not fields. A
 * connection whose encrypted_label cannot be migrated under either subkey is
 * still counted as migrated, so its label is lost silently and this check
 * passes. The trade is argued at that swallowed catch in the connections loop.
 * This guard is about rows being REACHED, not about every field inside a row
 * landing, and a completeness check that claims completeness it does not have
 * is worse than one that states its limit.
 *
 * WHY A COUNT AND NOT THE LOOP'S OWN SIGNAL. Each paging loop ends on a short
 * page, which is the only honest end condition for a read: a capped or empty
 * read raises no error, so the row count is all there is. What it cannot tell
 * you is whether the table held more rows than the loop ever saw. Two ways that
 * happens, both silent:
 *
 *  - the project's PostgREST row cap is lowered below CONNECTION_PAGE_SIZE or
 *    TRANSACTION_PAGE_SIZE. That cap is a project setting outside this
 *    repository and nothing here asserts the relationship, so the first page
 *    comes back short and the loop stops with every later row untouched;
 *  - another session INSERTs a row while the loop runs, shifting the window.
 *    Keyset pagination on id does not close this: a row inserted below the
 *    cursor is missed exactly as offset paging misses it, and it is missed
 *    while still wrapped under the OLD MEK. During a recovery that is not
 *    exotic, because a sync in a second tab writes encrypted_transactions rows.
 *
 * Either way the row is left under a MEK that recoverWithCode() has already
 * replaced and nothing stores any more, which is permanent loss for that row.
 *
 * WHY IT RUNS HERE. Before the user_vault_meta write is the last instant at
 * which failing costs nothing irreversible: the stored enc_mek_ciphertext and
 * recovery_ciphertext still wrap the old MEK, every un-migrated row still
 * reads, the user can still unlock, and clearMigrationKeys has not run. One
 * line later the same mismatch cannot be recovered from at all.
 *
 * WHY THE READ IS RETRIED. This runs at the one instant where a thrown error
 * is most expensive: every ciphertext is already under the new MEK and the only
 * copy of that MEK is in this page. A count is a pure idempotent read, so
 * giving up on the first 502, dropped connection or rate limit would convert a
 * transient network error into permanent key loss for a user who then reloads,
 * and without this guard that recovery would have completed. It is read up to
 * COUNT_READ_ATTEMPTS times with a backoff. A count that was read successfully
 * and DISAGREES is never retried: that is a decision, not a flake.
 *
 * WHY A HEAD REQUEST WITH AN EXACT COUNT. PostgREST computes that count
 * separately from the rows it returns, so it is the true total and is not
 * itself subject to the row cap that is one of the two failures above. An
 * estimate would not be evidence of anything.
 *
 * WHY THERE IS NO user_id FILTER. Neither of these tables has a user_id column
 * and row level security is what scopes them to the caller (VERIFIED on the dev
 * project 2026-08-31: relrowsecurity is true on both). The paging reads carry
 * no filter either, so adding one only here would compare two different sets.
 *
 * WHAT THE MIGRATED NUMBER IS. It is incremented only when a row update handed
 * back the row it changed, so it is proof of a landed write. Were it counting
 * updates that merely did not error, this would compare a read count against a
 * read count, and a run in which every write was refused at the row layer would
 * reconcile as clean and go on to the irreversible meta write.
 *
 * A count LOWER than migrated fails too, which is deliberate. It means a row
 * was deleted from under the loop, and this path cannot tell that apart from a
 * row that was skipped. Stopping before the meta write is the cheap direction
 * to be wrong in; the other direction is unrecoverable.
 */
async function assertEveryRowMigrated(
  supabase: VaultPersistClient,
  table: string,
  migrated: number,
  sleep: SleepFn = realSleep,
): Promise<void> {
  for (let attempt = 1; attempt <= COUNT_READ_ATTEMPTS; attempt += 1) {
    let count: unknown = null;
    let readError: unknown = null;
    let readFailed = false;
    try {
      const result = await supabase.from(table).select("id", { count: "exact", head: true });
      count = (result as { count?: unknown }).count;
      readError = (result as { error?: unknown }).error;
      readFailed = Boolean(readError);
    } catch (err) {
      readFailed = true;
      readError = err;
    }

    if (!readFailed && typeof count === "number" && Number.isFinite(count)) {
      // The count was read. Whatever it says is now a decision and never a
      // flake, so this returns or throws here rather than trying again.
      if (count !== migrated) {
        throw new Error(rowCountMismatchMessage(table, migrated, count));
      }
      return;
    }

    if (attempt < COUNT_READ_ATTEMPTS) await sleep(retryAfterMsFromError(readError, attempt));
  }

  // Every attempt failed. Only now is this a real failure rather than a flaky
  // network, and "I could not check" must never read as "everything matched".
  throw new Error(rowCountUnreadableMessage(table));
}

export interface RewrapVaultArgs {
  supabase: VaultPersistClient;
  userId: string;
  /**
   * enc_mek_ciphertext as it was before this change. Compare-and-swap guard,
   * so a concurrent change or a lost session fails loudly instead of leaving
   * the user holding a recovery code that opens nothing.
   */
  priorEncMekCiphertext: string;
  newEncMekCiphertext: string;
  newRecoveryCiphertext: string;
}

/**
 * Persist the re-wrapped MEK and the fresh recovery code after a password
 * change. No ciphertext moves here: the MEK is unchanged, only its wrapping.
 *
 * Throws if the write did not land. The caller must not show the new recovery
 * code unless this resolves, because a code that was never stored opens
 * nothing.
 */
export async function persistRewrappedVaultMeta(args: RewrapVaultArgs): Promise<void> {
  const {
    supabase,
    userId,
    priorEncMekCiphertext,
    newEncMekCiphertext,
    newRecoveryCiphertext,
  } = args;

  const { error: saveErr, data: saveData } = await supabase
    .from("user_vault_meta")
    .update({
      enc_mek_ciphertext: newEncMekCiphertext,
      recovery_ciphertext: newRecoveryCiphertext,
    })
    .eq("user_id", userId)
    .eq("enc_mek_ciphertext", priorEncMekCiphertext)
    .select("user_id");
  if (saveErr) throw new Error((saveErr as { message?: string }).message ?? "Save failed.");
  if (!saveData || (saveData as unknown[]).length === 0) {
    throw new Error(PASSWORD_CHANGE_CONFLICT_MESSAGE);
  }
}
