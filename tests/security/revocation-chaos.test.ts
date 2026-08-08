/**
 * CR-06: agent revocation chaos test.
 *
 * Removed 2026-07-21: the agent-membership feature (agent_members,
 * agent_invitation_tokens, revoke_agent_member, revoke_agent_invitation_token)
 * was retired 2026-06-25. Tests for removed code are absent rather than
 * failing or lying.
 */

import { test } from 'vitest';

// Tombstone: keeps vitest from throwing "No test suite found" when the
// tests/security/ glob is widened. If agent revocation is ever re-introduced,
// replace this with real coverage.
test.todo('CR-06: agent revocation chaos tests (retired with agent-membership 2026-06-25)');
