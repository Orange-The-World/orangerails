-- Assert the GRANTEE AXIS on the six stealth and vault tables: which ROLES may
-- appear in a policy on them at all. This file changes no policy, no grant and
-- no data. It reads pg_policy and raises if the axis is not what the migration
-- before it established.
--
-- WHY A SEPARATE CHECK AT ALL, when 20260903001500 already self checks. That
-- file's checks assert an end state by naming two role list SHAPES and comparing
-- an aggregate for equality INSIDE each shape: policies whose role list is
-- exactly PUBLIC, and policies whose role list is exactly the logged in role. An
-- equality inside a filter is a real check, and it is still walkable past,
-- because a row outside the filter is matched by no branch and raises nothing. A
-- SELECT policy added later on one of those tables addressed to {anon}, or to
-- {authenticated,anon}, falls in neither aggregate. Both checks pass. An
-- anonymous session reads the table.
--
-- MEASURED, on the development cluster (fzwmnzmtqidumdqjdddz) on 2026-09-02:
-- those six tables carry exactly ten policies, and every one of them is
-- addressed to PUBLIC today. So nothing sits outside the two shapes at this
-- moment and the gap is LATENT. That is deliberately not treated as a reason to
-- leave it open. A check earns its keep in a state that does not exist yet, so
-- "nothing matches today" is the condition under which the missing branch
-- matters, not an argument against writing it.
--
-- THE PROPERTY THIS ASSERTS, in one sentence: on these six tables, the only
-- named role that may appear in any policy is the logged in role, and no
-- permissive SELECT policy may be addressed to PUBLIC. Those two together mean
-- no policy on these tables admits an anonymous session, whatever shape somebody
-- writes it in.
--
-- AN ALLOW LIST, NOT A WIDER ENUMERATION, AND WHAT THAT COSTS. Listing more
-- expected shapes only moves the blind spot. An allow list has a branch for the
-- case nobody thought of, which is the whole point. The trade is real and is
-- stated here rather than discovered later: a legitimately added policy naming
-- some other role WILL make this file raise, and widening the list then costs a
-- one line follow on migration. That is the cost of a check that cannot be
-- walked past, and it is the cheaper of the two failures.
--
-- WHY service_role IS ON THE LIST AND or_agent_reader IS NOT. Both hold
-- rolbypassrls, so row level security does not apply to either and naming either
-- one in a policy changes nothing for it. service_role is on the list because it
-- is the server side identity and a policy naming it is a plausible, harmless
-- thing for a future migration to write. or_agent_reader is a restricted read
-- role that should never be named in a policy, so if it turns up in one, saying
-- so out loud is the useful behaviour.
--
-- WHY IT RAISES AND DOES NOT WARN. Unlike a platform owned default privilege, a
-- policy on one of our own tables is something a migration CAN fix. A condition
-- a later file can repair should stop the deploy, because the repair is the
-- point. A warning here would be a note nobody reads on the way past.
--
-- ORDER. This asserts the end state that 20260903001500 creates, so it must be
-- applied after it, which the timestamp enforces while both are in the tree.
-- Check 0 exists so that arriving on a cluster where the narrowing has not been
-- applied names the missing file instead of failing with a puzzle.
--
-- IDEMPOTENT AND SIDE EFFECT FREE. It reads catalogues and raises. It can be
-- applied any number of times against any state.
--
-- REVERSAL: delete this file. It changes nothing, so there is nothing to put
-- back.

DO $$
DECLARE
  six CONSTANT text[] := ARRAY[
    'stealth_connections','stealth_scan_ranges','stealth_transactions',
    'stealth_utxos','workspace_admins','wrapped_data_keys'];
  -- The only named roles that may appear in a policy on these six tables.
  -- Anything else, the anonymous role first among them, raises below.
  allowed CONSTANT text[] := ARRAY['authenticated','service_role'];
  -- The six read policies as they exist BEFORE the narrowing. Used only to tell
  -- "the prerequisite has not been applied" apart from "something is wrong".
  pre_narrowing CONSTANT text :=
    'stealth_connections|Owners can read their stealth connections, '
    'stealth_scan_ranges|Owners can read their stealth scan ranges, '
    'stealth_transactions|Owners can read their stealth transactions, '
    'stealth_utxos|owner read via connection, '
    'workspace_admins|workspace_admins: owner and admin can read their rows, '
    'wrapped_data_keys|Recipients can read their own wrapped data keys';
  census    text;
  offenders text;
BEGIN
  -- The full state of the grantee axis on these six tables, rendered once and
  -- quoted in every failure message below. A check that says something is wrong
  -- without showing what it saw makes the reader go and look, and looking is the
  -- step where a hurried reader stops.
  SELECT coalesce(string_agg(line, ' / ' ORDER BY line), 'NONE') INTO census
    FROM (
      -- polcmd is the internal "char" type, not text. Without the cast, text ||
      -- "char" is ambiguous and the block does not compile at all.
      SELECT c.relname || '|' || p.polname || '|cmd=' || p.polcmd::text
             || '|' || CASE WHEN p.polpermissive THEN 'permissive' ELSE 'restrictive' END
             || '|roles=' ||
             CASE WHEN p.polroles = '{0}'::oid[] THEN 'PUBLIC'
                  ELSE coalesce(
                    (SELECT string_agg(coalesce(r.rolname, 'oid ' || pr.oid::text), '+' ORDER BY 1)
                       FROM unnest(p.polroles) AS pr(oid)
                       LEFT JOIN pg_roles r ON r.oid = pr.oid),
                    'EMPTY')
             END AS line
        FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname = ANY(six)) s;

  -- 0. PREREQUISITE. If the six read policies are still addressed to PUBLIC then
  --    20260903001500 has not been applied here and every check below would fail
  --    for that one reason. Say so plainly instead of reporting six offenders.
  SELECT coalesce(string_agg(c.relname || '|' || p.polname, ', ' ORDER BY c.relname, p.polname), 'NONE')
    INTO offenders
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname = ANY(six)
     AND p.polcmd IN ('r','*')
     AND p.polpermissive
     AND p.polroles = '{0}'::oid[];

  IF offenders = pre_narrowing THEN
    RAISE EXCEPTION
      'stealth and vault grantee axis: the six read policies are still addressed to PUBLIC, so migration 20260903001500 (narrow the stealth and vault SELECT policies) has not been applied on this cluster. Apply it first: this file asserts the state that one creates. Current axis: %',
      census;
  END IF;

  -- 1. NO PERMISSIVE SELECT POLICY ON THESE TABLES MAY BE ADDRESSED TO PUBLIC.
  --    PUBLIC applies to every role that can reach the table, the anonymous role
  --    included, so a read policy written that way puts the whole wall back on
  --    one expression inside the USING clause. A RESTRICTIVE policy addressed to
  --    PUBLIC is not covered here on purpose: a restrictive policy grants
  --    nothing, it only takes rows away, so it cannot open a read path.
  IF offenders <> 'NONE' THEN
    RAISE EXCEPTION
      'stealth and vault grantee axis: permissive SELECT policies addressed to PUBLIC found [%]. A read policy on these tables must name the logged in role, so that an anonymous session does not match it at all. Current axis: %',
      offenders, census;
  END IF;

  -- 2. THE ALLOW LIST. Every named role appearing in any policy on these six
  --    tables must be on it. This is the branch the shape based checks in
  --    20260903001500 do not have: a role list of {anon}, or {authenticated,anon},
  --    or one naming a role added after this file was written, is equal to
  --    neither of the two shapes those checks compare and so passes them in
  --    silence. Here it is simply not on the list, and the message names it.
  --    Grantee oid 0 is PUBLIC rather than a named role and is handled by check
  --    1 and by the four write policies note below, so it is excluded here.
  SELECT coalesce(string_agg(DISTINCT c.relname || '|' || p.polname || '|' ||
                             coalesce(r.rolname, 'oid ' || pr.oid::text), ', '), 'NONE')
    INTO offenders
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(p.polroles) AS pr(oid)
    LEFT JOIN pg_roles r ON r.oid = pr.oid
   WHERE n.nspname = 'public'
     AND c.relname = ANY(six)
     AND pr.oid <> 0
     AND (r.rolname IS NULL OR NOT (r.rolname = ANY(allowed)));

  IF offenders <> 'NONE' THEN
    RAISE EXCEPTION
      'stealth and vault grantee axis: policies name roles outside the allow list [%]. Allowed here: %. If the new role is legitimate, widen the list in a later migration rather than deleting this check. Current axis: %',
      offenders, array_to_string(allowed, ', '), census;
  END IF;

  RAISE NOTICE
    'stealth and vault grantee axis holds: no permissive SELECT policy is addressed to PUBLIC, and every named role in a policy on these six tables is on the allow list (%). Axis as read: %',
    array_to_string(allowed, ', '), census;
END $$;
