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
 * PROVENANCE, stated plainly because it bounds what this function can promise.
 * The three attributes currently reach us from Quiltt's React SDK
 * onExitSuccess callback, forwarded by the browser in the POST body. The HMAC
 * key in computeAccountFingerprint prevents an offline oracle: nobody can grind
 * candidate keys and recognise a fingerprint without it. It does NOT stop a
 * caller from submitting different attribute values than the ones the bank
 * reported, because the caller supplies the input. Dedup is therefore only as
 * stable as the caller is consistent. Reading these three fields server-side
 * from Quiltt, and preferring a stable institution id over the display name,
 * is tracked separately and is the durable fix; this normalisation reduces the
 * blast radius in the meantime and is required either way.
 */

export interface QuilttAccountAttrs {
  institution: string;
  mask: string;
  kind: string;
}

/**
 * Normalise one attribute before it enters the canonical key.
 *
 * Trims surrounding whitespace, collapses internal whitespace runs to a single
 * space, and upper-cases. Every field gets the same treatment: the previous
 * version upper-cased `kind` only, so "Mercury", "mercury" and "Mercury "
 * produced three different fingerprints for one real account, which is exactly
 * the duplicate-row symptom this key exists to prevent.
 *
 * Case folding uses toUpperCase() rather than toLowerCase() because
 * lower-casing loses information for a small number of scripts where the round
 * trip is not stable. Unicode normalisation is NFKC so that visually identical
 * strings from different sources fold together.
 */
function normaliseAttr(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toUpperCase();
}

/**
 * Build the canonical account key for a Quiltt connection.
 *
 * Format: `${institution}|${mask}|${kind}`, pipe-separated, every field
 * normalised by normaliseAttr above.
 *
 * Each field must be a non-empty string with no pipe character, checked AFTER
 * normalisation so that a field of only whitespace fails rather than becoming
 * an empty segment. Throws a descriptive error on violation so callers fail
 * loudly rather than silently producing an ambiguous or colliding key.
 */
export function quilttCanonicalAccountKey({ institution, mask, kind }: QuilttAccountAttrs): string {
  const normalised: Record<string, string> = {};

  for (const [name, value] of [
    ['institution', institution],
    ['mask', mask],
    ['kind', kind],
  ] as [string, string][]) {
    if (typeof value !== 'string') {
      throw new Error(
        `[quiltt-account-key] ${name} is required and must be a non-empty string`,
      );
    }

    const clean = normaliseAttr(value);

    if (!clean) {
      throw new Error(
        `[quiltt-account-key] ${name} is required and must be a non-empty string`,
      );
    }
    if (clean.includes('|')) {
      throw new Error(
        `[quiltt-account-key] ${name} must not contain the pipe character (|)`,
      );
    }

    normalised[name] = clean;
  }

  return `${normalised.institution}|${normalised.mask}|${normalised.kind}`;
}
