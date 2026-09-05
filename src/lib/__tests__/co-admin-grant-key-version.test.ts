/**
 * The co-admin grant must build its subkeys from the vault's MEK.
 *
 * WHY THIS FILE EXISTS. A key-version-2 vault has a random MEK, and the vault
 * password only produces the KEK that wraps it. A grant that runs HKDF over
 * the password-derived value therefore hands the recipient two subkeys that
 * decrypt nothing, and tries to unwrap the owner's ML-DSA signing secret with
 * a key that secret was never wrapped under. Every vault created by setupVault
 * is key-version 2.
 *
 * WHAT IS ACTUALLY PROVED HERE. The fixtures are built with the product's own
 * functions, in the order setupVault and ensurePqcKeypairs build them, so a
 * pass cannot come from the test agreeing with a mistake in its own setup. The
 * grant then runs against a recording Supabase stub, so this reports what the
 * code did rather than what it looks like it does, and it reports the order of
 * the writes as well as the outcome: a grant that stops half way leaves a
 * co-admin listed with nothing to open, which is worse than one that refuses.
 *
 * The version-1 fixture is the regression guard. Subkeys granted before this
 * change must stay byte-identical, or every existing grant stops opening
 * anything.
 */

import { describe, it, expect } from "vitest";
import { grantCoAdmin, unwrapBlob64 } from "../co-admin";
import type { CoAdminSupabaseLike } from "../co-admin";
import {
  createVaultVerifier,
  deriveKek,
  deriveMEK,
  generateMekBytes,
  importMekAsHkdf,
  wrapMekBytes,
} from "../vault";
import {
  deriveSubkey,
  derivePqcSecretWrapKey,
  deriveVerifierKey,
  HKDF_CONTEXTS,
} from "../key-derivation";
import { buildPqcKeyMaterial, unwrapPqcSecretKey } from "../pqc-lifecycle";
import { generateHybridKemKeyPair } from "../pqc";
import { base64ToBytes } from "../key-wrapping";

// Argon2id runs several times per test. The default 5s timeout is not enough
// and a timeout here would read as a failure of the thing under test.
const ARGON2_TIMEOUT_MS = 120_000;

const OWNER_PASSWORD = "co-admin-grant-fixture-7!";
const OWNER_USER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_USER_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_KEY_ID = "33333333-3333-4333-8333-333333333333";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function randomSaltB64(): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/** Raw bytes of a subkey as the DATA path derives it, for byte comparison. */
async function dataPathSubkeyBytes(
  mek: CryptoKey,
  context: (typeof HKDF_CONTEXTS)[keyof typeof HKDF_CONTEXTS],
  saltB64: string,
): Promise<Uint8Array> {
  const key = await deriveSubkey(mek, context, saltB64);
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

interface OwnerVault {
  keyVersion: number;
  saltB64: string;
  mek: CryptoKey;
  encMekCiphertext: string | null;
  verifierCiphertext: string;
  sigSecretWrapped: string;
}

/**
 * Build an owner vault exactly the way the product builds one.
 *
 * Version 2 is what setupVault produces: a random MEK, wrapped by the
 * Argon2id-derived KEK. Version 1 is the legacy shape, where the Argon2id
 * output IS the MEK. In both, the PQC secrets are wrapped under a subkey of
 * whatever the MEK is, which is what ensurePqcKeypairs does.
 */
async function buildOwnerVault(password: string, keyVersion: 1 | 2): Promise<OwnerVault> {
  const saltB64 = randomSaltB64();

  let mek: CryptoKey;
  let encMekCiphertext: string | null = null;

  if (keyVersion === 2) {
    const mekRaw = generateMekBytes();
    mek = await importMekAsHkdf(mekRaw);
    const kek = await deriveKek(password, saltB64);
    encMekCiphertext = await wrapMekBytes(mekRaw, kek);
  } else {
    mek = await deriveMEK(password, saltB64);
  }

  const verifierCiphertext = await createVaultVerifier(await deriveVerifierKey(mek, saltB64));
  const pqc = await buildPqcKeyMaterial(await derivePqcSecretWrapKey(mek, saltB64));

  return {
    keyVersion,
    saltB64,
    mek,
    encMekCiphertext,
    verifierCiphertext,
    sigSecretWrapped: pqc.sig_secret_wrapped,
  };
}

interface InsertedRow {
  table: string;
  row: Record<string, unknown>;
}

interface Recorder {
  calls: string[];
  inserts: InsertedRow[];
}

/**
 * A Supabase stub that answers the allocate RPC and records every call in the
 * order it arrives. A delete or a select is a failure: the grant flow has no
 * business making one, and silently tolerating it would hide a real change.
 */
function recordingSupabase(): { supabase: CoAdminSupabaseLike; recorder: Recorder } {
  const recorder: Recorder = { calls: [], inserts: [] };

  const supabase = {
    from(table: string) {
      return {
        select(columns: string) {
          recorder.calls.push(`select ${table}(${columns})`);
          throw new Error(`unexpected select on ${table} during grant`);
        },
        insert(row: Record<string, unknown>) {
          recorder.calls.push(`insert ${table}`);
          recorder.inserts.push({ table, row });
          return Promise.resolve({ data: [row], error: null });
        },
        delete() {
          recorder.calls.push(`delete ${table}`);
          throw new Error(`unexpected delete on ${table} during grant`);
        },
      };
    },
    rpc(fn: string) {
      recorder.calls.push(`rpc ${fn}`);
      return Promise.resolve({ data: WORKSPACE_KEY_ID, error: null });
    },
  };

  return { supabase: supabase as unknown as CoAdminSupabaseLike, recorder };
}

type GrantRun =
  | { outcome: "completed"; workspaceKeyId: string; recorder: Recorder }
  | { outcome: "threw"; errorName: string; errorMessage: string; recorder: Recorder };

/**
 * Run the real grant against a fixture and report what happened, including
 * what had already been written when it stopped. Nothing here asserts: the
 * caller decides what the record means.
 */
async function runGrant(
  vault: OwnerVault,
  targetKemPubB64: string,
  password: string = OWNER_PASSWORD,
): Promise<GrantRun> {
  const { supabase, recorder } = recordingSupabase();

  // The fixed signature takes the unlocked MEK and the fields needed to
  // confirm the owner's password without deriving key material from it. The
  // cast keeps this one file compiling against the signature before the fix
  // and the signature after it, so the file that is red here is the same file
  // that is green later.
  const params = {
    ownerUserId: OWNER_USER_ID,
    ownerSaltB64: vault.saltB64,
    ownerPassword: password,
    ownerVerifierCiphertext: vault.verifierCiphertext,
    ownerKeyVersion: vault.keyVersion,
    ownerEncMekCiphertext: vault.encMekCiphertext,
    vaultMek: vault.mek,
    ownerSigSecretWrapped: vault.sigSecretWrapped,
    targetUserId: TARGET_USER_ID,
    targetKemPubB64,
    existingKeyId: null,
    supabase,
  } as unknown as Parameters<typeof grantCoAdmin>[0];

  try {
    const result = await grantCoAdmin(params);
    return { outcome: "completed", workspaceKeyId: result.workspaceKeyId, recorder };
  } catch (err) {
    return {
      outcome: "threw",
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
      recorder,
    };
  }
}

function describeRun(run: GrantRun): string {
  const calls = run.recorder.calls.length > 0 ? run.recorder.calls.join(" -> ") : "(none)";
  const head =
    run.outcome === "threw"
      ? `THREW ${run.errorName}: ${run.errorMessage}`
      : `COMPLETED with workspaceKeyId ${run.workspaceKeyId}`;
  return `${head} | supabase calls in order: ${calls} | rows written: ${run.recorder.inserts.length}`;
}

/**
 * Read the granted subkeys back out the way the recipient does, so the
 * comparison is against what the co-admin would really hold.
 */
async function grantedSubkeys(
  recorder: Recorder,
  targetSecretKey: Uint8Array,
): Promise<{ creds: Uint8Array; txns: Uint8Array }> {
  const wrappedRow = recorder.inserts.find((i) => i.table === "wrapped_data_keys");
  if (!wrappedRow) throw new Error("no wrapped_data_keys row was written");
  const wrappedCt = wrappedRow.row.wrapped_ciphertext as string;
  const blob = await unwrapBlob64(base64ToBytes(wrappedCt), targetSecretKey);
  return { creds: blob.slice(0, 32), txns: blob.slice(32, 64) };
}

// ------------------------------------------------------------------
// The record: what the grant does on a vault the product actually creates.
// ------------------------------------------------------------------

describe("co-admin grant on a key-version-2 vault", () => {
  it(
    "either refuses cleanly or completes, and never leaves a half-written grant",
    async () => {
      const vault = await buildOwnerVault(OWNER_PASSWORD, 2);
      const target = generateHybridKemKeyPair();
      const run = await runGrant(vault, bytesToBase64(target.publicKey));

      if (run.outcome === "threw") {
        // Refusing is acceptable. Refusing AFTER writing a row is not: the
        // owner would be left with a co-admin in their list holding no key,
        // or a key row for someone their list does not show.
        expect(run.recorder.inserts, describeRun(run)).toHaveLength(0);
        return;
      }

      // The write order belongs to persistCoAdminGrant and is not this test's
      // to choose: the list row goes first and the wrapped key second, so a
      // stop between them leaves a co-admin who is listed and holds nothing,
      // rather than one who holds a usable key while appearing nowhere. This
      // assertion is here to catch a silent change to that order, so it is
      // pinned to the order that module documents and argues for.
      expect(run.recorder.calls, describeRun(run)).toEqual([
        "rpc allocate_workspace_key",
        "insert workspace_admins",
        "insert wrapped_data_keys",
      ]);
    },
    ARGON2_TIMEOUT_MS,
  );

  it(
    "grants the same subkeys the owner's own data path uses",
    async () => {
      const vault = await buildOwnerVault(OWNER_PASSWORD, 2);
      const target = generateHybridKemKeyPair();
      const run = await runGrant(vault, bytesToBase64(target.publicKey));

      if (run.outcome !== "completed") {
        throw new Error(
          `The grant did not complete on a key-version-2 vault, which is the shape setupVault ` +
            `creates. Recorded: ${describeRun(run)}`,
        );
      }

      const granted = await grantedSubkeys(run.recorder, target.secretKey);
      const expectedCreds = await dataPathSubkeyBytes(
        vault.mek,
        HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1,
        vault.saltB64,
      );
      const expectedTxns = await dataPathSubkeyBytes(
        vault.mek,
        HKDF_CONTEXTS.ORANGERAILS_TRANSACTIONS_V1,
        vault.saltB64,
      );

      // Byte equality, not "it decrypts something". A subkey that is close is
      // a subkey that opens nothing.
      expect(Array.from(granted.creds)).toEqual(Array.from(expectedCreds));
      expect(Array.from(granted.txns)).toEqual(Array.from(expectedTxns));
    },
    ARGON2_TIMEOUT_MS,
  );

  it(
    "refuses when the owner cannot produce the vault password",
    async () => {
      const vault = await buildOwnerVault(OWNER_PASSWORD, 2);
      const target = generateHybridKemKeyPair();
      const run = await runGrant(vault, bytesToBase64(target.publicKey), "not-the-password-9!");

      expect(run.outcome, describeRun(run)).toBe("threw");
      expect(run.recorder.inserts, describeRun(run)).toHaveLength(0);
    },
    ARGON2_TIMEOUT_MS,
  );

  it(
    "records what the password-derived key material does here: it opens nothing",
    async () => {
      // The defect this change removes, kept as a standing record rather than
      // as a sentence in a comment. The grant used to run HKDF over the
      // Argon2id stretch of the password. On a vault of the shape setupVault
      // creates, that value is the KEK which WRAPS the master key, so the wrap
      // key it produces is not the one the owner's PQC secrets were wrapped
      // under, and the ML-DSA signing secret does not come back at all.
      const vault = await buildOwnerVault(OWNER_PASSWORD, 2);

      // deriveMEK is the Argon2id stretch imported as an HKDF key, which is
      // exactly the key material the grant used to build its subkeys from.
      const passwordStretch = await deriveMEK(OWNER_PASSWORD, vault.saltB64);
      const wrongWrapKey = await derivePqcSecretWrapKey(passwordStretch, vault.saltB64);
      await expect(
        unwrapPqcSecretKey(wrongWrapKey, vault.sigSecretWrapped),
      ).rejects.toBeTruthy();

      // And the key the vault really holds does open it. Without this half the
      // line above would also pass against a fixture that is simply unreadable,
      // which would prove nothing about where the key material came from.
      const rightWrapKey = await derivePqcSecretWrapKey(vault.mek, vault.saltB64);
      const secret = await unwrapPqcSecretKey(rightWrapKey, vault.sigSecretWrapped);
      expect(new Uint8Array(secret as unknown as ArrayBuffer).byteLength).toBeGreaterThan(0);
    },
    ARGON2_TIMEOUT_MS,
  );
});

// ------------------------------------------------------------------
// The regression guard: grants issued before this change must stay valid.
// ------------------------------------------------------------------

describe("co-admin grant on a legacy key-version-1 vault", () => {
  it(
    "still grants the same subkeys the owner's own data path uses",
    async () => {
      const vault = await buildOwnerVault(OWNER_PASSWORD, 1);
      const target = generateHybridKemKeyPair();
      const run = await runGrant(vault, bytesToBase64(target.publicKey));

      if (run.outcome !== "completed") {
        throw new Error(`A legacy vault grant must keep working. Recorded: ${describeRun(run)}`);
      }

      const granted = await grantedSubkeys(run.recorder, target.secretKey);
      const expectedCreds = await dataPathSubkeyBytes(
        vault.mek,
        HKDF_CONTEXTS.ORANGERAILS_CREDENTIALS_V1,
        vault.saltB64,
      );
      const expectedTxns = await dataPathSubkeyBytes(
        vault.mek,
        HKDF_CONTEXTS.ORANGERAILS_TRANSACTIONS_V1,
        vault.saltB64,
      );

      expect(Array.from(granted.creds)).toEqual(Array.from(expectedCreds));
      expect(Array.from(granted.txns)).toEqual(Array.from(expectedTxns));
    },
    ARGON2_TIMEOUT_MS,
  );
});
