/**
 * Pure validation helpers for or-quiltt-disconnect.
 *
 * Extracted from index.ts so both index.ts and validate.test.ts import
 * from one place. No Deno.serve, no network calls -- safe for deno test.
 */

export interface DisconnectBody {
  app_user_id?: string;
  connection_id?: unknown;
  full_unlink?: unknown;
}

export type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

export function validateBody(body: DisconnectBody): ValidationResult {
  if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
    return { ok: false, status: 400, error: 'app_user_id required (string, <=256 chars)' };
  }
  if (
    body.connection_id !== undefined &&
    (typeof body.connection_id !== 'string' || (body.connection_id as string).length > 256)
  ) {
    return { ok: false, status: 400, error: 'connection_id must be a string <=256 chars' };
  }
  return { ok: true };
}
