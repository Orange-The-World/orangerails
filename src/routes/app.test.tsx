// @vitest-environment jsdom
//
// The first test that ever mounts src/routes/app.tsx (OR-E0018 step 1,
// folded from OR-T0837). Until this file existed, package.json's own
// "test": "vitest run" never touched this route: the repo had zero
// *.test.tsx files anywhere.
//
// The second test below is OR-T0834's acceptance criterion 2: the co-admin
// workspace loader must not report "no workspaces" when the read that would
// tell it so was actually rejected. That guard (classifyRead, OR-T1768) is
// already shipped; this is what proves it stays shipped, by driving the
// real effect with a Supabase client that returns an error instead of an
// empty result and asserting on the real rendered output -- not an
// extracted helper in isolation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mockNavigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@/context/VaultContext", () => ({
  useVault: () => ({
    isUnlocked: true,
    saltB64: "test-salt",
    lock: vi.fn(),
    encryptCredentials: vi.fn(async (s: string) => s),
    decryptText: vi.fn(async (s: string) => s),
    encryptText: vi.fn(async (s: string) => s),
    decryptTransaction: vi.fn(async (s: string) => JSON.parse(s)),
    encryptTransaction: vi.fn(async (t: unknown) => JSON.stringify(t)),
    exportCredentialsKeyForSync: vi.fn(),
    exportTransactionsKeyForSync: vi.fn(),
    ensurePqcKeypairs: vi.fn(async () => ({ generated: false })),
    grantCoAdmin: vi.fn(),
    revokeCoAdmin: vi.fn(),
    loadAdminSubkeys: vi.fn(),
    changeVaultPassword: vi.fn(),
  }),
}));

interface ReadResult {
  data: unknown;
  error: unknown;
}

// A minimal chainable query-builder stand-in for the handful of
// PostgREST-style calls app.tsx makes (.select().eq().order() etc, some
// terminated with .single()/.maybeSingle(), some awaited directly). It is
// deliberately generic rather than a full supabase-js mock: app.tsx only
// ever calls the methods below on the objects `from()` returns.
function makeQueryBuilder(result: ReadResult) {
  const builder: PromiseLike<ReadResult> & Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => builder,
    in: () => builder,
    delete: () => builder,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (onFulfilled: (r: ReadResult) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

let tableResults: Record<string, ReadResult>;
let rpcResults: Record<string, ReadResult>;

function resetSupabaseFixtures() {
  tableResults = {
    user_vault_meta: {
      data: {
        vault_salt: "test-salt",
        workspace_key_id: null,
        kem_secret_wrapped: "wrapped-kem-secret",
        enc_mek_ciphertext: null,
        vault_verifier_ciphertext: null,
        vault_key_version: 1,
      },
      error: null,
    },
    workspace_admins: { data: [], error: null },
    connections: { data: [], error: null },
    source_wallets: { data: [], error: null },
    encrypted_transactions: { data: [], error: null },
  };
  rpcResults = {
    get_or_create_direct_subaccount: { data: "subaccount-1", error: null },
    list_coadmin_workspaces: { data: [], error: null },
    get_coadmin_emails: { data: [], error: null },
  };
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { user: { id: "user-1", email: "user@example.com" } } },
      })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    rpc: vi.fn((fn: string) => Promise.resolve(rpcResults[fn] ?? { data: null, error: null })),
    from: vi.fn((table: string) => makeQueryBuilder(tableResults[table] ?? { data: [], error: null })),
  },
}));

// Imported after the mocks above so app.tsx picks up the mocked modules.
const { AppHome } = await import("./app");

describe("AppHome (/app)", () => {
  beforeEach(() => {
    resetSupabaseFixtures();
    mockNavigate.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the unlocked screen once session + vault checks pass", async () => {
    render(<AppHome />);
    expect(
      await screen.findByText(/Session-based zero-knowledge active/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith({ to: "/login" });
    expect(mockNavigate).not.toHaveBeenCalledWith({ to: "/unlock" });
  });

  it("surfaces a rejected co-admin workspaces read as a visible error, not a silent empty list (OR-T0834)", async () => {
    rpcResults.list_coadmin_workspaces = {
      data: null,
      error: { message: "permission denied for function list_coadmin_workspaces" },
    };

    render(<AppHome />);

    // The real failure mode this guards: before classifyRead (OR-T1768),
    // `{ data: null, error }` was destructured for `data` only, so a
    // rejected read and "administers nothing" were indistinguishable and
    // the page showed no error at all.
    expect(
      await screen.findByText(/Could not load your co-admin workspaces/i, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/permission denied for function list_coadmin_workspaces/i),
    ).toBeInTheDocument();
  });
});
