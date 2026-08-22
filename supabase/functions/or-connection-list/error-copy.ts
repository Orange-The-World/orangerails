/**
 * DL-1490: turn the stored error code into something a person can read.
 *
 * or-sync already returns full customer-facing copy when a sync fails, but a
 * sync response is a MOMENT. or-connection-list is the STATE, and it returned
 * only the stored column: `UPSTREAM_AUTH_FAILED:b1f8c74eef0ed7be`. There is no
 * sentence in that. For any failure that is not happening right now, which is
 * every failure a support person looks at, the consumer had nothing to show
 * unless it kept its own copy of our error vocabulary.
 *
 * This resolves the code through the same catalog or-sync uses, so the two
 * surfaces cannot drift apart.
 */
import { lookupErrorCopy } from '../_shared/error-catalog.ts';

/**
 * The exact shape or-sync and or-quiltt-sync persist: CODE:correlationId.
 *
 * Anchored and deliberately strict. On a non-sink platform the column holds
 * ciphertext, and this must never mistake a ciphertext for a code and hand a
 * caller a confident wrong sentence. The sink-mode gate below is the primary
 * guard; this shape check is the second one.
 */
const STORED_ERROR = /^([A-Z][A-Z0-9_]*):([0-9a-f]{8,64})$/;

export interface ErrorCopyFields {
  error:          string;
  correlation_id: string;
  message:        string;
  detail:         string;
  action:         string | null;
  help_url:       string;
}

/**
 * Additive by construction. Every existing field is preserved untouched and
 * the new ones are only ever added, so a client reading `encrypted_last_error`
 * or `status` today keeps working unchanged.
 *
 * Returns the row as-is when the platform is not sink mode (the column is
 * encrypted and not ours to interpret), when there is no stored error, or when
 * the value does not have the shape we write.
 */
export function withErrorCopy<T extends Record<string, unknown>>(
  row: T,
  sinkMode: boolean,
): T | (T & ErrorCopyFields) {
  if (!sinkMode) return row;

  const raw = row.encrypted_last_error;
  if (typeof raw !== 'string' || raw.length === 0) return row;

  const m = STORED_ERROR.exec(raw);
  if (!m) return row;

  const copy = lookupErrorCopy(m[1]);
  return {
    ...row,
    error:          m[1],
    correlation_id: m[2],
    message:        copy.title,
    detail:         copy.body,
    action:         copy.action,
    help_url:       copy.help_url,
  };
}
