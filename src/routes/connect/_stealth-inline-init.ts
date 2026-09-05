/**
 * Inline Stealth Sync step for the /connect picker (DL-0347).
 *
 * Why this exists
 * ---------------
 * Two entries in the provider catalogue, `sparrow` and `xpub`, carry a
 * `connectUrl` and were therefore routed by navigating the whole document to
 * /connect/sparrow or /connect/bitcoin. That is a dead end for a host app.
 *
 * `or-link-success` , the only message that tells the opening app a
 * connection completed , is posted from the picker chunk. Navigating away
 * unloads that chunk, so neither destination page has any code path that can
 * notify the opener. The user could finish a perfect xpub connection there and
 * the host app would still sit until its own timeout and report failure.
 *
 * Keeping the user inside /connect and mounting the widget in an iframe is
 * what closes that loop: the picker stays loaded, so it can still post
 * `or-link-success` when the widget reports OR_STEALTH_ADD_COMPLETE.
 *
 * Relationship to _sparrow-init-handler.ts
 * ----------------------------------------
 * That helper does the same handshake for a signed-in OrangeRails user on the
 * standalone /connect/sparrow page, authenticating with a Supabase JWT. This
 * one is its host-app counterpart: the caller is a user of a consuming app who
 * has no OrangeRails account and therefore no JWT, so it authenticates with the
 * widget_token minted for the session. The guards are deliberately identical in
 * order and strictness; only the credential and the target window differ.
 */

import { STEALTH_PROTOCOL_VERSION } from "@/stealth/lib/postmessage";

/**
 * Catalogue slugs that must run as an inline step instead of a navigation.
 *
 * Verified against the deployed catalogue (105 providers): exactly three
 * entries carry a connectUrl , `sparrow`, `xpub` and `quiltt`. Only the first
 * two are Stealth Sync. `quiltt` is deliberately excluded: it needs a
 * server-minted Quiltt session before its page can render, which is a separate
 * exchange, and Bank has its own entry point in the host app.
 */
export const STEALTH_INLINE_SLUGS: ReadonlySet<string> = new Set(["sparrow", "xpub"]);

export function isStealthInlineSlug(slug: string | undefined | null): boolean {
  return typeof slug === "string" && STEALTH_INLINE_SLUGS.has(slug);
}

/** Minimal message-event shape. Accepts a real MessageEvent or a plain object in tests. */
export interface StealthReadyEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

/** Minimal frame handle. Accepts a real Window or a mock object in tests. */
export interface FrameHandle {
  postMessage: (msg: unknown, targetOrigin: string) => void;
}

export interface StealthInlineInitArgs {
  /** Consuming app's slug, from ?platform= on the /connect URL. */
  appSlug: string;
  /** The consuming app's own id for this user, from ?app_user_id=. */
  appUserId: string;
  /** Per-app HKDF subkey, base64. Required in widget mode. */
  credKeyB64: string;
  /**
   * Session credential minted server-to-server by the host app's backend.
   * Optional here on purpose: when it is absent the widget still renders and
   * the user still gets a real error from the edge function rather than a
   * silent hang, which is strictly better than the navigation dead end this
   * replaces.
   */
  widgetToken?: string;
  /** Origin the widget posts replies to. Always this document's own origin. */
  selfOrigin: string;
}

/**
 * Build the OR_STEALTH_INIT payload for the inline add step.
 *
 * `mode: "add"` and no `connection_id`: this step only ever creates a new
 * connection. Sync runs later, from the host app, against a connection that
 * already exists.
 *
 * No `access_token` and no `proxy_base_url`. A host-app user has no
 * OrangeRails JWT (auth mode B is unavailable) and the browser must never hold
 * a platform API key (auth mode A is unavailable). The widget_token path is
 * the only one open to this caller.
 */
export function buildStealthInlineInit(args: StealthInlineInitArgs) {
  const init: Record<string, unknown> = {
    type: "OR_STEALTH_INIT",
    protocol_version: STEALTH_PROTOCOL_VERSION,
    app_slug: args.appSlug,
    app_user_id: args.appUserId,
    mode: "add",
    or_stealth_key_b64: args.credKeyB64,
    return_callback_origin: args.selfOrigin,
  };
  // Only present the field when we actually have one. Sending
  // `widget_token: undefined` would serialise away anyway, but an explicit
  // absence keeps the posted payload honest about what it carries.
  if (args.widgetToken) init.widget_token = args.widgetToken;
  return init;
}

/**
 * Post OR_STEALTH_INIT to `frame` if `event` is a well-formed
 * OR_STEALTH_READY from that frame at our own origin.
 *
 * Guards, in order (any failure returns false and nothing is posted):
 *   1. event.source !== frame        -- rejects any other window
 *   2. event.origin !== selfOrigin   -- rejects cross-origin impersonation
 *   3. event.data.type !== 'OR_STEALTH_READY'
 *
 * The widget is same-origin here (it is served from /connect/stealth on this
 * very document's origin), so `selfOrigin` is both the expected sender origin
 * and the exact targetOrigin we post back to. It is never "*".
 *
 * Returns true when INIT was posted. The caller must stop calling this for the
 * same frame after the first true, so a second READY cannot re-INIT a widget
 * that is already running.
 */
export function sendStealthInitOnReady(
  event: StealthReadyEvent,
  frame: FrameHandle,
  args: StealthInlineInitArgs,
): boolean {
  if (event.source !== frame) return false;
  if (event.origin !== args.selfOrigin) return false;
  const msg = event.data as { type?: string };
  if (msg?.type !== "OR_STEALTH_READY") return false;

  frame.postMessage(buildStealthInlineInit(args), args.selfOrigin);
  return true;
}

/**
 * Classify a message from the inline widget.
 *
 * Applies the same source and origin guards as the READY path. A message that
 * fails either is not merely ignored as unknown, it is refused: returning
 * "ignore" for a spoofed ADD_COMPLETE is the point of this function.
 */
export function classifyStealthMessage(
  event: StealthReadyEvent,
  frame: FrameHandle,
  selfOrigin: string,
): "add-complete" | "error" | "ignore" {
  if (event.source !== frame) return "ignore";
  if (event.origin !== selfOrigin) return "ignore";
  const msg = event.data as { type?: string };
  if (msg?.type === "OR_STEALTH_ADD_COMPLETE") return "add-complete";
  if (msg?.type === "OR_STEALTH_ERROR") return "error";
  return "ignore";
}
