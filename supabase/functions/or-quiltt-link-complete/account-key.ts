/**
 * Quiltt canonical account key.
 *
 * The canonical key is derived from stable, provider-supplied account
 * attributes: institution name, last-four account mask, and account kind
 * (CHECKING/SAVINGS/etc). It INTENTIONALLY excludes quiltt_connection_id,
 * which changes on every re-link event even when the underlying bank account
 * is the same. Using it would break re-link dedup -- each reconnect would
 * create a new fingerprint and a duplicate connections row.
 *
 * This is the value passed as `canonicalAccountKey` to
 * computeAccountFingerprint for all Quiltt connections. The format is
 * permanent for key version v1: changing it silently invalidates all
 * existing fingerprints and breaks dedup for every existing row. Any change
 * must be preceded by a coordinated re-fingerprinting migration (same policy
 * as the OR_ACCT_FINGERPRINT_KEY_V1 rotation documented in account-fingerprint.ts).
 *
 * The three attributes come from Quiltt's React SDK onExitSuccess callback
 * and are forwarded by the browser in the POST body. The HMAC key makes the
 * fingerprint secure even though these values travel from the client.
 */

export interface QuilttAccountAttrs {
  institution: string;
  mask: string;
  kind: string;
}

/**
 * Build the canonical account key for a Quiltt connection.
 *
 * Format: `${institution}|${mask}|${kind}` (pipe-separated, uppercase kind).
 * Each field must be a non-empty string with no pipe character.
 * Throws a descriptive error on violation so callers fail loudly rather than
 * silently producing an ambiguous or colliding key.
 *
 * `kind` is normalised to uppercase so that CHECKING and checking do not
 * produce different fingerprints for the same real account.
 */
export function quilttCanonicalAccountKey({ institution, mask, kind }: QuilttAccountAttrs): string {
  for (const [name, value] of [
    ['institution', institution],
    ['mask', mask],
    ['kind', kind],
  ] as [string, string][]) {
    if (!value || typeof value !== 'string') {
      throw new Error(
        `[quiltt-account-key] ${name} is required and must be a non-empty string`,
      );
    }
    if (value.includes('|')) {
      throw new Error(
        `[quiltt-account-key] ${name} must not contain the pipe character (|); got: ${name}=${JSON.stringify(value)}`,
      );
    }
  }
  return `${institution}|${mask}|${kind.toUpperCase()}`;
}
