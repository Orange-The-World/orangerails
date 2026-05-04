/**
 * Stealth Sync widget — "add" route stub.
 *
 * Milestone 2A scope: paste-an-xpub form that detects the script type
 * client-side and shows it back to the user. This is a wiring check, not
 * a working flow. The real submit (validate, seal, POST to
 * or-stealth-connection-create, post OR_STEALTH_ADD_COMPLETE back to
 * the consuming app) lands in milestone 2B.
 *
 * Master plan §4.5.
 */

import { useState } from "react";

import { detectScriptType, type ScriptType } from "@/stealth/lib/derive";
// Imported here to verify the seal module bundles cleanly through the
// rest of the build. Wired up to the real submit handler in 2B.
import type { SealedEnvelope } from "@/stealth/lib/seal";
import type { StealthInitMessage } from "@/stealth/lib/postmessage";

// Reference the type so that TS does not strip the import. This keeps
// the seal module on the dependency graph today and makes the 2B wiring
// a one-line change.
const _sealedEnvelopeShape: SealedEnvelope | undefined = undefined;
void _sealedEnvelopeShape;

export function AddRoute({ init }: { init: StealthInitMessage }) {
  const [xpub, setXpub] = useState("");
  const [detected, setDetected] = useState<ScriptType | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onDetect() {
    setError(null);
    setDetected(null);
    const trimmed = xpub.trim();
    if (trimmed.length < 4) {
      setError("Paste your xpub, ypub, or zpub first.");
      return;
    }
    try {
      setDetected(detectScriptType(trimmed));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">
          Stealth Sync — Add wallet
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Paste your extended public key. We never see it, even on our
          servers. Everything stays in your browser.
        </p>

        <label
          className="mt-4 block text-xs font-medium text-foreground"
          htmlFor="xpub-input"
        >
          Extended public key
        </label>
        <textarea
          id="xpub-input"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={xpub}
          onChange={(e) => setXpub(e.target.value)}
          placeholder="xpub… / ypub… / zpub…"
          className="mt-1 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
        />

        <button
          type="button"
          onClick={onDetect}
          className="mt-3 inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          Detect script type
        </button>

        {error ? (
          <p className="mt-3 text-xs text-destructive">{error}</p>
        ) : null}
        {detected ? (
          <p className="mt-3 text-xs text-foreground">
            Detected script type:{" "}
            <span className="font-mono font-semibold">{detected}</span>
          </p>
        ) : null}

        <dl className="mt-6 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
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
