/**
 * Guards the co-admin workspace loader in src/routes/app.tsx.
 *
 * That loader runs several Supabase reads to work out which workspaces the
 * signed-in user is a co-admin of. Before this guard existed it destructured
 * only `data` off every one of those reads, so a query the database REJECTED
 * and a query that legitimately returned nothing both ended the same way:
 * "this person is a co-admin of nothing", with no error on screen and
 * nothing in the console. See DEV-0401.
 *
 * Given the outcome of the top-level membership queries, decide whether the
 * loader may safely apply the workspace list it collected, or must bail out
 * and leave whatever was already on screen alone rather than overwrite it
 * with a false empty result.
 */

export interface CoAdminQueryOutcome {
  error: unknown | null;
}

export function shouldApplyCoAdminRefresh(outcomes: CoAdminQueryOutcome[]): boolean {
  return outcomes.every((outcome) => outcome.error === null);
}
