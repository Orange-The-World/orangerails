/**
 * Recovery tests for OR-T0499.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-link-complete/index.test.ts
 *
 * The HTTP entrypoint binds Deno.serve at import time, so these tests exercise
 * the exported recovery operation with a stateful Supabase-shaped client. The
 * state starts where the forced-failure acceptance case starts: a claimed
 * widget token, a pending connection, and optionally a source_wallet row from
 * an earlier successful batch. A connection delete cascades that child row in
 * the mock just as the repository's source_wallets foreign key does.
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("OR_ACCT_FINGERPRINT_KEY_V1", "or-link-complete-recovery-test-key");
const { recoverIncompleteLink } = await import("./index.ts");

interface RecoveryState {
  connection: { id: string; status: "pending" | "active" } | null;
  sourceWalletConnectionIds: string[];
  token: { id: string; used_at: string | null };
  failConnectionDelete?: boolean;
  failTokenRelease?: boolean;
  mutations: string[];
}

// The production helper accepts SupabaseClient; this purpose-built fluent mock
// implements only the mutation surface the helper uses.
// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeRecoveryClient(state: RecoveryState): any {
  return {
    from(table: string) {
      let mutation: "delete" | "update" | null = null;
      let patch: Record<string, unknown> | null = null;
      const filters: Array<{ op: "eq" | "not"; column: string; value: unknown }> = [];

      const chain = {
        delete() {
          mutation = "delete";
          return chain;
        },
        update(value: Record<string, unknown>) {
          mutation = "update";
          patch = value;
          return chain;
        },
        eq(column: string, value: unknown) {
          filters.push({ op: "eq", column, value });
          return chain;
        },
        not(column: string, operator: string, value: unknown) {
          filters.push({ op: "not", column, value: `${operator}:${String(value)}` });
          return chain;
        },
        select(_columns: string) {
          return chain;
        },
        maybeSingle() {
          if (table === "connections" && mutation === "delete") {
            state.mutations.push("delete connection");
            if (state.failConnectionDelete) {
              return Promise.resolve({
                data: null,
                error: { message: "forced selection cleanup failure" },
              });
            }
            const id = filters.find((f) => f.op === "eq" && f.column === "id")?.value;
            const status = filters.find((f) => f.op === "eq" && f.column === "status")?.value;
            const conn = state.connection;
            if (!conn || conn.id !== id || conn.status !== status) {
              return Promise.resolve({ data: null, error: null });
            }
            state.connection = null;
            state.sourceWalletConnectionIds = state.sourceWalletConnectionIds.filter(
              (connectionId) => connectionId !== conn.id,
            );
            return Promise.resolve({ data: { id: conn.id }, error: null });
          }

          if (table === "pending_widget_sessions" && mutation === "update") {
            state.mutations.push("release token");
            if (state.failTokenRelease) {
              return Promise.resolve({
                data: null,
                error: { message: "forced token release failure" },
              });
            }
            const id = filters.find((f) => f.op === "eq" && f.column === "id")?.value;
            if (state.token.id !== id || state.token.used_at === null || patch?.used_at !== null) {
              return Promise.resolve({ data: null, error: null });
            }
            state.token.used_at = null;
            return Promise.resolve({ data: { id: state.token.id }, error: null });
          }

          throw new Error(`unexpected recovery mutation: ${table}.${mutation}`);
        },
      };
      return chain;
    },
  };
}

const CONNECTION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TOKEN_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function failedSelectionState(): RecoveryState {
  return {
    connection: { id: CONNECTION_ID, status: "pending" },
    // Models the split-batch case: one wallet insert landed before the next
    // selection write failed.
    sourceWalletConnectionIds: [CONNECTION_ID],
    token: { id: TOKEN_ID, used_at: "2026-09-14T12:00:00.000Z" },
    mutations: [],
  };
}

Deno.test("OR-T0499: failed selection is removed and the same token can retry", async () => {
  const state = failedSelectionState();

  const result = await recoverIncompleteLink(makeRecoveryClient(state), CONNECTION_ID, TOKEN_ID);

  assertEquals(result, { connectionRemoved: true, tokenReleased: true, error: null });
  assertEquals(state.connection, null, "zero-row connection must not remain as all-sync");
  assertEquals(state.sourceWalletConnectionIds, [], "partial selection rows must be cascaded away");
  assertEquals(state.token.used_at, null, "the claimed token must be reusable by the retry");
  assertEquals(
    state.mutations,
    ["delete connection", "release token"],
    "the token must not be released before duplicate-producing state is removed",
  );
});

Deno.test(
  "OR-T0499: cleanup failure leaves an explicit pending row and keeps token spent",
  async () => {
    const state = { ...failedSelectionState(), failConnectionDelete: true };

    const result = await recoverIncompleteLink(makeRecoveryClient(state), CONNECTION_ID, TOKEN_ID);

    assertEquals(result.connectionRemoved, false);
    assertEquals(result.tokenReleased, false);
    assertEquals(
      state.connection?.status,
      "pending",
      "failed cleanup must not masquerade as active",
    );
    assertEquals(
      state.token.used_at === null,
      false,
      "retry must not race a connection that still exists",
    );
    assertEquals(state.mutations, ["delete connection"]);
  },
);

Deno.test("OR-T0499: recovery cannot delete a connection that is already active", async () => {
  const state = failedSelectionState();
  state.connection = { id: CONNECTION_ID, status: "active" };

  const result = await recoverIncompleteLink(makeRecoveryClient(state), CONNECTION_ID, TOKEN_ID);

  assertEquals(result.connectionRemoved, false);
  assertEquals(result.tokenReleased, false);
  assertEquals(state.connection?.status, "active");
  assertEquals(state.token.used_at === null, false);
  assertEquals(state.mutations, ["delete connection"]);
});

Deno.test("OR-T0499: token-release failure still leaves a clean connection retry", async () => {
  const state = { ...failedSelectionState(), failTokenRelease: true };

  const result = await recoverIncompleteLink(makeRecoveryClient(state), CONNECTION_ID, TOKEN_ID);

  assertEquals(result.connectionRemoved, true);
  assertEquals(result.tokenReleased, false);
  assertEquals(
    state.connection,
    null,
    "a fresh-token retry must not create a duplicate connection",
  );
  assertEquals(state.sourceWalletConnectionIds, []);
});

Deno.test("OR-T0499: tokenless failed selection gets a clean retry path", async () => {
  const state = failedSelectionState();

  const result = await recoverIncompleteLink(makeRecoveryClient(state), CONNECTION_ID);

  assertEquals(result, { connectionRemoved: true, tokenReleased: true, error: null });
  assertEquals(state.connection, null);
  assertEquals(state.mutations, ["delete connection"]);
});
