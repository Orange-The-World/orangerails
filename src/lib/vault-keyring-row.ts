/**
 * Tolerant read of the caller's own keyring columns.
 *
 * WHY THIS IS ITS OWN READ. The main vault meta select in the app stays exactly
 * as it was before envelope v3, so a project that does not carry
 * user_vault_meta.keyring_ciphertext yet cannot have its whole vault load broken
 * by a column it never asked about. The keyring columns are asked for here
 * instead, on their own, and the answer is one of three things:
 *
 *   ok             The read worked. Either value may be null: a vault row exists
 *                  before any keyring has been sealed.
 *   column-absent  Postgres said the column does not exist (SQLSTATE 42703). That
 *                  is the ONLY error that means "this project has no keyrings
 *                  yet", so it is read as no keyring.
 *   error          Anything else: a network failure, a denied read, no row, a
 *                  different Postgres error. It is NEVER read as "no keyring".
 *                  An owner who holds a keyring and is mistaken for one who does
 *                  not would be granted under the wrong envelope, so callers stop.
 *
 * DELETE THIS FILE once every project the app runs against carries the column:
 * fold both columns back into the main select and remove the column-absent case.
 * Nothing else depends on it staying.
 */

/** SQLSTATE undefined_column. PostgREST forwards it as the error code. */
export const UNDEFINED_COLUMN_CODE = "42703";

/** The two columns this read asks for, and nothing else. */
export const KEYRING_ROW_COLUMNS = "keyring_ciphertext, keyring_epoch";

export type OwnKeyringRow =
  | {
      status: "ok";
      keyringCiphertext: string | null;
      keyringEpoch: number | string | null;
    }
  | { status: "column-absent" }
  | { status: "error"; error: unknown };

/** The slice of the Supabase client this read uses, so it can be stubbed. */
export interface KeyringRowClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): {
        single(): PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
}

/**
 * Read keyring_ciphertext and keyring_epoch for one user's own vault row.
 * Never throws: every failure comes back as a status the caller must handle.
 */
export async function readOwnKeyringRow(
  supabase: KeyringRowClient,
  userId: string,
): Promise<OwnKeyringRow> {
  let result: { data: unknown; error: unknown };
  try {
    result = await supabase
      .from("user_vault_meta")
      .select(KEYRING_ROW_COLUMNS)
      .eq("user_id", userId)
      .single();
  } catch (error) {
    return { status: "error", error };
  }

  const { data, error } = result;
  if (error) {
    const code = (error as { code?: unknown }).code;
    if (code === UNDEFINED_COLUMN_CODE) return { status: "column-absent" };
    return { status: "error", error };
  }

  // No error and no row is not "no keyring": it is a read that returned nothing
  // to reason about, so it stops the caller like any other failure.
  if (!data || typeof data !== "object") {
    return { status: "error", error: new Error("The vault row was not returned.") };
  }

  const row = data as Record<string, unknown>;
  const ciphertext = row.keyring_ciphertext;
  const epoch = row.keyring_epoch;
  return {
    status: "ok",
    keyringCiphertext: typeof ciphertext === "string" ? ciphertext : null,
    keyringEpoch: typeof epoch === "number" || typeof epoch === "string" ? epoch : null,
  };
}
