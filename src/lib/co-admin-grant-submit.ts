/**
 * Orchestrates a single co-admin grant attempt with the on-screen list
 * refresh a failed grant now needs (OR-T1238).
 *
 * WHY THIS EXISTS. persistCoAdminGrant (see co-admin.ts) writes the
 * workspace_admins list row BEFORE the wrapped_data_keys row, so a stop
 * between the two leaves a real, visible-in-the-database list entry with no
 * key behind it. grantCoAdmin surfaces that as CoAdminGrantIncompleteError.
 * Before this existed, the caller only re-read the co-admin list on success,
 * so that left-behind entry sat in workspace_admins invisible to the owner
 * until they reloaded the page.
 *
 * TWO RULES THIS ENFORCES.
 *   1. Only refresh on CoAdminGrantIncompleteError. Any other throw means
 *      the list row was never written (the owner password check, the HKDF
 *      derivation, the key allocation, or the list write itself all failed
 *      before persistCoAdminGrant's second write), so there is nothing new
 *      to show and refreshing would just slow down the error path.
 *   2. The grant's own error is what must reach the caller. If the refresh
 *      itself throws, that failure is swallowed rather than replacing the
 *      original error: an owner who failed to grant access needs to know
 *      that, not why the list re-read also failed.
 */

import { CoAdminGrantIncompleteError } from "./co-admin";

export interface GrantCoAdminAndRefreshDeps<T> {
  /** Performs the grant itself (grantCoAdmin, or a stand-in for tests). */
  grant: () => Promise<T>;
  /** Re-reads the co-admin list and updates whatever state renders it. */
  refreshList: () => Promise<void>;
}

export async function grantCoAdminAndRefresh<T>(
  deps: GrantCoAdminAndRefreshDeps<T>,
): Promise<T> {
  try {
    return await deps.grant();
  } catch (err) {
    if (err instanceof CoAdminGrantIncompleteError) {
      try {
        await deps.refreshList();
      } catch {
        // The grant's own error is the one that must reach the caller.
      }
    }
    throw err;
  }
}
