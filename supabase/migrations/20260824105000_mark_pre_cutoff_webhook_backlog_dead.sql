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
-- first tick. That requirement is real and still stands.
--
-- CORRECTION, 2026-08-31, OR-T0419. The argument this paragraph used to make
-- for how that requirement was met is FALSE, and it was falsified on these
-- exact files. It read: "The apply runner walks supabase/migrations/*.sql in
-- filename order, one round trip per file, so version 20260824105000 is
-- guaranteed to run ahead of both 20260824110000 and 20260824120000. The
-- ordering is therefore a property of the filenames rather than of whoever runs
-- the apply."
--
-- Filename order is a WITHIN-RUN property. The runner sorts the files it is
-- given in one run and skips anything already in the ledger; it cannot reorder
-- across runs. On a partly-applied database, which is every environment we own,
-- a file that merges later while numbering earlier is applied AFTER migrations
-- that number above it.
--
-- That is what happened on dev on 2026-08-24. 20260824120000 (the schedule)
-- merged first and applied. THIS file merged later with a lower version and did
-- not. For about forty minutes the dev ledger held the schedule and not the
-- retirement below, with the drain job active. Nothing was harmed only because
-- webhook_delivery on dev held 0 rows. That was luck.
--
-- WHAT ENFORCES IT NOW. The apply job in .github/workflows/supabase-deploy.yml
-- refuses to apply a migration numbered below the highest version already in
-- the target ledger, and names the file and the max. A migration that genuinely
-- may run late opts in with an explicit "-- out-of-order-apply:" marker line.
-- Do NOT cite the filename argument again. Cite that guard.
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
