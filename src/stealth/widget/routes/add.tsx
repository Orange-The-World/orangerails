/**
 * Stealth Sync widget — "add" route.
 *
 * Master plan §4.5 (data flow: adding a new xpub) and §6.1.
 *
 * Flow:
 *   1. User pastes an xpub or output descriptor, picks a label, sets the
 *      wallet birthday, and (optionally) tunes the gap limit.
 *   2. We parse the input client-side. The only network call we make is
 *      the final POST of the sealed envelope. Validation is in-browser.
 *   3. We seal the envelope under the per-app key from INIT, compute a
 *      blind index over the normalized input, and POST to
 *      `or-stealth-connection-create`.
 *   4. On success we postMessage OR_STEALTH_ADD_COMPLETE back to the
 *      consuming app and show a "Done — close this window" view.
 *   5. On failure we postMessage OR_STEALTH_ERROR and surface the message.
 */

import { useMemo, useState } from "react";

import {
  parseDescriptor,
  type ParsedDescriptor,
  type ScriptType,
} from "@/stealth/lib/derive";
import { sealEnvelope, blindIndex } from "@/stealth/lib/seal";
import type {
  StealthAddCompleteMessage,
  StealthErrorCode,
  StealthErrorMessage,
  StealthInitMessage,
} from "@/stealth/lib/postmessage";
import { useStealthInit } from "../StealthInitContext";

// Default wallet-birthday: today minus one year. Master plan §14: most
// active wallets are well under a year old. Older wallets get nudged to
// edit the date manually after adding.
function defaultBirthdayISO(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  // YYYY-MM-DD in the user's local time. Birthday is a date, not a moment.
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Today, ISO. Used as the upper bound on the birthday picker.
function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Decide which payload kind the descriptor maps to, plus the script-type
 * label that the postMessage protocol expects on completion.
 */
function shapeForCompletion(parsed: ParsedDescriptor): {
  kind: "xpub_stealth" | "descriptor_stealth";
  scriptType: StealthAddCompleteMessage["script_type"];
} {
  if (parsed.kind === "multisig") {
    return { kind: "descriptor_stealth", scriptType: "multisig-descriptor" };
  }
  const t: ScriptType = parsed.keys[0].scriptType;
  return { kind: "xpub_stealth", scriptType: t };
}

/** Get the consuming app's URL endpoint for the stealth functions. We
 *  prefer same-origin if a relative URL is configured (the OR app proxies
 *  edge functions); otherwise we fall back to the full Supabase URL. */
function resolveFunctionUrl(name: string): string {
  const base = (
    (import.meta.env.VITE_OR_FUNCTIONS_BASE_URL as string | undefined) ?? ""
  ).replace(/\/$/, "");
  if (base) return `${base}/${name}`;
  // Same-origin default; Caddy at connect.orangerails.com proxies
  // /functions/v1/* to the Supabase edge function host.
  return `/functions/v1/${name}`;
}

interface AccessTokenInit extends StealthInitMessage {
  /** Optional Supabase JWT for direct-mode auth on the edge function POST.
   *  Reading this off the message is a forward-compatible carve-out;
   *  master plan §4.4 leaves this optional. */
  access_token?: string;
}

export function AddRoute({ init: _init }: { init: StealthInitMessage }) {
  const { init, parent } = useStealthInit();
  const initWithToken = init as AccessTokenInit;

  const [input, setInput] = useState("");
  const [label, setLabel] = useState("");
  const [birthday, setBirthday] = useState<string>(defaultBirthdayISO);
  const [gapLimit, setGapLimit] = useState<number>(20);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ alreadyExisted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const today = useMemo(todayISO, []);

  function postWidgetError(code: StealthErrorCode, message: string, retryable: boolean) {
    if (!parent) return;
    const msg: StealthErrorMessage = {
      type: "OR_STEALTH_ERROR",
      code,
      message,
      retryable,
    };
    try {
      parent.postMessage(msg, init.return_callback_origin);
    } catch (e) {
      console.error("[stealth/add] failed to post error to parent:", e);
    }
  }

  async function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    setError(null);

    // ── Validate ────────────────────────────────────────────────────
    const trimmed = input.trim();
    if (trimmed.length < 4) {
      setError("Paste an xpub, ypub, zpub, or output descriptor first.");
      return;
    }
    const cleanLabel = label.trim();
    if (cleanLabel.length === 0) {
      setError("Give this wallet a label so you can recognize it later.");
      return;
    }
    if (cleanLabel.length > 80) {
      setError("Label is too long. Please keep it under 80 characters.");
      return;
    }
    if (!ISO_DATE_RE.test(birthday)) {
      setError("Wallet birthday must be a date (YYYY-MM-DD).");
      return;
    }
    if (birthday > today) {
      setError("Wallet birthday cannot be in the future.");
      return;
    }
    if (!Number.isInteger(gapLimit) || gapLimit < 1 || gapLimit > 1000) {
      setError("Gap limit must be a whole number between 1 and 1000.");
      return;
    }

    let parsed: ParsedDescriptor;
    try {
      parsed = parseDescriptor(trimmed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Could not parse: ${msg}`);
      postWidgetError("INVALID_XPUB", msg, false);
      return;
    }

    const shape = shapeForCompletion(parsed);

    // ── Build the plaintext envelope payload (master plan §4.3). ────
    const envelopePayload =
      shape.kind === "xpub_stealth"
        ? {
            kind: "xpub_stealth" as const,
            xpub: parsed.keys[0].xpub,
            label: cleanLabel,
            wallet_birthday: birthday,
            gap_limit: gapLimit,
            script_type: parsed.keys[0].scriptType,
          }
        : {
            kind: "descriptor_stealth" as const,
            descriptor: trimmed,
            label: cleanLabel,
            wallet_birthday: birthday,
            gap_limit: gapLimit,
          };

    setSubmitting(true);
    try {
      const sealed = await sealEnvelope(envelopePayload, init.or_stealth_key_b64);
      const blind = await blindIndex(trimmed, init.or_stealth_key_b64);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (initWithToken.access_token) {
        headers["Authorization"] = `Bearer ${initWithToken.access_token}`;
      }

      const resp = await fetch(resolveFunctionUrl("or-stealth-connection-create"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          app_user_id: init.app_user_id,
          app_slug: init.app_slug,
          connection_kind: shape.kind,
          sealed_envelope: sealed,
          blind_index: blind,
          // ZKA: birthday stays inside the envelope. The plaintext column
          // is reserved for V2 which already has the date in the clear.
          wallet_birthday_plaintext: null,
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const msg = `Edge function returned ${resp.status}${text ? `: ${text}` : ""}`;
        setError(msg);
        postWidgetError("INTERNAL", msg, true);
        return;
      }

      const json = (await resp.json()) as {
        connection_id?: string;
        already_existed?: boolean;
      };
      if (!json.connection_id) {
        const msg = "Edge function did not return a connection_id.";
        setError(msg);
        postWidgetError("INTERNAL", msg, false);
        return;
      }

      // Even when the connection already existed, we still post
      // ADD_COMPLETE so the parent app gets the connection_id back. The
      // parent can decide whether to display "added" vs "already linked"
      // based on its own state; the message itself is the same shape.
      const complete: StealthAddCompleteMessage = {
        type: "OR_STEALTH_ADD_COMPLETE",
        connection_id: json.connection_id,
        wallet_birthday: birthday,
        label: cleanLabel,
        script_type: shape.scriptType,
      };
      if (parent) {
        try {
          parent.postMessage(complete, init.return_callback_origin);
        } catch (e) {
          console.error("[stealth/add] failed to post complete:", e);
        }
      }
      setDone({ alreadyExisted: json.already_existed === true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      postWidgetError("NETWORK", msg, true);
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">
            {done.alreadyExisted ? "Already connected" : "Wallet added"}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {done.alreadyExisted
              ? "This xpub is already connected to your account. We pointed your app at the existing connection so you do not have a duplicate."
              : "Your wallet is now sealed and stored. You can close this window."}
          </p>
          <button
            type="button"
            onClick={() => window.close()}
            className="mt-4 inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Close this window
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-foreground">
          Stealth Sync — Add wallet
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Paste an extended public key or output descriptor. Everything stays
          in your browser.
        </p>

        <div className="mt-3 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Transparency: </span>
            your xpub is being sealed in your browser. We will only see opaque
            bytes after this.
          </p>
        </div>

        <label
          className="mt-4 block text-xs font-medium text-foreground"
          htmlFor="xpub-input"
        >
          Extended public key or output descriptor
        </label>
        <textarea
          id="xpub-input"
          rows={3}
          spellCheck={false}
          autoComplete="off"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="xpub… / ypub… / zpub… / wsh(sortedmulti(...))"
          className="mt-1 w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
        />

        <label
          className="mt-3 block text-xs font-medium text-foreground"
          htmlFor="label-input"
        >
          Label
        </label>
        <input
          id="label-input"
          type="text"
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Sparrow main"
          className="mt-1 w-full rounded-md border border-border bg-background p-2 text-xs"
        />

        <label
          className="mt-3 block text-xs font-medium text-foreground"
          htmlFor="birthday-input"
        >
          Wallet birthday
        </label>
        <input
          id="birthday-input"
          type="date"
          value={birthday}
          max={today}
          onChange={(e) => setBirthday(e.target.value)}
          className="mt-1 w-full rounded-md border border-border bg-background p-2 text-xs"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          We start scanning from this date. The default of one year ago keeps
          syncs fast. Older wallets can edit this later to scan further back.
        </p>

        <label
          className="mt-3 block text-xs font-medium text-foreground"
          htmlFor="gap-input"
        >
          Gap limit
        </label>
        <input
          id="gap-input"
          type="number"
          min={1}
          max={1000}
          value={gapLimit}
          onChange={(e) => setGapLimit(Number.parseInt(e.target.value, 10) || 0)}
          className="mt-1 w-full rounded-md border border-border bg-background p-2 text-xs"
        />

        {error ? (
          <p className="mt-3 text-xs text-destructive">{error}</p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="mt-4 inline-flex w-full items-center justify-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Sealing and uploading…" : "Add wallet"}
        </button>

        <dl className="mt-6 space-y-1 border-t border-border pt-3 text-[10px] text-muted-foreground">
          <div>
            <dt className="inline font-medium text-foreground">app: </dt>
            <dd className="inline font-mono">{init.app_slug}</dd>
          </div>
          <div>
            <dt className="inline font-medium text-foreground">user: </dt>
            <dd className="inline font-mono">{init.app_user_id}</dd>
          </div>
        </dl>
      </form>
    </div>
  );
}

export default AddRoute;
