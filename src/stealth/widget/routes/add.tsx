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

import { useEffect, useMemo, useState } from "react";

// Detect whether we should show the script-type picker for the pasted
// input. The picker is only shown when the prefix is ambiguous: a bare
// `xpub` or `tpub` extended key. SLIP-132 prefixes (`ypub`, `zpub`) and
// output descriptors (`pkh(`, `wpkh(`, `sh(...)`, `wsh(...)`, `tr(`)
// already encode the script type unambiguously, so we hide the picker.
function pickerStateForInput(raw: string): {
  show: boolean;
  defaultScriptType: ScriptType;
} {
  const s = raw.trim();
  if (/^xpub[A-Za-z0-9]+$/.test(s) || /^tpub[A-Za-z0-9]+$/.test(s)) {
    // Native segwit (bc1q...) is the most common modern Sparrow /
    // hardware-wallet export when the prefix is plain `xpub`; default
    // to it.
    return { show: true, defaultScriptType: "p2wpkh" };
  }
  return { show: false, defaultScriptType: "p2pkh" };
}

import {
  deriveAddress,
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
import { proxyFetch } from "../lib/proxyFetch";

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

/** Get the URL endpoint for the stealth functions. Order of preference:
 *    1. proxy_base_url from INIT — when the consuming app provides a
 *       server-side proxy (V2 pattern). The proxy attaches the platform
 *       API key, keeping that secret off the browser.
 *    2. VITE_OR_FUNCTIONS_BASE_URL build-time env — direct Supabase
 *       functions host (typically requires the consumer to also pass
 *       access_token in INIT for Bearer auth).
 *    3. Same-origin /functions/v1/* — relies on a reverse proxy at the
 *       widget host.
 */
function resolveFunctionUrl(
  name: string,
  proxyBaseUrl: string | undefined,
): string {
  if (proxyBaseUrl) {
    return `${proxyBaseUrl.replace(/\/$/, "")}/${name}`;
  }
  const base = (
    (import.meta.env.VITE_OR_FUNCTIONS_BASE_URL as string | undefined) ?? ""
  ).replace(/\/$/, "");
  if (base) return `${base}/${name}`;
  return `/functions/v1/${name}`;
}

interface AccessTokenInit extends StealthInitMessage {
  /** Optional Supabase JWT for direct-mode auth on the edge function POST.
   *  Reading this off the message is a forward-compatible carve-out;
   *  master plan §4.4 leaves this optional. */
  access_token?: string;
  /** Optional consumer-app proxy base URL. When present, the widget POSTs
   *  edge-function calls through this URL instead of OR's Supabase host;
   *  the proxy attaches the platform API key server-side so the secret
   *  never reaches the browser. V2 pattern. */
  proxy_base_url?: string;
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
  // The user-overridable script type for ambiguous `xpub` / `tpub`
  // prefixes. We initialize from the prefix heuristic and reset whenever
  // the input changes so a fresh paste re-applies the default.
  const [scriptType, setScriptType] = useState<ScriptType>("p2wpkh");
  const [scriptTypeTouched, setScriptTypeTouched] = useState(false);
  // Visual-confirmation state. The user must explicitly confirm the
  // first three derived addresses match their wallet, OR override after
  // the "No, different addresses" warning, before the submit button is
  // enabled. Reset whenever the input or chosen script type changes.
  const [confirmState, setConfirmState] = useState<"none" | "yes" | "no">(
    "none",
  );
  const [overrideConfirm, setOverrideConfirm] = useState(false);
  const addressesConfirmed = confirmState === "yes";

  const picker = useMemo(() => pickerStateForInput(input), [input]);
  // Effective script type: if the user touched the dropdown, honour it;
  // otherwise track the default for the current prefix.
  const effectiveScriptType: ScriptType = picker.show
    ? scriptTypeTouched
      ? scriptType
      : picker.defaultScriptType
    : scriptType;

  // Parse the pasted input for the confirmation card. Errors here are
  // swallowed; we only render the card when parsing succeeds. The real
  // submit path re-parses and surfaces errors to the user.
  const parsedForPreview = useMemo<ParsedDescriptor | null>(() => {
    const trimmed = input.trim();
    if (trimmed.length < 4) return null;
    try {
      return parseDescriptor(trimmed);
    } catch {
      return null;
    }
  }, [input]);

  // Derive the first three receive addresses for the confirmation card.
  // We only render for single-key wallets where deriveAddress applies;
  // multisig descriptors are rare in the consumer flow and skip the card.
  const previewAddresses = useMemo<string[] | null>(() => {
    if (!parsedForPreview) return null;
    if (parsedForPreview.kind !== "single") return null;
    const xpub = parsedForPreview.keys[0].xpub;
    const t: ScriptType = picker.show
      ? effectiveScriptType
      : parsedForPreview.keys[0].scriptType;
    try {
      return [0, 1, 2].map((i) => deriveAddress(xpub, 0, i, t));
    } catch {
      return null;
    }
  }, [parsedForPreview, picker.show, effectiveScriptType]);

  // Reset confirmation whenever the inputs that feed the preview change.
  // useMemo above re-runs on the same deps; mirror them here.
  useEffect(() => {
    setConfirmState("none");
    setOverrideConfirm(false);
  }, [input, effectiveScriptType, picker.show]);

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

    // For ambiguous `xpub` / `tpub` single-key inputs, override the
    // detected script type with the user's pick. The auto-detection for
    // ypub / zpub / descriptors stays in charge.
    if (
      parsed.kind === "single" &&
      pickerStateForInput(trimmed).show
    ) {
      parsed = {
        ...parsed,
        keys: [{ ...parsed.keys[0], scriptType: effectiveScriptType }],
      };
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

      const requestBody = {
        app_user_id: init.app_user_id,
        app_slug: init.app_slug,
        connection_kind: shape.kind,
        sealed_envelope: sealed,
        blind_index: blind,
        // ZKA: birthday stays inside the envelope. The plaintext column
        // is reserved for V2 which already has the date in the clear.
        wallet_birthday_plaintext: null,
      };

      // proxy_base_url present → route through the parent app's
      // postMessage proxy (V2 pattern, keeps platform key off the
      // browser). Otherwise direct cross-origin fetch.
      let respStatus: number;
      let respText: string;
      if (initWithToken.proxy_base_url && parent) {
        const result = await proxyFetch({
          parent,
          parentOrigin: init.return_callback_origin,
          fn: "or-stealth-connection-create",
          body: requestBody,
        });
        respStatus = result.status;
        respText = result.bodyText;
      } else {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (initWithToken.access_token) {
          headers["Authorization"] = `Bearer ${initWithToken.access_token}`;
        }
        const resp = await fetch(
          resolveFunctionUrl(
            "or-stealth-connection-create",
            initWithToken.proxy_base_url,
          ),
          {
            method: "POST",
            headers,
            body: JSON.stringify(requestBody),
          },
        );
        respStatus = resp.status;
        respText = await resp.text().catch(() => "");
      }

      const resp = {
        ok: respStatus >= 200 && respStatus < 300,
        status: respStatus,
      };

      if (!resp.ok) {
        const text = respText;
        const msg = `Edge function returned ${resp.status}${text ? `: ${text}` : ""}`;
        setError(msg);
        postWidgetError("INTERNAL", msg, true);
        return;
      }

      const json: { connection_id?: string; already_existed?: boolean } =
        respText ? JSON.parse(respText) : {};
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

        {picker.show ? (
          <>
            <label
              className="mt-3 block text-xs font-medium text-foreground"
              htmlFor="script-type-input"
            >
              Wallet type
            </label>
            <select
              id="script-type-input"
              value={effectiveScriptType}
              onChange={(e) => {
                setScriptType(e.target.value as ScriptType);
                setScriptTypeTouched(true);
              }}
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-xs"
            >
              <option value="p2wpkh">Modern, most common (bc1q...)</option>
              <option value="p2tr">Newest, taproot (bc1p...)</option>
              <option value="p2sh-p2wpkh">Older segwit (3...)</option>
              <option value="p2pkh">Oldest, classic (1...)</option>
            </select>
            <p className="mt-1 text-[10px] text-muted-foreground">
              Most modern wallets exported from Sparrow with an xpub prefix
              use bc1q addresses. Pick the type that matches your wallet.
            </p>
          </>
        ) : null}

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

        <details className="mt-3 group">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground select-none">
            Advanced settings
          </summary>
          <div className="mt-2">
            <label
              className="block text-xs font-medium text-foreground"
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
              onChange={(e) =>
                setGapLimit(Number.parseInt(e.target.value, 10) || 0)
              }
              className="mt-1 w-full rounded-md border border-border bg-background p-2 text-xs"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              How many empty addresses we scan before stopping. Default 20
              works for almost every wallet (Sparrow, BlueWallet, Ledger,
              Trezor). Only change this if your wallet generates addresses
              with unusually large gaps.
            </p>
          </div>
        </details>

        {previewAddresses ? (
          <div className="mt-4 rounded-md border border-border bg-muted/20 p-3">
            <p className="text-xs font-medium text-foreground">
              Confirm this is the right wallet
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              We derived these from your key. Open your wallet's "Receive"
              tab and check the first few addresses match.
            </p>
            <ol className="mt-2 space-y-1 font-mono text-[11px] text-foreground">
              {previewAddresses.map((addr, i) => (
                <li key={addr}>
                  {i + 1}. {addr}
                </li>
              ))}
            </ol>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setConfirmState("yes");
                  setOverrideConfirm(false);
                }}
                className={`inline-flex items-center justify-center rounded-md px-3 py-2 text-xs font-medium ${
                  confirmState === "yes"
                    ? "bg-primary text-primary-foreground"
                    : "border border-border bg-background text-foreground hover:bg-muted"
                }`}
              >
                Yes, these match my wallet
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmState("no");
                  setOverrideConfirm(false);
                }}
                className={`inline-flex items-center justify-center rounded-md px-3 py-2 text-xs font-medium ${
                  confirmState === "no"
                    ? "bg-destructive text-destructive-foreground"
                    : "border border-border bg-background text-foreground hover:bg-muted"
                }`}
              >
                No, different addresses
              </button>
            </div>
            {confirmState === "no" ? (
              <div className="mt-2 text-[11px] text-muted-foreground">
                <p>
                  Then this key may not be from the wallet you intended.
                  Double-check what you copied or, for xpub keys, try a
                  different wallet type above.
                </p>
                {!overrideConfirm ? (
                  <button
                    type="button"
                    onClick={() => setOverrideConfirm(true)}
                    className="mt-1 underline hover:no-underline"
                  >
                    Submit anyway
                  </button>
                ) : (
                  <p className="mt-1 italic">
                    Override enabled. You can submit below.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="mt-3 text-xs text-destructive">{error}</p>
        ) : null}

        <button
          type="submit"
          disabled={
            submitting ||
            (previewAddresses !== null &&
              !addressesConfirmed &&
              !overrideConfirm)
          }
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
