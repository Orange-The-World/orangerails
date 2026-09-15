// @vitest-environment jsdom
//
// OR-T1934 step 7: changeVaultPassword must assert the two freshly built
// envelopes (password + recovery) re-open to the same MEK bytes BEFORE it
// ever returns them to the caller, not only after the caller has persisted
// them. See src/lib/vault.ts assertMekEnvelopeReopens and PR #1225, which
// shipped the POST-write half of this and explicitly deferred the pre-write
// half to its own ticket.
//
// The failure path is driven by mocking assertMekEnvelopeReopens itself
// (partial mock of @/lib/vault, every other export is the real
// implementation) rather than trying to make real WebCrypto produce a
// corrupt envelope, which nothing in this function's normal operation can
// do. That mirrors how PR #1225's own tests drove their failure path: by
// injecting a wrong ciphertext, not by breaking AES-GCM.
//
// changeVaultPassword never imports or calls persistRewrappedVaultMeta --
// only its caller (src/routes/app.tsx) does, once changeVaultPassword has
// resolved. So the acceptance criterion "persistRewrappedVaultMeta was
// never called" is what it means for changeVaultPassword to reject instead
// of resolving: the caller has nothing to persist, because
// newEncMekCiphertext / newRecoveryCiphertext never left this function.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { VaultProvider, useVault } from "./VaultContext";
import {
  generateVaultSalt,
  generateMekBytes,
  deriveKek,
  wrapMekBytes,
  importMekAsHkdf,
  createVaultVerifier,
  CURRENT_VAULT_KEY_VERSION,
  assertMekEnvelopeReopens,
} from "@/lib/vault";
import { deriveVerifierKey } from "@/lib/key-derivation";
import { persistRewrappedVaultMeta } from "@/lib/vault-persist";

vi.mock("@/lib/vault", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault")>();
  return {
    ...actual,
    assertMekEnvelopeReopens: vi.fn(actual.assertMekEnvelopeReopens),
  };
});

vi.mock("@/lib/vault-persist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/vault-persist")>();
  return {
    ...actual,
    persistRewrappedVaultMeta: vi.fn(),
  };
});

const mockedAssert = vi.mocked(assertMekEnvelopeReopens);
const mockedPersist = vi.mocked(persistRewrappedVaultMeta);

const CURRENT_PASSWORD = "xk4$Qzrmw9!bLpVt2h";
const NEW_PASSWORD = "gT7*wRnq83@FjDsY5m";

/** Builds a real (non-mocked) v2 vault fixture using the actual crypto primitives. */
async function buildStoredVault(password: string) {
  const storedSaltB64 = generateVaultSalt();
  const mekRaw = generateMekBytes();
  const kek = await deriveKek(password, storedSaltB64);
  const storedEncMekCiphertext = await wrapMekBytes(mekRaw, kek);
  const mek = await importMekAsHkdf(mekRaw);
  const verifierKey = await deriveVerifierKey(mek, storedSaltB64);
  const storedVerifierCiphertext = await createVaultVerifier(verifierKey);
  return { storedSaltB64, storedEncMekCiphertext, storedVerifierCiphertext };
}

describe("changeVaultPassword pre-write envelope check (OR-T1934 step 7)", () => {
  beforeEach(async () => {
    // vi.fn(actual.assertMekEnvelopeReopens) in the factory already makes the
    // real implementation the default; mockClear() drops call history and any
    // one-off override from a PRIOR test without touching that default.
    mockedAssert.mockClear();
    const actual = await vi.importActual<typeof import("@/lib/vault")>("@/lib/vault");
    mockedAssert.mockImplementation(actual.assertMekEnvelopeReopens);
    mockedPersist.mockClear();
    mockedPersist.mockResolvedValue(undefined);
  });

  it("resolves normally when both freshly built envelopes re-open cleanly (control case)", async () => {
    const stored = await buildStoredVault(CURRENT_PASSWORD);
    const { result } = renderHook(() => useVault(), { wrapper: VaultProvider });

    let resolved: Awaited<ReturnType<typeof result.current.changeVaultPassword>> | undefined;
    await act(async () => {
      resolved = await result.current.changeVaultPassword({
        currentPassword: CURRENT_PASSWORD,
        newPassword: NEW_PASSWORD,
        storedSaltB64: stored.storedSaltB64,
        storedEncMekCiphertext: stored.storedEncMekCiphertext,
        storedVerifierCiphertext: stored.storedVerifierCiphertext,
        keyVersion: CURRENT_VAULT_KEY_VERSION,
      });
    });

    expect(resolved?.newEncMekCiphertext).toBeTruthy();
    expect(resolved?.newRecoveryCiphertext).toBeTruthy();
    // Pre-write check ran for both envelopes; verifyPersistedEnvelopes (the
    // post-write check) was returned but not invoked by changeVaultPassword
    // itself, so exactly 2 calls at this point.
    expect(mockedAssert).toHaveBeenCalledTimes(2);
  });

  it("throws before returning when the freshly built PASSWORD envelope fails to re-open, and never builds a caller-usable result", async () => {
    const stored = await buildStoredVault(CURRENT_PASSWORD);
    const { result } = renderHook(() => useVault(), { wrapper: VaultProvider });

    mockedAssert.mockImplementationOnce(async (what: string) => {
      throw new Error(`${what} could not be re-opened with the key that wrapped it.`);
    });

    let caught: unknown;
    let resolvedValue: unknown;
    await act(async () => {
      try {
        resolvedValue = await result.current.changeVaultPassword({
          currentPassword: CURRENT_PASSWORD,
          newPassword: NEW_PASSWORD,
          storedSaltB64: stored.storedSaltB64,
          storedEncMekCiphertext: stored.storedEncMekCiphertext,
          storedVerifierCiphertext: stored.storedVerifierCiphertext,
          keyVersion: CURRENT_VAULT_KEY_VERSION,
        });
      } catch (ex) {
        caught = ex;
      }
    });

    expect(resolvedValue).toBeUndefined();
    expect((caught as Error)?.message).toMatch(/freshly built password key envelope/);
    // Only the first (password) assertion ran; the function threw before
    // reaching the recovery-envelope check.
    expect(mockedAssert).toHaveBeenCalledTimes(1);
  });

  it("throws before returning when the freshly built RECOVERY envelope fails to re-open", async () => {
    const stored = await buildStoredVault(CURRENT_PASSWORD);
    const { result } = renderHook(() => useVault(), { wrapper: VaultProvider });

    // mockImplementationOnce queues FIFO against call order, so the first
    // queued entry must cover call 1 (password envelope, must succeed for
    // real) before the second queued entry covers call 2 (recovery
    // envelope, forced to fail) -- otherwise the "once" override lands on
    // the wrong call.
    const actual = await vi.importActual<typeof import("@/lib/vault")>("@/lib/vault");
    mockedAssert.mockImplementationOnce(actual.assertMekEnvelopeReopens);
    mockedAssert.mockImplementationOnce(async (what: string) => {
      throw new Error(`${what} re-opened to different key material than it was given.`);
    });

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.changeVaultPassword({
          currentPassword: CURRENT_PASSWORD,
          newPassword: NEW_PASSWORD,
          storedSaltB64: stored.storedSaltB64,
          storedEncMekCiphertext: stored.storedEncMekCiphertext,
          storedVerifierCiphertext: stored.storedVerifierCiphertext,
          keyVersion: CURRENT_VAULT_KEY_VERSION,
        });
      } catch (ex) {
        caught = ex;
      }
    });

    expect((caught as Error)?.message).toMatch(/freshly built recovery code envelope/);
    expect(mockedAssert).toHaveBeenCalledTimes(2);
  });

  it("never calls persistRewrappedVaultMeta when changeVaultPassword rejects on a bad envelope (acceptance: OR-T1947/OR-T1934 step 7)", async () => {
    const stored = await buildStoredVault(CURRENT_PASSWORD);
    const { result } = renderHook(() => useVault(), { wrapper: VaultProvider });

    mockedAssert.mockImplementationOnce(async (what: string) => {
      throw new Error(`${what} could not be re-opened with the key that wrapped it.`);
    });

    // Mirrors src/routes/app.tsx's change-password submit handler verbatim:
    // await changeVaultPassword(...) first, then await persistRewrappedVaultMeta(...)
    // with the values it returned. If changeVaultPassword rejects, this second
    // call must never happen -- there is nothing safe to persist yet.
    let caught: unknown;
    await act(async () => {
      try {
        const { newEncMekCiphertext, newRecoveryCiphertext, verifyPersistedEnvelopes } =
          await result.current.changeVaultPassword({
            currentPassword: CURRENT_PASSWORD,
            newPassword: NEW_PASSWORD,
            storedSaltB64: stored.storedSaltB64,
            storedEncMekCiphertext: stored.storedEncMekCiphertext,
            storedVerifierCiphertext: stored.storedVerifierCiphertext,
            keyVersion: CURRENT_VAULT_KEY_VERSION,
          });
        await persistRewrappedVaultMeta({
          supabase: {} as never,
          userId: "test-user",
          priorEncMekCiphertext: stored.storedEncMekCiphertext,
          newEncMekCiphertext,
          newRecoveryCiphertext,
          verifyPersisted: verifyPersistedEnvelopes,
        });
      } catch (ex) {
        caught = ex;
      }
    });

    expect((caught as Error)?.message).toMatch(/freshly built password key envelope/);
    expect(mockedPersist).not.toHaveBeenCalled();
  });
});
