import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/context/VaultContext";
import { MIN_PASSWORD_LENGTH, CURRENT_VAULT_KEY_VERSION } from "@/lib/vault";
import { formatError } from "@/lib/format-error";
import { logSecurityEvent } from "@/lib/audit";
import { migrateAndPersistRotatedVault, type VaultPersistClient } from "@/lib/vault-persist";
import {
  invalidateCoAdminGrantsAfterRecovery,
  coAdminInvalidationMessage,
  type CoAdminInvalidation,
  type CoAdminRecoveryClient,
} from "@/lib/co-admin-recovery";

export const Route = createFileRoute("/recover")({
  component: RecoverPage,
});

function RecoverPage() {
  const navigate = useNavigate();
  const { recoverWithCode, migrateCredentialsCiphertext, migrateTransactionCiphertext, clearMigrationKeys } =
    useVault();

  const [recoveryCode, setRecoveryCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [newCodeSaved, setNewCodeSaved] = useState(false);

  const [step, setStep] = useState<"form" | "new-code">("form");
  const [newRecoveryCode, setNewRecoveryCode] = useState("");
  const [newCodeCopied, setNewCodeCopied] = useState(false);
  /**
   * What happened to this owner's co-admin grants, in plain words, or null if
   * they had none. Shown on the new-code screen, which is the one screen we
   * know the user reads after a recovery.
   */
  const [coAdminNotice, setCoAdminNotice] = useState<string | null>(null);

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
        // kem_secret_wrapped and sig_secret_wrapped are read here because they are
        // wrapped under an HKDF subkey of the MEK, and the recovery below rotates
        // the MEK. They are not data rows, so the migration never sees them: if
        // they are not carried across in the same write, the only key that opens
        // them is discarded and nothing ever regenerates them.
        // workspace_key_id is read because every co-admin grant is keyed by it,
        // and the rotation below makes all of them undecryptable.
        .select(
          "vault_salt, vault_verifier_ciphertext, recovery_ciphertext, kem_secret_wrapped, sig_secret_wrapped, workspace_key_id",
        )
        .eq("user_id", session.user.id)
        .single();

      if (metaErr || !meta) throw new Error("Could not load vault metadata.");
      if (!meta.recovery_ciphertext) {
        throw new Error(
          "This vault was created before recovery codes were supported. Recovery is not available.",
        );
      }

      const {
        newEncMekCiphertext,
        newRecoveryCode: freshCode,
        newRecoveryCiphertext,
        newVerifierCiphertext,
        newKemSecretWrapped,
        newSigSecretWrapped,
      } = await recoverWithCode({
        recoveryCode,
        recoveryCiphertext: meta.recovery_ciphertext,
        saltB64: meta.vault_salt,
        verifierCiphertext: meta.vault_verifier_ciphertext,
        newPassword,
        kemSecretWrapped: meta.kem_secret_wrapped ?? null,
        sigSecretWrapped: meta.sig_secret_wrapped ?? null,
      });

      // Everything from here to the meta write lives in src/lib/vault-persist.ts.
      // It is the part that loses vaults when it is wrong, and while it sat
      // inline in this component no test could reach it without mounting the
      // page, so a green suite said nothing about it. The order, the
      // compare-and-swap and the row-count check are unchanged; read the
      // comments there for what writing meta last does and does not buy.
      //
      // It throws unless the meta write is proven to have landed, and it only
      // zeroes the old key material once that proof exists.
      await migrateAndPersistRotatedVault({
        supabase: supabase as unknown as VaultPersistClient,
        userId: session.user.id,
        priorRecoveryCiphertext: meta.recovery_ciphertext,
        newEncMekCiphertext,
        newRecoveryCiphertext,
        newVerifierCiphertext,
        vaultKeyVersion: CURRENT_VAULT_KEY_VERSION,
        newKemSecretWrapped,
        newSigSecretWrapped,
        migrateCredentialsCiphertext,
        migrateTransactionCiphertext,
        clearMigrationKeys,
      });

      // The meta write is proven, so the rotation is real and every existing
      // co-admin grant is now dead: those blobs hold HKDF subkeys of the MEK
      // this recovery just replaced. They die silently, because the recipient's
      // unwrap still succeeds and only the decrypts fail, so the grants are
      // removed here and the owner is told rather than left with emergency
      // access that looks present and does nothing.
      //
      // AFTER the meta write, never before: until it lands the stored wrappers
      // still hold the old MEK and those grants are still perfectly good.
      //
      // This cannot fail the recovery. The recovery has already succeeded, and
      // saying otherwise would tell the user something false about their vault.
      // invalidateCoAdminGrantsAfterRecovery does not throw by design; the try
      // is belt and braces so that even an unexpected throw becomes something
      // the owner can act on instead of a recovery that reads as broken.
      let coAdminResult: CoAdminInvalidation;
      try {
        coAdminResult = await invalidateCoAdminGrantsAfterRecovery({
          supabase: supabase as unknown as CoAdminRecoveryClient,
          ownerUserId: session.user.id,
          workspaceKeyId: meta.workspace_key_id ?? null,
        });
      } catch (cleanupErr) {
        coAdminResult = { status: "failed", reason: formatError(cleanupErr) };
      }
      setCoAdminNotice(coAdminInvalidationMessage(coAdminResult));

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
              Your old recovery code has been replaced. Save this new one , it will not be shown
              again.
            </p>
          </div>

          {coAdminNotice && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
              {coAdminNotice}
            </div>
          )}

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
