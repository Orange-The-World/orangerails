import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/context/VaultContext";
import { MIN_PASSWORD_LENGTH } from "@/lib/vault";
import { formatError } from "@/lib/format-error";
import { logSecurityEvent } from "@/lib/audit";

export const Route = createFileRoute("/recover")({
  component: RecoverPage,
});

function RecoverPage() {
  const navigate = useNavigate();
  const { recoverWithCode } = useVault();

  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [newCodeSaved, setNewCodeSaved] = useState(false);

  const [step, setStep] = useState<"form" | "new-code">("form");
  const [newRecoveryCode, setNewRecoveryCode] = useState("");
  const [newCodeCopied, setNewCodeCopied] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== newPasswordConfirm) {
      setError("Passwords do not match.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Vault password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setSubmitting(true);
    try {
      // Fetch vault meta for the current session.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        setError("You must be signed in to recover your vault.");
        setSubmitting(false);
        return;
      }

      const { data: meta, error: metaErr } = await (supabase as any)
        .from("user_vault_meta")
        .select("vault_salt, vault_verifier_ciphertext, recovery_ciphertext")
        .eq("user_id", session.user.id)
        .single();

      if (metaErr || !meta) throw new Error("Could not load vault metadata.");
      if (!meta.recovery_ciphertext) {
        throw new Error(
          "This vault was created before recovery codes were supported. Recovery is not available.",
        );
      }

      const { newEncMekCiphertext, newRecoveryCode: freshCode, newRecoveryCiphertext } =
        await recoverWithCode({
          recoveryCode,
          recoveryCiphertext: meta.recovery_ciphertext,
          saltB64: meta.vault_salt,
          verifierCiphertext: meta.vault_verifier_ciphertext,
          newPassword,
        });

      // Persist the updated key material.
      const { error: updateErr } = await (supabase as any)
        .from("user_vault_meta")
        .update({
          enc_mek_ciphertext: newEncMekCiphertext,
          recovery_ciphertext: newRecoveryCiphertext,
          vault_key_version: 2,
        })
        .eq("user_id", session.user.id);
      if (updateErr) throw updateErr;

      void logSecurityEvent(supabase, session.user.id, "vault_recover");

      setNewRecoveryCode(freshCode);
      setStep("new-code");
    } catch (err) {
      setError(formatError(err));
      setSubmitting(false);
    }
  }

  if (step === "new-code") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="w-full max-w-md space-y-5">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-semibold">Save your new recovery code</h1>
            <p className="text-sm text-muted-foreground">
              Your old recovery code has been replaced. Save this new one — it will not be shown
              again.
            </p>
          </div>

          <div className="rounded-md border-2 border-orange-500/40 bg-orange-500/5 p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-orange-600">
              New recovery code
            </p>
            <div className="grid grid-cols-3 gap-2">
              {newRecoveryCode.split(" ").map((word, i) => (
                <div key={i} className="flex items-center gap-1.5 text-sm">
                  <span className="w-5 text-right text-xs text-muted-foreground shrink-0">
                    {i + 1}.
                  </span>
                  <span className="font-mono font-medium">{word}</span>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(newRecoveryCode).then(() => {
                  setNewCodeCopied(true);
                  setTimeout(() => setNewCodeCopied(false), 2000);
                });
              }}
              className="w-full rounded-md border border-orange-500/30 bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              {newCodeCopied ? "Copied ✓" : "Copy all 12 words"}
            </button>
          </div>

          <div className="flex items-start gap-2">
            <input
              id="new-code-saved"
              type="checkbox"
              checked={newCodeSaved}
              onChange={(e) => setNewCodeSaved(e.target.checked)}
              className="mt-1"
            />
            <label htmlFor="new-code-saved" className="text-xs text-muted-foreground">
              I have saved my new recovery code. I understand the old code no longer works.
            </label>
          </div>

          <button
            type="button"
            disabled={!newCodeSaved}
            onClick={() => navigate({ to: "/app" })}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Enter the app
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold">Recover vault access</h1>
          <p className="text-sm text-muted-foreground">
            Enter your 12-word recovery code to reset your vault password. Your encrypted data
            stays intact.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="recovery-code" className="text-sm font-medium">
              Recovery code
            </label>
            <textarea
              id="recovery-code"
              required
              rows={3}
              placeholder="Enter your 12 words separated by spaces"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono resize-none"
            />
            <p className="text-xs text-muted-foreground">
              12 words separated by spaces, exactly as you saved them.
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="new-password" className="text-sm font-medium">
              New vault password
            </label>
            <input
              id="new-password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Minimum {MIN_PASSWORD_LENGTH} characters. Use a strong passphrase.
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="new-password-confirm" className="text-sm font-medium">
              Confirm new vault password
            </label>
            <input
              id="new-password-confirm"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.target.value)}
              className={`w-full rounded-md border bg-background px-3 py-2 text-sm transition-colors ${
                newPasswordConfirm.length === 0
                  ? "border-input"
                  : newPassword === newPasswordConfirm
                    ? "border-green-500"
                    : "border-destructive"
              }`}
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? "Recovering..." : "Reset vault password"}
          </button>

          <p className="text-center text-sm text-muted-foreground">
            Remember your password?{" "}
            <Link to="/unlock" className="text-primary hover:underline">
              Unlock vault
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
