import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/context/VaultContext";

export const Route = createFileRoute("/unlock")({
  component: UnlockPage,
});

function UnlockPage() {
  const navigate = useNavigate();
  const { unlock, ensurePqcKeypairs } = useVault();
  const [userId, setUserId] = useState<string | null>(null);

  const [vaultMeta, setVaultMeta] = useState<{
    vault_salt: string;
    vault_verifier_ciphertext: string;
    vault_key_version: number;
    enc_mek_ciphertext: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [vaultPassword, setVaultPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the user's vault metadata on mount.
  useEffect(() => {
    (async () => {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();
      if (sessionError || !session) {
        navigate({ to: "/login" });
        return;
      }

      const { data, error: metaError } = await (supabase as any)
        .from("user_vault_meta")
        .select("vault_salt, vault_verifier_ciphertext, vault_key_version, enc_mek_ciphertext")
        .eq("user_id", session.user.id)
        .single();

      if (metaError || !data) {
        setError("No vault found for this account. Please complete signup.");
        setLoading(false);
        return;
      }

      setVaultMeta(data);
      setUserId(session.user.id);
      setLoading(false);
    })();
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!vaultMeta) return;
    setError(null);
    setSubmitting(true);

    const ok = await unlock(
      vaultPassword,
      vaultMeta.vault_salt,
      vaultMeta.vault_verifier_ciphertext,
      vaultMeta.vault_key_version,
      vaultMeta.enc_mek_ciphertext,
    );

    if (!ok) {
      setError("Wrong vault password. Try again.");
      setSubmitting(false);
      return;
    }

    // Fire-and-forget: if the user pre-dates the PQC rollout, backfill their
    // keys now. Failures here (network, RLS) are non-fatal for unlock — the
    // user can still reach /app and operate without PQC until the next try.
    if (userId) {
      ensurePqcKeypairs(
        supabase as unknown as Parameters<typeof ensurePqcKeypairs>[0],
        userId,
      ).catch((err) => {
        console.warn("ensurePqcKeypairs failed during unlock:", err);
      });
    }

    navigate({ to: "/app" });
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading vault...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold">Unlock your vault</h1>
          <p className="text-sm text-muted-foreground">
            This is your <strong>vault password</strong> — separate from the account password you
            used to sign in. It is not stored anywhere and cannot be reset.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="vault-password" className="text-sm font-medium">
              Vault password
            </label>
            <input
              id="vault-password"
              type="password"
              required
              autoComplete="current-password"
              autoFocus
              value={vaultPassword}
              onChange={(e) => setVaultPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Check your password manager (1Password, Bitwarden, KeePass) or wherever you saved
              it during setup.
            </p>
          </div>

          {error && (
            <div className="space-y-1">
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </div>
              <p className="text-xs text-muted-foreground px-1">
                Note: your vault password is not your account login password — they are different.
              </p>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !vaultMeta}
            className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? "Unlocking..." : "Unlock vault"}
          </button>

          <p className="text-center text-sm text-muted-foreground">
            <Link to="/recover" className="text-primary hover:underline">
              Forgot your vault password?
            </Link>
          </p>

          <button
            type="button"
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/login" });
            }}
            className="w-full text-sm text-muted-foreground hover:underline"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
