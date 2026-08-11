/**
 * Pure validation helpers for or-quiltt-session-revoke.
 *
 * Extracted from index.ts so both index.ts and jwt-binding.test.ts import
 * from one place. No Deno.serve, no network calls -- safe for deno test.
 *
 * checkTokenState accepts nowMs so callers can pass Date.now() (deterministic
 * in tests, real time in the handler).
 */

export interface PendingWidgetSession {
  id: string;
  platform_id: string;
  app_user_id: string;
  expires_at: string;
  used_at: string | null;
}

export type TokenCheckResult =
  | { ok: true; session: PendingWidgetSession }
  | { ok: false; status: 401; error: string; code: string };

export function checkTokenState(
  session: PendingWidgetSession | null,
  nowMs: number,
): TokenCheckResult {
  if (!session) {
    return { ok: false, status: 401, error: 'Invalid widget token', code: 'widget_token_unknown' };
  }
  if (session.used_at) {
    return { ok: false, status: 401, error: 'Invalid widget token', code: 'widget_token_used' };
  }
  if (new Date(session.expires_at).getTime() < nowMs) {
    return { ok: false, status: 401, error: 'Invalid widget token', code: 'widget_token_expired' };
  }
  return { ok: true, session };
}

/**
 * Decode the `userId` claim from a Quiltt session JWT without verifying the
 * signature (Quiltt's DELETE endpoint does the real verification). Returns null
 * for any malformed input rather than throwing.
 */
export function extractJwtUserId(sessionToken: string): string | null {
  try {
    const parts = sessionToken.split('.');
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(padded + '==='.slice((padded.length + 3) % 4)));
    if (typeof json.userId === 'string') return json.userId;
    return null;
  } catch {
    return null;
  }
}
