/**
 * Tests for the co-admin wrapped key read in src/lib/co-admin-workspace-read.ts.
 *
 * THE ONE THAT MATTERS is "reports ambiguous, not none, when two rows match".
 * The read this replaces used maybeSingle(), which returns an ERROR on more
 * than one match, and the caller discarded the error and treated the absent row
 * as "no grant". A co-admin's shared workspace then vanished from their list
 * with nothing shown to anybody.
 *
 * The fixture is the red-before-green proof rather than a claim about one: the
 * fake client implements select, eq and limit and NOTHING ELSE. An
 * implementation that reached for maybeSingle() would not merely return the
 * wrong answer, it would throw, so the suite cannot go green on the old shape.
 */

import { describe, it, expect } from "vitest";
import {
  readWrappedDataKey,
  DUPLICATE_WRAPPED_KEY_MESSAGE,
  type WrappedKeyClient,
} from "../co-admin-workspace-read";

type QueryResult = { data: unknown[] | null; error: unknown };

interface RecordedCall {
  table: string;
  columns: string;
  filters: Array<[string, unknown]>;
  limit?: number;
}

interface Chain {
  select(columns: string): Chain;
  eq(column: string, value: unknown): Chain;
  limit(n: number): Promise<QueryResult>;
}

function makeClient(result: QueryResult) {
  const calls: RecordedCall[] = [];
  const client = {
    from(table: string) {
      const call: RecordedCall = { table, columns: "", filters: [] };
      calls.push(call);
      const chain: Chain = {
        select(columns: string) {
          call.columns = columns;
          return chain;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return chain;
        },
        limit(n: number) {
          call.limit = n;
          return Promise.resolve(result);
        },
      };
      return chain;
    },
  };
  return { client: client as unknown as WrappedKeyClient, calls };
}

const oneRow = { wrapped_ciphertext: "wrapped-1", grant_sig: "sig-1" };
const otherRow = { wrapped_ciphertext: "wrapped-2", grant_sig: "sig-2" };

describe("reading a co-admin's wrapped workspace key", () => {
  it("returns the row when exactly one grant matches", async () => {
    const { client } = makeClient({ data: [oneRow], error: null });

    const read = await readWrappedDataKey(client, "key-1");

    expect(read).toEqual({ status: "ok", row: oneRow });
  });

  it("reports ambiguous, not none, when two rows match", async () => {
    // The defect. Two rows used to reach the caller as "no grant" and the
    // workspace silently disappeared from the co-admin's list while the owner
    // still saw them as granted.
    const { client } = makeClient({ data: [oneRow, otherRow], error: null });

    const read = await readWrappedDataKey(client, "key-1");

    expect(read.status).toBe("ambiguous");
    expect(read.status).not.toBe("none");
  });

  it("does not quietly pick one of the two", async () => {
    // Both rows carry a signature binding the grant to this recipient and this
    // key id, so both may verify and nothing here knows which the owner meant.
    // Choosing on a self custody path is the same silent guess as the bug.
    const { client } = makeClient({ data: [oneRow, otherRow], error: null });

    const read = await readWrappedDataKey(client, "key-1");

    expect(read).not.toHaveProperty("row");
  });

  it("returns none when there is genuinely no grant", async () => {
    const { client } = makeClient({ data: [], error: null });

    expect(await readWrappedDataKey(client, "key-1")).toEqual({ status: "none" });
  });

  it("treats a null result set as none rather than throwing", async () => {
    const { client } = makeClient({ data: null, error: null });

    expect(await readWrappedDataKey(client, "key-1")).toEqual({ status: "none" });
  });

  it("returns the error instead of discarding it", async () => {
    // The inline read destructured only `data`, so every read failure looked
    // exactly like an absent grant.
    const failure = { message: "read failed" };
    const { client } = makeClient({ data: null, error: failure });

    expect(await readWrappedDataKey(client, "key-1")).toEqual({
      status: "error",
      error: failure,
    });
  });

  it("asks for at most two rows, which is what separates one from many", async () => {
    const { client, calls } = makeClient({ data: [oneRow], error: null });

    await readWrappedDataKey(client, "key-1");

    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("wrapped_data_keys");
    expect(calls[0].columns).toBe("wrapped_ciphertext, grant_sig");
    expect(calls[0].filters).toEqual([["data_key_id", "key-1"]]);
    // One row would make "more than one" unreachable. Anything larger reads
    // rows nothing needs.
    expect(calls[0].limit).toBe(2);
  });

  it("has a duplicate message that names the state and gives an action", async () => {
    // A message that only apologises leaves the user with nowhere to go, and
    // this state does not clear itself.
    expect(DUPLICATE_WRAPPED_KEY_MESSAGE).toContain("more than one key grant");
    expect(DUPLICATE_WRAPPED_KEY_MESSAGE).toContain("Ask the owner");
  });
});
