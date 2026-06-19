/**
 * Stealth Sync widget , "delete" route stub.
 *
 * Milestone 1 placeholder. Final flow: confirm prompt → call
 * or-stealth-connection-delete → post OR_STEALTH_DELETE_COMPLETE back.
 *
 * Master plan §6.1.
 */

import type { StealthInitMessage } from "@/stealth/lib/postmessage";

export function DeleteRoute({ init }: { init: StealthInitMessage }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">
          Stealth Sync , Delete wallet
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Coming soon. Mode: <span className="font-mono">delete</span>.
        </p>
        <dl className="mt-4 space-y-1 text-xs text-muted-foreground">
          <div>
            <dt className="inline font-medium text-foreground">
              connection_id:{" "}
            </dt>
            <dd className="inline font-mono">{init.connection_id ?? "(missing)"}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

export default DeleteRoute;
