import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useVault } from '@/context/VaultContext';

export const Route = createFileRoute('/app')({
  component: AppHome,
});

function AppHome() {
  const navigate = useNavigate();
  const { isUnlocked, lock } = useVault();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        navigate({ to: '/login' });
        return;
      }
      setEmail(session.user.email ?? null);

      if (!isUnlocked) {
        navigate({ to: '/unlock' });
        return;
      }
    })();
  }, [isUnlocked, navigate]);

  async function handleSignOut() {
    lock();
    await supabase.auth.signOut();
    navigate({ to: '/login' });
  }

  if (!isUnlocked) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Redirecting to unlock...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="font-semibold">OrangeRails</div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{email}</span>
            <button
              onClick={handleSignOut}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Welcome to OrangeRails</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your vault is unlocked. This is a minimal Phase 1 landing page —
            the full dashboard (connections, sync status, adapter catalog) ships
            with Phase 2.
          </p>
        </div>

        <div className="rounded-md border p-4 space-y-2 bg-green-500/5 border-green-500/40">
          <div className="text-sm font-medium text-green-700 dark:text-green-400">
            ✓ Session-based zero-knowledge active
          </div>
          <div className="text-xs text-muted-foreground">
            Your Master Encryption Key lives only in this browser tab's memory.
            Close the tab or click "Sign out" to clear it. Nothing sensitive
            has been transmitted to our server except ciphertext and opaque
            metadata.
          </div>
        </div>

        <div className="rounded-md border p-4 space-y-2">
          <div className="text-sm font-medium">What's coming next</div>
          <ul className="text-xs text-muted-foreground space-y-1 list-disc pl-4">
            <li>Phase 2: Link widget — connect Blink, Kraken, BTCPay, xpub and more.</li>
            <li>Phase 3: BitBooks Vault integration using your existing vault password.</li>
            <li>Phase 4: additional provider adapters contributed by the community.</li>
            <li>Phase 5: public launch, self-hosted Docker deployment, audit.</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
