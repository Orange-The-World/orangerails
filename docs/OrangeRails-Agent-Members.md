# OrangeRails Agent Members

**Version:** 0.1
**Last updated:** 2026-05-19 (session ANVIL)
**Status:** Foundation migration in place. Invitation flow + MCP transport in subsequent commits.

This document describes the `agent_members` table and the membership model for AI agents (Claude, ChatGPT, Cursor, Continue, Cline, custom) in OrangeRails.

## 1. Why agents need their own membership model

The existing OrangeRails membership concepts are:

- **`auth.users`** — human users, authenticated via Supabase auth (email + password or magic link)
- **`workspace_admins`** — other human users granted co-admin access to a primary user's data
- **`apps` + `user_app_grants`** — registered third-party apps (BitBooks V3, OrangeWay) that act on a user's behalf via OAuth-style access tokens

AI agents do not fit cleanly into any of these:

| Aspect | Human user | Co-admin | App | Agent |
|---|---|---|---|---|
| Has email login | yes | yes | no | no |
| Auth mechanism | password + MFA | password + MFA | server-to-server signature | cryptographic challenge using own keypair |
| Has its own keypair | yes (derived from vault password) | yes (derived from vault password) | yes (registered with app) | yes (generated on agent machine) |
| Multiple per owner | no | yes | no (one app, many users) | yes (one owner, many agents) |
| Role granularity | n/a | binary admin | binary scopes per app | tiered: read_only / bookkeeper / accountant / owner |
| Invitation flow | self-signup | email | developer-portal | CLI redemption of one-time token |
| Revocation | account deletion | grant deletion | token revoke | per-agent revoke + DEK rotation |

Agents are similar enough to co-admins (own keypair, wrapped data keys, revocable) that we reuse much of the infrastructure (`wrapped_data_keys` table, `key-wrapping.ts` library) — but the invitation flow, role tiers, and audit attribution are different enough that a separate table is the cleanest model.

## 2. The shadow user pattern

The existing `wrapped_data_keys` table has `recipient_user_id` referencing `auth.users(id)`. To reuse this infrastructure without modifying the auth schema, **each agent gets a shadow `auth.users` row** created on invitation redemption.

The shadow user:

- Has no email login (uses a generated synthetic email like `agent-<uuid>@orangerails-agents.local` that cannot receive mail)
- Has no password (cannot be used for standard Supabase auth)
- Is referenced by `agent_members.shadow_user_id`
- Authenticates via cryptographic challenge: the agent's CLI signs a server-issued nonce with the agent's Ed25519 secret key; the server verifies with `agent_members.identity_pubkey`; on success, a short-lived Supabase access token is issued for the shadow user

This pattern lets the agent's actions flow through the existing RLS policies and the existing `wrapped_data_keys` lookup unchanged. From the perspective of the storage layer, the agent is "just another auth.users".

## 3. Table shape

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | Agent member identifier |
| `owner_user_id` | UUID FK → auth.users | The human owner who invited this agent |
| `shadow_user_id` | UUID FK → auth.users (UNIQUE) | Set on invitation redemption. The auth.users row for this agent. |
| `agent_name` | TEXT | "Claude on the maintainer's laptop" — display only |
| `agent_kind` | ENUM | claude_code / claude_desktop / chatgpt / cursor / continue / cline / custom |
| `role` | ENUM | read_only / bookkeeper / accountant / owner |
| `identity_pubkey` | TEXT | Base64 Ed25519 public key. NULL until redemption. |
| `kem_pubkey` | TEXT | Base64 hybrid X25519+MLKEM768 public key. NULL until redemption. |
| `invited_at` | TIMESTAMPTZ | When the owner created the invitation |
| `activated_at` | TIMESTAMPTZ | When the agent redeemed the invitation |
| `revoked_at` | TIMESTAMPTZ | When the agent was removed. NULL while active. |
| `last_activity_at` | TIMESTAMPTZ | Most recent successful tool call |
| `notes` | TEXT | Optional metadata, never sensitive |

Constraints:

- `(owner_user_id, identity_pubkey)` is unique (an owner cannot have two agents with the same keypair)
- `identity_pubkey` and `kem_pubkey` are either both set or both NULL
- `activated_at` requires `identity_pubkey` and `shadow_user_id`

## 4. Row Level Security

- Owners can SELECT all their own agent rows (active + revoked) — for the Members UI
- A logged-in agent (acting as `shadow_user_id`) can SELECT only its own row — for self-introspection
- INSERT is service-role only — agents are minted by SECURITY DEFINER edge functions, not by clients
- Owners can UPDATE `role` and `notes` on their own active agents (revoked agents are immutable history)
- DELETE is service-role only — revocation flips `revoked_at` and is handled by a function that also rotates wrapped data keys

## 5. Lifecycle

```
1. Owner clicks "Invite Claude" in /portal → agent_members row created (pubkeys NULL, activated_at NULL)
2. Server returns one-time invitation token to the owner (token TTL: 7 days per Decision 3)
3. Owner runs `npx @orangerails/mcp connect <invitation-token>` on their laptop
4. CLI generates Ed25519 + X25519 keypair, stores private key locally
5. CLI POSTs to /or-agent-invite-redeem with: token, identity_pubkey, kem_pubkey
6. Server validates token, creates shadow auth.users row, updates agent_members:
   - sets shadow_user_id, identity_pubkey, kem_pubkey
   - sets activated_at
7. Owner's browser (still online from step 1) wraps copies of org data keys (ORK, ORT, BBK)
   for the agent's kem_pubkey, inserts rows into wrapped_data_keys keyed by shadow_user_id
8. CLI receives initial access token (1h TTL per Decision 2) + refresh token (30d TTL)
9. CLI writes config snippet into the detected MCP client's config file
10. Agent is live; can now hit MCP server
```

## 6. Revocation

```
1. Owner clicks "Remove Claude" in /portal
2. Edge function or-agent-revoke runs (SECURITY DEFINER):
   - sets agent_members.revoked_at
   - deletes wrapped_data_keys rows where recipient_user_id = shadow_user_id
   - revokes all OAuth tokens for shadow_user_id
3. Owner's browser triggers data-key rotation:
   - generates fresh ORK, ORT, BBK
   - re-encrypts business data with new keys (lazy/async, in background)
   - re-wraps new keys for remaining members (humans + agents)
4. Audit entry recorded: "Member <agent_name> revoked by <owner> at <time>. Reason: <text>."
```

The revoked agent cannot decrypt new data even if it kept its private key locally. Data it cached locally before revocation is the residual exposure window — same as any human co-admin revocation.

## 7. What is NOT in this first migration

These come in subsequent commits:

- `agent_invitation_tokens` table (one-time tokens with 7-day TTL)
- `or-agent-invite-mint` edge function (owner side: create invitation)
- `or-agent-invite-redeem` edge function (agent side: complete invitation)
- `or-agent-revoke` edge function (revocation with DEK rotation)
- `or-mcp-stdio-bridge` and `or-mcp-sse` endpoints (the MCP server itself)
- `audit_entries` table with Merkle chain (audit log enhancement)
- `last_activity_at` trigger (set on every API call via shadow_user_id)

## 8. Cross references

- Architecture pattern: [02 Architecture — Agent as Employee](https://wiki.abascal.ca/doc/02-proposed-architecture-agent-as-employee-Ga7ngrjhkO)
- Decision rationale: [09 Decisions Log](https://wiki.abascal.ca/doc/09-decisions-log-phase-1-kickoff-H8twQYcNQA)
- Gap analysis: [10 Phase 1 Gap Analysis](https://wiki.abascal.ca/doc/10-phase-1-gap-analysis-what-exists-vs-what-to-build-r7mRAOazFh)
- Existing co-admin pattern this builds on: `docs/OrangeRails-CoAdmins.md`, `supabase/migrations/20260420200000_workspace_admins.sql`
- Existing key-wrapping infrastructure: `src/lib/key-wrapping.ts`, `supabase/migrations/20260420120000_pqc_keys.sql`
