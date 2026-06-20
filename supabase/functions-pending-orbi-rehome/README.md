# Pending: re-home to Orange-The-World/orbi

Functions in this directory belong logically to the ORBI repo
(`Orange-The-World/orbi`) but their source still lives here because
the ORBI extraction happened mid-migration. They import from
`../../../orbi/src/*` paths that no longer exist after the split, so
they cannot be deployed from this repo.

## To-do

1. Move `on-demand-resolve/` (and any future entries here) into the
   `Orange-The-World/orbi` repo under `supabase/functions/`.
2. Wire ORBIs supabase project (or reuse `lcdicqalreskibdfxkzb` if OR
   continues to host ORBIs read-side) into the orbi repos CI.
3. Delete this directory from `Orange-The-World/orangerails`.
