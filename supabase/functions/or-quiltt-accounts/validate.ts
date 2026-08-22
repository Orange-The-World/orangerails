/**
 * Pure validation helpers for or-quiltt-accounts.
 *
 * Extracted from index.ts so both index.ts and mode-select.test.ts import
 * from one place. No Deno.serve, no network calls -- safe for deno test.
 */

export interface AccountsBody {
  app_user_id?: string;
  quiltt_connection_id?: unknown;
}

export type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

export type QueryMode = 'single_connection' | 'profile_wide';

export function validateBody(body: AccountsBody): ValidationResult {
  if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
    return { ok: false, status: 400, error: 'app_user_id required (string, <=256 chars)' };
  }
  return { ok: true };
}

export function validatePlatformAuth(mode: string): ValidationResult {
  if (mode !== 'platform') {
    return { ok: false, status: 403, error: 'platform API key required' };
  }
  return { ok: true };
}

/** Returns the query mode based on the trimmed quiltt_connection_id. */
export function resolveQueryMode(body: AccountsBody): QueryMode {
  const connectionId =
    typeof body.quiltt_connection_id === 'string'
      ? body.quiltt_connection_id.trim()
      : '';
  return connectionId ? 'single_connection' : 'profile_wide';
}
