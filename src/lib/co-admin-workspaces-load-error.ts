/**
 * Whether the list_coadmin_workspaces read failed, and what to tell the user
 * if so, in src/routes/app.tsx's co-admin gate effect.
 *
 * WHY THIS IS ITS OWN FUNCTION (OR-T0834 step 7). The decision this makes is
 * the exact one DEV-0401 fixed: a rejected read must never look like "you
 * administer nothing". Before this file existed, that decision was four
 * lines buried inside a ~200-line effect in a 1928-line route component, so
 * nothing could call it without mounting the whole screen (no test harness
 * reaches src/routes/app.tsx today -- see OR-E0018). Lifting it out does not
 * make the screen itself testable, but it makes THIS decision testable,
 * which is the one this ticket's acceptance criterion names: proving a
 * PostgREST error is surfaced via classifyRead rather than silently read as
 * zero workspaces.
 *
 * classifyRead and formatError are already independently tested elsewhere
 * (read-outcome.test.ts, and formatError's own shape handling). What was
 * NOT tested before this file is their composition at this specific call
 * site: that the right pair of values reaches classifyRead, that the
 * resulting message actually carries formatError's output, and that the
 * success path stays silent. A copy-paste mistake at any of app.tsx's four
 * classifyRead call sites (e.g. checking the wrong error variable) would not
 * have been caught by either function's own tests in isolation.
 */
import { classifyRead } from "@/lib/read-outcome";
import { formatError } from "@/lib/format-error";

export type CoAdminWorkspacesLoadResult = { failed: false } | { failed: true; message: string };

export function describeCoAdminWorkspacesLoadFailure(
  data: unknown,
  error: unknown,
): CoAdminWorkspacesLoadResult {
  if (classifyRead(data, error) !== "error") return { failed: false };
  return {
    failed: true,
    message: `Could not load your co-admin workspaces: ${formatError(error)}`,
  };
}
