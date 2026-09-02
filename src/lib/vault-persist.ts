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

/**
 * Shown when the reconciliation below the paging loops finds that this run did
 * not re-encrypt every row the table holds for this user.
 *
 * It names both numbers on purpose. "migrated 0 of 12 transactions" and
 * "migrated 12 of 12 transactions" have to read differently, because the whole
 * family of defects on this path is a check that cannot tell those two apart.
 */
export function rowsNotReconciledMessage(
  label: string,
  migrated: number,
  total: number | null | undefined,
): string {
  const totalText = typeof total === "number" ? String(total) : "unknown";
  return (
    `Vault recovery stopped before saving: migrated ${migrated} of ${totalText} ${label}. ` +
    "Your stored vault keys were not changed. Do not close or reload this page, and contact " +
    "support with this message."
  );
}

/**
 * Shown when a row UPDATE reported no error and yet changed no row.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT COSMETIC. A PostgREST update that matches
 * nothing, because row-level security refused it or because the row went away
 * underneath us, comes back with no error at all. Counting those as migrated
 * would make the reconciliation below compare a read against a read: on a run
 * where every write is refused, the migrated total equals the table total, the
 * reconciliation agrees, and the irreversible meta write proceeds having
 * re-encrypted nothing. Asking each update for the row it changed is the only
 * thing that makes the migrated number evidence of a landed write.
 */
export function rowNotWrittenMessage(label: string, rowId: string): string {
  return (
    `Vault recovery stopped before saving: a ${label} row (${rowId}) was not written. ` +
    "Your stored vault keys were not changed. Do not close or reload this page, and contact " +
    "support with this message."
  );
}

/**
 * Shown when rows this user owns are still not stamped with this rotation's
 * key generation once the sweeps have stopped finding work.
 *
 * It is a different failure from rowsNotReconciledMessage above and says so.
 * That one means the table holds more rows than this run wrote. This one means
 * a row exists that is NOT under the key this run just created, which is the
 * thing that actually strands data, and it is detected by asking the server
 * rather than by comparing two client-side readings that can cancel.
 */
export function rowsNotAtGenerationMessage(
  label: string,
  stale: number,
  generation: number,
): string {
  return (
    `Vault recovery stopped before saving: ${stale} ${label} are still under the previous ` +
    `key (not at generation ${generation}). Your stored vault keys were not changed. Do not ` +
    "close or reload this page, and contact support with this message."
  );
}

/** Shown when the generation marker on a table cannot be read at all. */
export const GENERATION_UNREADABLE_MESSAGE =
  "Vault recovery stopped before saving: the key generation of your stored rows could not be read. Your stored vault keys were not changed. Do not close or reload this page, and contact support with this message.";

/**
 * What the database puts in data_key_generation when nobody sets it.
 *
 * VERIFIED against information_schema on the dev project: connections and
 * encrypted_transactions both carry data_key_generation smallint NOT NULL
 * DEFAULT 1. Two things follow and the whole check below rests on them.
 *
 * NOT NULL means a filter of "not equal to this generation" is complete: there
 * is no third state that silently escapes both sides of the comparison.
 *
 * DEFAULT 1, and nothing anywhere writes this column, means every row another
 * session inserts while a rotation is running arrives carrying exactly this
 * value. A rotation therefore only has to pick a generation ABOVE it, and a
 * concurrent insert is guaranteed to be distinguishable from a row this run
 * rewrote, without any coordination between the two sessions.
 */
export const DATA_KEY_GENERATION_DEFAULT = 1;

/** Transactions are re-encrypted in pages of this size. */
export const TRANSACTION_PAGE_SIZE = 500;

/** Connections are re-encrypted in pages of this size. */
export const CONNECTION_PAGE_SIZE = 500;

/**
 * How many times the reconciliation goes back to finish rows this run missed
 * before it gives up. Bounded, so a table being written continuously by another
 * session cannot keep this loop running for ever.
 */
export const RECONCILE_MAX_PASSES = 3;

/**
 * Read the exact number of rows this user owns in `table`.
 *
 * WHY A HEAD COUNT AND NOT A SELECT OF IDS. The failure being guarded against
 * is a read that comes back short without erroring, so counting the rows a
 * select returns would measure the fault with the ruler that has the fault in
 * it. PostgREST computes an exact count server side and reports it out of band
 * in the Content-Range header, so it is not clipped by the server-side maximum
 * row count that clips the row payload.
 *
 * THE REQUIREMENT THIS READ HAS TO MEET. These tables are scoped by row-level
 * security rather than by a column this code could filter on, so the count read
 * and the paged reads have to carry the same filters as each other. If either
 * side ever gains a filter the other does not have, the two sides stop
 * measuring the same set and every comparison below becomes meaningless.
 *
 * A count that cannot be read is a FAILURE, not a pass. At the point where it
 * matters, an unreadable count is indistinguishable from agreement, and letting
 * it through would put the original silence straight back.
 */
async function exactRowCount(
  supabase: VaultPersistClient,
  table: string,
  label: string,
  migrated: number,
): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true });
  if (error) throw error;
  if (typeof count !== "number") throw new Error(rowsNotReconciledMessage(label, migrated, null));
  return count;
}

/** One table's share of the rotation, as the reconciliation needs to see it. */
interface TableReconcile {
  table: string;
  label: string;
  /** ids this run has PROVEN it rewrote */
  migrated: Set<string>;
  /** re-walk the table, migrating only the rows not already in `migrated` */
  sweep: () => Promise<void>;
}

/**
 * Finish the rotation, and do not return until every row this user owns is
 * PROVEN to be under the new MEK.
 *
 * WHY FINISHING AND NOT STOPPING. Between the first rewritten row and the meta
 * write, the only copy of the new MEK is in this page's memory, so a row this
 * run has already rewritten is readable only until the tab closes. Stopping is
 * therefore not free: it gives up every row already written in order to save
 * the rows that were missed. The missed rows are still under the old MEK and
 * the old subkeys are still in memory, because clearMigrationKeys has not run,
 * so they can simply be migrated too. That is strictly better than abandoning
 * either set.
 *
 * WHY COMPLETENESS IS DECIDED BY A SWEEP AND NOT BY COMPARING COUNTS. An
 * earlier version of this decided the rotation was complete when the exact row
 * count equalled the number of rows this run had written. One concurrent DELETE
 * of an already-migrated row defeats that comparison, and while the walk paged
 * by offset it opened a gap in the same operation: removing a row from a page
 * already consumed shifted every later row one place toward the start, so
 * exactly one row fell between the window just read and the next window and was
 * never returned at all. The delete also lowers the total by one, and the
 * deleted row's id stays in the migrated set because it was written before it
 * was removed. Those effects cancel one for one, so the counts agree and a
 * skipped row is stranded under a key nothing stores any more.
 *
 * walkAndMigrate now addresses each page by key rather than by offset, so the
 * shift half of that no longer happens at all. The count comparison is still
 * not sound and is still not what decides here: one delete of a migrated row
 * plus one insert below the cursor cancel each other in the total just as
 * neatly, and the inserted row is still under the old MEK. So the test here is
 * coverage, which is a property of what this run actually reached: keep
 * sweeping until a COMPLETE walk of a table finds every row it returns already
 * migrated. That does not care WHY a row was missed, which is the only reason
 * to trust it against the next mechanism nobody has thought of.
 *
 * THE COST, stated because it is not free. A clean rotation now walks each
 * table twice. The second walk is what turns the first walk's completeness from
 * an assumption into evidence, and it issues no updates, because every row it
 * sees is already in the migrated set.
 *
 * WHY THE COUNT IS STILL HERE. A sweep cannot see a row the read never returns
 * at all. If the project's server-side maximum row count is ever lowered below
 * the page size, every walk ends on the same short first page, so every sweep
 * agrees there is nothing left to do while the rows past the cap sit
 * unmigrated. Only a count computed server side catches that. The two tests
 * fail in different directions and neither one replaces the other.
 *
 * WHY A TOTAL LOWER THAN THE MIGRATED COUNT IS NOT AN ERROR. It means rows went
 * away after being rewritten, by deletion or by leaving this user's
 * row-level-security scope, and a row that is gone cannot be stranded. Note it
 * is no longer read as evidence that nothing was MISSED, which is exactly what
 * the old version got wrong; it is only a reason not to abandon the rotation.
 * The sweep is what decides completeness.
 *
 * WHAT HAPPENS IF IT NEVER CONVERGES. This is a real choice, not a default.
 * After RECONCILE_MAX_PASSES sweeps, something is inserting rows about as fast
 * as this loop migrates them. Both branches lose data, so the error names the
 * arithmetic: stopping gives up the rows this run wrote, and continuing to the
 * meta write would permanently discard the only key for the rows it did not.
 * Stopping is chosen because it changes nothing that is stored, so the user
 * still holds a vault that unlocks and everything still readable from storage
 * stays readable, and because continuing would fail silently and be discovered
 * months later by a user missing transactions. The real answer to this case is
 * a resumable, per-row-keyed rotation that records which rows have moved. That
 * does not exist yet and is not in scope here.
 */
async function reconcileEveryRow(
  supabase: VaultPersistClient,
  tables: TableReconcile[],
): Promise<void> {
  for (let pass = 0; ; pass++) {
    // Sweep every table, THEN count every table. Doing both one table at a time
    // would let a row inserted into the first table while the second is being
    // swept escape this pass's count entirely.
    const addedBySweep = new Map<string, number>();
    for (const entry of tables) {
      const before = entry.migrated.size;
      await entry.sweep();
      addedBySweep.set(entry.table, entry.migrated.size - before);
    }

    const unsettled: Array<{ entry: TableReconcile; total: number }> = [];
    for (const entry of tables) {
      const total = await exactRowCount(supabase, entry.table, entry.label, entry.migrated.size);
      const added = addedBySweep.get(entry.table) ?? 0;
      // A sweep that migrated something is proof this run had not finished, so
      // the next sweep has to confirm there is nothing left. A total above the
      // migrated count means rows exist that no sweep has ever reached.
      if (added > 0 || total > entry.migrated.size) unsettled.push({ entry, total });
    }
    if (unsettled.length === 0) return;

    if (pass >= RECONCILE_MAX_PASSES) {
      // Prefer a table that is genuinely short, so the numbers in the message
      // read as "migrated fewer than exist" rather than the other way round.
      const blocked =
        unsettled.find(({ entry, total }) => total > entry.migrated.size) ?? unsettled[0];
      throw new Error(
        rowsNotReconciledMessage(blocked.entry.label, blocked.entry.migrated.size, blocked.total),
      );
    }
  }
}

/**
 * Walk a table in ordered pages and hand every row not already migrated to
 * `migrateRow`.
 *
 * WHY THE PAGE IS ADDRESSED BY KEY AND NOT BY OFFSET. `.range(offset, ...)`
 * addresses rows by POSITION. Deleting a row from a window that has already
 * been read shifts every later row one place toward the start, so exactly one
 * row falls between the window just read and the next window and is never
 * returned at all. Asking for `id > the last id of the previous page` addresses
 * rows by IDENTITY instead: a row removed below the cursor moves nothing, and
 * the row that would have been skipped is still returned.
 *
 * That shift is caught by the sweep in reconcileEveryRow when it happens during
 * a migrating walk, because a later walk returns the row. It is NOT caught when
 * it happens during the confirming sweep itself: the row is shifted out of that
 * sweep's own window, the sweep migrates nothing, and the same delete lowers the
 * exact count by one while the deleted row's id stays in the migrated set, so
 * the pass settles. A sweep can only prove what it actually returned.
 *
 * WHAT THIS DOES NOT FIX, stated so it is not read as a replacement for the
 * reconciliation. A row INSERTED below the cursor while this walk runs is still
 * missed, by construction, whichever way the page is addressed. Completeness is
 * decided by reconcileEveryRow sweeping until a walk finds nothing left to do,
 * not here.
 *
 * WHY THE ORDER CLAUSE IS LOAD BEARING. It is what makes the cursor mean
 * anything: `id > lastSeen` only walks the table once if rows arrive in
 * ascending id order. Postgres guarantees no row order without ORDER BY, and
 * the update inside this walk writes a new tuple version, which can change the
 * order a later scan returns. Without it a row can be skipped, which strands it
 * under a key nothing stores any more, or returned twice.
 *
 * WHY THE PAGE LENGTH ENDS THE WALK. A capped or empty read raises no error, so
 * the number of rows returned is the only honest signal that there is nothing
 * more to read.
 */
async function walkAndMigrate<Row extends { id: string }>(
  supabase: VaultPersistClient,
  table: string,
  columns: string,
  pageSize: number,
  migrated: Set<string>,
  migrateRow: (row: Row) => Promise<void>,
): Promise<void> {
  let lastSeenId: string | null = null;
  for (;;) {
    // The generated database types do not cover these tables, which is why the
    // client is structural. Naming the builder is what lets the cursor filter
    // be applied only on the pages that have one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = supabase.from(table).select(columns);
    if (lastSeenId !== null) query = query.gt("id", lastSeenId);
    const { data, error } = await query.order("id", { ascending: true }).limit(pageSize);
    if (error) throw error;

    const page = (data ?? []) as Row[];
    if (page.length === 0) break;

    for (const row of page) {
      if (!migrated.has(row.id)) await migrateRow(row);
    }

    if (page.length < pageSize) break;
    lastSeenId = page[page.length - 1].id;
  }
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
  //
  // WHY THESE READS ARE PAGED. Each used to be a single unpaged select.
  // PostgREST caps a select at a server-side maximum row count, and a capped
  // read is a SUCCESSFUL read: no error is raised on any path. A user holding
  // more rows than that cap therefore had every row past it left wrapped under
  // the OLD MEK while the meta write at the bottom of this function still
  // landed. Nothing in that sequence reports a problem, and because
  // recoverWithCode() mints a fresh MEK on every call, the key those rows are
  // still wrapped under is gone. Silent and permanent.
  //
  // WHAT PAGING CANNOT FIX ON ITS OWN, stated rather than hidden. A walk over a
  // stable order is still not immune to another session changing the table
  // while it runs. An INSERT below the cursor is missed and is written under the
  // OLD MEK by construction, whichever way the page is addressed. A DELETE from
  // a page already read used to shift every later row one place toward the
  // start, so a row fell between two windows and was never returned at all; the
  // walk pages by key rather than by offset, which removes that one and only
  // that one. The rest is handled by reconcileEveryRow below, which drives the
  // walks and keeps sweeping until a complete walk finds nothing left to
  // migrate.
  //
  // Distinct ids, not a running tally, and added only once the UPDATE has
  // returned the row it changed: a read that hands the same row back twice must
  // not be able to make the reconciliation agree, and neither must a write that
  // was refused at the row layer.
  const migratedConnectionIds = new Set<string>();
  const migrateConnection = async (conn: {
    id: string;
    encrypted_credentials: string;
    encrypted_label: string | null;
  }) => {
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
    const { data: connWritten, error: connErr } = await supabase
      .from("connections")
      .update(connUpdate)
      .eq("id", conn.id)
      .select("id");
    if (connErr) throw connErr;
    if (!connWritten || (connWritten as unknown[]).length !== 1) {
      throw new Error(rowNotWrittenMessage("connection", conn.id));
    }
    migratedConnectionIds.add(conn.id);
  };
  const walkConnections = () =>
    walkAndMigrate(
      supabase,
      "connections",
      "id, encrypted_credentials, encrypted_label",
      CONNECTION_PAGE_SIZE,
      migratedConnectionIds,
      migrateConnection,
    );

  // encrypted_payload uses the transactions subkey, which changes with the MEK.
  //
  // These updates are issued one at a time rather than through Promise.all. The
  // row that failed has to be nameable, and a batch that rejects partway leaves
  // the migrated set holding whichever siblings happened to settle first, which
  // is exactly the number the reconciliation below depends on being exact.
  const migratedTransactionIds = new Set<string>();
  const migrateTransaction = async (txn: { id: string; encrypted_payload: string }) => {
    const newPayload = await migrateTransactionCiphertext(txn.encrypted_payload);
    const { data: txnWritten, error: txnErr } = await supabase
      .from("encrypted_transactions")
      .update({ encrypted_payload: newPayload })
      .eq("id", txn.id)
      .select("id");
    if (txnErr) throw txnErr;
    if (!txnWritten || (txnWritten as unknown[]).length !== 1) {
      throw new Error(rowNotWrittenMessage("transaction", txn.id));
    }
    migratedTransactionIds.add(txn.id);
  };
  const walkTransactions = () =>
    walkAndMigrate(
      supabase,
      "encrypted_transactions",
      "id, encrypted_payload",
      TRANSACTION_PAGE_SIZE,
      migratedTransactionIds,
      migrateTransaction,
    );

  // MIGRATE AND RECONCILE, BEFORE THE META WRITE.
  //
  // This drives both walks and does not return until every row is proven to be
  // under the new MEK. It is the last instant at which the rotation can still be
  // FINISHED: the stored enc_mek_ciphertext and recovery_ciphertext still wrap
  // the OLD MEK, every row that has not moved still reads, and
  // clearMigrationKeys has not run, so a row this run missed is still under the
  // old subkeys and can simply be migrated now. After the write below, the same
  // gap is unrecoverable AND silent.
  //
  // WHAT THIS CATCHES. Completeness is decided by a sweep that finds nothing
  // left to migrate, so it covers a row missed by a reorder, by a concurrent
  // insert, or by the position shift a concurrent delete causes, without having
  // to enumerate those mechanisms. The exact count is kept alongside it for the
  // one case a sweep cannot see: the page size is only safe while it stays
  // strictly below the project's server-side maximum row count, and that cap is
  // a project setting outside version control, so lowering it under 500 would
  // make every walk end on the same short first page and agree with itself.
  //
  // Both tables are reconciled together rather than one after each walk,
  // deliberately: a row inserted into connections DURING the transaction walk
  // is caught only by a check that runs after both.
  await reconcileEveryRow(supabase, [
    {
      table: "connections",
      label: "connections",
      migrated: migratedConnectionIds,
      sweep: walkConnections,
    },
    {
      table: "encrypted_transactions",
      label: "transactions",
      migrated: migratedTransactionIds,
      sweep: walkTransactions,
    },
  ]);

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
