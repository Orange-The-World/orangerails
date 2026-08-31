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
  // It does NOT make a retry safe. See the note on the meta write below before
  // relying on it.
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
  // recovery_ciphertext still wrap the OLD MEK, so the user can still unlock
  // and every un-migrated row still reads. Nothing stored is invalidated. That
  // is real and it is why this order stays.
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
    throw new Error(RECOVERY_META_NOT_SAVED_MESSAGE);
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
