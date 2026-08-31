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

import { formatError } from "./format-error";

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
 * The sentence that answers the question a user in this state will actually
 * ask: which password opens my vault now.
 *
 * After ANY failure in this function the stored enc_mek_ciphertext still wraps
 * the OLD MEK under the OLD password KEK, because the write that would replace
 * it is the last statement here and it either did not run or did not land. So
 * the vault opens with the password the user had BEFORE this recovery attempt,
 * NOT the new one they just typed into the form. That is counter-intuitive and
 * nothing used to say it, so the user's obvious next move was to try the new
 * password, fail, and conclude the vault was gone.
 */
export const VAULT_OPENS_WITH_OLD_PASSWORD_MESSAGE =
  "Your vault still opens with the vault password you had BEFORE this recovery attempt, not the new password you just chose.";

/**
 * Shown when the rotated vault meta write did not land. By the time this can
 * happen every ciphertext the user owns is already under the new MEK, and the
 * only copies of that MEK are in the write that just failed. That is why the
 * message tells the user not to close the page rather than to try again.
 */
export const RECOVERY_META_NOT_SAVED_MESSAGE =
  "Vault recovery did not save. Your data has been re-encrypted but the new keys were not stored. Do not close or reload this page, and contact support with this message. " +
  VAULT_OPENS_WITH_OLD_PASSWORD_MESSAGE;

/**
 * Shown when the rotation failed part way through one of the row walks, before
 * the meta write was ever reached.
 *
 * This is the same irreversible state the message above exists to prevent,
 * reached by a different door. Rows have already been rewritten under the new
 * MEK, and the only copies of that MEK are in session memory: mekRef in
 * VaultContext and the wrappers held by the calling route. Nothing has
 * persisted them. Close or reload the page and every row already migrated is
 * permanently unreadable.
 *
 * Until this existed the user was shown the raw PostgREST error instead, which
 * is worse than merely unhelpful: a database error invites a reload, and a
 * reload is the single action that makes the loss permanent.
 */
export const RECOVERY_PARTIAL_FAILURE_MESSAGE =
  "Vault recovery stopped part way through. Some of your data has already been re-encrypted with a new key that has not been saved anywhere yet. Do not close or reload this page, and contact support with this message. " +
  VAULT_OPENS_WITH_OLD_PASSWORD_MESSAGE;

/**
 * Marks an error whose message ALREADY carries the do-not-close-this-page
 * warning, so the boundary in migrateAndPersistRotatedVault passes it through
 * instead of replacing a specific message with the generic one.
 */
const VAULT_WARNING_MARKER = "__vaultRotationWarning";

function markVaultWarning<T extends Error>(err: T): T {
  (err as unknown as Record<string, unknown>)[VAULT_WARNING_MARKER] = true;
  return err;
}

function carriesVaultWarning(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as Record<string, unknown>)[VAULT_WARNING_MARKER],
  );
}

/** A mid-rotation failure, with the error that caused it kept rather than lost. */
export interface VaultRotationPartialFailure extends Error {
  /**
   * The original thrown value, usually a PostgrestError. Kept so support can
   * diagnose the cause. Deliberately NOT the headline: it is appended after the
   * warning, because what the user does in the next ten seconds matters more
   * than what the database said.
   */
  underlyingError: unknown;
}

function rotationPartialFailure(cause: unknown): VaultRotationPartialFailure {
  const detail = formatError(cause);
  const err = new Error(
    detail
      ? `${RECOVERY_PARTIAL_FAILURE_MESSAGE} Technical detail for support: ${detail}`
      : RECOVERY_PARTIAL_FAILURE_MESSAGE,
  ) as VaultRotationPartialFailure;
  err.underlyingError = cause;
  return markVaultWarning(err);
}

/**
 * Whether this rotation has passed the point of no return.
 *
 * ISSUED, not confirmed. A row update whose response never arrived may still
 * have landed, and we cannot tell the two apart from here, so the flag is set
 * before the statement goes out rather than after it succeeds. The cost of
 * being wrong in that direction is one unnecessary warning; the cost of being
 * wrong in the other direction is a vault.
 */
interface RotationProgress {
  anyRowWriteIssued: boolean;
}

/** Shown when the compare-and-swap on a password change matched no row. */
export const PASSWORD_CHANGE_CONFLICT_MESSAGE =
  "Vault was changed from another session. Reload the page and try again.";

/** Connections and transactions are re-encrypted in pages of this size. */
const ROTATION_PAGE_SIZE = 500;

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
}

/**
 * Re-encrypt every ciphertext this user owns under the new MEK, then persist
 * the rotated vault meta, then zero the old key material.
 *
 * Throws if anything fails. The caller must not treat the recovery as done
 * unless this resolves.
 */
export async function migrateAndPersistRotatedVault(args: RotateVaultArgs): Promise<void> {
  const progress: RotationProgress = { anyRowWriteIssued: false };
  try {
    await rotateAndPersistVault(args, progress);
  } catch (err) {
    // The trigger is "has anything been written yet", NOT "which statement
    // failed". That is why this is one boundary around the whole function
    // rather than an edit at each throw site: a throw site added later is
    // covered without anyone having to remember this rule.
    //
    // Nothing written means nothing lost, so the raw error is the honest
    // answer and dressing it up would only hide a real fault. Once a row write
    // has been issued the user is in the irreversible state and needs the
    // warning, whatever the underlying failure was.
    if (!progress.anyRowWriteIssued) throw err;
    if (carriesVaultWarning(err)) throw err;
    throw rotationPartialFailure(err);
  }
}

async function rotateAndPersistVault(
  args: RotateVaultArgs,
  progress: RotationProgress,
): Promise<void> {
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
  } = args;

  // Re-encrypt connections first, then transactions, then meta.
  // Meta is written last so a partial failure leaves the STORED wrappers still
  // pointing at the old MEK: the user can still unlock, and every row that has
  // not moved yet still reads. That is the only property this ordering buys.
  // It does NOT make a retry safe, and it does NOT save the rows that already
  // moved, which are lost. See the note on the meta write below before relying
  // on it.
  // credentials subkey changes with the MEK.
  //
  // WHY THIS PAGES AT ALL. An unfiltered select LOOKS like it returns every
  // row and does not. PostgREST applies its own db-max-rows cap server side,
  // whatever the client asked for. A capped read here would re-encrypt only
  // the rows that came back, finish with no error, let the meta write land and
  // let clearMigrationKeys() destroy the old MEK. Every connection past the
  // cap would then hold credentials wrapped under a key that does not exist
  // anywhere, permanently unusable, with recovery reported as successful.
  //
  // The keyset argument is the same one the transaction walk below sets out:
  // id is a uuid primary key, NOT NULL and unique, and this loop never writes
  // it, so ascending id plus "greater than the last id of the previous page"
  // is a stable total order. It cannot skip a row or return one twice however
  // PostgreSQL moves the row physically when it is updated. The loop exits on
  // an EMPTY page and on nothing else, for the reason spelled out at the
  // bottom of the transaction walk, and that exit cannot spin because the
  // cursor strictly increases.
  //
  // NOT solved here, deliberately, and the same gap the transaction walk has:
  // a row INSERTED by another session mid-rotation. A uuid is random, so a new
  // row can sort below the cursor and be missed.
  let lastConnId: string | null = null;
  for (;;) {
    const connPage = supabase
      .from("connections")
      .select("id, encrypted_credentials, encrypted_label")
      .order("id", { ascending: true })
      .limit(ROTATION_PAGE_SIZE);
    const { data: conns, error: connsErr } = await (lastConnId === null
      ? connPage
      : connPage.gt("id", lastConnId));
    if (connsErr) throw connsErr;
    const connRows = (conns ?? []) as Array<{
      id: string;
      encrypted_credentials: string;
      encrypted_label: string | null;
    }>;
    if (connRows.length === 0) break;

    for (const conn of connRows) {
      const newCreds = await migrateCredentialsCiphertext(conn.encrypted_credentials);
      const connUpdate: Record<string, unknown> = { encrypted_credentials: newCreds };
      if (conn.encrypted_label) {
        try {
          connUpdate.encrypted_label = await migrateCredentialsCiphertext(conn.encrypted_label);
        } catch {
          try {
            connUpdate.encrypted_label = await migrateTransactionCiphertext(conn.encrypted_label);
          } catch {
            // Label migration failed with BOTH the old and the new subkey.
            //
            // The decision is to continue. The credentials are what make a
            // connection usable and they have already migrated, so aborting
            // the whole rotation here would strand the user in the half-done
            // state described at the meta write below, which is far worse
            // than losing one label.
            //
            // Be exact about what continuing costs, because the old wording
            // said "stale" and that reads as recoverable. It is not.
            // Execution runs on to the meta write and then to
            // clearMigrationKeys(), after which the old MEK does not exist
            // anywhere. From that point this label is permanently unreadable.
            // The connection keeps working; its name does not come back.
          }
        }
      }
      // Set BEFORE the statement goes out. Once it has been issued we cannot
      // know whether it landed, and a row that did land is unreadable without
      // the new MEK that only exists in this session.
      progress.anyRowWriteIssued = true;
      const { error: connErr } = await supabase
        .from("connections")
        .update(connUpdate)
        .eq("id", conn.id);
      if (connErr) throw connErr;
    }

    // The page came back ordered by id ascending, so the last row carries the
    // high-water mark for the next page.
    lastConnId = connRows[connRows.length - 1].id;
  }

  // Re-encrypt transactions in pages of 500.
  // encrypted_payload uses the transactions subkey, which changes with the MEK.
  //
  // WHY THIS PAGES BY KEY AND NOT BY OFFSET. This loop UPDATES every row in
  // the page it just read and then asks for the next page. Under LIMIT/OFFSET
  // with no ORDER BY, which is what .range() alone produces, PostgreSQL owes
  // us no ordering at all: a row rewritten here can come back behind the
  // offset boundary and never be selected again. It would never be
  // re-encrypted, this loop would still finish normally, the meta write below
  // would land and clearMigrationKeys() would destroy the only key that could
  // still read it. That transaction would be permanently and silently
  // unreadable. The other direction is a row selected twice, which throws on
  // the second decrypt and aborts the rotation half-done.
  //
  // Paging by the primary key removes that, rather than making it less likely.
  // id is a uuid primary key: NOT NULL, unique, and never written by this
  // loop, so ascending id plus "greater than the last id of the previous page"
  // is a stable total order. It cannot skip a row or return one twice however
  // PostgreSQL moves the row physically when it is updated.
  //
  // That claim holds only because the loop exits on an EMPTY page and on
  // nothing else. A short page is NOT an end-of-table signal here; the note at
  // the bottom of the loop says why, and it is load bearing.
  //
  // NOT solved here, deliberately: a row INSERTED by another session while
  // this loop runs. A uuid is random, so a new row can sort below lastId and
  // be missed. Concurrent writes during a rotation need the whole rotation to
  // be resumable, which is the same gap the meta write note below describes.
  let lastId: string | null = null;
  for (;;) {
    const page = supabase
      .from("encrypted_transactions")
      .select("id, encrypted_payload")
      .order("id", { ascending: true })
      .limit(ROTATION_PAGE_SIZE);
    const { data: txns, error: txnsErr } = await (lastId === null
      ? page
      : page.gt("id", lastId));
    if (txnsErr) throw txnsErr;
    const rows = (txns ?? []) as Array<{ id: string; encrypted_payload: string }>;
    if (rows.length === 0) break;

    await Promise.all(
      rows.map(async (txn) => {
        const newPayload = await migrateTransactionCiphertext(txn.encrypted_payload);
        // Set BEFORE the statement goes out, for the reason given in the
        // connections walk. It matters more here: these run concurrently under
        // Promise.all, so one rejecting says nothing about whether its siblings
        // landed.
        progress.anyRowWriteIssued = true;
        const { error: txnErr } = await supabase
          .from("encrypted_transactions")
          .update({ encrypted_payload: newPayload })
          .eq("id", txn.id);
        if (txnErr) throw txnErr;
      }),
    );

    // NO SHORT-PAGE BREAK, deliberately. "rows.length < ROTATION_PAGE_SIZE"
    // reads like end-of-table and is not: PostgREST applies its own db-max-rows
    // cap server-side, so a request for 500 can legitimately return fewer while
    // rows remain above the cursor. Stopping there would leave those rows never
    // re-encrypted, the loop would still finish normally, the meta write would
    // land and clearMigrationKeys() would destroy the only key that could read
    // them. That is the same permanent, silent loss the keyset rewrite above
    // exists to remove, reintroduced one line lower down.
    //
    // The empty-page exit is sufficient on its own and cannot spin: the cursor
    // strictly increases, so every page starts past the last id of the previous
    // one and the set above it shrinks each time. The cost is one extra round
    // trip per rotation.
    //
    // The page came back ordered by id ascending, so the last row carries the
    // high-water mark for the next page.
    lastId = rows[rows.length - 1].id;
  }

  // All ciphertexts migrated. Persist rotated vault meta now that every row is
  // under the new MEK.
  //
  // WHAT WRITING META LAST ACTUALLY BUYS, and what it does not.
  // If a row migration above threw, the stored enc_mek_ciphertext and
  // recovery_ciphertext still wrap the OLD MEK, so the user can still UNLOCK
  // and every row that has NOT moved yet still reads. That is the whole of it,
  // and it is why this order stays.
  //
  // It does NOT mean nothing stored is invalidated. Every row this function
  // already rewrote is now under the new MEK, and the only copies of the new
  // MEK are in session memory, because the write that would persist them is
  // the one below and it has not run. So a mid-walk failure leaves a SPLIT
  // vault, not an intact one: the already-migrated prefix is permanently
  // unreadable once this session ends, and the un-migrated suffix still reads.
  // The connections walk above runs to completion before the transaction walk
  // starts, so a throw anywhere in the transaction walk puts EVERY connection
  // credential the user owns in that lost prefix.
  //
  // Do not read this ordering as making a partial failure survivable. It only
  // keeps the user able to unlock. Making it survivable means persisting the
  // new wrapper before the walks, or versioning the key per row, and neither
  // exists yet.
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
  const { data: updatedRows, error: updateErr } = await supabase
    .from("user_vault_meta")
    .update({
      enc_mek_ciphertext: newEncMekCiphertext,
      recovery_ciphertext: newRecoveryCiphertext,
      vault_verifier_ciphertext: newVerifierCiphertext,
      vault_key_version: vaultKeyVersion,
    })
    .eq("user_id", userId)
    .eq("recovery_ciphertext", priorRecoveryCiphertext)
    .select("user_id");
  if (updateErr) throw updateErr;
  if (!updatedRows || (updatedRows as unknown[]).length !== 1) {
    // Marked so the boundary keeps this more specific message instead of
    // replacing it with the generic partial-failure one.
    throw markVaultWarning(new Error(RECOVERY_META_NOT_SAVED_MESSAGE));
  }

  // Zero old key material. Only reached once the meta write above is proven to
  // have landed.
  // clearMigrationKeys is deliberately NOT called when anything above throws:
  // after a partial failure these stashed subkeys are the only thing that can
  // still read data left under the old MEK in this session. Keeping them is
  // worth doing on its own; it is not the same as the migration being
  // retryable, and it does not make it so.
  clearMigrationKeys();
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
