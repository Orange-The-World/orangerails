/**
 * Tests for widget-mode auth in platform-auth.ts.
 *
 * Run with:
 *   deno test supabase/functions/_shared/platform-auth.test.ts
 *
 * Scope. Every case here runs fully offline. The branches under test are the
 * ones that decide an outcome BEFORE any Supabase client is constructed or any
 * query is issued:
 *
 *   - authenticateWidgetToken screens the token shape before makeServiceClient
 *   - enforceWidgetAppUser is pure
 *   - resolveSubaccount and getCallerPlatformId both return on the widget
 *     branch before touching ctx.serviceClient
 *
 * That is why passing a null serviceClient below is safe rather than sloppy:
 * a test that reached the client would throw on it, so the null is itself an
 * assertion that these paths never do.
 *
 * NOT covered here, deliberately: the row lookup in authenticateWidgetToken
 * (expiry, used_at, the platform and user the row carries). That needs a real
 * pending_widget_sessions row and belongs with the integration tests, not in
 * an offline unit suite that would have to mock the query builder and would
 * then only be testing the mock.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0';
import {
  authenticateWidgetToken,
  enforceWidgetAppUser,
  getCallerPlatformId,
  isAuthError,
  resolveSubaccount,
  type AuthContext,
  type WidgetAuthContext,
} from './platform-auth.ts';

/**
 * A client that fails loudly if anything touches it. Every path exercised
 * below must return before reaching the database.
 */
const NO_CLIENT = new Proxy({}, {
  get() {
    throw new Error('serviceClient must not be used on this path');
  },
}) as unknown as SupabaseClient;

function widgetCtx(
  overrides: Partial<WidgetAuthContext> = {},
): WidgetAuthContext {
  return {
    mode: 'widget',
    platformId: 'plat-1',
    appUserId: 'user-1',
    serviceClient: NO_CLIENT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// authenticateWidgetToken: token shape screening
// ---------------------------------------------------------------------------

// A widget_token is a pending_widget_sessions primary key, which is a uuid.
// Anything else must be refused here rather than sent to Postgres, which
// answers 22P02 on a malformed uuid. That would surface as a 500 and tell a
// caller their input reached the database.
const MALFORMED: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['null', null],
  ['empty string', ''],
  ['not a uuid', 'not-a-uuid'],
  ['number', 12345],
  ['object', { id: '00000000-0000-0000-0000-000000000000' }],
  ['uuid with trailing text', '00000000-0000-0000-0000-000000000000x'],
  ['uuid with leading space', ' 00000000-0000-0000-0000-000000000000'],
  ['sql fragment', "' OR 1=1 --"],
  ['uuid missing a group', '00000000-0000-0000-000000000000'],
];

for (const [label, value] of MALFORMED) {
  Deno.test(`authenticateWidgetToken refuses ${label} without a DB call`, async () => {
    const result = await authenticateWidgetToken(value);
    assertEquals(isAuthError(result), true);
    if (!isAuthError(result)) return;
    assertEquals(result.status, 401);
    // One message for every failure. Forged, expired, spent and
    // never-existed must be indistinguishable to the caller.
    assertEquals(result.message, 'Invalid widget token');
  });
}

// ---------------------------------------------------------------------------
// enforceWidgetAppUser
// ---------------------------------------------------------------------------

Deno.test('enforceWidgetAppUser allows a matching app_user_id', () => {
  assertEquals(enforceWidgetAppUser(widgetCtx(), 'user-1'), null);
});

Deno.test('enforceWidgetAppUser refuses a different app_user_id', () => {
  const err = enforceWidgetAppUser(widgetCtx(), 'someone-else');
  assertEquals(err?.status, 403);
  assertEquals(err?.message, 'app_user_id must match the widget session');
});

Deno.test('enforceWidgetAppUser refuses an absent app_user_id', () => {
  // Undefined must not read as "no opinion" and fall through. The endpoints
  // validate app_user_id separately, but this lock must not depend on that
  // ordering to be safe.
  assertEquals(enforceWidgetAppUser(widgetCtx(), undefined)?.status, 403);
});

Deno.test('enforceWidgetAppUser is a no-op in platform mode', () => {
  const ctx: AuthContext = {
    mode: 'platform',
    platformId: 'plat-1',
    platformSlug: 'ow',
    serviceClient: NO_CLIENT,
  };
  // Platform mode is server-to-server and names its own app_user_id by
  // design, so this lock must not touch it.
  assertEquals(enforceWidgetAppUser(ctx, 'anyone-at-all'), null);
});

Deno.test('enforceWidgetAppUser is a no-op in direct mode', () => {
  const ctx: AuthContext = {
    mode: 'direct',
    userId: 'auth-user-1',
    subaccountId: 'sub-1',
    serviceClient: NO_CLIENT,
  };
  // Direct mode carries its own separate lock against ctx.userId.
  assertEquals(enforceWidgetAppUser(ctx, 'anyone-at-all'), null);
});

// ---------------------------------------------------------------------------
// resolveSubaccount
// ---------------------------------------------------------------------------

Deno.test('resolveSubaccount refuses widget mode', async () => {
  // WidgetAuthContext also carries a platformId, so without an explicit guard
  // it would fall into the platform branch and resolve a subaccount for a
  // caller that was never entitled to name one. NO_CLIENT throwing would
  // catch that regression too.
  const result = await resolveSubaccount(widgetCtx(), 'sub-1');
  assertEquals(isAuthError(result), true);
  if (!isAuthError(result)) return;
  assertEquals(result.status, 403);
  assertEquals(result.message, 'Widget-token callers cannot act on a subaccount');
});

Deno.test('resolveSubaccount refuses widget mode even with no subaccount named', async () => {
  const result = await resolveSubaccount(widgetCtx(), undefined);
  assertEquals(isAuthError(result), true);
  if (!isAuthError(result)) return;
  assertEquals(result.status, 403);
});

// ---------------------------------------------------------------------------
// getCallerPlatformId
// ---------------------------------------------------------------------------

Deno.test('getCallerPlatformId returns the token row platform in widget mode', async () => {
  // The id came off pending_widget_sessions, so it is as verified as the
  // platform key that minted the session, and no lookup is needed.
  const result = await getCallerPlatformId(widgetCtx({ platformId: 'plat-42' }));
  assertEquals(result, 'plat-42');
});

Deno.test('getCallerPlatformId returns the platform id in platform mode', async () => {
  const result = await getCallerPlatformId({
    mode: 'platform',
    platformId: 'plat-7',
    platformSlug: 'ow',
    serviceClient: NO_CLIENT,
  });
  assertEquals(result, 'plat-7');
});
