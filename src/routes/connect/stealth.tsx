/**
 * /connect/stealth — OR Connect widget popup entry point for Stealth Sync.
 *
 * Mounted at https://connect.orangerails.com/connect/stealth.
 *
 * The consuming app (V2 / V3 / OW / third-party SaaS) opens this URL in a
 * popup, exchanges the OR_STEALTH_READY / OR_STEALTH_INIT handshake, and
 * the widget runs the chosen mode entirely in the user's browser.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §6.1.
 * Protocol contract: src/stealth/lib/postmessage.ts (read-only).
 */

import { createFileRoute } from "@tanstack/react-router";
import { App as StealthWidget } from "@/stealth/widget/App";

function StealthWidgetPage() {
  return <StealthWidget />;
}

export const Route = createFileRoute("/connect/stealth")({
  component: StealthWidgetPage,
});
