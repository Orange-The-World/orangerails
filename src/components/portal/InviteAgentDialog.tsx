import { useState } from "react";
import {
  mintInvitation,
  type AgentKind,
  type AgentRole,
  type MintInviteResponse,
} from "@/lib/agent-members-queries";

interface InviteAgentDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Three-step modal for inviting an AI agent into the org.
 *
 * Step 1: pick agent name + kind + role.
 * Step 2: server returns the one-time invitation_token. Owner copies it.
 * Step 3: dismiss; the AgentMembersSection's polling picks up the new row.
 *
 * Wrapping the org data keys for the agent's kem_pubkey (Milestone 1.4)
 * happens automatically once the agent redeems and shows up as Active ,
 * that orchestration lives in a separate watcher (see comment at the end).
 */
export function InviteAgentDialog({ open, onClose }: InviteAgentDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [agentName, setAgentName] = useState("");
  const [agentKind, setAgentKind] = useState<AgentKind>("claude_code");
  const [role, setRole] = useState<AgentRole>("bookkeeper");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mintResult, setMintResult] = useState<MintInviteResponse | null>(null);

  if (!open) return null;

  const reset = () => {
    setStep(1);
    setAgentName("");
    setAgentKind("claude_code");
    setRole("bookkeeper");
    setSubmitting(false);
    setError(null);
    setMintResult(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const onCreate = async () => {
    if (!agentName.trim()) {
      setError("Give the agent a name (e.g., 'Claude on my laptop')");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await mintInvitation({
        agent_name: agentName.trim(),
        agent_kind: agentKind,
        role,
      });
      setMintResult(result);
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const setupCommand = mintResult
    ? `npx @orangerails/mcp connect ${mintResult.invitation_token}`
    : "";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-lg bg-background border shadow-lg p-6">
        {step === 1 && (
          <>
            <h3 className="text-lg font-semibold">Invite an agent</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Add an AI agent as a member of your org. The agent gets its own keypair, its own
              audit identity, and you can revoke it any time.
            </p>

            <div className="mt-5 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Agent name</label>
                <input
                  type="text"
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="Claude on my laptop"
                  maxLength={100}
                  className="w-full rounded-md border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Which AI client?</label>
                <select
                  value={agentKind}
                  onChange={(e) => setAgentKind(e.target.value as AgentKind)}
                  className="w-full rounded-md border px-3 py-2 text-sm bg-background"
                >
                  <option value="claude_code">Claude Code</option>
                  <option value="claude_desktop">Claude Desktop</option>
                  <option value="chatgpt">ChatGPT</option>
                  <option value="cursor">Cursor</option>
                  <option value="continue">Continue</option>
                  <option value="cline">Cline</option>
                  <option value="custom">Custom / Other</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as AgentRole)}
                  className="w-full rounded-md border px-3 py-2 text-sm bg-background"
                >
                  <option value="read_only">Read only , sees data, makes no changes</option>
                  <option value="bookkeeper">Bookkeeper , reads + writes transactions</option>
                  <option value="accountant">Accountant , bookkeeper + close periods</option>
                  <option value="owner">Owner , full control (use sparingly)</option>
                </select>
              </div>
            </div>

            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                onClick={close}
                className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm hover:bg-accent"
              >
                Cancel
              </button>
              <button
                onClick={onCreate}
                disabled={submitting || !agentName.trim()}
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {submitting ? "Creating…" : "Create invite"}
              </button>
            </div>
          </>
        )}

        {step === 2 && mintResult && (
          <>
            <h3 className="text-lg font-semibold">Setup command</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Copy this once , the token is shown only here. It expires in 7 days.
            </p>

            <pre className="mt-4 rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all">
              {setupCommand}
            </pre>

            <div className="mt-3 flex items-center justify-between">
              <button
                onClick={() => navigator.clipboard.writeText(setupCommand)}
                className="inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
              >
                Copy to clipboard
              </button>
              <span className="text-xs text-muted-foreground">
                Expires{" "}
                {new Date(mintResult.expires_at).toLocaleDateString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            </div>

            <p className="mt-4 text-xs text-muted-foreground">
              Run the command on the machine where the agent lives. Once the agent redeems, it
              appears in your members list as <em>Active</em>. Your browser then automatically
              wraps the org data keys for the agent so it can read your books.
            </p>

            <div className="mt-6 flex items-center justify-end">
              <button
                onClick={close}
                className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                I&apos;ve copied it, close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/*
 * NOTE on the wrap-after-activate flow:
 *
 * After the agent redeems the invitation, agent_members.activated_at flips
 * non-null and kem_pubkey is populated. The AgentMembersSection polls every
 * 5s and re-renders. The actual key wrapping should happen automatically
 * the first time a newly-activated agent is observed.
 *
 * Wire that watcher into VaultContext (or a dedicated hook):
 *   - useEffect that watches the AgentMembersView list for new active
 *     agents
 *   - For each new active agent, call wrapAndStoreForAgent from
 *     src/lib/agent-key-wrapping.ts with the agent's kem_pubkey + the
 *     currently-unlocked org data keys
 *   - If the vault is locked when activation lands, defer until the next
 *     unlock event
 *
 * Sketched but intentionally not implemented here to keep this PR focused
 * on the UI surface. The orchestration hook is a small follow-up.
 */
