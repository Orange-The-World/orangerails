import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useVault } from "@/context/VaultContext";
import type { GrantSupabaseLike } from "@/context/VaultContext";
import { formatError } from "@/lib/format-error";
import type { NormalizedTransaction } from "@/lib/crypto-fields";
import { decryptString } from "@/lib/vault";

function formatErrorVerbose(err: unknown): string {
  const msg = formatError(err);
  if (msg) return msg;
  // WebCrypto OperationError has an empty .message — include the name instead.
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name: string }).name;
    if (name && name !== "Error") return name;
  }
  return "Unknown error";
}

export const Route = createFileRoute("/app")({
  component: AppHome,
});

// ------------------------------------------------------------------
// Types — match the database schema.
// ------------------------------------------------------------------

interface Connection {
  id: string;
  provider_type: string;
  encrypted_label: string | null;
  encrypted_credentials: string;
  credentials_key_version: number;
  status: "active" | "error" | "disconnected";
  last_sync_at: string | null;
  last_sync_cursor: string | null;
  encrypted_last_error: string | null;
  created_at: string;
  // Derived client-side after decryption. Never stored in the DB row.
  decrypted_label?: string | null;
  decrypted_last_error?: string | null;
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

interface CoAdminRow {
  id: string;
  admin_user_id: string;
  added_at: string;
  adminEmail?: string; // resolved client-side via pqc-lookup-user (best-effort)
}

interface WorkspaceOption {
  ownerUserId: string;
  ownerEmail: string;
  workspaceKeyId: string;
  wrappedCiphertextB64: string;
  // No kemSecretWrapped here — the admin's own kem_secret_wrapped is used
  // for all workspace unwraps, stored separately in myKemSecretWrapped state.
}

// Providers available in Phase 1. Grows as we add adapters.
// Each provider ships with:
//   description: short one-liner for the dropdown
//   apiKeyUrl:   deep link to where the user creates their API key
//   steps:       numbered instructions shown inline in the dialog
//   scopeHint:   what permission/scope the user should pick when creating the key
const PROVIDERS = [
  {
    type: "blink",
    name: "Blink",
    description: "Lightning + USD stablecoin wallet by Galoy.",
    apiKeyUrl: "https://dashboard.blink.sv/api-keys",
    steps: [
      "Sign in to the Blink dashboard.",
      "Go to Settings → API keys (or use the link above).",
      "Create a new key with read-only access — we only need to read your transactions.",
      "Copy the key and paste it below before it disappears (Blink only shows it once).",
    ],
    scopeHint: "read-only",
  },
] as const;

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

function AppHome() {
  const navigate = useNavigate();
  const {
    isUnlocked,
    lock,
    encryptCredentials,
    decryptText,
    encryptText,
    decryptTransaction,
    encryptTransaction,
    exportCredentialsKeyForSync,
    exportTransactionsKeyForSync,
    ensurePqcKeypairs,
    grantCoAdmin,
    revokeCoAdmin,
    loadAdminSubkeys,
    changeVaultPassword,
  } = useVault();

  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [transactions, setTransactions] = useState<DecryptedTxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Co-admin state
  const [coAdmins, setCoAdmins] = useState<CoAdminRow[]>([]);
  const [workspaceKeyId, setWorkspaceKeyId] = useState<string | null>(null);
  const [vaultSalt, setVaultSalt] = useState<string | null>(null);
  const [myKemSecretWrapped, setMyKemSecretWrapped] = useState<string | null>(null);
  const [adminWorkspaces, setAdminWorkspaces] = useState<WorkspaceOption[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceOption | null>(null);
  // Cached admin subkeys — persists until tab closes (MVP limitation).
  const adminSubkeysRef = useRef<
    Map<string, { credentialsKey: CryptoKey; transactionsKey: CryptoKey }>
  >(new Map());
  const [coAdminOpen, setCoAdminOpen] = useState(false);
  const [grantDialogOpen, setGrantDialogOpen] = useState(false);

  // Security (change vault password) state
  const [securityOpen, setSecurityOpen] = useState(false);
  const [vaultEncMekCiphertext, setVaultEncMekCiphertext] = useState<string | null>(null);
  const [vaultVerifierCiphertext, setVaultVerifierCiphertext] = useState<string | null>(null);
  const [vaultKeyVersion, setVaultKeyVersion] = useState<number>(1);
  const [changePwForm, setChangePwForm] = useState({ current: "", next: "", confirm: "" });
  const [changePwLoading, setChangePwLoading] = useState(false);
  const [changePwErr, setChangePwErr] = useState<string | null>(null);
  const [changePwNewRecovery, setChangePwNewRecovery] = useState<string | null>(null);
  const [changePwRecoveryAcked, setChangePwRecoveryAcked] = useState(false);

  // Gate: redirect if not authenticated or not unlocked. Also load co-admin metadata.
  useEffect(() => {
    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) {
        navigate({ to: "/login" });
        return;
      }
      setEmail(session.user.email ?? null);
      setUserId(session.user.id);
      if (!isUnlocked) {
        navigate({ to: "/unlock" });
        return;
      }

      // Load vault salt + workspace_key_id + co-admin list.
      const { data: meta } = await (supabase as any)
        .from("user_vault_meta")
        .select("vault_salt, workspace_key_id, kem_secret_wrapped, enc_mek_ciphertext, vault_verifier_ciphertext, key_version")
        .eq("user_id", session.user.id)
        .single();
      if (meta) {
        setVaultSalt(((meta as Record<string, unknown>).vault_salt as string) ?? null);
        setWorkspaceKeyId(((meta as Record<string, unknown>).workspace_key_id as string) ?? null);
        const kemWrapped = ((meta as Record<string, unknown>).kem_secret_wrapped as string) ?? null;
        setMyKemSecretWrapped(kemWrapped);
        setVaultEncMekCiphertext(((meta as Record<string, unknown>).enc_mek_ciphertext as string) ?? null);
        setVaultVerifierCiphertext(((meta as Record<string, unknown>).vault_verifier_ciphertext as string) ?? null);
        setVaultKeyVersion(((meta as Record<string, unknown>).key_version as number) ?? 1);

        // If PQC keys are missing (signup pre-dated the PQC rollout or an earlier
        // ensurePqcKeypairs call failed), generate them now so co-admin works.
        if (!kemWrapped) {
          ensurePqcKeypairs(
            supabase as unknown as Parameters<typeof ensurePqcKeypairs>[0],
            session.user.id,
          )
            .then((result) => {
              if (result.generated) {
                // Re-fetch so myKemSecretWrapped is populated.
                return supabase
                  .from("user_vault_meta")
                  .select("kem_secret_wrapped")
                  .eq("user_id", session.user.id)
                  .single()
                  .then(({ data }) => {
                    if (data) {
                      setMyKemSecretWrapped(
                        ((data as Record<string, unknown>).kem_secret_wrapped as string) ?? null,
                      );
                    }
                  });
              }
            })
            .catch((err) => console.warn("PQC key backfill failed:", err));
        }
      }

      // Load list of users this person has granted co-admin to.
      const { data: admins } = await supabase
        .from("workspace_admins")
        .select("id, admin_user_id, added_at")
        .eq("owner_user_id", session.user.id);
      const adminRows = (admins ?? []) as CoAdminRow[];

      // Load workspaces where this user is a co-admin.
      const { data: myAdminOf } = await supabase
        .from("workspace_admins")
        .select("owner_user_id")
        .eq("admin_user_id", session.user.id);

      const workspaces: WorkspaceOption[] = [];
      if (myAdminOf && myAdminOf.length > 0) {
        const ownerIds = (myAdminOf as { owner_user_id: string }[]).map((r) => r.owner_user_id);
        for (const ownerId of ownerIds) {
          const { data: ownerMeta } = await supabase
            .from("user_vault_meta")
            .select("workspace_key_id")
            .eq("user_id", ownerId)
            .single();
          if (!ownerMeta) continue;
          const ownerKeyId = (ownerMeta as Record<string, unknown>).workspace_key_id as string | null;
          if (!ownerKeyId) continue;
          const { data: wdk } = await supabase
            .from("wrapped_data_keys")
            .select("wrapped_ciphertext")
            .eq("data_key_id", ownerKeyId)
            .maybeSingle();
          if (!wdk) continue;
          workspaces.push({
            ownerUserId: ownerId,
            ownerEmail: ownerId, // resolved below
            workspaceKeyId: ownerKeyId,
            wrappedCiphertextB64: (wdk as Record<string, unknown>).wrapped_ciphertext as string,
          });
        }
      }

      // Resolve emails for all connected users in one RPC call.
      const allIds = [
        ...adminRows.map((r) => r.admin_user_id),
        ...workspaces.map((w) => w.ownerUserId),
      ];
      const emailMap = new Map<string, string>();
      if (allIds.length > 0) {
        const { data: emailRows } = await supabase.rpc("get_coadmin_emails", {
          user_ids: allIds,
        });
        for (const row of (emailRows ?? []) as { user_id: string; email: string }[]) {
          emailMap.set(row.user_id, row.email);
        }
      }

      setCoAdmins(adminRows.map((r) => ({ ...r, adminEmail: emailMap.get(r.admin_user_id) })));
      setAdminWorkspaces(
        workspaces.map((w) => ({ ...w, ownerEmail: emailMap.get(w.ownerUserId) ?? w.ownerUserId })),
      );
    })();
  }, [isUnlocked, navigate]);

  // ------------------------------------------------------------------
  // Workspace-aware encrypt/decrypt: when an admin has switched to an
  // owner's workspace, use the cached admin subkeys instead of the vault's
  // own subkeys.
  // ------------------------------------------------------------------

  const getActiveCredentialsKey = useCallback(async (): Promise<CryptoKey | null> => {
    if (!activeWorkspace || !myKemSecretWrapped) return null;
    const cached = adminSubkeysRef.current.get(activeWorkspace.workspaceKeyId);
    if (cached) return cached.credentialsKey;
    const subkeys = await loadAdminSubkeys({
      ownerWorkspaceKeyId: activeWorkspace.workspaceKeyId,
      wrappedCiphertextB64: activeWorkspace.wrappedCiphertextB64,
      kemSecretWrapped: myKemSecretWrapped,
    });
    adminSubkeysRef.current.set(activeWorkspace.workspaceKeyId, subkeys);
    return subkeys.credentialsKey;
  }, [activeWorkspace, myKemSecretWrapped, loadAdminSubkeys]);

  const getActiveTransactionsKey = useCallback(async (): Promise<CryptoKey | null> => {
    if (!activeWorkspace || !myKemSecretWrapped) return null;
    const cached = adminSubkeysRef.current.get(activeWorkspace.workspaceKeyId);
    if (cached) return cached.transactionsKey;
    const subkeys = await loadAdminSubkeys({
      ownerWorkspaceKeyId: activeWorkspace.workspaceKeyId,
      wrappedCiphertextB64: activeWorkspace.wrappedCiphertextB64,
      kemSecretWrapped: myKemSecretWrapped,
    });
    adminSubkeysRef.current.set(activeWorkspace.workspaceKeyId, subkeys);
    return subkeys.transactionsKey;
  }, [activeWorkspace, myKemSecretWrapped, loadAdminSubkeys]);

  // Load connections + decrypt recent transactions.
  // When activeWorkspace is set, only load the owner's connections and use
  // their subkeys for decryption. When null, only load the current user's own.
  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      // Resolve which user's connections to show and which keys to use.
      const isAdminView = !!activeWorkspace;
      let txnsKey: CryptoKey | null = null;
      if (isAdminView) {
        // Warm the credentials key cache too — avoids a cold load on first Sync.
        await getActiveCredentialsKey();
        txnsKey = await getActiveTransactionsKey();
        if (!txnsKey) throw new Error("Could not load workspace keys.");
      }

      // Determine which user's connections to fetch.
      const currentSession = await supabase.auth.getSession();
      const myId = currentSession.data.session?.user.id;
      if (!myId) throw new Error("Not authenticated");
      const targetUserId = isAdminView ? activeWorkspace!.ownerUserId : myId;

      const { data: conns, error: connErr } = await supabase
        .from("connections")
        .select("*")
        .eq("user_id", targetUserId)
        .order("created_at", { ascending: false });
      if (connErr) throw connErr;

      // Decrypt label + last_error using the appropriate key.
      const decryptedConns = await Promise.all(
        (conns ?? []).map(async (raw): Promise<Connection> => {
          const c = raw as unknown as Connection;
          let decrypted_label: string | null = null;
          let decrypted_last_error: string | null = null;
          if (c.encrypted_label) {
            try {
              decrypted_label = isAdminView
                ? await decryptString(c.encrypted_label, txnsKey!)
                : await decryptText(c.encrypted_label);
            } catch {
              /* ignore — label is cosmetic */
            }
          }
          if (c.encrypted_last_error) {
            try {
              const raw = isAdminView
                ? await decryptString(c.encrypted_last_error, txnsKey!)
                : await decryptText(c.encrypted_last_error);
              decrypted_last_error = raw || "(empty error — check browser console for details)";
            } catch {
              decrypted_last_error = "(could not decrypt error — check browser console)";
            }
          }
          return { ...c, decrypted_label, decrypted_last_error };
        }),
      );
      setConnections(decryptedConns);

      // Fetch only transactions belonging to the target user's connections.
      const connIds = (conns ?? []).map((c) => (c as unknown as Connection).id);
      const txQuery = supabase
        .from("encrypted_transactions")
        .select("id, connection_id, external_id, encrypted_payload, occurred_at")
        .order("occurred_at", { ascending: false })
        .limit(50);
      const { data: txs, error: txErr } = connIds.length > 0
        ? await txQuery.in("connection_id", connIds)
        : await txQuery.in("connection_id", ["00000000-0000-0000-0000-000000000000"]);
      if (txErr) throw txErr;

      // Decrypt each transaction with the appropriate key.
      const decrypted = await Promise.all(
        (txs ?? []).map(async (row: EncryptedTxRow): Promise<DecryptedTxRow | null> => {
          try {
            const tx = isAdminView
              ? JSON.parse(await decryptString(row.encrypted_payload, txnsKey!)) as NormalizedTransaction
              : await decryptTransaction(row.encrypted_payload);
            return { ...tx, connection_id: row.connection_id, occurred_at: row.occurred_at };
          } catch (e) {
            console.warn("Failed to decrypt transaction", row.id, e);
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
  }, [activeWorkspace, decryptTransaction, decryptText, getActiveCredentialsKey, getActiveTransactionsKey]);

  useEffect(() => {
    if (isUnlocked) void refresh();
  }, [isUnlocked, refresh, activeWorkspace]);

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  // Export an arbitrary CryptoKey as base64 (for in-transit handoff to or-sync).
  async function exportRawKeyAsBase64(key: CryptoKey): Promise<string> {
    const raw = await crypto.subtle.exportKey("raw", key);
    const bytes = new Uint8Array(raw);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async function handleAddConnection(params: { provider: string; label: string; apiKey: string }) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session) throw new Error("Not authenticated");

    const encrypted = await encryptCredentials({ api_key: params.apiKey });
    const labelPlaintext = params.label || params.provider;
    const encrypted_label = await encryptText(labelPlaintext);

    const { error: insertErr } = await supabase.from("connections").insert({
      user_id: session.user.id,
      provider_type: params.provider,
      encrypted_label,
      encrypted_credentials: encrypted,
      credentials_key_version: 1,
      status: "active",
    });
    if (insertErr) throw insertErr;
    setNotice("Connection added. Your API key is encrypted — we cannot read it.");
    await refresh();
  }

  async function handleSync(conn: Connection) {
    setSyncingId(conn.id);
    setErr(null);
    try {
      const isAdminView = !!activeWorkspace;
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      // Export the appropriate AES keys as base64 for in-transit handoff.
      // The or-sync edge function uses them in memory only and never persists.
      let credentials_key: string;
      let transactions_key: string;

      if (isAdminView) {
        const credsKey = await getActiveCredentialsKey();
        const txnsKey = await getActiveTransactionsKey();
        if (!credsKey || !txnsKey) throw new Error("Could not load workspace keys.");
        credentials_key = await exportRawKeyAsBase64(credsKey);
        transactions_key = await exportRawKeyAsBase64(txnsKey);
      } else {
        credentials_key = await exportCredentialsKeyForSync();
        transactions_key = await exportTransactionsKeyForSync();
      }

      // Call or-sync. The edge function handles decrypt → fetch → encrypt → upsert.
      const body: Record<string, unknown> = {
        connection_ids: [conn.id],
        credentials_key,
        transactions_key,
      };
      if (isAdminView && activeWorkspace) {
        body.target_user_id = activeWorkspace.ownerUserId;
      }

      const fnRes = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/or-sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!fnRes.ok) {
        const detail = await fnRes.text().catch(() => "");
        throw new Error(`Sync failed (HTTP ${fnRes.status}): ${detail || "see console"}`);
      }

      const result = (await fnRes.json()) as {
        synced: number;
        connections: Array<{ connection_id: string; synced: number; error?: string }>;
      };

      // Surface any per-connection error from the edge function.
      const connResult = result.connections.find((c) => c.connection_id === conn.id);
      if (connResult?.error) throw new Error(connResult.error);

      setNotice(
        `Synced ${result.synced} transaction${result.synced === 1 ? "" : "s"} from ${conn.decrypted_label || conn.provider_type}.`,
      );
      await refresh();
    } catch (e) {
      const msg = formatErrorVerbose(e);
      console.error("[OrangeRails] Sync error:", e);
      setErr(msg);
    } finally {
      setSyncingId(null);
    }
  }

  async function handleDelete(conn: Connection) {
    if (
      !confirm(
        `Delete the ${conn.decrypted_label || conn.provider_type} connection? Synced transactions for this connection will also be removed.`,
      )
    )
      return;
    const { error: delErr } = await supabase.from("connections").delete().eq("id", conn.id);
    if (delErr) {
      setErr(formatError(delErr));
      return;
    }
    setNotice("Connection deleted.");
    await refresh();
  }

  async function handleSignOut() {
    lock();
    await supabase.auth.signOut();
    navigate({ to: "/login" });
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
          <div className="flex items-center gap-4 flex-wrap">
            {/* Workspace switcher — only shown when this user is a co-admin of at least one workspace */}
            {adminWorkspaces.length > 0 && (
              <select
                value={activeWorkspace?.workspaceKeyId ?? ""}
                onChange={async (e) => {
                  const keyId = e.target.value;
                  if (!keyId) {
                    setActiveWorkspace(null);
                    // useEffect[activeWorkspace] triggers refresh automatically.
                    return;
                  }
                  const ws = adminWorkspaces.find((w) => w.workspaceKeyId === keyId) ?? null;
                  if (!ws) return;
                  try {
                    if (!myKemSecretWrapped) {
                      throw new Error(
                        "Your vault PQC keys are not set up yet. Lock and unlock your vault to generate them, then try again.",
                      );
                    }
                    // Pre-load and cache subkeys now so refresh() can use them immediately.
                    if (!adminSubkeysRef.current.has(ws.workspaceKeyId)) {
                      let subkeys;
                      try {
                        subkeys = await loadAdminSubkeys({
                          ownerWorkspaceKeyId: ws.workspaceKeyId,
                          wrappedCiphertextB64: ws.wrappedCiphertextB64,
                          kemSecretWrapped: myKemSecretWrapped,
                        });
                      } catch (unwrapErr) {
                        const name =
                          unwrapErr && typeof unwrapErr === "object" && "name" in unwrapErr
                            ? (unwrapErr as { name: string }).name
                            : "";
                        if (name === "OperationError") {
                          throw new Error(
                            "Could not decrypt workspace keys. The grant may need to be revoked and re-issued.",
                          );
                        }
                        throw unwrapErr;
                      }
                      adminSubkeysRef.current.set(ws.workspaceKeyId, subkeys);
                    }
                    // Setting state triggers useEffect[activeWorkspace] → refresh().
                    setActiveWorkspace(ws);
                  } catch (switchErr) {
                    setErr(`Failed to load workspace: ${formatErrorVerbose(switchErr)}`);
                  }
                }}
                className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
              >
                <option value="">My data</option>
                {adminWorkspaces.map((ws) => (
                  <option key={ws.workspaceKeyId} value={ws.workspaceKeyId}>
                    {ws.ownerEmail}'s data
                  </option>
                ))}
              </select>
            )}
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

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <div className="rounded-md border bg-green-500/5 border-green-500/40 p-3 text-xs text-green-700 dark:text-green-400">
          ✓ Session-based zero-knowledge active. Keys live only in this browser tab's memory.
        </div>

        {notice && <div className="rounded-md border p-3 text-sm bg-muted/30">{notice}</div>}
        {err && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {err}
          </div>
        )}

        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">
              {activeWorkspace
                ? `${activeWorkspace.ownerEmail}'s connections`
                : "Your connections"}
            </h2>
            {!activeWorkspace && (
              <button
                onClick={() => setAddOpen(true)}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Add connection
              </button>
            )}
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

        {/* Co-admins — collapsible settings section */}
        {!activeWorkspace && (
          <section className="border rounded-md">
            <button
              onClick={() => setCoAdminOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium hover:bg-muted/30"
            >
              <span>Co-admin emergency access</span>
              <span className="text-muted-foreground">{coAdminOpen ? "▲" : "▼"}</span>
            </button>
            {coAdminOpen && (
              <div className="px-4 pb-4 space-y-3 border-t">
                <p className="text-xs text-muted-foreground pt-3">
                  Grant another registered OrangeRails user full read/write access to your data.
                  Useful if you become unavailable. They'll see your data after their next vault
                  unlock.
                </p>
                {coAdmins.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No co-admins yet.</div>
                ) : (
                  <div className="space-y-2">
                    {coAdmins.map((a) => (
                      <div
                        key={a.id}
                        className="flex items-center justify-between border rounded-md px-3 py-2 text-sm"
                      >
                        <div>
                          <span className="font-mono text-xs text-muted-foreground">
                            {a.adminEmail ?? a.admin_user_id.slice(0, 8) + "…"}
                          </span>
                          <span className="ml-2 text-xs text-muted-foreground">
                            added {new Date(a.added_at).toLocaleDateString()}
                          </span>
                        </div>
                        <button
                          className="text-xs text-destructive hover:underline"
                          onClick={async () => {
                            if (
                              !confirm(
                                "Revoke this co-admin? They will lose access on their next unlock.",
                              )
                            )
                              return;
                            if (!workspaceKeyId || !userId) {
                              setErr("Missing workspace key — try reloading.");
                              return;
                            }
                            try {
                              await revokeCoAdmin({
                                ownerWorkspaceKeyId: workspaceKeyId,
                                adminUserId: a.admin_user_id,
                                ownerUserId: userId,
                                supabase: supabase as unknown as GrantSupabaseLike,
                              });
                              setCoAdmins((prev) => prev.filter((x) => x.id !== a.id));
                              setNotice("Co-admin revoked.");
                            } catch (e) {
                              setErr(formatError(e));
                            }
                          }}
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <button
                  onClick={() => setGrantDialogOpen(true)}
                  className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
                >
                  Add co-admin
                </button>
              </div>
            )}
          </section>
        )}

        {/* ── Security ─────────────────────────────────────────── */}
        <section className="rounded-lg border p-4 space-y-3">
          <button
            onClick={() => setSecurityOpen(!securityOpen)}
            className="flex w-full items-center justify-between text-left"
          >
            <h2 className="text-sm font-semibold">Security</h2>
            <span className="text-xs text-muted-foreground">{securityOpen ? "▲" : "▼"}</span>
          </button>

          {securityOpen && (
            <div className="space-y-4 pt-1">
              <p className="text-xs text-muted-foreground">
                Change your vault password. Your data will not be re-encrypted — only the key
                wrapping changes. A new recovery code will be generated; save it immediately.
              </p>

              {changePwNewRecovery ? (
                /* Step 2: show new recovery code */
                <div className="space-y-3">
                  <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide">
                    New recovery code — save this now
                  </p>
                  <div className="rounded-md border border-orange-400/40 bg-orange-50/40 p-3 font-mono text-sm break-all">
                    {changePwNewRecovery}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    This code will not be shown again. Store it in a password manager or print it.
                  </p>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={changePwRecoveryAcked}
                      onChange={(e) => setChangePwRecoveryAcked(e.target.checked)}
                    />
                    I have saved my recovery code
                  </label>
                  <button
                    disabled={!changePwRecoveryAcked}
                    onClick={() => {
                      setChangePwNewRecovery(null);
                      setChangePwRecoveryAcked(false);
                      setChangePwForm({ current: "", next: "", confirm: "" });
                      setNotice("Vault password changed successfully.");
                    }}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                  >
                    Done
                  </button>
                </div>
              ) : (
                /* Step 1: change password form */
                <form
                  className="space-y-3"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setChangePwErr(null);
                    if (changePwForm.next !== changePwForm.confirm) {
                      setChangePwErr("New passwords do not match.");
                      return;
                    }
                    if (!vaultSalt || !vaultEncMekCiphertext || !vaultVerifierCiphertext) {
                      setChangePwErr("Vault metadata not loaded. Try reloading the page.");
                      return;
                    }
                    setChangePwLoading(true);
                    try {
                      const { newEncMekCiphertext, newRecoveryCode, newRecoveryCiphertext } =
                        await changeVaultPassword({
                          currentPassword: changePwForm.current,
                          newPassword: changePwForm.next,
                          storedSaltB64: vaultSalt,
                          storedEncMekCiphertext: vaultEncMekCiphertext,
                          storedVerifierCiphertext: vaultVerifierCiphertext,
                          keyVersion: vaultKeyVersion,
                        });
                      // Persist new wrapping to user_vault_meta.
                      const { error: saveErr } = await (supabase as any)
                        .from("user_vault_meta")
                        .update({
                          enc_mek_ciphertext: newEncMekCiphertext,
                          recovery_ciphertext: newRecoveryCiphertext,
                        })
                        .eq("user_id", userId);
                      if (saveErr) throw new Error((saveErr as { message?: string }).message ?? "Save failed.");
                      setVaultEncMekCiphertext(newEncMekCiphertext);
                      setChangePwNewRecovery(newRecoveryCode);
                    } catch (ex) {
                      setChangePwErr(formatErrorVerbose(ex));
                    }
                    setChangePwLoading(false);
                  }}
                >
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Current password</label>
                    <input
                      type="password"
                      value={changePwForm.current}
                      onChange={(e) => setChangePwForm((f) => ({ ...f, current: e.target.value }))}
                      className="w-full rounded-md border px-3 py-1.5 text-sm bg-background"
                      autoComplete="current-password"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">New password</label>
                    <input
                      type="password"
                      value={changePwForm.next}
                      onChange={(e) => setChangePwForm((f) => ({ ...f, next: e.target.value }))}
                      className="w-full rounded-md border px-3 py-1.5 text-sm bg-background"
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Confirm new password</label>
                    <input
                      type="password"
                      value={changePwForm.confirm}
                      onChange={(e) => setChangePwForm((f) => ({ ...f, confirm: e.target.value }))}
                      className="w-full rounded-md border px-3 py-1.5 text-sm bg-background"
                      autoComplete="new-password"
                    />
                  </div>
                  {changePwErr && <p className="text-xs text-destructive">{changePwErr}</p>}
                  <button
                    type="submit"
                    disabled={
                      changePwLoading ||
                      !changePwForm.current ||
                      !changePwForm.next ||
                      !changePwForm.confirm
                    }
                    className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
                  >
                    {changePwLoading ? "Changing…" : "Change password"}
                  </button>
                </form>
              )}
            </div>
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

      {grantDialogOpen && userId && vaultSalt && (
        <GrantCoAdminDialog
          onClose={() => setGrantDialogOpen(false)}
          onSubmit={async ({ targetEmail, password }) => {
            const result = await grantCoAdmin({
              ownerUserId: userId,
              ownerSaltB64: vaultSalt,
              ownerPassword: password,
              targetEmail,
              existingKeyId: workspaceKeyId,
              supabase: supabase as unknown as GrantSupabaseLike,
            });
            if (result.workspaceKeyId !== workspaceKeyId) {
              setWorkspaceKeyId(result.workspaceKeyId);
            }
            // Reload co-admin list with resolved emails.
            const { data: admins } = await supabase
              .from("workspace_admins")
              .select("id, admin_user_id, added_at")
              .eq("owner_user_id", userId);
            const freshRows = (admins ?? []) as CoAdminRow[];
            const freshIds = freshRows.map((r) => r.admin_user_id);
            const emailMap = new Map<string, string>();
            if (freshIds.length > 0) {
              const { data: emailRows } = await supabase.rpc("get_coadmin_emails", { user_ids: freshIds });
              for (const row of (emailRows ?? []) as { user_id: string; email: string }[]) {
                emailMap.set(row.user_id, row.email);
              }
            }
            setCoAdmins(freshRows.map((r) => ({ ...r, adminEmail: emailMap.get(r.admin_user_id) })));
            setNotice("Co-admin added. They'll see your data on their next unlock.");
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------
// Sub-components
// ------------------------------------------------------------------

function ConnectionRow({
  conn,
  syncing,
  onSync,
  onDelete,
}: {
  conn: Connection;
  syncing: boolean;
  onSync: () => void;
  onDelete: () => void;
}) {
  const statusColor =
    conn.status === "active"
      ? "text-green-600 dark:text-green-400"
      : conn.status === "error"
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <div className="rounded-md border p-4 flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{conn.decrypted_label || conn.provider_type}</div>
        <div className="text-xs text-muted-foreground flex items-center gap-2 mt-1">
          <span className="uppercase">{conn.provider_type}</span>
          <span>·</span>
          <span className={statusColor}>{conn.status}</span>
          <span>·</span>
          <span>{conn.last_sync_at ? `Synced ${timeAgo(conn.last_sync_at)}` : "Never synced"}</span>
        </div>
        {conn.decrypted_last_error && (
          <div className="text-xs text-destructive mt-1 truncate">
            Last error: {conn.decrypted_last_error}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onSync}
          disabled={syncing}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
        >
          {syncing ? "Syncing..." : "Sync now"}
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
              <td className="px-3 py-2 whitespace-nowrap">
                {new Date(tx.occurred_at).toLocaleString()}
              </td>
              <td className="px-3 py-2">{tx.direction === "in" ? "↓ in" : "↑ out"}</td>
              <td className="px-3 py-2">{tx.type}</td>
              <td className="px-3 py-2 text-right font-mono">
                {(tx.amount_sats ?? 0).toLocaleString()}
              </td>
              <td className="px-3 py-2 max-w-xs truncate">{tx.description ?? "—"}</td>
              <td className="px-3 py-2">{tx.status ?? "—"}</td>
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
  const [provider, setProvider] = useState<string>(PROVIDERS[0].type);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!apiKey.trim()) {
      setError("API key required.");
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
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg p-6 max-w-md w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-lg font-semibold">Add a connection</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Your API key will be encrypted in this browser before it leaves. OrangeRails stores
            ciphertext only.
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
                <option key={p.type} value={p.type}>
                  {p.name}
                </option>
              ))}
            </select>
            {providerMeta && (
              <p className="text-xs text-muted-foreground">{providerMeta.description}</p>
            )}
          </div>

          {providerMeta && (
            <div className="rounded-md border border-orange-500/30 bg-orange-500/5 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium uppercase tracking-wide text-orange-600 dark:text-orange-400">
                  How to get your {providerMeta.name} API key
                </div>
                <a
                  href={providerMeta.apiKeyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-primary hover:underline whitespace-nowrap"
                >
                  Open {providerMeta.name} dashboard ↗
                </a>
              </div>
              <ol className="text-xs text-muted-foreground space-y-1 list-decimal pl-4">
                {providerMeta.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              <div className="text-xs text-muted-foreground italic">
                Permission scope to pick:{" "}
                <span className="font-medium not-italic">{providerMeta.scopeHint}</span>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <label className="text-sm font-medium">
              Label <span className="text-muted-foreground">(optional)</span>
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`My ${providerMeta?.name ?? "account"}`}
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
              placeholder="Paste the key you just copied"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? "Encrypting + saving..." : "Add connection"}
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

/**
 * Coerce adapter-provided timestamps to ISO 8601.
 * Accepts: ISO string (pass-through), Unix seconds (number or numeric string),
 * Unix milliseconds (>= 10^12). Defensive against adapter bugs like the one
 * that surfaced when Blink returned Unix seconds where we expected ISO.
 */
function toIsoTimestamp(v: unknown): string {
  if (typeof v === "string" && /^\d+$/.test(v)) {
    const n = Number(v);
    return new Date(n >= 1e12 ? n : n * 1000).toISOString();
  }
  if (typeof v === "number") {
    return new Date(v >= 1e12 ? v : v * 1000).toISOString();
  }
  if (typeof v === "string") {
    const parsed = new Date(v);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  // Last resort: throw so the adapter bug is surfaced, not silently corrupted.
  throw new Error(`Adapter returned invalid timestamp: ${JSON.stringify(v)}`);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function GrantCoAdminDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (p: { targetEmail: string; password: string }) => Promise<void>;
}) {
  const [targetEmail, setTargetEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!targetEmail.trim() || !password) {
      setError("Email and vault password required.");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ targetEmail: targetEmail.trim(), password });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 px-4"
      onClick={onClose}
    >
      <div
        className="bg-background rounded-lg p-6 max-w-md w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-lg font-semibold">Add co-admin</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Grant another OrangeRails user full access to your data. They must already have an
            account and have unlocked their vault at least once.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="text-sm font-medium">Co-admin email</label>
            <input
              type="email"
              value={targetEmail}
              onChange={(e) => setTargetEmail(e.target.value)}
              required
              autoComplete="off"
              placeholder="their@email.com"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Your vault password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="Re-confirm to authorize the grant"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Required to derive your encryption keys. Never sent to the server.
            </p>
          </div>
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? "Granting..." : "Grant full access"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
