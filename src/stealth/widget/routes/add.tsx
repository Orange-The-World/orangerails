/**
 * Stealth Sync widget — "add" route stub.
 *
 * Milestone 1 placeholder. Final flow: paste xpub, label, birthday →
 * validate → seal envelope → POST to or-stealth-connection-create →
 * post OR_STEALTH_ADD_COMPLETE back to the consuming app.
 *
 * Master plan §4.5.
 */

import type { StealthInitMessage } from "@/stealth/lib/postmessage";

export function AddRoute({ init }: { init: StealthInitMessage }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">
          Stealth Sync — Add wallet
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Coming soon. Mode: <span className="font-mono">add</span>.
        </p>
        <dl className="mt-4 space-y-1 text-xs text-muted-foreground">
          <div>
            <dt className="inline font-medium text-foreground">app: </dt>
            <dd className="inline font-mono">{init.app_slug}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">user: </dt>
            <dd className="inline font-mono">{init.app_user_id}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">
              connection_id:{" "}
            </dt>
            <dd className="inline font-mono">{init.connection_id ?? "(none)"}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

export default AddRoute;
