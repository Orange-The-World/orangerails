import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useVault } from '@/context/VaultContext';
import { MIN_PASSWORD_LENGTH } from '@/lib/vault';

export const Route = createFileRoute('/signup')({
  component: SignupPage,
});

type Mode = 'loading' | 'fresh' | 'resume' | 'unknown';

function SignupPage() {
  const navigate = useNavigate();
  const { setupVault } = useVault();

  // Mode detection:
  // - 'fresh'   : no session yet. Show the full form (email + both passwords).
  // - 'resume'  : session exists but no user_vault_meta row. Show only vault fields.
  // - 'loading' : checking the session + vault-meta on mount.
  // - 'unknown' : edge case (session exists + vault exists). We redirect to /unlock.
  const [mode, setMode] = useState<Mode>('loading');
  const [resumeEmail, setResumeEmail] = useState<string>(''); // readonly display for resume mode

  const [email, setEmail] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [vaultPassword, setVaultPassword] = useState('');
  const [vaultPasswordConfirm, setVaultPasswordConfirm] = useState('');
  const [acknowledgedUnrecoverable, setAcknowledgedUnrecoverable] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount: figure out which mode we're in.
  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setMode('fresh');
        return;
      }

      setResumeEmail(session.user.email ?? '');

      // Check if vault metadata already exists for this user.
      const { data: vaultMeta } = await supabase
        .from('user_vault_meta')
        .select('user_id')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (vaultMeta) {
        // Already fully set up — send them to unlock.
        setMode('unknown');
        navigate({ to: '/unlock' });
        return;
      }

      // Session but no vault: came back from email verification. Finish vault setup.
      setMode('resume');
    })();
  }, [navigate]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Vault-password validations apply to both modes.
    if (vaultPassword !== vaultPasswordConfirm) {
      setError('Vault passwords do not match.');
      return;
    }
    if (mode === 'fresh' && vaultPassword === accountPassword) {
      setError('Vault password must be different from your account password.');
      return;
    }
    if (!acknowledgedUnrecoverable) {
      setError('You must acknowledge that a lost vault password cannot be recovered.');
      return;
    }

    setSubmitting(true);
    try {
      let userId: string;

      if (mode === 'fresh') {
        // Fresh signup path — create auth user + session.
        const { data: signupData, error: signupError } = await supabase.auth.signUp({
          email,
          password: accountPassword,
        });
        if (signupError) throw signupError;
        if (!signupData.session || !signupData.user) {
          throw new Error(
            'No active session after signup. Disable email-confirmation in your Supabase project settings, or contact support.',
          );
        }
        userId = signupData.user.id;
      } else {
        // Resume path — session already exists, just finish the vault.
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
          throw new Error('Session lost. Please sign in again.');
        }
        userId = session.user.id;
      }

      // Set up the vault regardless of path.
      const { saltB64, verifierCiphertext, keyVersion } = await setupVault(vaultPassword);

      const { error: metaError } = await supabase.from('user_vault_meta').insert({
        user_id: userId,
        vault_salt: saltB64,
        vault_verifier_ciphertext: verifierCiphertext,
        vault_key_version: keyVersion,
      });
      if (metaError) throw metaError;

      navigate({ to: '/app' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  if (mode === 'loading' || mode === 'unknown') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const isResume = mode === 'resume';

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold">
            {isResume ? 'Finish setting up your vault' : 'Create your OrangeRails account'}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isResume
              ? 'Your account is verified. Set your vault password to finish.'
              : 'Zero-knowledge from day one. Your vault password never leaves this browser.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isResume ? (
            <div className="rounded-md border bg-muted/30 p-3 text-sm">
              <div className="text-xs text-muted-foreground">Signed in as</div>
              <div className="font-medium">{resumeEmail}</div>
            </div>
          ) : (
            <>
              <div className="space-y-1">
                <label htmlFor="email" className="text-sm font-medium">Email</label>
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
                <label htmlFor="account-password" className="text-sm font-medium">Account password</label>
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
            </>
          )}

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
              Encrypts your provider credentials. <strong>We cannot recover this.</strong>{' '}
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
            {submitting ? (isResume ? 'Setting up vault...' : 'Creating account...') : (isResume ? 'Finish setup' : 'Create account')}
          </button>

          {!isResume && (
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{' '}
              <Link to="/login" className="text-primary hover:underline">Sign in</Link>
            </p>
          )}

          {isResume && (
            <button
              type="button"
              onClick={async () => {
                await supabase.auth.signOut();
                setMode('fresh');
              }}
              className="w-full text-sm text-muted-foreground hover:underline"
            >
              Not you? Sign out and start over
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
