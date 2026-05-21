-- ============================================================
-- audit_entries — tamper evident action log (Merkle chained)
-- ============================================================
-- See: https://wiki.abascal.ca/doc/07-safety-sandboxing-recovery-Pd5Z4FcyKG
-- Session: 2026-05-19-ANVIL
--
-- Every meaningful action by any member (human or agent) is recorded here.
-- Entries are linked in a hash chain so any tampering with old entries is
-- detectable by walking the chain and comparing computed vs stored hashes.
--
-- Distinct from vault_security_events (which tracks security-specific
-- events like password changes, MFA setup, key rotation). audit_entries
-- is the broader log of every state mutation that an MCP tool or human
-- could perform.
--
-- Cryptographic property:
--   For any entry N: this_hash = SHA-256(prev_hash || canonical_bytes(N))
--   So an attacker who modifies any field of any old entry must also
--   change this_hash, which changes prev_hash of entry N+1, which
--   cascades forward. Verification walks forward and detects breaks.
--
-- Anchoring: every hour, the latest this_hash + (timestamp, height)
-- is published to a public registry (initially a git repo we control,
-- v2: Bitcoin OP_RETURN). That public record makes server-side tampering
-- detectable even by Orange Rails staff.
--
-- This migration does NOT include the anchor cron or verify_audit_chain
-- function. Those are follow ups once we have hourly_audit_anchors
-- table + pg_cron schedule.

-- ============================================================
-- 1. audit_entries table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.audit_entries (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Monotonic position in the chain. The first entry has chain_height = 1.
  -- Indexed for fast chain walks.
  chain_height      BIGSERIAL    UNIQUE NOT NULL,

  -- Who acted
  actor_user_id     UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_member_id   UUID         REFERENCES public.agent_members(id) ON DELETE SET NULL,

  -- What happened
  action            TEXT         NOT NULL,        -- e.g. "books.create_transaction"
  resource_type    TEXT,                          -- e.g. "transaction"
  resource_id       TEXT,                         -- usually a UUID, sometimes a composite key

  -- Optional state snapshots (encrypted by the caller, server cannot read)
  before_ciphertext TEXT,
  after_ciphertext  TEXT,

  -- Free form context
  reason            TEXT,                          -- caller provided, "I needed to undo X"
  client_ip         INET,
  client_user_agent TEXT,
  result            TEXT,                          -- "ok" / "denied" / "error" + optional code

  -- Tamper evidence
  prev_hash         TEXT         NOT NULL,         -- hex SHA-256 of the previous entry's this_hash, or 64 zeros for genesis
  this_hash         TEXT         NOT NULL UNIQUE,  -- hex SHA-256 over canonical bytes of this entry

  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.audit_entries IS
  'Tamper evident log of every member action. Merkle/hash chained; verify with verify_audit_chain (future migration).';

-- ============================================================
-- 2. Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS audit_entries_actor_user_idx
  ON public.audit_entries(actor_user_id, created_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_entries_actor_member_idx
  ON public.audit_entries(actor_member_id, created_at DESC)
  WHERE actor_member_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_entries_action_idx
  ON public.audit_entries(action, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_entries_resource_idx
  ON public.audit_entries(resource_type, resource_id, created_at DESC)
  WHERE resource_id IS NOT NULL;

-- ============================================================
-- 3. RLS
-- ============================================================
ALTER TABLE public.audit_entries ENABLE ROW LEVEL SECURITY;

-- A user can read entries where:
--   - they are the actor (their own actions), OR
--   - they are the owner of the agent_member that acted
-- This is enough for the dashboard "see what my agents did" view.

DROP POLICY IF EXISTS "Users read own audit entries" ON public.audit_entries;
CREATE POLICY "Users read own audit entries"
  ON public.audit_entries FOR SELECT
  TO authenticated
  USING (
    actor_user_id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.agent_members am
      WHERE am.id = audit_entries.actor_member_id
        AND am.owner_user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policy: clients cannot write directly to audit_entries.
-- Writes go through append_audit_entry() (SECURITY DEFINER).
-- DELETE is forbidden entirely; tamper evidence requires immutability.
-- (We do periodic archival to cold storage in a v2 migration, never DELETE.)

-- ============================================================
-- 4. canonical_audit_bytes() — deterministic byte encoding for hashing
-- ============================================================
-- The hash chain only works if every node computes the same bytes for the
-- same entry. We use a fixed-order pipe-separated JSON-ish encoding.
-- Field order is frozen here for the lifetime of the table.

CREATE OR REPLACE FUNCTION public.canonical_audit_bytes(
  p_chain_height      BIGINT,
  p_actor_user_id     UUID,
  p_actor_member_id   UUID,
  p_action            TEXT,
  p_resource_type     TEXT,
  p_resource_id       TEXT,
  p_before_ciphertext TEXT,
  p_after_ciphertext  TEXT,
  p_reason            TEXT,
  p_client_ip         INET,
  p_client_user_agent TEXT,
  p_result            TEXT,
  p_created_at        TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT concat_ws(
    '|',
    p_chain_height::TEXT,
    coalesce(p_actor_user_id::TEXT, ''),
    coalesce(p_actor_member_id::TEXT, ''),
    coalesce(p_action, ''),
    coalesce(p_resource_type, ''),
    coalesce(p_resource_id, ''),
    coalesce(p_before_ciphertext, ''),
    coalesce(p_after_ciphertext, ''),
    coalesce(p_reason, ''),
    coalesce(p_client_ip::TEXT, ''),
    coalesce(p_client_user_agent, ''),
    coalesce(p_result, ''),
    to_char(p_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
$$;

COMMENT ON FUNCTION public.canonical_audit_bytes IS
  'Deterministic field ordering for hash chaining. Field order frozen for the lifetime of the audit_entries table; changing this is a v2 schema migration that requires re-chaining.';

-- ============================================================
-- 5. append_audit_entry — the only writer
-- ============================================================
CREATE OR REPLACE FUNCTION public.append_audit_entry(
  p_action            TEXT,
  p_actor_user_id     UUID DEFAULT NULL,
  p_actor_member_id   UUID DEFAULT NULL,
  p_resource_type     TEXT DEFAULT NULL,
  p_resource_id       TEXT DEFAULT NULL,
  p_before_ciphertext TEXT DEFAULT NULL,
  p_after_ciphertext  TEXT DEFAULT NULL,
  p_reason            TEXT DEFAULT NULL,
  p_client_ip         INET DEFAULT NULL,
  p_client_user_agent TEXT DEFAULT NULL,
  p_result            TEXT DEFAULT 'ok'
)
RETURNS TABLE(
  entry_id      UUID,
  chain_height  BIGINT,
  this_hash     TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prev_hash    TEXT;
  v_chain_height BIGINT;
  v_created_at   TIMESTAMPTZ := now();
  v_canonical    TEXT;
  v_this_hash    TEXT;
  v_entry_id     UUID := gen_random_uuid();
BEGIN
  IF p_action IS NULL OR length(trim(p_action)) = 0 THEN
    RAISE EXCEPTION 'action is required';
  END IF;

  -- Lock the latest entry to serialize chain extension.
  -- Without locking, two concurrent appends could compute the same prev_hash.
  SELECT this_hash INTO v_prev_hash
  FROM public.audit_entries
  ORDER BY chain_height DESC
  LIMIT 1
  FOR UPDATE;

  -- Genesis: 64 zeros if there is no previous entry.
  IF v_prev_hash IS NULL THEN
    v_prev_hash := repeat('0', 64);
  END IF;

  -- Reserve a chain_height by inserting a placeholder and computing the hash from it.
  -- We pre-reserve the height via nextval on the BIGSERIAL sequence.
  v_chain_height := nextval(pg_get_serial_sequence('public.audit_entries', 'chain_height'));

  v_canonical := public.canonical_audit_bytes(
    v_chain_height,
    p_actor_user_id,
    p_actor_member_id,
    trim(p_action),
    p_resource_type,
    p_resource_id,
    p_before_ciphertext,
    p_after_ciphertext,
    p_reason,
    p_client_ip,
    p_client_user_agent,
    p_result,
    v_created_at
  );

  v_this_hash := encode(
    digest(v_prev_hash || v_canonical, 'sha256'),
    'hex'
  );

  INSERT INTO public.audit_entries (
    id,
    chain_height,
    actor_user_id,
    actor_member_id,
    action,
    resource_type,
    resource_id,
    before_ciphertext,
    after_ciphertext,
    reason,
    client_ip,
    client_user_agent,
    result,
    prev_hash,
    this_hash,
    created_at
  ) VALUES (
    v_entry_id,
    v_chain_height,
    p_actor_user_id,
    p_actor_member_id,
    trim(p_action),
    p_resource_type,
    p_resource_id,
    p_before_ciphertext,
    p_after_ciphertext,
    p_reason,
    p_client_ip,
    p_client_user_agent,
    p_result,
    v_prev_hash,
    v_this_hash,
    v_created_at
  );

  RETURN QUERY SELECT v_entry_id, v_chain_height, v_this_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.append_audit_entry(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_audit_entry(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.append_audit_entry(TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INET, TEXT, TEXT) TO service_role;
-- DO NOT GRANT to authenticated. Audit C1 (2026-05-21): any signed-in
-- customer would otherwise be able to forge entries claiming to be any
-- other actor doing any action. Edge functions that need to append
-- (or-agent-*) already run with service_role context. SECURITY DEFINER
-- on RPCs callable by authenticated may also wrap this safely.

COMMENT ON FUNCTION public.append_audit_entry IS
  'Appends a tamper evident audit entry. Locks the tail of the chain to serialize writes. Called by every state mutating edge function or trigger.';

-- ============================================================
-- 6. Required extension for digest()
-- ============================================================
-- pgcrypto provides digest(). Should already be installed in any recent
-- Supabase project; this is idempotent.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
