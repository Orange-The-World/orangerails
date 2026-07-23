/**
 * RLS cross-tenant access denial tests for agent_members,
 * agent_invitation_tokens, and audit_entries.
 *
 * Removed 2026-07-21: the agent-membership feature (agent_members,
 * agent_invitation_tokens, mint_agent_invitation, revoke_agent_member,
 * revoke_agent_invitation_token) was retired 2026-06-25. All tests in
 * this file depended on that surface (the audit_entries fixture was
 * seeded via mint_agent_invitation). Tests for removed code are absent
 * rather than failing or lying. Add new RLS tests here when current
 * tables need cross-tenant coverage.
 */
