/**
 * Data fetching helpers for the agent members portal section.
 *
 * Reads agent_members + agent_invitation_tokens. RLS already restricts
 * to rows owned by the calling user, so no extra filters are needed.
 */

import { supabase } from "@/integrations/supabase/client";

export type AgentKind =
  | "claude_code"
  | "claude_desktop"
  | "chatgpt"
  | "cursor"
  | "continue"
  | "cline"
  | "custom";

export type AgentRole = "read_only" | "bookkeeper" | "accountant" | "owner";

export interface AgentMemberRow {
  id: string;
  owner_user_id: string;
  shadow_user_id: string | null;
  agent_name: string;
  agent_kind: AgentKind;
  role: AgentRole;
  identity_pubkey: string | null;
  kem_pubkey: string | null;
  invited_at: string;
  activated_at: string | null;
  revoked_at: string | null;
  last_activity_at: string | null;
}

export interface AgentInvitationRow {
  id: string;
  agent_member_id: string;
  owner_user_id: string;
  created_at: string;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
}

export type AgentStatus = "pending" | "active" | "revoked" | "expired";

export interface AgentMemberView extends AgentMemberRow {
  status: AgentStatus;
  invitation: AgentInvitationRow | null;
}

export function deriveStatus(
  member: AgentMemberRow,
  invitation: AgentInvitationRow | null,
): AgentStatus {
  if (member.revoked_at) return "revoked";
  if (member.activated_at) return "active";
  if (invitation && !invitation.redeemed_at && !invitation.revoked_at) {
    const expiresMs = Date.parse(invitation.expires_at);
    if (!Number.isNaN(expiresMs) && expiresMs > Date.now()) return "pending";
  }
  return "expired";
}

export async function fetchAgentMembers(): Promise<AgentMemberView[]> {
  const { data: members, error } = await supabase
    .from("agent_members")
    .select(
      "id,owner_user_id,shadow_user_id,agent_name,agent_kind,role,identity_pubkey,kem_pubkey,invited_at,activated_at,revoked_at,last_activity_at",
    )
    .order("invited_at", { ascending: false });
  if (error) throw new Error(`fetchAgentMembers: ${error.message}`);
  if (!members || members.length === 0) return [];

  const ids = (members as AgentMemberRow[]).map((m) => m.id);
  const { data: invites, error: invErr } = await supabase
    .from("agent_invitation_tokens")
    .select("id,agent_member_id,owner_user_id,created_at,expires_at,redeemed_at,revoked_at")
    .in("agent_member_id", ids);
  if (invErr) throw new Error(`fetchAgentMembers (invitations): ${invErr.message}`);

  const inviteByAgent = new Map<string, AgentInvitationRow>();
  for (const i of (invites as AgentInvitationRow[]) ?? []) {
    if (!inviteByAgent.has(i.agent_member_id)) {
      inviteByAgent.set(i.agent_member_id, i);
    }
  }

  return (members as AgentMemberRow[]).map((m) => {
    const inv = inviteByAgent.get(m.id) ?? null;
    return { ...m, invitation: inv, status: deriveStatus(m, inv) };
  });
}

export interface MintInviteResponse {
  agent_member_id: string;
  invitation_token: string;
  expires_at: string;
}

export async function mintInvitation(input: {
  agent_name: string;
  agent_kind: AgentKind;
  role: AgentRole;
}): Promise<MintInviteResponse> {
  const { data: session } = await supabase.auth.getSession();
  const jwt = session?.session?.access_token;
  if (!jwt) throw new Error("Not signed in");

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/or-agent-invite-mint`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as MintInviteResponse;
}

export async function revokeAgent(agent_member_id: string, reason: string | null): Promise<void> {
  const { data: session } = await supabase.auth.getSession();
  const jwt = session?.session?.access_token;
  if (!jwt) throw new Error("Not signed in");

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/or-agent-revoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ agent_member_id, reason: reason ?? undefined }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export async function revokePendingInvitation(token_id: string): Promise<void> {
  const { error } = await supabase.rpc("revoke_agent_invitation_token", { p_token_id: token_id });
  if (error) throw new Error(error.message);
}

export function formatRelative(iso: string | null): string {
  if (!iso) return ",";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

export function formatCountdown(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return "expired";
  const day = Math.floor(ms / 86_400_000);
  if (day > 0) return `in ${day}d`;
  const hr = Math.floor(ms / 3_600_000);
  if (hr > 0) return `in ${hr}h`;
  const min = Math.floor(ms / 60_000);
  return `in ${min}m`;
}
