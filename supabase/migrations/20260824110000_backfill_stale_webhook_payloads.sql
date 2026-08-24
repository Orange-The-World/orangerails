-- ============================================================
-- Backfill queued sync.completed payloads to the canonical event shape.
-- DL-1565, follow-on to the emitter alignment in #846.
--
-- WHY THIS EXISTS, and why #846 alone does not cover it.
--
-- #846 made every emitter build one payload shape. It changes what gets WRITTEN
-- from now on. It cannot change rows that were already written: the payload is
-- serialised into webhook_delivery at enqueue time and never rebuilt. So any
-- row enqueued before #846 still carries whatever shape its emitter produced on
-- the day, and a code deploy will never reach it.
--
-- Two shapes exist in the queue. The older one is flat only: event,
-- subaccount_id, connection_id, synced_count, ts, and optionally provider. The
-- newer one adds `type` and `data` alongside those same flat fields.
--
-- @orangerails/webhooks constructEvent() dispatches on body.type. Given a row
-- in the older shape it throws, because there is no type to dispatch on. A
-- receiver on our published SDK therefore cannot read the older rows at all.
--
-- ORDERING REQUIREMENT, and why this file carries an earlier timestamp than
-- the change it follows. Delivery is one-way: once a queued row has been POSTed
-- and accepted it is no longer pending, so a row sent in a shape the receiver
-- cannot use is not recoverable by retrying later. The shape has to be right
-- before anything drains the queue, not after.
--
-- #844 added 20260824120000_schedule_or_webhook_dispatch.sql, which gives this
-- queue its first scheduled drain. The apply runner walks
-- supabase/migrations/*.sql in filename order, one statement round trip per
-- file, so on any environment where both are pending, whichever sorts first
-- runs first. This file is deliberately versioned 20260824110000, ahead of that
-- one, so the payloads are correct before the schedule exists rather than a few
-- round trips after it. That is out of chronological order on purpose. It is
-- already applied on dev, where this migration is a no-op, and the runner
-- applies by set membership rather than by ordering, so arriving late there
-- changes nothing.
--
-- WHAT IT DOES. For undrained sync.completed rows missing `type`, adds the
-- canonical half built from the row's OWN flat fields. Nothing is invented and
-- nothing is removed: the flat fields stay exactly as they are, because
-- receivers written before the SDK read them and the dual shape is deliberate.
--
-- `data` is exactly SyncCompletedEvent['data']: subaccount_id, connection_id,
-- synced_count, ts. `provider` is NOT included in `data`, deliberately, because
-- the published type does not carry it. It remains flat, same as #846.
--
-- Idempotent: filtered on rows that lack `type`, so a second run matches
-- nothing. Scoped twice over: `succeeded_at IS NULL` so delivered history is
-- never rewritten, and `attempts < 5` so rows the pre-cutoff mark in
-- 20260824105000 has retired are left exactly as that migration left them.
-- `attempts < 5` is the contract, not the sentinel string in `last_error`:
-- the integer is what the dispatcher itself predicates on, the string is for
-- humans reading the table. Reversible, see foot.
--
-- Down / undo. This migration adds `type`/`data` ONLY to rows that lacked a
-- `type` at apply time. Rows already in canonical shape (emitted by #846) are
-- never touched here and MUST NOT be stripped on reversal. Because both kinds
-- carry type+data afterwards, a blanket
--   UPDATE ... SET payload = payload - 'type' - 'data'
--     WHERE succeeded_at IS NULL AND event_type = 'sync.completed';
-- is too wide: it would corrupt the #846 rows this migration never modified.
-- To reverse, key the strip to exactly the ids reported before apply:
--   -- capture BEFORE running this migration:
--   SELECT id FROM public.webhook_delivery
--    WHERE succeeded_at IS NULL AND attempts < 5
--      AND event_type = 'sync.completed'
--      AND NOT (payload ? 'type');
--   -- then reverse only those ids:
--   UPDATE public.webhook_delivery
--      SET payload = payload - 'type' - 'data'
--    WHERE id = ANY(:captured_ids);
-- ============================================================

DO $$
DECLARE
  before_count INT;
  after_count  INT;
BEGIN
  SELECT count(*) INTO before_count
  FROM public.webhook_delivery
  WHERE succeeded_at IS NULL
    AND attempts < 5
    AND event_type = 'sync.completed'
    AND NOT (payload ? 'type');

  RAISE NOTICE '[backfill] % undrained sync.completed row(s) missing the canonical shape', before_count;

  UPDATE public.webhook_delivery
     SET payload = payload
                 || jsonb_build_object('type', 'sync.completed')
                 || jsonb_build_object(
                      'data',
                      jsonb_build_object(
                        'subaccount_id', payload -> 'subaccount_id',
                        'connection_id', payload -> 'connection_id',
                        'synced_count',  payload -> 'synced_count',
                        'ts',            payload -> 'ts'
                      )
                    )
   WHERE succeeded_at IS NULL
     AND attempts < 5
     AND event_type = 'sync.completed'
     AND NOT (payload ? 'type');

  -- Post-condition. Fail the migration rather than report a success that left
  -- unparseable rows in a queue that is about to be drained for the first time.
  SELECT count(*) INTO after_count
  FROM public.webhook_delivery
  WHERE succeeded_at IS NULL
    AND attempts < 5
    AND event_type = 'sync.completed'
    AND NOT (payload ? 'type');

  IF after_count <> 0 THEN
    RAISE EXCEPTION '[backfill] % undrained sync.completed row(s) still missing type', after_count;
  END IF;

  -- Guard against a backfill that produced a `data` object with NULL members,
  -- which would parse but carry nothing. A flat field we cannot read is a row
  -- we must look at by hand, not one to quietly ship.
  SELECT count(*) INTO after_count
  FROM public.webhook_delivery
  WHERE succeeded_at IS NULL
    AND attempts < 5
    AND event_type = 'sync.completed'
    AND (payload -> 'data' ->> 'subaccount_id' IS NULL
      OR payload -> 'data' ->> 'connection_id' IS NULL);

  IF after_count <> 0 THEN
    RAISE EXCEPTION
      '[backfill] % row(s) have a data object with no subaccount_id or connection_id', after_count;
  END IF;

  RAISE NOTICE '[backfill] % row(s) upgraded, 0 unparseable remain', before_count;
END $$;
