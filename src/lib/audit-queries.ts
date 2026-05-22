/**
 * Data fetching for the audit log section of /portal.
 *
 * RLS already restricts to entries the calling user is actor-of OR
 * actor-member-of-the-owner-of. We just SELECT and render.
 */

import { supabase } from "@/integrations/supabase/client";

export interface AuditEntryRow {
  id: string;
  chain_height: number;
  actor_user_id: string | null;
  actor_member_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  reason: string | null;
  client_ip: string | null;
  client_user_agent: string | null;
  result: string | null;
  created_at: string;
}

export interface AuditEntryView extends AuditEntryRow {
  actor_label: string;
  action_label: string;
  resource_label: string;
}

const AGENT_KIND_LABEL: Record<string, string> = {
  claude_code: "Claude Code",
  claude_desktop: "Claude Desktop",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
  continue: "Continue",
  cline: "Cline",
  custom: "Custom agent",
};

const ACTION_LABEL: Record<string, string> = {
  "agents.invite_minted": "invited a new agent",
  "agents.invite_redeemed": "completed agent setup",
  "agents.token_refreshed": "refreshed their access token",
  "agents.revoke": "revoked an agent",
  "agents.data_key_rotated": "rotated the org data key",
};

export async function fetchRecentAuditEntries(limit = 50): Promise<AuditEntryView[]> {
  const { data: entries, error } = await supabase
    .from("audit_entries")
    .select(
      "id,chain_height,actor_user_id,actor_member_id,action,resource_type,resource_id,reason,client_ip,client_user_agent,result,created_at",
    )
    .order("chain_height", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`fetchRecentAuditEntries: ${error.message}`);
  if (!entries || entries.length === 0) return [];

  const memberIds = Array.from(
    new Set(
      (entries as AuditEntryRow[])
        .map((e) => e.actor_member_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const agentByMemberId = new Map<string, { agent_name: string; agent_kind: string }>();
  if (memberIds.length > 0) {
    const { data: agents } = await supabase
      .from("agent_members")
      .select("id,agent_name,agent_kind")
      .in("id", memberIds);
    for (const a of (agents as Array<{ id: string; agent_name: string; agent_kind: string }>) ?? []) {
      agentByMemberId.set(a.id, { agent_name: a.agent_name, agent_kind: a.agent_kind });
    }
  }

  const { data: session } = await supabase.auth.getSession();
  const callerId = session?.session?.user?.id ?? null;

  return (entries as AuditEntryRow[]).map((e) => {
    const agent = e.actor_member_id ? agentByMemberId.get(e.actor_member_id) : undefined;
    const actor_label = agent
      ? `${agent.agent_name} (${AGENT_KIND_LABEL[agent.agent_kind] ?? agent.agent_kind})`
      : e.actor_user_id === callerId
        ? "You"
        : "Someone else";
    const action_label = ACTION_LABEL[e.action] ?? humanizeAction(e.action);
    const resource_label = e.resource_type
      ? `${e.resource_type}${e.resource_id ? ` (${shortId(e.resource_id)})` : ""}`
      : "—";
    return { ...e, actor_label, action_label, resource_label };
  });
}

function humanizeAction(action: string): string {
  const cleaned = action.replace(/^[a-z_]+\./, "");
  return cleaned.replace(/_/g, " ");
}

function shortId(id: string): string {
  if (id.length > 12) return id.slice(0, 8) + "…";
  return id;
}

export function formatTimestamp(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  if (ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
