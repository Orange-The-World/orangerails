/**
 * Stealth Sync widget — top-level component.
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
 *   3. Once INIT is captured, render one of four route stubs based on
 *      init.mode: 'add' | 'sync' | 'list' | 'delete'.
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

const DEFAULT_ALLOWED_ORIGINS =
  "http://localhost:3000,http://localhost:5173,http://localhost:8080,https://app.bitbooks.com";

const DIRECT_LOAD_GRACE_MS = 1500;

function parseAllowedOrigins(): ReadonlySet<string> {
  const raw =
    (import.meta.env.VITE_OR_STEALTH_ALLOWED_ORIGINS as string | undefined) ??
    DEFAULT_ALLOWED_ORIGINS;
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

function isAllowedOrigin(origin: string, allowlist: ReadonlySet<string>): boolean {
  return allowlist.has(origin);
}

function postReady(target: Window | null) {
  if (!target) return;
  const ready: StealthReadyMessage = {
    type: "OR_STEALTH_READY",
    protocol_version: STEALTH_PROTOCOL_VERSION,
  };
  // Origin '*' is acceptable here — the READY message contains no secrets,
  // and we have not yet learned the trusted callback origin from INIT.
  target.postMessage(ready, "*");
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

export function App() {
  const allowlist = useMemo(parseAllowedOrigins, []);
  const [init, setInit] = useState<StealthInitMessage | null>(null);
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
    // Send READY once on mount.
    postReady(window.opener as Window | null);

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

      setInit(data as StealthInitMessage);
      setAwaitingInit(false);
      setError(null);
    };

    window.addEventListener("message", handler);

    // Direct-load fallback: if no INIT arrives within the grace window AND
    // we have no opener and no parent frame, render the friendly direct-load
    // card instead of the indefinite "Loading…" placeholder.
    const graceTimer = window.setTimeout(() => {
      setAwaitingInit(false);
    }, DIRECT_LOAD_GRACE_MS);

    return () => {
      window.removeEventListener("message", handler);
      window.clearTimeout(graceTimer);
    };
  }, [allowlist]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <h1 className="text-lg font-semibold text-destructive">
            Stealth Sync widget error
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  if (!init) {
    const isDirectLoad =
      !awaitingInit &&
      (typeof window === "undefined" ||
        (window.opener === null && window.parent === window));

    if (isDirectLoad) {
      return <DirectLoadCard />;
    }

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold text-foreground">Stealth Sync</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Waiting for the parent app to send OR_STEALTH_INIT…
          </p>
        </div>
      </div>
    );
  }

  switch (init.mode) {
    case "add":
      return <AddRoute init={init} />;
    case "sync":
      return <SyncRoute init={init} />;
    case "list":
      return <ListRoute init={init} />;
    case "delete":
      return <DeleteRoute init={init} />;
    default:
      return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6">
          <div className="max-w-md text-center">
            <h1 className="text-lg font-semibold text-foreground">
              Unknown mode
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Mode "{String(init.mode)}" is not supported by this widget.
            </p>
          </div>
        </div>
      );
  }
}

export default App;
