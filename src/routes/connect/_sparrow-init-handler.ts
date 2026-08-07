/**
 * Sparrow INIT exchange helper (DL-0448).
 *
 * Extracted from sparrow.tsx so the source/origin/type guards and the
 * OR_STEALTH_INIT payload can be covered by vitest unit tests without a
 * browser, a real Supabase session, or a running vault.
 *
 * Called by handleLaunch in sparrow.tsx when isUnlocked is true and the
 * popup has been opened at /connect/stealth.
 */

import { STEALTH_PROTOCOL_VERSION } from "@/stealth/lib/postmessage";

/** Minimal message-event shape. Accepts a real MessageEvent or a plain object in tests. */
export interface StealthReadyEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

/** Minimal popup handle. Accepts a real Window or a mock object in tests. */
export interface PopupHandle {
  postMessage: (msg: unknown, targetOrigin: string) => void;
}

/** Subset of a Supabase Session that we actually need. */
export interface AuthSession {
  user: { id: string };
  access_token: string;
}

/**
 * Sends OR_STEALTH_INIT to `popup` if `event` is a well-formed
 * OR_STEALTH_READY from `popup` at `selfOrigin`.
 *
 * Guards checked in order (any failure returns false, nothing is posted):
 *   1. event.source !== popup  -- rejects messages from any other window
 *   2. event.origin !== selfOrigin  -- rejects cross-origin impersonation
 *   3. event.data.type !== 'OR_STEALTH_READY'  -- ignores other message types
 *   4. getSession() returns null  -- no active auth session
 *   5. getStealthKey() throws  -- crypto error, non-fatal, warning logged
 *
 * Returns true when OR_STEALTH_INIT was posted, false in all other cases.
 * The caller is responsible for de-duplicating: remove the listener on the
 * first true return so this is never called again for the same popup.
 */
export async function sendInitOnReady(
  event: StealthReadyEvent,
  popup: PopupHandle,
  selfOrigin: string,
  getSession: () => Promise<AuthSession | null>,
  getStealthKey: () => Promise<string>,
): Promise<boolean> {
  if (event.source !== popup) return false;
  if (event.origin !== selfOrigin) return false;
  const msg = event.data as { type?: string };
  if (msg?.type !== "OR_STEALTH_READY") return false;

  try {
    const session = await getSession();
    if (!session) return false;
    const keyB64 = await getStealthKey();
    popup.postMessage(
      {
        type: "OR_STEALTH_INIT",
        protocol_version: STEALTH_PROTOCOL_VERSION,
        app_slug: "or",
        app_user_id: session.user.id,
        mode: "add",
        or_stealth_key_b64: keyB64,
        return_callback_origin: selfOrigin,
        access_token: session.access_token,
        gap_limit: 250,
      },
      selfOrigin,
    );
    return true;
  } catch (err) {
    // Non-fatal: popup is open and falls through to DirectLoadCard.
    console.warn("[sparrow] Could not send OR_STEALTH_INIT:", err);
    return false;
  }
}
