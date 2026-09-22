/**
 * Pins the OR-T1789 residual on src/routes/app.tsx.
 *
 * PR #1182 made a failed list_coadmin_workspaces call visible via setErr.
 * refresh() clears that same slot on every run. The PQC key backfill is
 * fired and not awaited; when it lands it writes myKemSecretWrapped, which
 * is in getActiveCredentialsKey / getActiveTransactionsKey deps, which are
 * in refresh's deps, which re-runs the effect that calls refresh(). That
 * ordering can wipe the RPC failure after it has been shown, leaving an
 * empty co-admin list with no message.
 *
 * This file does not mount the page. It reads the route source and checks
 * two things the ticket asked for:
 *   1. The dependency chain in the brief (points 2 to 4) is still present,
 *      so the ordering is reachable rather than assumed gone.
 *   2. The RPC failure is no longer written into `err`, and refresh() does
 *      not reset the slot that holds it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "app.tsx"), "utf8");

function bodyAfter(marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`app.tsx no longer contains ${JSON.stringify(marker)}`);
  }
  const brace = source.indexOf("{", start);
  if (brace < 0) {
    throw new Error(`no block after ${JSON.stringify(marker)}`);
  }
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(brace, i + 1);
    }
  }
  throw new Error(`unbalanced block after ${JSON.stringify(marker)}`);
}

function depsAfter(marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`app.tsx no longer contains ${JSON.stringify(marker)}`);
  }
  const body = bodyAfter(marker);
  const bodyStart = source.indexOf("{", start);
  const afterBody = source.slice(bodyStart + body.length);
  const match = afterBody.match(/^\s*,\s*(\[[\s\S]*?\])\s*\)/);
  if (!match) {
    throw new Error(`no dependency array after ${JSON.stringify(marker)}`);
  }
  return match[1];
}

describe("OR-T1789 co-admin workspace load failure vs refresh()", () => {
  it("the PQC-backfill → refresh identity chain is still in the file, so the ordering is reachable", () => {
    // Point 4: backfill is fired, not awaited, and writes myKemSecretWrapped.
    const backfill = source.indexOf("if (!kemWrapped)");
    expect(backfill).toBeGreaterThan(-1);
    const backfillSlice = source.slice(backfill, backfill + 1200);
    expect(backfillSlice).toMatch(/ensurePqcKeypairs\s*\(/);
    expect(backfillSlice).not.toMatch(/await\s+ensurePqcKeypairs\s*\(/);
    expect(backfillSlice).toMatch(/\.then\s*\(/);
    expect(backfillSlice).toMatch(/setMyKemSecretWrapped\s*\(/);

    // Point 3: myKemSecretWrapped is in the key-loader callbacks' deps.
    const credsDeps = depsAfter("const getActiveCredentialsKey = useCallback");
    const txnsDeps = depsAfter("const getActiveTransactionsKey = useCallback");
    expect(credsDeps).toContain("myKemSecretWrapped");
    expect(txnsDeps).toContain("myKemSecretWrapped");

    // Point 2: those callbacks are in refresh's deps, and refresh clears err.
    const refreshDeps = depsAfter("const refresh = useCallback(async () => {");
    expect(refreshDeps).toContain("getActiveCredentialsKey");
    expect(refreshDeps).toContain("getActiveTransactionsKey");

    const refreshBody = bodyAfter("const refresh = useCallback(async () => {");
    expect(refreshBody).toMatch(/setErr\(\s*null\s*\)/);

    // The effect re-runs refresh whenever that callback identity changes.
    const refreshEffect = source.slice(
      source.indexOf("if (isUnlocked) void refresh();"),
    );
    const effectDeps = refreshEffect.slice(
      refreshEffect.indexOf("}, ["),
      refreshEffect.indexOf("]);") + 3,
    );
    expect(effectDeps).toContain("refresh");
  });

  it("the list_coadmin_workspaces failure has its own state that refresh() does not reset", () => {
    expect(source).toMatch(
      /const \[coAdminWorkspacesLoadError,\s*setCoAdminWorkspacesLoadError\]/,
    );

    const rpcSlice = source.slice(
      source.indexOf('"list_coadmin_workspaces"'),
      source.indexOf("const workspaces: WorkspaceOption[]"),
    );
    expect(rpcSlice).toContain("setCoAdminWorkspacesLoadError");
    expect(rpcSlice).not.toMatch(/setErr\s*\(/);

    const refreshBody = bodyAfter("const refresh = useCallback(async () => {");
    expect(refreshBody).not.toContain("setCoAdminWorkspacesLoadError");

    // Failed load must not collapse into "you administer nothing".
    const afterRpc = source.slice(source.indexOf("setCoAdmins("));
    expect(afterRpc).toMatch(
      /if\s*\(\s*!coAdminWorkspacesLoadFailed\s*\)[\s\S]*setAdminWorkspaces\s*\(/,
    );

    // Rendered next to the workspace list, not only through the shared banner.
    expect(source).toMatch(/\{coAdminWorkspacesLoadError\s*&&/);
  });
});
