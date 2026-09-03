-- ============================================================
-- Retire the pre-cutoff webhook_delivery backlog before the queue is ever drained.
-- DL-1562.
--
-- WHY. The dispatcher schedule added in 20260824120000 gives this queue its
-- first drain. Some rows in it have been pending for weeks. Delivering those is
-- not a late delivery, it is a wrong one: consumers treat a webhook as current
-- state, so replaying an old payload can push a consumer back into a state it
-- has already moved past. The decision on the ticket was to send nothing from
-- before a fixed cutoff, and to record exactly how many we chose not to send.
--
-- ORDERING. This must run before the schedule exists, not merely before the
-- first tick.
--
-- CORRECTION, 2026-08-27, DL-1596. The rest of this paragraph used to read:
-- "The apply runner walks supabase/migrations/*.sql in filename order, one
-- round trip per file, so version 20260824105000 is guaranteed to run ahead of
-- both 20260824110000 (the payload backfill) and 20260824120000 (the
-- schedule). The ordering is therefore a property of the filenames rather than
-- of whoever runs the apply." THAT ARGUMENT IS FALSIFIED. Do not cite it as a
-- control anywhere. Filename order orders the files inside ONE run. It cannot
-- reorder across runs, and every environment we own is already partly applied.
--
-- It failed on this very pair. 20260824120000 merged first, in #844 and #846,
-- and was applied. This file merged about forty minutes later in #850 carrying
-- a LOWER version and was not. For that window the dispatcher schedule was live
-- and the retirement this file performs had not run. Dev was unharmed only
-- because webhook_delivery on dev held 0 rows, which is luck and not a control.
--
-- The control that now exists is the out-of-order gate in
-- .github/workflows/supabase-deploy.yml. Before anything is applied it reads the
-- ledger and refuses if a pending migration numbers below the highest version
-- already applied on that target, naming the file and that version. Going ahead
-- is a deliberate dispatch with allow_out_of_order ticked, not a retry.
--
-- If you write a migration whose safety depends on running before another one,
-- its number is not what makes that happen. Say so in the header and make the
-- dependency explicit in the SQL.
--
-- HOW A ROW IS RETIRED, and why not succeeded_at. Setting succeeded_at would
-- record these as delivered. They were never sent, so every future count of
-- delivered webhooks would be permanently overstated, and the number would be
-- wrong in the direction that hides a problem. Instead the row is retired the
-- way the dispatcher already understands: attempts is raised to the retry
-- ceiling, succeeded_at stays NULL, and last_error carries a sentinel so a
-- human reading the table can tell this apart from a delivery that failed five
-- times on its own.
--
-- `attempts < 5` is the contract. It is what the dispatcher selects on and what
-- 20260824110000 predicates on, so all three agree on what "still to send"
-- means by construction. Nothing branches on the sentinel string.
--
-- CUTOFF. A fixed timestamp literal, not an interval from apply time. An
-- interval would mark a different set depending on the minute the apply is
-- pressed, so review and apply could disagree and the rehearsal would not
-- predict the real run. Fixed means dev, the rehearsal and production all
-- retire exactly the same rows.
--
-- IDEMPOTENT by construction: a retired row no longer satisfies attempts < 5,
-- so a second run counts zero, updates zero, and its equality guard passes.
--
-- Down / undo. Undoing this would put old payloads back in line for delivery,
-- which is the thing the ticket decided against, so do not undo it wholesale.
-- If a specific row must be revived, capture ids before apply:
--   SELECT id FROM public.webhook_delivery
--    WHERE succeeded_at IS NULL AND attempts < 5
--      AND created_at < '2026-08-17 00:00:00+00';
--   -- then revive only those ids:
--   UPDATE public.webhook_delivery SET attempts = 0, last_error = NULL
--    WHERE id = ANY(:captured_ids);
-- ============================================================

DO $$
DECLARE
  cutoff CONSTANT TIMESTAMPTZ := '2026-08-17 00:00:00+00';
  n      INT;
  marked INT;
BEGIN
  SELECT count(*) INTO n
  FROM public.webhook_delivery
  WHERE succeeded_at IS NULL
    AND attempts < 5
    AND created_at < cutoff;

  -- Sanity bound, deliberately not the expected count. A literal expectation
  -- goes stale between review and apply; a bound catches the case where this
  -- runs against a database far larger than the one it was written for and
  -- would retire a great deal more than anyone reviewed.
  IF n > 40 THEN
    RAISE EXCEPTION
      '[pre-cutoff mark] % pending rows before the cutoff, which is more than this migration was reviewed for. Refusing to retire them unexamined.', n;
  END IF;

  RAISE NOTICE '[pre-cutoff mark] % pending row(s) created before %, retiring', n, cutoff;

  UPDATE public.webhook_delivery
     SET attempts   = 5,
         last_error = 'abandoned: pre-cutoff backlog, never dispatched'
   WHERE succeeded_at IS NULL
     AND attempts < 5
     AND created_at < cutoff;

  GET DIAGNOSTICS marked = ROW_COUNT;

  -- The count and the update must agree inside this one transaction. If they
  -- do not, something changed the table between the two statements and this
  -- migration no longer knows what it retired.
  IF marked <> n THEN
    RAISE EXCEPTION
      '[pre-cutoff mark] counted % pending row(s) before the cutoff but retired %. Refusing to continue.', n, marked;
  END IF;

  RAISE NOTICE '[pre-cutoff mark] % row(s) retired as pre-cutoff, 0 delivered', marked;
END $$;
