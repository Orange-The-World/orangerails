import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { formatError } from "@/lib/format-error";
import { logSecurityEvent } from "@/lib/audit";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface TokenRow {
  id: string;
  app_slug: string;
  app_name: string;
  granted_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  rotated_at: string | null;
}

interface FreshToken {
  token: string;
  salt: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  const diffMo = Math.round(diffDay / 30);
  if (diffMo < 12) return `${diffMo} month${diffMo === 1 ? "" : "s"} ago`;
  const diffYr = Math.round(diffMo / 12);
  return `${diffYr} year${diffYr === 1 ? "" : "s"} ago`;
}

/**
 * Classify token expiry state.
 *   - expired: expires_at <= now
 *   - soon:    expires_at within 7 days
 *   - ok:      expires_at further out or null
 */
function expiryState(expires_at: string | null): "expired" | "soon" | "ok" {
  if (!expires_at) return "ok";
  const exp = new Date(expires_at).getTime();
  if (Number.isNaN(exp)) return "ok";
  const now = Date.now();
  if (exp <= now) return "expired";
  if (exp - now < 7 * 24 * 60 * 60 * 1000) return "soon";
  return "ok";
}

function formatExpiry(expires_at: string | null): string {
  if (!expires_at) return "no expiry";
  const exp = new Date(expires_at).getTime();
  if (Number.isNaN(exp)) return "—";
  const diffMs = exp - Date.now();
  if (diffMs <= 0) return "expired";
  const diffDay = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (diffDay === 0) return "expires today";
  if (diffDay === 1) return "expires tomorrow";
  return `expires in ${diffDay} days`;
}

// ────────────────────────────────────────────────────────────────────────────
// Copy button
// ────────────────────────────────────────────────────────────────────────────

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // silent — clipboard may be unavailable in some contexts
        }
      }}
      className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Section
// ────────────────────────────────────────────────────────────────────────────

export function ApiTokensSection({ userId }: { userId: string | null }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh-token reveal state (one-time display).
  const [generating, setGenerating] = useState(false);
  const [fresh, setFresh] = useState<FreshToken | null>(null);
  const [savedAcked, setSavedAcked] = useState(false);

  // Branded confirm state — replaces native window.confirm() prompts so the
  // dialog renders with the OrangeRails theme. Holds the row id pending the
  // corresponding action; null when no dialog is open.
  const [pendingRevokeId, setPendingRevokeId] = useState<string | null>(null);
  const [pendingRotateId, setPendingRotateId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, error: rpcErr } = await supabase.rpc("list_or_access_tokens");
      if (rpcErr) throw new Error(rpcErr.message ?? "Failed to load tokens");
      setRows((data ?? []) as TokenRow[]);
    } catch (e) {
      setError(formatError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Trigger the branded confirm dialog. The actual revoke/rotate work runs
  // from confirmRevoke / confirmRotate below.
  const handleRevoke = (id: string) => setPendingRevokeId(id);
  const handleRotate = (id: string) => setPendingRotateId(id);

  const confirmRevoke = async (id: string) => {
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from("user_app_grants")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id);
      if (updErr) throw new Error(updErr.message ?? "Revoke failed");
      if (userId) void logSecurityEvent(supabase, userId, "token_rotated", { grant_id: id, action: "revoke" });
      await reload();
    } catch (e) {
      setError(formatError(e));
    }
  };

  const confirmRotate = async (id: string) => {
    setError(null);
    try {
      const [tokenRes, saltRes] = await Promise.all([
        (supabase.rpc as any)("rotate_or_access_token", { p_grant_id: id }),
        supabase.rpc("get_or_vault_salt"),
      ]);
      if (tokenRes.error) throw new Error(tokenRes.error.message ?? "Rotate failed");
      if (saltRes.error) throw new Error(saltRes.error.message ?? "Salt lookup failed");
      const token = tokenRes.data as string | null;
      const salt = saltRes.data as string | null;
      if (!token || !salt) throw new Error("Empty token or salt returned");
      setFresh({ token, salt });
      setSavedAcked(false);
      if (userId) void logSecurityEvent(supabase, userId, "token_rotated", { action: "rotate", grant_id: id });
    } catch (e) {
      setError(formatError(e));
    }
  };

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const [tokenRes, saltRes] = await Promise.all([
        supabase.rpc("create_or_access_token", { app_slug: "bitbooks" }),
        supabase.rpc("get_or_vault_salt"),
      ]);
      if (tokenRes.error) throw new Error(tokenRes.error.message ?? "Token creation failed");
      if (saltRes.error) throw new Error(saltRes.error.message ?? "Salt lookup failed");
      const token = tokenRes.data as string | null;
      const salt = saltRes.data as string | null;
      if (!token || !salt) throw new Error("Empty token or salt returned");
      setFresh({ token, salt });
      setSavedAcked(false);
      if (userId) void logSecurityEvent(supabase, userId, "token_rotated", { action: "create", app_slug: "bitbooks" });
    } catch (e) {
      setError(formatError(e));
    } finally {
      setGenerating(false);
    }
  };

  const handleDone = async () => {
    setFresh(null);
    setSavedAcked(false);
    await reload();
  };

  return (
    <section className="rounded-lg border p-4 space-y-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <h2 className="text-sm font-semibold">API Tokens</h2>
        <span className="text-xs text-muted-foreground">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="space-y-4 pt-1">
          <p className="text-xs text-muted-foreground">
            Generate a token to connect BitBooks V3 or BitBooks Personal. Tokens are like
            passwords — store them in your password manager.
          </p>

          {/* ── Fresh token reveal ───────────────────────────────────── */}
          {fresh && (
            <div className="rounded-md border border-orange-400/40 bg-orange-50/40 p-3 space-y-3">
              <p className="text-xs font-semibold text-orange-600 uppercase tracking-wide">
                ⚠ Save these values NOW — the token will not be shown again
              </p>

              <div className="space-y-2">
                <div className="space-y-1">
                  <div className="text-xs font-medium">OR Access Token</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded border bg-background px-2 py-1 font-mono text-xs">
                      {fresh.token}
                    </code>
                    <CopyButton value={fresh.token} />
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-xs font-medium">OR Vault Salt</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded border bg-background px-2 py-1 font-mono text-xs">
                      {fresh.salt}
                    </code>
                    <CopyButton value={fresh.salt} />
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={savedAcked}
                  onChange={(e) => setSavedAcked(e.target.checked)}
                />
                I have saved my token and vault salt
              </label>

              <button
                type="button"
                disabled={!savedAcked}
                onClick={handleDone}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              >
                I'm done
              </button>
            </div>
          )}

          {/* ── Token list ───────────────────────────────────────────── */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">App</th>
                  <th className="py-2 pr-4 font-medium">Generated</th>
                  <th className="py-2 pr-4 font-medium">Last used</th>
                  <th className="py-2 pr-4 font-medium">Expires</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-3 text-xs text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-3 text-xs text-muted-foreground">
                      No tokens yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const active = row.revoked_at === null;
                    const exp = expiryState(row.expires_at);
                    return (
                      <tr key={row.id} className="border-b last:border-b-0">
                        <td className="py-2 pr-4">{row.app_name}</td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {formatRelative(row.granted_at)}
                        </td>
                        <td className="py-2 pr-4 text-muted-foreground">
                          {formatRelative(row.last_used_at)}
                        </td>
                        <td className="py-2 pr-4">
                          <span className={
                            exp === "expired" ? "text-destructive" :
                            exp === "soon" ? "text-orange-600" :
                            "text-muted-foreground"
                          }>
                            {formatExpiry(row.expires_at)}
                          </span>
                          {row.rotated_at && (
                            <span className="block text-xs text-muted-foreground">
                              rotated {formatRelative(row.rotated_at)}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          {!active ? (
                            <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                              Revoked
                            </span>
                          ) : exp === "expired" ? (
                            <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                              Expired
                            </span>
                          ) : exp === "soon" ? (
                            <span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
                              Expiring soon
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
                              Active
                            </span>
                          )}
                        </td>
                        <td className="py-2">
                          {active && (
                            <div className="flex gap-1">
                              <button
                                type="button"
                                onClick={() => void handleRotate(row.id)}
                                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                              >
                                Rotate
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleRevoke(row.id)}
                                className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                              >
                                Revoke
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          {/* ── Generate button ──────────────────────────────────────── */}
          {!fresh && (
            <div>
              <button
                type="button"
                disabled={generating}
                onClick={() => void handleGenerate()}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              >
                {generating ? "Generating…" : "Generate new token"}
              </button>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingRevokeId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevokeId(null);
        }}
        title="Revoke token?"
        description="Apps using this token will immediately lose access. This cannot be undone, but you can generate a new token at any time."
        confirmLabel="Revoke token"
        destructive
        onConfirm={async () => {
          if (pendingRevokeId) await confirmRevoke(pendingRevokeId);
        }}
      />

      <ConfirmDialog
        open={pendingRotateId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRotateId(null);
        }}
        title="Rotate token?"
        description="The current token will stop working immediately. Apps using it will need the new token before they can sync again."
        confirmLabel="Rotate token"
        destructive
        onConfirm={async () => {
          if (pendingRotateId) await confirmRotate(pendingRotateId);
        }}
      />
    </section>
  );
}
