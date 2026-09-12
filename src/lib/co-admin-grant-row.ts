/**
 * Reading a co-admin grant row without trusting its shape.
 *
 * A row of public.wrapped_data_keys carries the key material for exactly one
 * grant, and there are now two shapes it can be in:
 *
 *   envelope v2  wrapped_ciphertext holds the 64 byte subkey blob wrapped to
 *                the recipient. wrapped_cak and coadmin_keyring_ciphertext
 *                are null.
 *   envelope v3  wrapped_cak holds the per grant co-admin key wrapped to the
 *                recipient, coadmin_keyring_ciphertext holds the sealed
 *                keyring projection, and wrapped_ciphertext is null because a
 *                v3 grant has no 64 byte blob to put there.
 *
 * Both shapes are insertable and readable at the same time, on purpose: a
 * recipient on v3 has to be able to consume a v2 grant from an owner still on
 * v2. That is why migration 20260828183000 drops NOT NULL on
 * wrapped_ciphertext and replaces it with the weakest rule that still refuses
 * an empty grant, num_nonnulls(wrapped_ciphertext, wrapped_cak) >= 1.
 *
 * THE VERSION IS DECIDED BY WHICH COLUMNS ARE PRESENT, NEVER BY THE ALGORITHM
 * STRING. The comment that migration puts on wrapped_ciphertext says so
 * outright: the algorithm column names the envelope version by convention,
 * nothing in the database enforces that agreement, and nothing may be added
 * that does. A reader that trusts the string would be trusting a value the
 * database never checked.
 *
 * FAIL CLOSED. Anything that is not exactly one complete shape returns null
 * and the caller skips the workspace. That covers a row with neither shape, a
 * half written v3 row, and a row carrying both shapes at once. None of those
 * is something a writer produces, so the safe reading of one is that we do not
 * know what we are looking at, and key material is not where you guess.
 */

/**
 * The columns a co-admin grant read must ask for.
 *
 * Kept next to the function that interprets them so a reader cannot silently
 * select less than the shape rule needs: a select that omits wrapped_cak makes
 * every v3 grant look like an empty row.
 */
export const CO_ADMIN_GRANT_COLUMNS =
  "wrapped_ciphertext, grant_sig, wrapped_cak, coadmin_keyring_ciphertext";

/**
 * One co-admin grant, in whichever envelope it was written.
 *
 * grantSigB64 stays nullable on both shapes. It is NOT NULL in the database
 * today, so a null here means something is wrong with the row rather than that
 * a signature is optional, and the consume path already refuses to decrypt
 * without one. Carrying it through rather than filtering on it here keeps that
 * refusal loud instead of turning it into a silently missing workspace.
 */
export type CoAdminGrant =
  | {
      version: 2;
      wrappedCiphertextB64: string;
      grantSigB64: string | null;
    }
  | {
      version: 3;
      wrappedCakB64: string;
      coadminKeyringCiphertextB64: string;
      grantSigB64: string | null;
    };

/**
 * A column counts as present only when it is a non empty string.
 *
 * null, undefined, a non string and the empty string are all absent. The empty
 * string matters: base64 of nothing is not key material, and letting it
 * through would put a value that cannot be unwrapped into a field the rest of
 * the code treats as a wrapped blob.
 */
function presentString(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;
  return value;
}

/**
 * Turn a wrapped_data_keys row into a grant, or into null if it is not exactly
 * one usable shape.
 *
 * Takes unknown rather than a generated row type on purpose. The value coming
 * back from PostgREST is whatever the database returned, and the generated
 * types have already been wrong about this table: they declared
 * wrapped_ciphertext as a plain string while the schema was about to allow
 * null, and they were missing grant_sig entirely. A guard that trusts the type
 * it is guarding against is not a guard.
 */
export function readCoAdminGrant(row: unknown): CoAdminGrant | null {
  if (row === null || typeof row !== "object") return null;
  const fields = row as Record<string, unknown>;

  const wrappedCiphertextB64 = presentString(fields, "wrapped_ciphertext");
  const wrappedCakB64 = presentString(fields, "wrapped_cak");
  const coadminKeyringCiphertextB64 = presentString(fields, "coadmin_keyring_ciphertext");
  const grantSigB64 = presentString(fields, "grant_sig");

  // Both envelopes at once. The database permits it (the presence rule only
  // asks for at least one), no writer produces it, and choosing one of the two
  // would be choosing which key material to trust. Refuse.
  const hasV3Column = wrappedCakB64 !== null || coadminKeyringCiphertextB64 !== null;
  if (wrappedCiphertextB64 !== null && hasV3Column) return null;

  if (wrappedCiphertextB64 !== null) {
    return { version: 2, wrappedCiphertextB64, grantSigB64 };
  }

  // A v3 grant needs both halves. The wrapped co-admin key alone opens
  // nothing, and the sealed keyring alone cannot be opened.
  if (wrappedCakB64 !== null && coadminKeyringCiphertextB64 !== null) {
    return {
      version: 3,
      wrappedCakB64,
      coadminKeyringCiphertextB64,
      grantSigB64,
    };
  }

  return null;
}
