/**
 * Stealth Sync widget — "sync" route stub.
 *
 * Milestone 1 placeholder. Final flow: fetch sealed envelope → derive
 * addresses → fetch filters → BIP158 match → fetch matched blocks →
 * normalize transactions → seal → POST to or-stealth-transactions-store →
 * post OR_STEALTH_SYNC_COMPLETE back to the consuming app, with a
 * transparency modal driving OR_STEALTH_PROGRESS messages throughout.
 *
 * Master plan §4.6 + §5.
 */

import type { StealthInitMessage } from "@/stealth/lib/postmessage";

export function SyncRoute({ init }: { init: StealthInitMessage }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">
          Stealth Sync — Sync wallet
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Coming soon. Mode: <span className="font-mono">sync</span>.
        </p>
        <dl className="mt-4 space-y-1 text-xs text-muted-foreground">
          <div>
            <dt className="inline font-medium text-foreground">
              connection_id:{" "}
            </dt>
            <dd className="inline font-mono">{init.connection_id ?? "(missing)"}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">app: </dt>
            <dd className="inline font-mono">{init.app_slug}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

export default SyncRoute;
