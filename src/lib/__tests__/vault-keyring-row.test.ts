/**
 * Tolerant read of the caller's own keyring columns (OR-T0769).
 *
 * The property under test: an undefined column is the ONLY failure that reads
 * as "this project has no keyrings yet". Every other failure, including a real
 * keyring that could not be read, must stop the caller. Treating an owner who
 * holds a keyring as one who does not would grant them under the wrong
 * envelope.
 *
 * Run with:
 *   bunx vitest run src/lib/__tests__/vault-keyring-row.test.ts
 */

import { describe, expect, test } from "vitest";
import {
  KEYRING_ROW_COLUMNS,
  UNDEFINED_COLUMN_CODE,
  readOwnKeyringRow,
  type KeyringRowClient,
} from "../vault-keyring-row";

const USER_ID = "11111111-2222-4333-8444-555555555555";

interface RecordedRead {
  table: string;
  columns: string;
  column: string;
  value: string;
}

type Outcome = () => PromiseLike<{ data: unknown; error: unknown }>;

/** A client that records what was asked and answers with the given outcome. */
function fakeClient(outcome: Outcome, reads: RecordedRead[]): KeyringRowClient {
  return {
    from(table) {
      return {
        select(columns) {
          return {
            eq(column, value) {
              reads.push({ table, columns, column, value });
              return { single: outcome };
            },
          };
        },
      };
    },
  };
}

function answering(data: unknown, error: unknown = null): Outcome {
  return () => Promise.resolve({ data, error });
}

describe("readOwnKeyringRow", () => {
  test("asks for exactly the two keyring columns of the caller's own vault row", async () => {
    const reads: RecordedRead[] = [];
    await readOwnKeyringRow(
      fakeClient(answering({ keyring_ciphertext: null, keyring_epoch: null }), reads),
      USER_ID,
    );

    expect(reads).toEqual([
      {
        table: "user_vault_meta",
        columns: "keyring_ciphertext, keyring_epoch",
        column: "user_id",
        value: USER_ID,
      },
    ]);
    // The constant the app imports is the same string, so the two cannot drift.
    expect(KEYRING_ROW_COLUMNS).toBe("keyring_ciphertext, keyring_epoch");
  });

  test("returns the ciphertext and a numeric epoch when the row has a keyring", async () => {
    const result = await readOwnKeyringRow(
      fakeClient(answering({ keyring_ciphertext: "c2VhbGVk", keyring_epoch: 3 }), []),
      USER_ID,
    );

    expect(result).toEqual({ status: "ok", keyringCiphertext: "c2VhbGVk", keyringEpoch: 3 });
  });

  test("passes a string epoch through, because a bigint column can arrive as text", async () => {
    const result = await readOwnKeyringRow(
      fakeClient(answering({ keyring_ciphertext: "c2VhbGVk", keyring_epoch: "9007199254" }), []),
      USER_ID,
    );

    expect(result).toEqual({
      status: "ok",
      keyringCiphertext: "c2VhbGVk",
      keyringEpoch: "9007199254",
    });
  });

  test("a vault row with no keyring yet is ok with nulls, not an error", async () => {
    const result = await readOwnKeyringRow(
      fakeClient(answering({ keyring_ciphertext: null, keyring_epoch: null }), []),
      USER_ID,
    );

    expect(result).toEqual({ status: "ok", keyringCiphertext: null, keyringEpoch: null });
  });

  test("an undefined column (SQLSTATE 42703) reads as column-absent", async () => {
    expect(UNDEFINED_COLUMN_CODE).toBe("42703");

    const result = await readOwnKeyringRow(
      fakeClient(
        answering(null, {
          code: "42703",
          message: "column user_vault_meta.keyring_ciphertext does not exist",
        }),
        [],
      ),
      USER_ID,
    );

    expect(result).toEqual({ status: "column-absent" });
  });

  test("a denied read (a different Postgres error) is an error, never column-absent", async () => {
    const denied = { code: "42501", message: "permission denied for table user_vault_meta" };
    const result = await readOwnKeyringRow(fakeClient(answering(null, denied), []), USER_ID);

    expect(result.status).toBe("error");
    expect(result).toEqual({ status: "error", error: denied });
  });

  test("error text that merely says a column does not exist is not enough without the code", async () => {
    const lookalike = { message: 'column "keyring_ciphertext" does not exist' };
    const result = await readOwnKeyringRow(fakeClient(answering(null, lookalike), []), USER_ID);

    expect(result).toEqual({ status: "error", error: lookalike });
  });

  test("a rejected request (network failure) comes back as an error and does not throw", async () => {
    const failure = new Error("network down");
    const result = await readOwnKeyringRow(
      fakeClient(() => Promise.reject(failure), []),
      USER_ID,
    );

    expect(result).toEqual({ status: "error", error: failure });
  });

  test("an exception thrown while building the request comes back as an error", async () => {
    const failure = new Error("client not ready");
    const result = await readOwnKeyringRow(
      fakeClient(() => {
        throw failure;
      }, []),
      USER_ID,
    );

    expect(result).toEqual({ status: "error", error: failure });
  });

  test("no error and no row is an error, not a vault without a keyring", async () => {
    const result = await readOwnKeyringRow(fakeClient(answering(null), []), USER_ID);

    expect(result.status).toBe("error");
  });

  test("an answer that is not a row is an error", async () => {
    const result = await readOwnKeyringRow(fakeClient(answering("not a row"), []), USER_ID);

    expect(result.status).toBe("error");
  });
});
