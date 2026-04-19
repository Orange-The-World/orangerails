import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useVault } from '@/context/VaultContext';
import { formatError } from '@/lib/format-error';
import type { NormalizedTransaction } from '@/lib/crypto-fields';

export const Route = createFileRoute('/app')({
  component: AppHome,
});

// ------------------------------------------------------------------
// Types — match the database schema.
// ------------------------------------------------------------------

interface Connection {
  id: string;
  provider_type: string;
  label: string | null;
  encrypted_credentials: string;
  credentials_key_version: number;
  status: 'active' | 'error' | 'disconnected';
  last_sync_at: string | null;
  last_sync_cursor: string | null;
  last_error: string | null;
  created_at: string;
}

interface EncryptedTxRow {
  id: string;
  connection_id: string;
  external_id: string;
  encrypted_payload: string;
  occurred_at: string;
}

type DecryptedTxRow = NormalizedTransaction & {
  connection_id: string;
  occurred_at: string;
};

// Providers available in Phase 1. Grows as we add adapters.
const PROVIDERS = [
  { type: 'blink', name: 'Blink', description: 'Lightning + USD stablecoin. Get your API key at dashboard.blink.sv.' },
] as const;

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

function AppHome() {
  const navigate = useNavigate();
  const { isUnlocked, lock, encryptCredentials, decryptCredentials, encryptTransaction, decryptTransaction } = useVault();

  const [email, setEmail] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [transactions, setTransactions] = useState<DecryptedTxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Gate: redirect if not authenticated or not unlocked.
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
      }
    })();
  }, [isUnlocked, navigate]);

  // Load connections + decrypt recent transactions.
  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const { data: conns, error: connErr } = await supabase
        .from('connections')
        .select('*')
        .order('created_at', { ascending: false });
      if (connErr) throw connErr;
      setConnections((conns ?? []) as Connection[]);

      const { data: txs, error: txErr } = await supabase
        .from('encrypted_transactions')
        .select('id, connection_id, external_id, encrypted_payload, occurred_at')
        .order('occurred_at', { ascending: false })
        .limit(50);
      if (txErr) throw txErr;

      // Decrypt each transaction in parallel. Ones that fail to decrypt
      // (wrong key version, corruption) are filtered out so a single bad
      // row doesn't poison the whole list.
      const decrypted = await Promise.all(
        (txs ?? []).map(async (row: EncryptedTxRow): Promise<DecryptedTxRow | null> => {
          try {
            const tx = await decryptTransaction(row.encrypted_payload);
            return { ...tx, connection_id: row.connection_id, occurred_at: row.occurred_at };
          } catch (e) {
            console.warn('Failed to decrypt transaction', row.id, e);
            return null;
          }
        }),
      );
      setTransactions(decrypted.filter((t): t is DecryptedTxRow => t !== null));
    } catch (e) {
      setErr(formatError(e));
    } finally {
      setLoading(false);
    }
  }, [decryptTransaction]);

  useEffect(() => {
    if (isUnlocked) void refresh();
  }, [isUnlocked, refresh]);

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async function handleAddConnection(params: { provider: string; label: string; apiKey: string }) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error('Not authenticated');

    const encrypted = await encryptCredentials({ api_key: params.apiKey });

    const { error: insertErr } = await supabase.from('connections').insert({
      user_id: session.user.id,
      provider_type: params.provider,
      label: params.label || params.provider,
      encrypted_credentials: encrypted,
      credentials_key_version: 1,
      status: 'active',
    });
    if (insertErr) throw insertErr;
    setNotice('Connection added. Your API key is encrypted — we cannot read it.');
    await refresh();
  }

  async function handleSync(conn: Connection) {
    setSyncingId(conn.id);
    setErr(null);
    try {
      // Decrypt the stored credentials locally.
      const creds = await decryptCredentials(conn.encrypted_credentials);
      const apiKey = creds.api_key;
      if (!apiKey) throw new Error('Connection has no api_key field');

      // Call the edge function (which calls the provider).
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');

      const fnRes = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sync-blink`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ api_key: apiKey, cursor: conn.last_sync_cursor }),
        },
      );
      if (!fnRes.ok) {
        const detail = await fnRes.text().catch(() => '');
        throw new Error(`Sync failed (HTTP ${fnRes.status}): ${detail || 'see console'}`);
      }
      const { transactions: newTxs, next_cursor } = await fnRes.json() as {
        transactions: NormalizedTransaction[];
        next_cursor: string | null;
      };

      // Encrypt each new transaction and upsert into encrypted_transactions.
      // Dedup is handled by the (connection_id, external_id) unique index.
      if (newTxs.length > 0) {
        const rows = await Promise.all(
          newTxs.map(async (tx) => ({
            connection_id: conn.id,
            external_id: tx.id,
            encrypted_payload: await encryptTransaction(tx),
            payload_key_version: 1,
            occurred_at: tx.timestamp,
          })),
        );
        const { error: upsertErr } = await supabase
          .from('encrypted_transactions')
          .upsert(rows, { onConflict: 'connection_id,external_id' });
        if (upsertErr) throw upsertErr;
      }

      // Update connection last_sync_at and cursor.
      const { error: updErr } = await supabase
        .from('connections')
        .update({
          last_sync_at: new Date().toISOString(),
          last_sync_cursor: next_cursor,
          status: 'active',
          last_error: null,
        })
        .eq('id', conn.id);
      if (updErr) throw updErr;

      setNotice(`Synced ${newTxs.length} transaction${newTxs.length === 1 ? '' : 's'} from ${conn.label || conn.provider_type}.`);
      await refresh();
    } catch (e) {
      const msg = formatError(e);
      setErr(msg);
      await supabase
        .from('connections')
        .update({ status: 'error', last_error: msg.slice(0, 500) })
        .eq('id', conn.id);
      await refresh();
    } finally {
      setSyncingId(null);
    }
  }

  async function handleDelete(conn: Connection) {
    if (!confirm(`Delete the ${conn.label || conn.provider_type} connection? Synced transactions for this connection will also be removed.`)) return;
    const { error: delErr } = await supabase.from('connections').delete().eq('id', conn.id);
    if (delErr) {
      setErr(formatError(delErr));
      return;
    }
    setNotice('Connection deleted.');
    await refresh();
  }

  async function handleSignOut() {
    lock();
    await supabase.auth.signOut();
    navigate({ to: '/login' });
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

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
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="font-semibold">OrangeRails</div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">{email}</span>
            <button onClick={handleSignOut} className="text-sm text-muted-foreground hover:text-foreground">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <div className="rounded-md border bg-green-500/5 border-green-500/40 p-3 text-xs text-green-700 dark:text-green-400">
          ✓ Session-based zero-knowledge active. Keys live only in this browser tab's memory.
        </div>

        {notice && (
          <div className="rounded-md border p-3 text-sm bg-muted/30">{notice}</div>
        )}
        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Your connections</h2>
            <button
              onClick={() => setAddOpen(true)}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Add connection
            </button>
          </div>

          {loading && connections.length === 0 ? (
            <div className="text-sm text-muted-foreground">Loading...</div>
          ) : connections.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center">
              <p className="text-sm text-muted-foreground">
                No connections yet. Add one to sync your Bitcoin transaction data.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {connections.map((c) => (
                <ConnectionRow
                  key={c.id}
                  conn={c}
                  syncing={syncingId === c.id}
                  onSync={() => handleSync(c)}
                  onDelete={() => handleDelete(c)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Recent transactions</h2>
          {transactions.length === 0 ? (
            <div className="rounded-md border border-dashed p-6 text-center">
              <p className="text-sm text-muted-foreground">
                No transactions yet. Add a connection above and click Sync.
              </p>
            </div>
          ) : (
            <TransactionTable rows={transactions} />
          )}
        </section>
      </main>

      {addOpen && (
        <AddConnectionDialog
          onClose={() => setAddOpen(false)}
          onSubmit={async (p) => {
            try {
              await handleAddConnection(p);
              setAddOpen(false);
            } catch (e) {
              throw new Error(formatError(e));
            }
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

function ConnectionRow({ conn, syncing, onSync, onDelete }: {
  conn: Connection;
  syncing: boolean;
  onSync: () => void;
  onDelete: () => void;
}) {
  const statusColor =
    conn.status === 'active' ? 'text-green-600 dark:text-green-400' :
    conn.status === 'error' ? 'text-destructive' :
    'text-muted-foreground';

  return (
    <div className="rounded-md border p-4 flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{conn.label || conn.provider_type}</div>
        <div className="text-xs text-muted-foreground flex items-center gap-2 mt-1">
          <span className="uppercase">{conn.provider_type}</span>
          <span>·</span>
          <span className={statusColor}>{conn.status}</span>
          <span>·</span>
          <span>{conn.last_sync_at ? `Synced ${timeAgo(conn.last_sync_at)}` : 'Never synced'}</span>
        </div>
        {conn.last_error && (
          <div className="text-xs text-destructive mt-1 truncate">Last error: {conn.last_error}</div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onSync}
          disabled={syncing}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {syncing ? 'Syncing...' : 'Sync now'}
        </button>
        <button
          onClick={onDelete}
          className="rounded-md border border-destructive/30 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function TransactionTable({ rows }: { rows: DecryptedTxRow[] }) {
  return (
    <div className="rounded-md border overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs uppercase">
          <tr>
            <th className="text-left px-3 py-2 font-medium">When</th>
            <th className="text-left px-3 py-2 font-medium">Direction</th>
            <th className="text-left px-3 py-2 font-medium">Type</th>
            <th className="text-right px-3 py-2 font-medium">Amount (sats)</th>
            <th className="text-left px-3 py-2 font-medium">Memo</th>
            <th className="text-left px-3 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((tx) => (
            <tr key={`${tx.connection_id}-${tx.id}`} className="border-t">
              <td className="px-3 py-2 whitespace-nowrap">{new Date(tx.occurred_at).toLocaleString()}</td>
              <td className="px-3 py-2">{tx.direction === 'in' ? '↓ in' : '↑ out'}</td>
              <td className="px-3 py-2">{tx.type}</td>
              <td className="px-3 py-2 text-right font-mono">{(tx.amount_sats ?? 0).toLocaleString()}</td>
              <td className="px-3 py-2 max-w-xs truncate">{tx.description ?? '—'}</td>
              <td className="px-3 py-2">{tx.status ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddConnectionDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (p: { provider: string; label: string; apiKey: string }) => Promise<void>;
}) {
  const [provider, setProvider] = useState(PROVIDERS[0].type);
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!apiKey.trim()) {
      setError('API key required.');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ provider, label: label.trim(), apiKey: apiKey.trim() });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const providerMeta = PROVIDERS.find((p) => p.type === provider);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4" onClick={onClose}>
      <div
        className="bg-background rounded-lg p-6 max-w-md w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-lg font-semibold">Add a connection</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Your API key will be encrypted in this browser before it leaves.
            OrangeRails stores ciphertext only.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">Provider</label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {PROVIDERS.map((p) => (
                <option key={p.type} value={p.type}>{p.name}</option>
              ))}
            </select>
            {providerMeta && (
              <p className="text-xs text-muted-foreground">{providerMeta.description}</p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Label <span className="text-muted-foreground">(optional)</span></label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="My Blink wallet"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">API key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              autoComplete="off"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button type="button" onClick={onClose} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? 'Encrypting + saving...' : 'Add connection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
