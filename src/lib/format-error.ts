/**
 * Normalize any thrown value into a readable string for UI display.
 *
 * Handles the common shapes we see:
 * - Native `Error` instances (most thrown values)
 * - Supabase `PostgrestError` (has .message, .details, .hint, .code but is NOT an Error)
 * - Supabase `AuthError` (has .message but is not always an Error)
 * - Plain strings (rare but happens)
 * - Objects with a { message } field
 * - Anything else → JSON-stringified so at least something useful shows
 */
export function formatError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;

  if (err && typeof err === 'object') {
    const e = err as {
      message?: string;
      error?: string;
      details?: string;
      hint?: string;
      code?: string | number;
    };

    // Prefer the most specific messaging we can find.
    const parts: string[] = [];
    if (e.message) parts.push(e.message);
    if (e.details && e.details !== e.message) parts.push(e.details);
    if (e.hint && e.hint !== e.message) parts.push(`Hint: ${e.hint}`);
    if (e.code) parts.push(`(code: ${e.code})`);

    if (parts.length > 0) return parts.join(' — ');

    // Fallback: stringify rather than show "[object Object]".
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  return String(err);
}
