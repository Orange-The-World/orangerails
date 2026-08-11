/**
 * Pure validation helpers for or-quiltt-session.
 *
 * Extracted from index.ts so both index.ts and validate.test.ts import
 * from one place. No Deno.serve, no network calls -- safe for deno test.
 */

export interface SessionBody {
  app_user_id?: string;
  mode?: string;
  existing_connection_id?: string;
}

export type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

export function validateBody(body: SessionBody): ValidationResult {
  if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
    return { ok: false, status: 400, error: 'app_user_id required (string, <=256 chars)' };
  }
  const mode = body.mode ?? 'link';
  if (mode !== 'link' && mode !== 'reconnect') {
    return { ok: false, status: 400, error: "mode must be 'link' or 'reconnect'" };
  }
  if (mode === 'reconnect' && !body.existing_connection_id) {
    return { ok: false, status: 400, error: "existing_connection_id required when mode='reconnect'" };
  }
  return { ok: true };
}
