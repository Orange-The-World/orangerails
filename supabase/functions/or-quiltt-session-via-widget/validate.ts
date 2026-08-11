/**
 * Pure validation helpers for or-quiltt-session-via-widget.
 *
 * Extracted from index.ts so both index.ts and validate.test.ts import
 * from one place. No Deno.serve, no network calls -- safe for deno test.
 *
 * checkTokenState accepts nowMs so callers can pass Date.now() (deterministic
 * in tests, real time in the handler).
 */

export type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

export interface PendingWidgetSession {
  id: string;
  platform_id: string;
  app_user_id: string;
  expires_at: string;
  used_at: string | null;
}

export type TokenCheckResult =
  | { ok: true; session: PendingWidgetSession }
  | { ok: false; status: 401; error: string };

export function validateBody(body: { widget_token?: unknown }): ValidationResult {
  if (!body.widget_token || typeof body.widget_token !== 'string') {
    return { ok: false, status: 400, error: 'widget_token required' };
  }
  return { ok: true };
}

export function checkTokenState(
  session: PendingWidgetSession | null,
  nowMs: number,
): TokenCheckResult {
  if (!session) return { ok: false, status: 401, error: 'Invalid widget token' };
  if (session.used_at) return { ok: false, status: 401, error: 'Invalid widget token' };
  if (new Date(session.expires_at).getTime() < nowMs) {
    return { ok: false, status: 401, error: 'Invalid widget token' };
  }
  return { ok: true, session };
}
