/**
 * CR-06: agent revocation chaos test.
 *
 * Removed 2026-07-21: the agent-membership feature (agent_members,
 * agent_invitation_tokens, revoke_agent_member, revoke_agent_invitation_token)
 * was retired 2026-06-25. These tests were also never invoked by CI (no
 * vitest or bun test step exists in .github/workflows/ci.yml). Tests for
 * removed code are absent rather than failing or lying.
 */
