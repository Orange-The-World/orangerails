import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useVault } from '@/context/VaultContext';
import { MIN_PASSWORD_LENGTH } from '@/lib/vault';

export const Route = createFileRoute('/signup')({
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const { setupVault } = useVault();

  const [email, setEmail] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [vaultPassword, setVaultPassword] = useState('');
  const [vaultPasswordConfirm, setVaultPasswordConfirm] = useState('');
  const [acknowledgedUnrecoverable, setAcknowledgedUnrecoverable] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (vaultPassword !== vaultPasswordConfirm) {
      setError('Vault passwords do not match.');
      return;
    }
    if (vaultPassword === accountPassword) {
      setError('Vault password must be different from your account password.');
      return;
    }
    if (!acknowledgedUnrecoverable) {
      setError('You must acknowledge that a lost vault password cannot be recovered.');
      return;
    }

    setSubmitting(true);
    try {
      // 1. Create the Supabase Auth user (email + account password).
      const { data: signupData, error: signupError } = await supabase.auth.signUp({
        email,
        password: accountPassword,
      });
      if (signupError) throw signupError;
      if (!signupData.session) {
        setError('Check your email to confirm your account, then return here to finish vault setup.');
        setSubmitting(false);
        return;
      }

      // 2. Set up the vault — generates salt, derives MEK, creates verifier.
      const { saltB64, verifierCiphertext, keyVersion } = await setupVault(vaultPassword);

      // 3. Upload the vault metadata.
      const { error: metaError } = await supabase.from('user_vault_meta').insert({
        user_id: signupData.session.user.id,
        vault_salt: saltB64,
        vault_verifier_ciphertext: verifierCiphertext,
        vault_key_version: keyVersion,
      });
      if (metaError) throw metaError;

      // 4. Land in the authenticated app.
      navigate({ to: '/app' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold">Create your OrangeRails account</h1>
          <p className="text-sm text-muted-foreground">
            Zero-knowledge from day one. Your vault password never leaves this browser.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="email" className="text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="account-password" className="text-sm font-medium">
              Account password
            </label>
            <input
              id="account-password"
              type="password"
              required
              autoComplete="new-password"
              minLength={8}
              value={accountPassword}
              onChange={(e) => setAccountPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Used for signing in. Recoverable via email.
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="vault-password" className="text-sm font-medium">
              Vault password <span className="text-orange-500">*</span>
            </label>
            <input
              id="vault-password"
              type="password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={vaultPassword}
              onChange={(e) => setVaultPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Encrypts your provider credentials. <strong>We cannot recover this.</strong>
              Minimum {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="vault-password-confirm" className="text-sm font-medium">
              Confirm vault password
            </label>
            <input
              id="vault-password-confirm"
              type="password"
              required
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={vaultPasswordConfirm}
              onChange={(e) => setVaultPasswordConfirm(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="flex items-start gap-2 rounded-md border border-orange-500/40 bg-orange-500/5 p-3">
            <input
              id="ack"
              type="checkbox"
              checked={acknowledgedUnrecoverable}
              onChange={(e) => setAcknowledgedUnrecoverable(e.target.checked)}
              className="mt-1"
            />
            <label htmlFor="ack" className="text-xs text-muted-foreground">
              I understand that if I lose my vault password, my encrypted credentials
              and transactions will be permanently unrecoverable. OrangeRails cannot
              reset a password it never stored.
            </label>
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
            {submitting ? 'Creating account...' : 'Create account'}
          </button>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <Link to="/login" className="text-primary hover:underline">
              Sign in
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
