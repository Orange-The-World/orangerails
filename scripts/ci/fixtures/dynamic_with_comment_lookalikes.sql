-- Fixture for OR-T2759's self-test.
--
-- Real dynamic statements that sit next to comment-like text. Each of the
-- two DROP POLICY lines must still be flagged (exit non-zero): a "--" inside
-- a quoted string is not a comment, and a trailing comment does not hide code.

DO $$
DECLARE
  p text := 'x';
BEGIN
  EXECUTE format('-- not a comment: DROP POLICY %I ON public.t', p);
  EXECUTE format('DROP POLICY %I ON public.t', p); -- trailing comment
END $$;
