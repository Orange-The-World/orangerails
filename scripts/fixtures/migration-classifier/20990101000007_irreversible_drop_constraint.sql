-- IRREVERSIBLE fixture: ALTER TABLE ... DROP CONSTRAINT.
--
-- Expected verdict: IRREVERSIBLE, rule [ALTER TABLE DROP].
--
-- Dropping a uniqueness guarantee looks reversible: you can add the constraint
-- back. You cannot add it back once duplicate rows have arrived through the
-- hole it left, not without choosing which rows to destroy. The file does not
-- say what this constraint guaranteed, so the class is refused.

alter table public.or_fixture_widget
  drop constraint or_fixture_widget_label_key;
