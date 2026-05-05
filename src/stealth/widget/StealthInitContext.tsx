/**
 * StealthInitContext — exposes the validated OR_STEALTH_INIT message to
 * widget routes.
 *
 * The init message carries the per-app stealth key (used to seal envelopes
 * and compute blind indexes), the consuming app's slug + user id, and the
 * trusted return-callback origin. Routes consume the context via
 * `useStealthInit()`; calling that outside an `<StealthInitProvider>` is a
 * programming bug.
 */

import { createContext, useContext } from "react";
import type { StealthInitMessage } from "@/stealth/lib/postmessage";

export interface StealthInitContextValue {
  init: StealthInitMessage;
  /** The Window object the widget posts replies back to. May be null in
   *  edge cases (e.g. parent closed the popup mid-handshake). */
  parent: Window | null;
}

const StealthInitContext = createContext<StealthInitContextValue | null>(null);

export function StealthInitProvider({
  value,
  children,
}: {
  value: StealthInitContextValue;
  children: React.ReactNode;
}) {
  return (
    <StealthInitContext.Provider value={value}>
      {children}
    </StealthInitContext.Provider>
  );
}

export function useStealthInit(): StealthInitContextValue {
  const ctx = useContext(StealthInitContext);
  if (!ctx) {
    throw new Error(
      "useStealthInit must be used inside <StealthInitProvider>. " +
        "This usually means a route was rendered before INIT was received.",
    );
  }
  return ctx;
}
