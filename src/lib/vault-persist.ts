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
 *
 * WHAT THE READS IN HERE HAVE TO GUARANTEE. Every row the user owns has to be
 * re-encrypted before the meta write, so a read that quietly returns fewer rows
 * than the table holds is the same defect as a failed write, and it is harder
 * to see: a capped read raises no error at all, and a scan with no ORDER BY may
 * return a row twice or not at all once the loop starts writing new tuple
 * versions under it. That is why the reads below are paged and ordered rather
 * than taken on trust.
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

/** Transactions are re-encrypted in pages of this size. */
export const TRANSACTION_PAGE_SIZE = 500;

/** Connections are re-encrypted in pages of this size. */
export const CONNECTION_PAGE_SIZE = 500;

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
          }
        }
      }
      const { error: connErr } = await supabase
        .from("connections")
        .update(connUpdate)
        .eq("id", conn.id);
      if (connErr) throw connErr;
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
  let offset = 0;
  for (;;) {
    const { data: txns, error: txnsErr } = await supabase
      .from("encrypted_transactions")
      .select("id, encrypted_payload")
      .order("id", { ascending: true })
      .range(offset, offset + TRANSACTION_PAGE_SIZE - 1);
    if (txnsErr) throw txnsErr;
    if (!txns || (txns as unknown[]).length === 0) break;

    await Promise.all(
      (txns as Array<{ id: string; encrypted_payload: string }>).map(async (txn) => {
        const newPayload = await migrateTransactionCiphertext(txn.encrypted_payload);
        const { error: txnErr } = await supabase
          .from("encrypted_transactions")
          .update({ encrypted_payload: newPayload })
          .eq("id", txn.id);
        if (txnErr) throw txnErr;
      }),
    );

    if ((txns as unknown[]).length < TRANSACTION_PAGE_SIZE) break;
    offset += TRANSACTION_PAGE_SIZE;
  }

  // From the first rewritten row until the meta write below lands, the only
  // copy of the new MEK is in the page's memory. Closing or reloading the tab
  // anywhere in that window strands every row that already moved, and the
  // migration loop above is therefore the dangerous stretch, not the write.

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
