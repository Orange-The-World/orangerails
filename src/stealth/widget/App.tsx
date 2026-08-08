/**
 * Stealth Sync widget , top-level component.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §6.1.
 * Protocol contract: src/stealth/lib/postmessage.ts (read-only).
 *
 * Lifecycle:
 *   1. On mount, post OR_STEALTH_READY to window.opener (origin '*' until
 *      INIT arrives and we learn the trusted origin from return_callback_origin).
 *   2. Listen for OR_STEALTH_INIT. Validate:
 *        - protocol_version
 *        - return_callback_origin against the allowlist (origins env)
 *        - event.origin matches return_callback_origin
 *        - seal_mode determines key requirements:
 *            widget mode (absent/'widget'): or_stealth_key_b64 required
 *            app mode ('app'): or_stealth_key_b64 must be absent, AND the
 *            INIT is refused outright until the app-mode routes exist
 *   3. Once INIT is captured, render one of four route stubs based on
 *      init.mode: 'add' | 'sync' | 'list' | 'delete'.
 *
 * Fail closed on purpose, not by accident: the four routes below are
 * widget-mode routes, they seal with a key. An app-mode INIT carries no key,
 * so admitting it here and letting it reach a route would call the seal path
 * with an undefined key. That is refused at step 2 rather than relying on a
 * base64 decoder to throw further down. Delete the refusal one route at a time,
 * as each app-mode route lands with a real keyless path.
 *
 * This is a milestone-1 stub: each route renders a placeholder. Subsequent
 * milestones implement the real flows (BIP32 derive, BIP158 match, scan, etc.).
 */

import { useEffect, useMemo, useState } from "react";
import {
  STEALTH_PROTOCOL_VERSION,
  type StealthInitMessage,
  type StealthReadyMessage,
  type StealthErrorMessage,
} from "@/stealth/lib/postmessage";
import { AddRoute } from "./routes/add";
import { SyncRoute } from "./routes/sync";
import { ListRoute } from "./routes/list";
import { DeleteRoute } from "./routes/delete";
import { DirectLoadCard } from "./components/DirectLoadCard";
import { StealthInitProvider } from "./StealthInitContext";
import { parseAllowedOrigins, isAllowedOrigin } from "./allowed-origins";

const DIRECT_LOAD_GRACE_MS = 1500;

/**
 * Modes that have a real app-mode (keyless) implementation. Empty today:
 * every route in this widget is a widget-mode route that seals with a key.
 * Add a mode here only when its keyless path exists and is tested.
 */
const APP_MODE_IMPLEMENTED_MODES: ReadonlySet<string> = new Set<string>();



/**
 * Resolve the most specific origin we can target the READY message at.
 *
 * Order of preference:
 *  1. Explicit `?parent_origin=https://app.example.com` query parameter on the
 *     widget URL. Opener apps that want strict origin targeting on READY can
 *     append this to the popup URL.
 *  2. `document.referrer` origin if set. Browsers preserve this when the
 *     popup is opened without a `noreferrer` flag.
 *  3. Fall back to `"*"`. READY carries no secrets (type + protocol_version
 *     only). The INIT handshake is where the real origin allowlist is enforced.
 */
function pickReadyTargetOrigin(): string {
  if (typeof window === "undefined") return "*";
  try {
    const params = new URLSearchParams(window.location.search);
    const declared = params.get("parent_origin");
    if (declared && /^https?:\/\/[^/?#]+$/.test(declared)) return declared;
  } catch {
    // window.location unavailable or malformed; fall through.
  }
  try {
    if (document.referrer) {
      const referrerOrigin = new URL(document.referrer).origin;
      if (referrerOrigin && referrerOrigin !== "null") return referrerOrigin;
    }
  } catch {
    // referrer missing or unparsable; fall through.
  }
  return "*";
}

function postReady(target: Window | null) {
  if (!target) return;
  const ready: StealthReadyMessage = {
    type: "OR_STEALTH_READY",
    protocol_version: STEALTH_PROTOCOL_VERSION,
  };
  target.postMessage(ready, pickReadyTargetOrigin());
}

function postError(
  target: Window | null,
  origin: string,
  err: Pick<StealthErrorMessage, "code" | "message" | "retryable">,
) {
  if (!target) return;
  const msg: StealthErrorMessage = {
    type: "OR_STEALTH_ERROR",
    code: err.code,
    message: err.message,
    retryable: err.retryable,
  };
  target.postMessage(msg, origin);
}

/** Pick the most likely parent: window.opener (popup case) or window.parent
 *  (iframe case, when it differs from window itself). */
function pickParentWindow(): Window | null {
  if (typeof window === "undefined") return null;
  if (window.opener) return window.opener as Window;
  if (window.parent && window.parent !== window) return window.parent;
  return null;
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
        <h1 className="text-lg font-semibold text-destructive">Stealth Sync widget error</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

export function App() {
  const allowlist = useMemo(parseAllowedOrigins, []);
  const [init, setInit] = useState<StealthInitMessage | null>(null);
  const [parent, setParent] = useState<Window | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Initial value: if there is no opener AND no parent frame (or we are on the
  // server where window is undefined), no postMessage INIT can ever arrive, so
  // we are in a direct-load situation from the start. Otherwise wait for the
  // grace window to give the real parent a chance to handshake.
  const [awaitingInit, setAwaitingInit] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    if (window.opener === null && window.parent === window) return false;
    return true;
  });

  useEffect(() => {
    // Send READY once on mount, to whichever window opened us. In the
    // popup case that is window.opener; in the iframe case it is
    // window.parent. Origin '*' is acceptable here because READY carries
    // no secrets; we learn the trusted origin from INIT.
    const parentWin = pickParentWindow();
    postReady(parentWin);

    const handler = (event: MessageEvent) => {
      const data = event.data as Partial<StealthInitMessage> | undefined;
      if (!data || data.type !== "OR_STEALTH_INIT") return;

      // Origin allowlist check (master plan §4.4).
      if (!isAllowedOrigin(event.origin, allowlist)) {
        setError(`Origin not allowed: ${event.origin}`);
        postError(event.source as Window | null, event.origin, {
          code: "ORIGIN_NOT_ALLOWED",
          message: `Origin ${event.origin} is not on the Stealth Sync allowlist.`,
          retryable: false,
        });
        return;
      }

      // The sender's claimed return_callback_origin must match the actual event origin.
      if (data.return_callback_origin !== event.origin) {
        setError("return_callback_origin mismatch");
        postError(event.source as Window | null, event.origin, {
          code: "ORIGIN_NOT_ALLOWED",
          message: "return_callback_origin does not match the sender origin.",
          retryable: false,
        });
        return;
      }

      if (data.protocol_version !== STEALTH_PROTOCOL_VERSION) {
        setError("protocol version mismatch");
        postError(event.source as Window | null, event.origin, {
          code: "PROTOCOL_VERSION_MISMATCH",
          message: `Widget speaks protocol v${STEALTH_PROTOCOL_VERSION}; got v${String(data.protocol_version)}.`,
          retryable: false,
        });
        return;
      }

      // Determine seal mode. Anything other than the explicit string 'app'
      // resolves to widget mode, preserving backward compatibility.
      const sealMode = data.seal_mode === "app" ? "app" : "widget";

      // Validate required fields shared by both modes.
      if (
        typeof data.app_slug !== "string" ||
        typeof data.app_user_id !== "string" ||
        (data.mode !== "add" &&
          data.mode !== "sync" &&
          data.mode !== "list" &&
          data.mode !== "delete")
      ) {
        setError("INIT message is missing required fields");
        postError(event.source as Window | null, event.origin, {
          code: "INTERNAL",
          message: "OR_STEALTH_INIT missing one of: app_slug, app_user_id, mode.",
          retryable: false,
        });
        return;
      }

      // Key enforcement: gated on seal mode.
      if (sealMode === "app") {
        // Defense in depth: app mode must not carry a key. The TypeScript type
        // StealthInitAppMessage types or_stealth_key_b64 as `never`, and
        // openStealthWidget refuses it at the sender. This guard catches any
        // runtime bypass of both.
        if (typeof data.or_stealth_key_b64 === "string") {
          setError("seal_mode=app must not carry or_stealth_key_b64");
          postError(event.source as Window | null, event.origin, {
            code: "INTERNAL",
            message:
              "seal_mode='app' must not include or_stealth_key_b64. The widget receives no key in app mode.",
            retryable: false,
          });
          return;
        }

        // Refuse an app-mode INIT for any mode whose keyless route does not
        // exist yet. Every route below is a widget-mode route that seals with
        // a key, so admitting this INIT would dispatch a keyless session into
        // key-holding crypto. Refuse here, explicitly, before route dispatch.
        if (!APP_MODE_IMPLEMENTED_MODES.has(data.mode)) {
          setError(`seal_mode='app' is not implemented for mode '${data.mode}'`);
          postError(event.source as Window | null, event.origin, {
            code: "INTERNAL",
            message: `seal_mode='app' is not implemented for mode '${data.mode}'. The widget refuses to run a key-holding route with no key.`,
            retryable: false,
          });
          return;
        }
      } else {
        // Widget mode: a real, non-empty key is required.
        if (
          typeof data.or_stealth_key_b64 !== "string" ||
          data.or_stealth_key_b64.length === 0
        ) {
          setError("INIT message is missing or_stealth_key_b64");
          postError(event.source as Window | null, event.origin, {
            code: "INTERNAL",
            message: "OR_STEALTH_INIT missing or_stealth_key_b64 (required in widget mode).",
            retryable: false,
          });
          return;
        }
      }

      // Optional gap_limit: reject explicitly rather than silently coercing.
      if (data.gap_limit !== undefined) {
        const g = data.gap_limit;
        if (!Number.isInteger(g) || g < 1 || g > 1000) {
          setError("INIT gap_limit out of range");
          postError(event.source as Window | null, event.origin, {
            code: "INVALID_GAP_LIMIT",
            message: `OR_STEALTH_INIT gap_limit must be an integer between 1 and 1000; got ${String(g)}.`,
            retryable: false,
          });
          return;
        }
      }

      // sync / list / delete need an existing connection_id. Add does not.
      if (data.mode !== "add" && typeof data.connection_id !== "string") {
        setError("INIT mode requires a connection_id");
        postError(event.source as Window | null, event.origin, {
          code: "CONNECTION_NOT_FOUND",
          message: `Mode '${data.mode}' requires connection_id in OR_STEALTH_INIT.`,
          retryable: false,
        });
        return;
      }

      setInit(data as StealthInitMessage);
      // Prefer the actual sending window (event.source). Fall back to the
      // pre-resolved opener/parent. This ensures replies always go to the
      // window that posted INIT.
      setParent((event.source as Window | null) ?? parentWin);
      setAwaitingInit(false);
      setError(null);
    };

    window.addEventListener("message", handler);

    // Direct-load fallback: if no INIT arrives within the grace window AND
    // we have no opener and no parent frame, render the friendly direct-load
    // card instead of the indefinite "Loading..." placeholder.
    const graceTimer = window.setTimeout(() => {
      setAwaitingInit(false);
    }, DIRECT_LOAD_GRACE_MS);

    return () => {
      window.removeEventListener("message", handler);
      window.clearTimeout(graceTimer);
    };
  }, [allowlist]);

  if (error) {
    return <ErrorCard message={error} />;
  }

  if (!init) {
    // No INIT yet. While the grace window is still open (awaitingInit) we wait,
    // giving a real parent time to finish the handshake. Once it expires with no
    // INIT, none is coming, so show the direct-load guidance regardless of whether
    // an opener or parent frame exists. This is the bare /connect/sparrow case
    // (#451): the Sparrow route opens this widget in a popup with a non-null
    // window.opener but never sends OR_STEALTH_INIT, so the old opener/parent gate
    // left the popup stuck on the waiting state forever. A real parent that does
    // send INIT sets init and supersedes this card, and the server render still
    // shows the card because awaitingInit starts false there. Requirement 2:
    // popup and same-tab paths now reach the same explained state.
    if (!awaitingInit) {
      return <DirectLoadCard />;
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-foreground">Stealth Sync</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Waiting for the parent app to send OR_STEALTH_INIT...
          </p>
        </div>
      </div>
    );
  }

  // Every route below is a widget-mode route: it seals with a key. App mode is
  // already refused at INIT, so this is unreachable today, and that is exactly
  // why it is here. It carries the invariant into the type system (the route
  // context takes a widget-mode init), so a future edit that admits app mode at
  // INIT without shipping a keyless route stops here instead of calling the
  // seal path with no key.
  if (init.seal_mode === "app") {
    return (
      <ErrorCard
        message={`Stealth Sync has no key in app mode, and mode '${init.mode}' has no keyless route yet.`}
      />
    );
  }
  const widgetInit = init;

  const route = (() => {
    switch (widgetInit.mode) {
      case "add":
        return <AddRoute init={widgetInit} />;
      case "sync":
        return <SyncRoute init={widgetInit} />;
      case "list":
        return <ListRoute init={widgetInit} />;
      case "delete":
        return <DeleteRoute init={widgetInit} />;
      default:
        return null;
    }
  })();
  if (route) {
    return <StealthInitProvider value={{ init: widgetInit, parent }}>{route}</StealthInitProvider>;
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-foreground">Unknown mode</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Mode "{String(widgetInit.mode)}" is not supported by this widget.
        </p>
      </div>
    </div>
  );
}

export default App;
