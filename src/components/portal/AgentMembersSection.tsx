import { useCallback, useEffect, useState } from "react";
import {
  fetchAgentMembers,
  formatRelative,
  formatCountdown,
  revokeAgent,
  revokePendingInvitation,
  type AgentMemberView,
  type AgentStatus,
} from "@/lib/agent-members-queries";
import { InviteAgentDialog } from "./InviteAgentDialog";

interface AgentMembersSectionProps {
  /** Polling interval in ms. Set to 0 to disable. */
  pollIntervalMs?: number;
}

/**
 * Section in /portal that lists the user's AI agent members.
 * Renders pending invitations, active agents, and revoked agents.
 * Polls every 5s (default) to pick up activation transitions.
 */
export function AgentMembersSection({ pollIntervalMs = 5000 }: AgentMembersSectionProps) {
  const [agents, setAgents] = useState<AgentMemberView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const rows = await fetchAgentMembers();
      setAgents(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    if (pollIntervalMs > 0) {
      const t = setInterval(reload, pollIntervalMs);
      return () => clearInterval(t);
    }
  }, [reload, pollIntervalMs]);

  const onRevoke = useCallback(
    async (id: string) => {
      const reason = prompt("Reason for revoking? (optional)") ?? null;
      setBusyId(id);
      try {
        await revokeAgent(id, reason);
        await reload();
      } catch (e) {
        alert(`Revoke failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  const onRevokeInvitation = useCallback(
    async (tokenId: string) => {
      setBusyId(tokenId);
      try {
        await revokePendingInvitation(tokenId);
        await reload();
      } catch (e) {
        alert(`Revoke invitation failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  return (
    <section className="rounded-lg border p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">Agents (AI members)</h2>
        <button
          onClick={() => setInviteOpen(true)}
          className="inline-flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Invite agent
        </button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">Error: {error}</p>}

      {!loading && agents.length === 0 && (
        <p className="text-sm text-muted-foreground">
          You haven&apos;t invited any AI agents yet. Click <em>Invite agent</em> to bring Claude,
          ChatGPT, or another AI into your org.
        </p>
      )}

      <ul className="space-y-3">
        {agents.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            busy={busyId === a.id || busyId === a.invitation?.id}
            onRevoke={onRevoke}
            onRevokeInvitation={onRevokeInvitation}
          />
        ))}
      </ul>

      <InviteAgentDialog
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false);
          reload();
        }}
      />
    </section>
  );
}

function AgentRow({
  agent,
  busy,
  onRevoke,
  onRevokeInvitation,
}: {
  agent: AgentMemberView;
  busy: boolean;
  onRevoke: (id: string) => void;
  onRevokeInvitation: (token_id: string) => void;
}) {
  return (
    <li className="rounded-md border p-4 flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <StatusDot status={agent.status} />
          <span className="font-medium truncate">{agent.agent_name}</span>
          <span className="text-xs text-muted-foreground">· {humanRole(agent.role)}</span>
          <span className="text-xs text-muted-foreground">· {humanKind(agent.agent_kind)}</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {agent.status === "pending" && agent.invitation && (
            <>Invitation expires {formatCountdown(agent.invitation.expires_at)}</>
          )}
          {agent.status === "active" && <>Last active {formatRelative(agent.last_activity_at)}</>}
          {agent.status === "revoked" && (
            <>Revoked {formatRelative(agent.revoked_at)}</>
          )}
          {agent.status === "expired" && <>Invitation expired</>}
        </p>
      </div>

      <div className="flex items-center gap-2">
        {agent.status === "active" && (
          <button
            onClick={() => onRevoke(agent.id)}
            disabled={busy}
            className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            Revoke
          </button>
        )}
        {agent.status === "pending" && agent.invitation && (
          <button
            onClick={() => onRevokeInvitation(agent.invitation!.id)}
            disabled={busy}
            className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            Revoke invitation
          </button>
        )}
      </div>
    </li>
  );
}

function StatusDot({ status }: { status: AgentStatus }) {
  const color =
    status === "active"
      ? "bg-emerald-500"
      : status === "pending"
        ? "bg-amber-500"
        : status === "revoked"
          ? "bg-muted-foreground/50"
          : "bg-destructive/60";
  return <span aria-hidden="true" className={`inline-block size-2 rounded-full ${color}`} />;
}

function humanRole(role: string): string {
  switch (role) {
    case "read_only":
      return "Read only";
    case "bookkeeper":
      return "Bookkeeper";
    case "accountant":
      return "Accountant";
    case "owner":
      return "Owner";
    default:
      return role;
  }
}

function humanKind(kind: string): string {
  switch (kind) {
    case "claude_code":
      return "Claude Code";
    case "claude_desktop":
      return "Claude Desktop";
    case "chatgpt":
      return "ChatGPT";
    case "cursor":
      return "Cursor";
    case "continue":
      return "Continue";
    case "cline":
      return "Cline";
    case "custom":
      return "Custom";
    default:
      return kind;
  }
}
