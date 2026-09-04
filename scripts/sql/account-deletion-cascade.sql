-- Account deletion must clear the vault meta rows it owns (DEV-0323).
--
-- HOW TO READ THE RESULT. This script ALWAYS ends by raising an exception.
-- That is deliberate and it is the whole design: everything it does happens
-- inside one transaction, and the raise is what rolls that transaction back so
-- the fixture leaves nothing behind. The exception MESSAGE is the result:
--
--   DEV0323_PASS ...   every leg held
--   DEV0323_FAIL ...   a leg did not hold, and the message says which
--   anything else      the script did not reach its own verdict, which is an
--                      UNKNOWN and must never be scored as a pass
--
-- A successful (non raising) return therefore means this file was edited into
-- something that no longer checks anything, and the caller treats it as a
-- failure. scripts/check-account-deletion-cascade.mjs is that caller.
--
-- TO RUN IT BY HAND against the dev project, paste it into the SQL editor. It
-- is safe: it creates its own fixture and rolls the whole thing back. Do not
-- run it against production. The caller refuses to.
--
-- WHY A FIXTURE. dev holds no auth.users rows, so there is nothing to delete
-- unless the test seeds it. Every seeded row is verified present before it is
-- deleted: a fixture that silently seeded nothing would make the assertion
-- below pass while proving nothing, which is the exact failure shape this
-- whole check exists to end.

DO $dev0323$
DECLARE
  probe_email  text := 'dev0323-cascade-probe@example.invalid';
  probe_email2 text := 'dev0323-cascade-probe-d@example.invalid';
  probe_mark  text := 'dev0323-probe';
  uid     uuid := gen_random_uuid();
  cid     uuid := gen_random_uuid();
  uid2    uuid := gen_random_uuid();
  cid2    uuid := gen_random_uuid();
  n       int;
  cust_n  int;
  auth_after uuid;
  deltype "char";
BEGIN
  -- LEG A. The two foreign keys that make the deletion reachable at all.
  -- Checked before any row is written, because if the cascade is gone the
  -- behavioural legs below would report a confusing symptom instead of the
  -- cause.
  SELECT confdeltype INTO deltype
    FROM pg_constraint
   WHERE conrelid = 'public.user_vault_meta'::regclass
     AND conname  = 'user_vault_meta_user_id_fkey';

  IF deltype IS NULL THEN
    RAISE EXCEPTION
      'DEV0323_FAIL user_vault_meta_user_id_fkey does not exist, so nothing removes a vault meta row when the account it belongs to is deleted';
  END IF;
  IF deltype <> 'c' THEN
    RAISE EXCEPTION
      'DEV0323_FAIL user_vault_meta_user_id_fkey is no longer ON DELETE CASCADE (confdeltype=%). Account removal will no longer reach the vault meta row through a cascade, and the delete guard refuses a top level delete.', deltype;
  END IF;

  SELECT confdeltype INTO deltype
    FROM pg_constraint
   WHERE conrelid = 'public.customer_vault_meta'::regclass
     AND conname  = 'customer_vault_meta_customer_id_fkey';

  IF deltype IS NULL THEN
    RAISE EXCEPTION
      'DEV0323_FAIL customer_vault_meta_customer_id_fkey does not exist, so nothing removes a customer vault meta row when the customer is deleted';
  END IF;
  IF deltype <> 'c' THEN
    RAISE EXCEPTION
      'DEV0323_FAIL customer_vault_meta_customer_id_fkey is no longer ON DELETE CASCADE (confdeltype=%)', deltype;
  END IF;

  -- LEG B. Delete the account. The vault meta row must go with it.
  INSERT INTO auth.users (id, email) VALUES (uid, probe_email);
  INSERT INTO public.user_vault_meta (user_id, vault_salt, vault_verifier_ciphertext)
       VALUES (uid, probe_mark, probe_mark);

  SELECT count(*) INTO n FROM public.user_vault_meta WHERE user_id = uid;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'DEV0323_FAIL the fixture seeded % user_vault_meta row(s) where 1 was expected, so the assertion that follows would have proved nothing', n;
  END IF;

  DELETE FROM auth.users WHERE id = uid;

  SELECT count(*) INTO n FROM public.user_vault_meta WHERE user_id = uid;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'DEV0323_FAIL deleting the account left % user_vault_meta row(s) behind for a user that no longer exists', n;
  END IF;

  -- LEG C. Delete the customer. The customer vault meta row must go with it.
  -- This is the owning cascade for that table. Note it is NOT the account
  -- deletion path: see the header.
  INSERT INTO public.customers (id, name, email, customer_type, plan)
       VALUES (cid, 'DEV0323 probe', probe_email, 'individual', 'free');
  INSERT INTO public.customer_vault_meta (customer_id, vault_salt, vault_verifier_ciphertext)
       VALUES (cid, probe_mark, probe_mark);

  SELECT count(*) INTO n FROM public.customer_vault_meta WHERE customer_id = cid;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'DEV0323_FAIL the fixture seeded % customer_vault_meta row(s) where 1 was expected, so the assertion that follows would have proved nothing', n;
  END IF;

  DELETE FROM public.customers WHERE id = cid;

  SELECT count(*) INTO n FROM public.customer_vault_meta WHERE customer_id = cid;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'DEV0323_FAIL deleting the customer left % customer_vault_meta row(s) behind for a customer that no longer exists', n;
  END IF;

  -- LEG D. Delete the account BEHIND a customer, not the customer itself.
  -- This is DEV-0334's ruling, implemented under DEV-0366: a BEFORE DELETE trigger
  -- on auth.users, trg_clear_customer_vault_meta_on_account_removal, must
  -- null customers.auth_user_id and delete that customer's vault meta row.
  -- It is a different path from LEG C above, which deletes the customer row
  -- directly and relies on the customer_id FK cascade. Here the customer row
  -- must survive with auth_user_id nulled: deleting it too would be a second,
  -- unrelated bug and this leg must not confuse the two.
  INSERT INTO auth.users (id, email) VALUES (uid2, probe_email2);
  INSERT INTO public.customers (id, name, email, customer_type, plan, auth_user_id)
       VALUES (cid2, 'DEV0323 probe D', probe_email2, 'individual', 'free', uid2);
  INSERT INTO public.customer_vault_meta (customer_id, vault_salt, vault_verifier_ciphertext)
       VALUES (cid2, probe_mark, probe_mark);

  SELECT count(*) INTO n FROM public.customer_vault_meta WHERE customer_id = cid2;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'DEV0323_FAIL the fixture seeded % customer_vault_meta row(s) for the account removal leg where 1 was expected, so the assertion that follows would have proved nothing', n;
  END IF;

  DELETE FROM auth.users WHERE id = uid2;

  SELECT count(*) INTO n FROM public.customer_vault_meta WHERE customer_id = cid2;
  IF n <> 0 THEN
    RAISE EXCEPTION
      'DEV0323_FAIL deleting the account left % customer_vault_meta row(s) behind for the customer it belonged to', n;
  END IF;

  SELECT count(*) INTO cust_n FROM public.customers WHERE id = cid2;
  IF cust_n <> 1 THEN
    RAISE EXCEPTION
      'DEV0323_FAIL deleting the account changed the customer row count to % (expected 1); the customer must be kept, only its auth_user_id cleared', cust_n;
  END IF;

  SELECT auth_user_id INTO auth_after FROM public.customers WHERE id = cid2;
  IF auth_after IS NOT NULL THEN
    RAISE EXCEPTION
      'DEV0323_FAIL the customer row survived account removal but auth_user_id was not nulled';
  END IF;

  RAISE EXCEPTION
    'DEV0323_PASS all four legs held: both foreign keys still cascade, account removal cleared user_vault_meta, customer removal cleared customer_vault_meta, and account removal (not customer removal) cleared the customer''s vault meta while keeping the customer row with auth_user_id nulled. This transaction is being rolled back on purpose.';
END
$dev0323$;
