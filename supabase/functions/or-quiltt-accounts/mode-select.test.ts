/**
 * Mode-selection and auth contract for or-quiltt-accounts (DL-0456).
 *
 * Run: deno test supabase/functions/or-quiltt-accounts/mode-select.test.ts
 *
 * Does NOT import from index.ts: Deno.serve at module top level binds a port.
 * Inlines the mode-selection and body-validation logic from index.ts.
 * Keep in sync with index.ts when either changes.
 *
 * The transform contract (buildAccountsResponse, mergeAccountSets) is covered
 * by the existing transform.test.ts. This file covers the two caller modes that
 * the transform layer never sees:
 *
 *   Mode A (single_connection): quiltt_connection_id present and non-empty after trim.
 *   Mode B (profile_wide):      quiltt_connection_id absent, empty, or whitespace-only.
 *
 * And the auth contract unique to this endpoint:
 *   Non-platform callers (direct mode, widget_token, user JWT) are rejected with 403.
 *   This is the fixture QA described as "direct mode returns 403".
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

// --- body validation (inlined from index.ts, keep in sync) ---------------------------

interface AccountsBody {
  app_user_id?: string;
  quiltt_connection_id?: unknown;
}

type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

function validateBody(body: AccountsBody): ValidationResult {
  if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
    return { ok: false, status: 400, error: 'app_user_id required (string, <=256 chars)' };
  }
  return { ok: true };
}

// --- auth mode check (inlined from index.ts, keep in sync) ---------------------------
// Source: index.ts ~line 130 -- `if (auth.mode !== 'platform') return 403`.

function validatePlatformAuth(mode: string): ValidationResult {
  if (mode !== 'platform') {
    return { ok: false, status: 403, error: 'platform API key required' };
  }
  return { ok: true };
}

// --- mode selection (inlined from index.ts, keep in sync) ----------------------------
// Source: index.ts ~lines 138-140.
// connectionId is the trimmed quiltt_connection_id from the body
// (empty string when the field was absent or non-string).

type QueryMode = 'single_connection' | 'profile_wide';

function resolveQueryMode(body: AccountsBody): QueryMode {
  const connectionId =
    typeof body.quiltt_connection_id === 'string'
      ? body.quiltt_connection_id.trim()
      : '';
  return connectionId ? 'single_connection' : 'profile_wide';
}

// --- tests: auth contract ------------------------------------------------------------

Deno.test('platform mode passes auth check', () => {
  const r = validatePlatformAuth('platform');
  assertEquals(r.ok, true);
});

Deno.test('direct mode is rejected with 403', () => {
  // Quiltt accounts only make sense in the context of an integrator end-user.
  // Direct-mode callers (orangerails.com app session) must receive 403, not 401.
  const r = validatePlatformAuth('direct');
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 403);
});

Deno.test('widget mode is rejected with 403', () => {
  // A widget_token caller must also be rejected -- the session belongs to a user,
  // not to an integrator backend, and the accounts call is a backend operation.
  const r = validatePlatformAuth('widget');
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 403);
});

// --- tests: body validation ----------------------------------------------------------

Deno.test('missing app_user_id is invalid (400)', () => {
  const r = validateBody({});
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('empty app_user_id is invalid (400)', () => {
  const r = validateBody({ app_user_id: '' });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('app_user_id at 257 chars is rejected', () => {
  const r = validateBody({ app_user_id: 'x'.repeat(257) });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

// --- tests: mode selection -----------------------------------------------------------

Deno.test('Mode A: non-empty quiltt_connection_id routes to single_connection', () => {
  const mode = resolveQueryMode({ app_user_id: 'u1', quiltt_connection_id: 'conn_EXAMPLE' });
  assertEquals(mode, 'single_connection');
});

Deno.test('Mode B: absent quiltt_connection_id routes to profile_wide', () => {
  const mode = resolveQueryMode({ app_user_id: 'u1' });
  assertEquals(mode, 'profile_wide');
});

Deno.test('Mode B: empty-string quiltt_connection_id routes to profile_wide', () => {
  // V2 sends empty string when the popup postMessage was lost across a
  // cross-origin redirect (Finicity/MX PROD flows sever window.opener).
  // Empty string must not route to single_connection with an empty id.
  const mode = resolveQueryMode({ app_user_id: 'u1', quiltt_connection_id: '' });
  assertEquals(mode, 'profile_wide');
});

Deno.test('Mode B: whitespace-only quiltt_connection_id routes to profile_wide after trim', () => {
  // A caller passing '   ' must be treated the same as an absent id.
  const mode = resolveQueryMode({ app_user_id: 'u1', quiltt_connection_id: '   ' });
  assertEquals(mode, 'profile_wide');
});

Deno.test('Mode B: non-string quiltt_connection_id is treated as absent', () => {
  const mode = resolveQueryMode({ app_user_id: 'u1', quiltt_connection_id: null });
  assertEquals(mode, 'profile_wide');
});

Deno.test('Mode B: numeric quiltt_connection_id is treated as absent', () => {
  const mode = resolveQueryMode({ app_user_id: 'u1', quiltt_connection_id: 42 });
  assertEquals(mode, 'profile_wide');
});
