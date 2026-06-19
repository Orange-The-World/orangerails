-- ============================================================
-- Agent Members — AI agents as first-class members of a user's org
-- ============================================================
-- Companion to: workspace_admins (human co-admin grants).
--
-- Companion to: workspace_admins (human co-admin grants).
-- agent_members extends the membership model to AI agents (Claude, ChatGPT,
-- Cursor, Continue, Cline, custom). Each agent has its own keypair generated
-- on its machine and is revocable independently of the owner.
--
-- Why a separate table from workspace_admins:
--   1. Agents have a CLI redemption flow, not an email invitation flow.
--   2. Agents have role tiers (bookkeeper, accountant, owner, read_only)
--      while workspace_admins is binary admin/not-admin.
--   3. Agents need attribution in the audit log distinct from human members.
--   4. Different revocation UX (cli-token-rotate vs email-confirm-remove).
--
-- Why agents are shadow auth.users:
--   The existing wrapped_data_keys table (in 20260420120000_pqc_keys.sql)
--   keys envelope rows by recipient_user_id -> auth.users(id). To reuse
--   that infrastructure unchanged, each agent gets a shadow auth.users row
--   on creation. The shadow user has no email login, no password — only
--   cryptographic authentication via the agent's identity keypair.
--
-- This migration does NOT:
--   - Create the agent invitation token system (separate migration)
--   - Create per-agent audit entries (separate migration adds audit_entries)
--   - Create the role -> tool permission matrix (lives in application code)

-- ============================================================
-- 1. agent_kind enum — what kind of agent client is connecting
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_kind') THEN
    CREATE TYPE public.agent_kind AS ENUM (
      'claude_code',
      'claude_desktop',
      'chatgpt',
      'cursor',
      'continue',
      'cline',
      'custom'
    );
  END IF;
END$$;

COMMENT ON TYPE public.agent_kind IS
  'Type of agent client. Used for display + telemetry. Has no permission implications — role controls permissions.';

-- ============================================================
-- 2. agent_role enum — permission tier within an org
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agent_role') THEN
    CREATE TYPE public.agent_role AS ENUM (
      'read_only',
      'bookkeeper',
      'accountant',
      'owner'
    );
  END IF;
END$$;

COMMENT ON TYPE public.agent_role IS
  'Permission tier for an agent member. read_only < bookkeeper < accountant < owner.';

-- ============================================================
-- 3. agent_members table — one row per agent invited into an owner's org
-- ============================================================
CREATE TABLE IF NOT EXISTS public.agent_members (
  id                    UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id         UUID            NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The shadow auth.users row for this agent. Set after invitation is redeemed.
  -- The wrapped_data_keys envelope is keyed off this. The shadow user has
  -- no email login; only cryptographic challenge auth.
  shadow_user_id        UUID            UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Display + telemetry
  agent_name            TEXT            NOT NULL,         -- "Claude on contributor laptop"
  agent_kind            public.agent_kind NOT NULL,
  role                  public.agent_role NOT NULL DEFAULT 'bookkeeper',

  -- Identity keys (Ed25519 + X25519). Public only — secret stays on agent machine.
  -- NULL until invitation is redeemed.
  identity_pubkey       TEXT,                             -- base64 Ed25519 public key (32 bytes raw)
  kem_pubkey            TEXT,                             -- base64 hybrid X25519+MLKEM768 public key, same format as user_vault_meta.kem_public_key

  -- Lifecycle timestamps
  invited_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  activated_at          TIMESTAMPTZ,                       -- null until invitation redeemed
  revoked_at            TIMESTAMPTZ,                       -- null while active
  last_activity_at      TIMESTAMPTZ,

  -- Optional: agent-specific metadata (free form, never sensitive data)
  notes                 TEXT,

  CONSTRAINT agent_members_unique_pubkey_per_owner
    UNIQUE (owner_user_id, identity_pubkey),

  CONSTRAINT agent_members_pubkeys_set_together
    CHECK (
      (identity_pubkey IS NULL AND kem_pubkey IS NULL) OR
      (identity_pubkey IS NOT NULL AND kem_pubkey IS NOT NULL)
    ),

  CONSTRAINT agent_members_activated_means_pubkeys
    CHECK (
      (activated_at IS NULL) OR
      (activated_at IS NOT NULL AND identity_pubkey IS NOT NULL AND shadow_user_id IS NOT NULL)
    )
);

COMMENT ON TABLE public.agent_members IS
  'AI agents invited into a user''s org. Mirrors the workspace_admins pattern but for agents. Pre-redemption: only invitation metadata. Post-redemption: shadow_user_id and pubkeys are set, agent can hit the API.';

COMMENT ON COLUMN public.agent_members.shadow_user_id IS
  'Shadow auth.users row created on invitation redemption. Used as recipient_user_id in wrapped_data_keys so the existing key-wrapping infrastructure works unchanged. No email login; auth is via cryptographic challenge using identity_pubkey.';

COMMENT ON COLUMN public.agent_members.identity_pubkey IS
  'Base64-encoded Ed25519 public key. Used to verify signed nonces during MCP authentication (the agent proves it holds the matching private key without ever sending it).';

COMMENT ON COLUMN public.agent_members.kem_pubkey IS
  'Base64-encoded hybrid X25519+ML-KEM-768 public key. Same format as user_vault_meta.kem_public_key. Used by the owner''s browser to wrap a copy of the org data keys for this agent.';

-- ============================================================
-- 4. Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS agent_members_owner_user_id_idx
  ON public.agent_members(owner_user_id);

CREATE INDEX IF NOT EXISTS agent_members_shadow_user_id_idx
  ON public.agent_members(shadow_user_id)
  WHERE shadow_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_members_active_idx
  ON public.agent_members(owner_user_id, last_activity_at DESC)
  WHERE revoked_at IS NULL;

-- ============================================================
-- 5. Row Level Security
-- ============================================================
ALTER TABLE public.agent_members ENABLE ROW LEVEL SECURITY;

-- Owner can read all their own agent members (active + revoked, for audit purposes).
DROP POLICY IF EXISTS "Owners read own agent_members" ON public.agent_members;
CREATE POLICY "Owners read own agent_members"
  ON public.agent_members FOR SELECT
  TO authenticated
  USING (owner_user_id = auth.uid());

-- An agent (acting as its shadow user) can read its own row, for self-introspection.
-- It cannot enumerate other agents or see the owner's other members.
DROP POLICY IF EXISTS "Agent reads own row" ON public.agent_members;
CREATE POLICY "Agent reads own row"
  ON public.agent_members FOR SELECT
  TO authenticated
  USING (shadow_user_id = auth.uid());

-- Inserts (creating an invitation) only via a SECURITY DEFINER edge function.
-- No direct INSERT policy here on purpose — clients cannot mint members.

-- Owner can update role + notes on their own active agents.
DROP POLICY IF EXISTS "Owners update own active agent_members" ON public.agent_members;
CREATE POLICY "Owners update own active agent_members"
  ON public.agent_members FOR UPDATE
  TO authenticated
  USING (owner_user_id = auth.uid() AND revoked_at IS NULL)
  WITH CHECK (owner_user_id = auth.uid() AND revoked_at IS NULL);

-- No direct DELETE policy — revocation is a SECURITY DEFINER function that
-- sets revoked_at, deletes wrapped_data_keys rows, and rotates the data key.

-- ============================================================
-- 6. Cross-table integrity: shadow auth users created here cannot be re-purposed
-- ============================================================
-- The shadow_user_id must reference an auth.users row whose only purpose is
-- to be this agent. We enforce this in the SECURITY DEFINER functions in the
-- next migration; the schema cannot directly enforce "is shadow user" without
-- touching the auth schema, which we avoid.

-- ============================================================
-- 7. Triggers — update last_activity_at when the agent hits the API
-- ============================================================
-- Placeholder. Actual update happens in the access_token validation path
-- (next migration). Documented here so the field is visible.
