-- OR-T1189 forced two-PR race proof, branch B. THROWAWAY, reverted immediately after the run.
-- Same version prefix as branch A's file, deliberately, to test the apply-order race window.
-- No-op: proves nothing about schema, only about CI apply-order wiring.
select 1;
