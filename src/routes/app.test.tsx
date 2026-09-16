// @vitest-environment jsdom

/**
 * Route-mount coverage for the co-admin duplicate-key banner on /app.
 *
 * OR-T1291's first acceptance criterion (acceptance_kind=artifact) was: the
 * duplicate-key message is still on screen after refresh() has run at least
 * once, proved by a test that mounts the route rather than by a description.
 * The fix itself shipped; this file is the missing proof.
 *
 * Before the fix, the workspace loader wrote that message into the same `err`
 * slot that refresh() clears with setErr(null) on every run. The loader does
 * not re-run (its deps are only isUnlocked and navigate), so a later Sync
 * left the workspace missing and unexplained. workspaceLoadIssues is a
 * separate list, so a later refresh must not wipe it.
 *
 * This file mounts the /app route component. A description of the state
 * machine is not the acceptance; the message still being in the document
 * after a later refresh is.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DUPLICATE_WRAPPED_KEY_MESSAGE } from "@/lib/co-admin-workspace-read";

const { mockVault, mockSupabase, refreshCount } = vi.hoisted(() => {
  const refreshCount = { n: 0 };

  const mockVault = {
    isUnlocked: true,
    lock: vi.fn(),
    encryptCredentials: vi.fn(),
    decryptText: vi.fn(async (value: string) => value),
    encryptText: vi.fn(async (value: string) => value),
    decryptTransaction: vi.fn(async () => {
      throw new Error("No transaction should be decrypted in this test");
    }),
    encryptTransaction: vi.fn(),
    exportCredentialsKeyForSync: vi.fn(async () => "credentials-key"),
    exportTransactionsKeyForSync: vi.fn(async () => "transactions-key"),
    ensurePqcKeypairs: vi.fn(async () => ({ generated: false })),
    grantCoAdmin: vi.fn(),
    revokeCoAdmin: vi.fn(),
    loadAdminSubkeys: vi.fn(async () => {
      throw new Error("Ambiguous workspaces must never load subkeys");
    }),
    changeVaultPassword: vi.fn(),
  };

  function queryResult(data: unknown, error: unknown = null) {
    const result = {
      select: () => result,
      eq: () => result,
      in: () => result,
      order: () => result,
      limit: () => result,
      single: () => Promise.resolve({ data, error }),
      maybeSingle: () => Promise.resolve({ data, error }),
      then: (
        resolve: (value: { data: unknown; error: unknown }) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve({ data, error }).then(resolve, reject),
    };
    return result;
  }

  const workspaceRows = [
    {
      owner_user_id: "owner-one",
      workspace_key_id: "workspace-one",
      sig_public_key: "owner-one-public-key",
    },
    {
      owner_user_id: "owner-two",
      workspace_key_id: "workspace-two",
      sig_public_key: "owner-two-public-key",
    },
  ];

  const connectionRow = {
    id: "connection-one",
    provider_type: "blink",
    status: "active",
    encrypted_label: null,
    encrypted_last_error: null,
    last_sync_at: null,
    created_at: "2026-09-13T00:00:00.000Z",
  };

  const mockSupabase = {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: "test-access-token",
            user: { id: "coadmin-user", email: "coadmin@example.test" },
          },
        },
        error: null,
      })),
      signOut: vi.fn(),
    },
    from: vi.fn((table: string) => {
      if (table === "user_vault_meta") {
        return queryResult({
          vault_salt: "test-salt",
          workspace_key_id: null,
          kem_secret_wrapped: "test-wrapped-kem-secret",
          enc_mek_ciphertext: "enc-mek",
          vault_verifier_ciphertext: "verifier",
          vault_key_version: 1,
        });
      }
      if (table === "workspace_admins") return queryResult([]);
      if (table === "wrapped_data_keys") {
        // Two rows for the same workspace key: the ambiguous state.
        return queryResult([
          { wrapped_ciphertext: "first", grant_sig: "sig-a" },
          { wrapped_ciphertext: "second", grant_sig: "sig-b" },
        ]);
      }
      if (table === "connections") {
        refreshCount.n += 1;
        return queryResult([connectionRow]);
      }
      if (table === "source_wallets") return queryResult([]);
      if (table === "encrypted_transactions") return queryResult([]);
      throw new Error(`Unexpected table in /app route test: ${table}`);
    }),
    rpc: vi.fn(async (name: string, params?: { user_ids?: string[] }) => {
      if (name === "get_or_create_direct_subaccount") {
        return { data: "direct-subaccount", error: null };
      }
      if (name === "list_coadmin_workspaces") {
        return { data: workspaceRows, error: null };
      }
      if (name === "get_coadmin_emails") {
        return {
          data: (params?.user_ids ?? []).map((userId) => ({
            user_id: userId,
            email: `${userId}@example.test`,
          })),
          error: null,
        };
      }
      if (name === "list_or_access_tokens") {
        return { data: [], error: null };
      }
      throw new Error(`Unexpected RPC in /app route test: ${name}`);
    }),
  };

  return { mockVault, mockSupabase, refreshCount };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: mockSupabase }));
vi.mock("@/context/VaultContext", () => ({
  useVault: () => mockVault,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/app/ApiTokensSection", () => ({
  ApiTokensSection: () => null,
}));
vi.mock("@/components/app/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

import { Route as AppRoute } from "./app";

function renderAppRoute() {
  const rootRoute = createRootRoute();
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/app",
    component: AppRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute]),
    history: createMemoryHistory({ initialEntries: ["/app"] }),
  });
  return render(<RouterProvider router={router} />);
}

/** Deepest elements whose text contains the duplicate-key copy. */
function issueBanners() {
  return Array.from(document.querySelectorAll("div")).filter((el) => {
    const text = el.textContent ?? "";
    if (!text.includes(DUPLICATE_WRAPPED_KEY_MESSAGE)) return false;
    return !Array.from(el.children).some((child) =>
      (child.textContent ?? "").includes(DUPLICATE_WRAPPED_KEY_MESSAGE),
    );
  });
}

describe("/app co-admin duplicate wrapped key", () => {
  beforeEach(() => {
    refreshCount.n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              synced: 0,
              connections: [{ connection_id: "connection-one" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps every ambiguous workspace message on screen after refresh() has run", async () => {
    renderAppRoute();

    const issues = await waitFor(() => {
      const found = issueBanners();
      expect(found).toHaveLength(2);
      return found;
    });

    expect(issues[0].textContent).toContain("owner-one@example.test");
    expect(issues[1].textContent).toContain("owner-two@example.test");
    expect(issues[0].textContent).toContain(DUPLICATE_WRAPPED_KEY_MESSAGE);
    expect(issues[1].textContent).toContain(DUPLICATE_WRAPPED_KEY_MESSAGE);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
    });

    const refreshCountBeforeSync = refreshCount.n;
    expect(refreshCountBeforeSync).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() => {
      expect(refreshCount.n).toBeGreaterThan(refreshCountBeforeSync);
    });

    const issuesAfterRefresh = issueBanners();
    expect(issuesAfterRefresh).toHaveLength(2);
    expect(issuesAfterRefresh[0].textContent).toContain("owner-one@example.test");
    expect(issuesAfterRefresh[1].textContent).toContain("owner-two@example.test");
    expect(issuesAfterRefresh[0].textContent).toContain(DUPLICATE_WRAPPED_KEY_MESSAGE);
    expect(issuesAfterRefresh[1].textContent).toContain(DUPLICATE_WRAPPED_KEY_MESSAGE);
  });
});
