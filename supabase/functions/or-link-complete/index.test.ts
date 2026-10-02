/**
 * Recovery tests for OR-T0499.
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-link-complete/index.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.env.set("OR_ACCT_FINGERPRINT_KEY_V1", "or-link-complete-recovery-test-key");

const { recoverIncompleteLink } = await import("./index.ts");

// ---------------------------------------------------------------------------
// Minimal test doubles
// ---------------------------------------------------------------------------

interface RecoveryState {
  connection: { id: string; status: "pending" | "active" } | null;
  token: { id: string; used_at: string | null };
  failConnectionDelete?: boolean;
  failTokenRelease?: boolean;
  mutations: string[];
}

function makeRecoveryClient(state: RecoveryState): any {
  return {
    from(table: string) {
      if (table === "connections") {
        return {
          delete() {
            return {
              eq(_col: string, _val: string) {
                return this;
              },
              select(_cols: string) {
                return {
                  maybeSingle: async () => {
                    if (state.failConnectionDelete) {
                      return { data: null, error: { message: "db error" } };
                    }
                    if (!state.connection || state.connection.status !== "pending") {
                      return { data: null, error: null };
                    }
                    state.mutations.push("connection_deleted");
                    state.connection = null;
                    return { data: { id: CONNECTION_ID }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "pending_widget_sessions") {
        return {
          update(_vals: Record<string, null>) {
            return {
              eq(_col: string, _val: string) {
                return this;
              },
              not(_col: string, _op: string, _val: null) {
                return this;
              },
              select(_cols: string) {
                return {
                  maybeSingle: async () => {
                    if (state.failTokenRelease) {
                      return { data: null, error: { message: "db error" } };
                    }
                    if (state.token.used_at === null) {
                      return { data: null, error: null };
                    }
                    state.mutations.push("token_released");
                    state.token.used_at = null;
                    return { data: { id: TOKEN_ID }, error: null };
                  },
                };
              },
            };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

const CONNECTION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const TOKEN_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function failedSelectionState(): RecoveryState {
  return {
    connection: { id: CONNECTION_ID, status: "pending" },
    token: { id: TOKEN_ID, used_at: new Date().toISOString() },
    mutations: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("OR-T0499: failed selection is removed and the same token can retry", async () => {
  const state = failedSelectionState();
  const client = makeRecoveryClient(state);
  const result = await recoverIncompleteLink(client, CONNECTION_ID, TOKEN_ID);

  assertEquals(result.connectionRemoved, true);
  assertEquals(result.tokenReleased, true);
  assertEquals(result.error, null);
  assertEquals(state.connection, null);
  assertEquals(state.token.used_at, null);
  assertEquals(state.mutations, ["connection_deleted", "token_released"]);
});

Deno.test("OR-T0499: cleanup failure leaves an explicit pending row and keeps token spent", async () => {
  const state = failedSelectionState();
  state.failConnectionDelete = true;
  const client = makeRecoveryClient(state);
  const result = await recoverIncompleteLink(client, CONNECTION_ID, TOKEN_ID);

  assertEquals(result.connectionRemoved, false);
  assertEquals(result.tokenReleased, false);
  assertEquals(typeof result.error, "string");
  // connection row must still exist so the caller can surface connection_id
  assertEquals(state.connection?.status, "pending");
  // token must still be spent so a duplicate session cannot be opened
  assertEquals(typeof state.token.used_at, "string");
  assertEquals(state.mutations, []);
});

Deno.test("OR-T0499: recovery cannot delete a connection that is already active", async () => {
  const state = failedSelectionState();
  state.connection!.status = "active";
  const client = makeRecoveryClient(state);
  const result = await recoverIncompleteLink(client, CONNECTION_ID, TOKEN_ID);

  // status guard on the delete means no row is matched
  assertEquals(result.connectionRemoved, false);
  assertEquals(result.error, "connection rollback affected no pending row");
  // active connection must be untouched
  assertEquals(state.connection?.status, "active");
  assertEquals(state.mutations, []);
});

Deno.test("OR-T0499: token-release failure still leaves a clean connection retry", async () => {
  const state = failedSelectionState();
  state.failTokenRelease = true;
  const client = makeRecoveryClient(state);
  const result = await recoverIncompleteLink(client, CONNECTION_ID, TOKEN_ID);

  // Connection was removed so there is no duplicate risk
  assertEquals(result.connectionRemoved, true);
  assertEquals(result.tokenReleased, false);
  assertEquals(typeof result.error, "string");
  assertEquals(state.connection, null);
  // Token remains spent: caller must treat retryable=false
  assertEquals(typeof state.token.used_at, "string");
  assertEquals(state.mutations, ["connection_deleted"]);
});

Deno.test("OR-T0499: tokenless failed selection gets a clean retry path", async () => {
  const state = failedSelectionState();
  const client = makeRecoveryClient(state);
  // Call without a widget token (legacy path)
  const result = await recoverIncompleteLink(client, CONNECTION_ID);

  assertEquals(result.connectionRemoved, true);
  // tokenReleased is true because there was nothing to release
  assertEquals(result.tokenReleased, true);
  assertEquals(result.error, null);
  assertEquals(state.connection, null);
  // No token mutation should have been attempted
  assertEquals(state.mutations, ["connection_deleted"]);
});
