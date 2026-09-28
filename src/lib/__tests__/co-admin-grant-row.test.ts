/**
 * Tests for src/lib/co-admin-grant-row.ts
 *
 * These are shape tests, not crypto tests. No Supabase, no network, no keys.
 *
 * What they are defending. Migration 20260828183000 drops NOT NULL on
 * public.wrapped_data_keys.wrapped_ciphertext so an envelope v3 grant can
 * carry wrapped_cak and coadmin_keyring_ciphertext instead. Before this
 * module the co-admin workspace loader cast that column to string with the
 * row existing as its only guard, so a v3 row would have put null into a
 * field typed string and carried it into the consume path.
 *
 * The load bearing assertions are therefore the negative ones: a v3 row must
 * not come back with a wrappedCiphertextB64 property at all, and anything
 * that is not exactly one complete envelope must come back as null.
 */

import { describe, it, expect } from "vitest";
import {
  CO_ADMIN_GRANT_COLUMNS,
  readCoAdminGrant,
  type CoAdminGrant,
} from "../co-admin-grant-row";

/** Grant ids as PostgREST returns a uuid column: lowercase and canonical. */
const V2_GRANT_ID = "0b7d3a52-1c64-4e9f-8d21-5a6e7f8091b2";
const V3_GRANT_ID = "6f1c1e0a-7d5b-4c1e-9a52-3b8f2d4a9c10";

/** A v2 grant row as the database returns it after the migration. */
function v2Row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: V2_GRANT_ID,
    wrapped_ciphertext: "d3JhcHBlZC1ibG9iLTY0",
    grant_sig: "c2ln",
    wrapped_cak: null,
    coadmin_keyring_ciphertext: null,
    ...overrides,
  };
}

/** A v3 grant row: no 64 byte blob, a wrapped co-admin key and a keyring. */
function v3Row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: V3_GRANT_ID,
    wrapped_ciphertext: null,
    grant_sig: "c2ln",
    wrapped_cak: "d3JhcHBlZC1jYWs",
    coadmin_keyring_ciphertext: "c2VhbGVkLWtleXJpbmc",
    ...overrides,
  };
}

describe("readCoAdminGrant", () => {
  it("reads a v2 row as version 2 and carries the wrapped blob", () => {
    const grant = readCoAdminGrant(v2Row());
    expect(grant).not.toBeNull();
    expect(grant?.version).toBe(2);
    if (grant?.version !== 2) throw new Error("expected a v2 grant");
    expect(grant.wrappedCiphertextB64).toBe("d3JhcHBlZC1ibG9iLTY0");
    expect(grant.grantSigB64).toBe("c2ln");
  });

  it("reads a v3 row as version 3 and carries both halves", () => {
    const grant = readCoAdminGrant(v3Row());
    expect(grant).not.toBeNull();
    expect(grant?.version).toBe(3);
    if (grant?.version !== 3) throw new Error("expected a v3 grant");
    expect(grant.grantId).toBe(V3_GRANT_ID);
    expect(grant.wrappedCakB64).toBe("d3JhcHBlZC1jYWs");
    expect(grant.coadminKeyringCiphertextB64).toBe("c2VhbGVkLWtleXJpbmc");
    expect(grant.grantSigB64).toBe("c2ln");
  });

  it("never carries a null wrapped_ciphertext forward as a string", () => {
    // The whole point of the module. A v3 row has wrapped_ciphertext null, and
    // the returned grant must not carry that field at all, as a string or
    // otherwise, so nothing downstream can read it as one.
    const grant = readCoAdminGrant(v3Row()) as CoAdminGrant;
    expect(grant).not.toBeNull();
    expect(Object.keys(grant)).not.toContain("wrappedCiphertextB64");
    expect("wrappedCiphertextB64" in grant).toBe(false);
  });

  it("refuses a grant row that carries no key material at all", () => {
    const empty = v2Row({ wrapped_ciphertext: null });
    expect(readCoAdminGrant(empty)).toBeNull();
  });

  it("refuses a half written v3 row", () => {
    expect(readCoAdminGrant(v3Row({ coadmin_keyring_ciphertext: null }))).toBeNull();
    expect(readCoAdminGrant(v3Row({ wrapped_cak: null }))).toBeNull();
  });

  it("refuses a v3 row that has no usable id", () => {
    // The sealed keyring is bound to the row id, so a v3 row without one cannot
    // be opened. Refusing here keeps that from surfacing later as an
    // authentication failure that looks like a wrong key.
    expect(readCoAdminGrant(v3Row({ id: null }))).toBeNull();
    expect(readCoAdminGrant(v3Row({ id: undefined }))).toBeNull();
    expect(readCoAdminGrant(v3Row({ id: "" }))).toBeNull();
    expect(readCoAdminGrant(v3Row({ id: 42 }))).toBeNull();
  });

  it("does not need an id to read a v2 row", () => {
    // A v2 grant is not bound to its row id, so a missing id must not change
    // how one reads.
    const grant = readCoAdminGrant(v2Row({ id: null }));
    expect(grant?.version).toBe(2);
    expect(grant !== null && "grantId" in grant).toBe(false);
  });

  it("refuses a row carrying both envelopes at once", () => {
    // The database permits this: the presence rule only asks for at least one
    // of the two key columns. No writer produces it, so we do not guess which
    // half to trust.
    const both = v3Row({ wrapped_ciphertext: "d3JhcHBlZC1ibG9iLTY0" });
    expect(readCoAdminGrant(both)).toBeNull();
  });

  it("treats an empty string as absent, not as key material", () => {
    expect(readCoAdminGrant(v2Row({ wrapped_ciphertext: "" }))).toBeNull();
    expect(readCoAdminGrant(v3Row({ wrapped_cak: "" }))).toBeNull();
  });

  it("treats a non string value as absent", () => {
    expect(readCoAdminGrant(v2Row({ wrapped_ciphertext: 42 }))).toBeNull();
    expect(readCoAdminGrant(v2Row({ wrapped_ciphertext: { blob: "x" } }))).toBeNull();
  });

  it("refuses anything that is not a row", () => {
    expect(readCoAdminGrant(null)).toBeNull();
    expect(readCoAdminGrant(undefined)).toBeNull();
    expect(readCoAdminGrant("wrapped_ciphertext")).toBeNull();
    expect(readCoAdminGrant(7)).toBeNull();
  });

  it("carries a missing grant signature through instead of hiding the row", () => {
    // A missing signature is a broken row, not an optional field. The consume
    // path refuses to decrypt without one, and that refusal is louder and more
    // useful than a workspace that quietly never appears.
    const grant = readCoAdminGrant(v2Row({ grant_sig: null }));
    expect(grant).not.toBeNull();
    expect(grant?.version).toBe(2);
    expect(grant?.grantSigB64).toBeNull();
  });

  it("does not let the algorithm string decide the envelope version", () => {
    // The migration comment on wrapped_ciphertext is explicit: the algorithm
    // column names the version by convention only, nothing in the database
    // enforces it, and nothing may be added that does. So a row whose
    // algorithm string disagrees with its columns is read by its columns.
    const v2ColumnsV3Algorithm = v2Row({ algorithm: "coadmin-keyring-v3" });
    expect(readCoAdminGrant(v2ColumnsV3Algorithm)?.version).toBe(2);

    const v3ColumnsV2Algorithm = v3Row({ algorithm: "hybrid-x25519-mlkem768-blob64" });
    expect(readCoAdminGrant(v3ColumnsV2Algorithm)?.version).toBe(3);
  });
});

describe("CO_ADMIN_GRANT_COLUMNS", () => {
  it("asks for every column the shape rule reads", () => {
    // A select that omits wrapped_cak makes every v3 grant look like an empty
    // row, and one that omits id makes every v3 grant unreadable, because the
    // sealed keyring is bound to the row id. The reader would then correctly
    // but uselessly refuse both. Compare whole column names: a substring check
    // for "id" would also pass on any longer name that happens to contain it.
    const selected = CO_ADMIN_GRANT_COLUMNS.split(",").map((column) => column.trim());
    for (const column of [
      "id",
      "wrapped_ciphertext",
      "grant_sig",
      "wrapped_cak",
      "coadmin_keyring_ciphertext",
    ]) {
      expect(selected).toContain(column);
    }
  });
});
