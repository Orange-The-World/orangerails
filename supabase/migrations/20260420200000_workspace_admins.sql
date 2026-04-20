-- ============================================================
-- Co-admin emergency access: workspace_admins + workspace_key_id
-- ============================================================
-- An owner can grant another authenticated user full read/write access to
-- their OrangeRails workspace. The wrapped subkey blob (credentials || txns)
-- is stored in wrapped_data_keys; this table records the grant relationship.
--
-- MVP limitations documented in docs/OrangeRails-CoAdmins.md:
--   - Cached subkeys in the admin's tab survive revocation until tab closes.
--   - Binary access only (no roles in v1).
--   - No delayed-grant wait window.

-- Step 1 — track which workspace each user's data keys belong to.
ALTER TABLE public.user_vault_meta
  ADD COLUMN IF NOT EXISTS workspace_key_id UUID;

COMMENT ON COLUMN public.user_vault_meta.workspace_key_id IS
  'Lazily allocated UUID for this user''s workspace. Used as data_key_id when wrapping subkeys for co-admins. NULL until the first co-admin grant.';

-- Step 2 — grant table.
CREATE TABLE IF NOT EXISTS public.workspace_admins (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_user_id   UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, admin_user_id)
);

COMMENT ON TABLE public.workspace_admins IS
  'Records co-admin grants. The owner wraps their subkey blob for the admin''s PQC KEM public key and stores it in wrapped_data_keys. Deleting this row revokes access (modulo cached in-tab subkeys — see docs/OrangeRails-CoAdmins.md).';

CREATE INDEX IF NOT EXISTS workspace_admins_owner_user_id_idx
  ON public.workspace_admins(owner_user_id);

CREATE INDEX IF NOT EXISTS workspace_admins_admin_user_id_idx
  ON public.workspace_admins(admin_user_id);

-- Step 3 — RLS for workspace_admins.
ALTER TABLE public.workspace_admins ENABLE ROW LEVEL SECURITY;

-- Owner sees their own grants; admin sees rows they appear in.
CREATE POLICY "workspace_admins: owner and admin can read their rows"
  ON public.workspace_admins
  FOR SELECT
  USING (
    owner_user_id = auth.uid()
    OR admin_user_id = auth.uid()
  );

-- Only the owner can grant (INSERT). We use a direct client policy so no
-- edge function is needed for this write path.
CREATE POLICY "workspace_admins: owner can insert"
  ON public.workspace_admins
  FOR INSERT
  WITH CHECK (owner_user_id = auth.uid());

-- Only the owner can revoke (DELETE).
CREATE POLICY "workspace_admins: owner can delete"
  ON public.workspace_admins
  FOR DELETE
  USING (owner_user_id = auth.uid());

-- Step 4 — allow wrapped_data_keys INSERT/DELETE by the authenticated owner
-- (previously service-role only). The owner inserts when granting; they
-- delete the corresponding row when revoking.
CREATE POLICY "wrapped_data_keys: owner can insert for admins"
  ON public.wrapped_data_keys
  FOR INSERT
  WITH CHECK (
    -- The inserting user must be the workspace owner referenced by data_key_id.
    EXISTS (
      SELECT 1
      FROM public.user_vault_meta uvm
      WHERE uvm.user_id    = auth.uid()
        AND uvm.workspace_key_id = data_key_id
    )
  );

CREATE POLICY "wrapped_data_keys: owner can delete their wrapped keys"
  ON public.wrapped_data_keys
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_vault_meta uvm
      WHERE uvm.user_id    = auth.uid()
        AND uvm.workspace_key_id = data_key_id
    )
  );

-- Step 5 — let admins read/write connections and encrypted_transactions
-- that belong to any workspace they are co-admin of.
-- The original policy ("owner_user_id = auth.uid()") stays in place;
-- these policies ADD the co-admin path.

-- connections
CREATE POLICY "connections: co-admins have full access"
  ON public.connections
  FOR ALL
  USING (
    owner_user_id IN (
      SELECT owner_user_id
      FROM public.workspace_admins
      WHERE admin_user_id = auth.uid()
    )
  )
  WITH CHECK (
    owner_user_id IN (
      SELECT owner_user_id
      FROM public.workspace_admins
      WHERE admin_user_id = auth.uid()
    )
  );

-- encrypted_transactions (if owner_user_id column exists; some schemas
-- derive ownership via connection_id — adjust policy accordingly)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'encrypted_transactions'
      AND column_name  = 'owner_user_id'
  ) THEN
    EXECUTE $q$
      CREATE POLICY "encrypted_transactions: co-admins have full access"
        ON public.encrypted_transactions
        FOR ALL
        USING (
          owner_user_id IN (
            SELECT owner_user_id
            FROM public.workspace_admins
            WHERE admin_user_id = auth.uid()
          )
        )
        WITH CHECK (
          owner_user_id IN (
            SELECT owner_user_id
            FROM public.workspace_admins
            WHERE admin_user_id = auth.uid()
          )
        )
    $q$;
  ELSE
    -- Fall back to connection-scoped ownership.
    EXECUTE $q$
      CREATE POLICY "encrypted_transactions: co-admins have full access"
        ON public.encrypted_transactions
        FOR ALL
        USING (
          connection_id IN (
            SELECT c.id
            FROM public.connections c
            JOIN public.workspace_admins wa
              ON wa.owner_user_id = c.owner_user_id
            WHERE wa.admin_user_id = auth.uid()
          )
        )
        WITH CHECK (
          connection_id IN (
            SELECT c.id
            FROM public.connections c
            JOIN public.workspace_admins wa
              ON wa.owner_user_id = c.owner_user_id
            WHERE wa.admin_user_id = auth.uid()
          )
        )
    $q$;
  END IF;
END $$;
