/**
 * Orange Rails, LDK connector — regression test for OR-T1721.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-ldk-channel-state/index.test.ts
 *
 * The database execution case also needs PostgreSQL connection variables and
 * LDK_CHANNEL_STATE_DB_TEST=1. CI supplies both and builds the table from the
 * repository migrations before running this file.
 *
 * WHY THIS TEST IS SHAPED THIS WAY.
 *
 * OR-T1721 found that UPSERT_CHANNEL_STATE_SQL, labelled the VERBATIM
 * persistence spec, could not run against the live dev `channel_state`
 * table: the ON CONFLICT target had no matching unique index, it named a
 * column (`sealed_blob`) that does not exist, it was missing `user_id`
 * entirely, and (found while fixing it) it also set `updated_at`, which is
 * not a column on this table either. Text checks keep each requirement easy
 * to diagnose, but they are not the acceptance proof: CI also creates the
 * table from its real migrations and executes this exported statement as an
 * authenticated user. The old SQL fails that execution before it writes.
 */

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handler, UPSERT_CHANNEL_STATE_SQL } from "./index.ts";

// Pinned from the live dev table. If a migration changes channel_state,
// update this list AND UPSERT_CHANNEL_STATE_SQL in the same PR.
const LIVE_CHANNEL_STATE_COLUMNS = [
  "id",
  "user_id",
  "outpoint_bidx",
  "seal_version",
  "sealed_iv",
  "sealed_ct",
  "update_id",
  "closed_at",
  "created_at",
] as const;

// Pinned from the live dev table's only unique index over the write path
// (channel_state_user_outpoint_uidx). A bare `outpoint_bidx` target has no
// matching unique index and fails at runtime (DESIGN.md §3.3).
const LIVE_CONFLICT_TARGET = "(user_id, outpoint_bidx)";

const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

function bindTestValues(updateId: number): string {
  const bindings = new Map([
    [":user_id", `'${TEST_USER_ID}'::uuid`],
    [":bidx", `'${"ab".repeat(32)}'`],
    [":new_id", `${updateId}::bigint`],
    [":seal_version", "1::smallint"],
    [":sealed_iv", `decode('${"01".repeat(12)}', 'hex')`],
    [":sealed_ct", `decode('${"02".repeat(17)}', 'hex')`],
  ]);

  let sql = UPSERT_CHANNEL_STATE_SQL;
  for (const [parameter, value] of bindings) {
    assert(sql.includes(parameter), `test setup: SQL no longer binds ${parameter}`);
    sql = sql.replaceAll(parameter, value);
  }
  return sql;
}

async function runPsql(sql: string): Promise<string> {
  const child = new Deno.Command("psql", {
    args: [
      "--no-password",
      "--no-psqlrc",
      "--quiet",
      "--tuples-only",
      "--no-align",
      "--set",
      "ON_ERROR_STOP=1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql));
  await writer.close();

  const output = await child.output();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  assert(output.success, `psql rejected UPSERT_CHANNEL_STATE_SQL: ${stderr}`);
  return new TextDecoder().decode(output.stdout).trim();
}

function referencedColumns(sql: string): string[] {
  // Every bare identifier that looks like a column reference: after INSERT
  // INTO ... (...), after SET, or as a bare EXCLUDED.<col> / channel_state.<col>.
  const insertList = sql.match(/INSERT INTO channel_state \(([^)]+)\)/)?.[1] ?? "";
  const fromInsert = insertList.split(",").map((c) => c.trim());
  const fromExcluded = [...sql.matchAll(/EXCLUDED\.(\w+)/g)].map((m) => m[1]);
  const fromTable = [...sql.matchAll(/channel_state\.(\w+)/g)].map((m) => m[1]);
  return [...new Set([...fromInsert, ...fromExcluded, ...fromTable])];
}

Deno.test("UPSERT_CHANNEL_STATE_SQL names only columns that exist on the live table", () => {
  const referenced = referencedColumns(UPSERT_CHANNEL_STATE_SQL);
  assert(referenced.length > 0, "test setup: no columns parsed out of the SQL, regex is broken");
  for (const col of referenced) {
    assert(
      (LIVE_CHANNEL_STATE_COLUMNS as readonly string[]).includes(col),
      `UPSERT_CHANNEL_STATE_SQL references "${col}", which is not a column on the live ` +
        `channel_state table (${LIVE_CHANNEL_STATE_COLUMNS.join(", ")}). This is the exact ` +
        "shape of the sealed_blob / updated_at defects in OR-T1721.",
    );
  }
});

Deno.test(
  "UPSERT_CHANNEL_STATE_SQL conflicts on the composite key that actually has a unique index",
  () => {
    assert(
      UPSERT_CHANNEL_STATE_SQL.includes(`ON CONFLICT ${LIVE_CONFLICT_TARGET}`),
      "ON CONFLICT must target the composite (user_id, outpoint_bidx) unique index. A bare " +
        "(outpoint_bidx) target has no matching unique index and fails at runtime (OR-T1721).",
    );
  },
);

Deno.test("UPSERT_CHANNEL_STATE_SQL binds user_id from the caller, not the request body", () => {
  assertEquals(
    UPSERT_CHANNEL_STATE_SQL.includes(":user_id"),
    true,
    "user_id must be bound as a parameter sourced from the verified JWT (DESIGN.md §4), not " +
      "omitted (OR-T1721) or read from the request body.",
  );
});

Deno.test({
  name: "UPSERT_CHANNEL_STATE_SQL executes against the migration-defined schema",
  ignore: Deno.env.get("LDK_CHANNEL_STATE_DB_TEST") !== "1",
  async fn() {
    const output = await runPsql(`
BEGIN;
INSERT INTO auth.users (id) VALUES ('${TEST_USER_ID}'::uuid);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '${TEST_USER_ID}', true);
${bindTestValues(1)}
${bindTestValues(2)}
SELECT update_id FROM public.channel_state
 WHERE user_id = '${TEST_USER_ID}'::uuid
   AND outpoint_bidx = '${"ab".repeat(32)}';
ROLLBACK;
`);

    assertEquals(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
      [TEST_USER_ID, "1", "2", "2"],
      "the authenticated upsert must insert once, update on the composite conflict, and retain update_id 2",
    );
  },
});

Deno.test("handler remains scaffold-only", async () => {
  const response = handler(new Request("https://example.invalid"));
  assertEquals(response.status, 501);
  assertEquals((await response.json()).error.includes("scaffold only"), true);
});
