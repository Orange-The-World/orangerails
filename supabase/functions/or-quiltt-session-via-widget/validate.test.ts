/**
 * Body-validation and widget_token state contract for or-quiltt-session-via-widget (DL-0456).
 *
 * Run: deno test supabase/functions/or-quiltt-session-via-widget/validate.test.ts
 *
 * Does NOT import from index.ts: Deno.serve at module top level binds a port.
 * Inlines the body check and widget_token state guards from index.ts.
 * Keep in sync with index.ts when either changes.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateBody, checkTokenState } from './validate.ts';

// --- tests: body validation ----------------------------------------------------------

Deno.test('missing widget_token is invalid (400)', () => {
  const r = validateBody({});
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('non-string widget_token is invalid (400)', () => {
  const r = validateBody({ widget_token: 42 });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('string widget_token passes body validation', () => {
  const r = validateBody({ widget_token: '12345678-1234-4234-a234-123456789abc' });
  assertEquals(r.ok, true);
});

// --- tests: widget_token state -------------------------------------------------------

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST   = new Date(Date.now() - 3_600_000).toISOString();
const NOW_MS = Date.now();

Deno.test('unknown widget_token (null session) returns 401', () => {
  const r = checkTokenState(null, NOW_MS);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 401);
});

Deno.test('used widget_token (used_at set) returns 401', () => {
  const r = checkTokenState(
    { id: 't', platform_id: 'p', app_user_id: 'u', expires_at: FUTURE, used_at: PAST },
    NOW_MS,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 401);
});

Deno.test('expired widget_token returns 401', () => {
  const r = checkTokenState(
    { id: 't', platform_id: 'p', app_user_id: 'u', expires_at: PAST, used_at: null },
    NOW_MS,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 401);
});

Deno.test('valid (unused, not expired) widget_token returns ok', () => {
  const r = checkTokenState(
    { id: 't', platform_id: 'p', app_user_id: 'u', expires_at: FUTURE, used_at: null },
    NOW_MS,
  );
  assertEquals(r.ok, true);
});

Deno.test('token expiring exactly 1 ms before call time is rejected', () => {
  // Boundary: expires_at - 1 ms relative to the call must be refused.
  const r = checkTokenState(
    {
      id: 't', platform_id: 'p', app_user_id: 'u',
      expires_at: new Date(NOW_MS - 1).toISOString(),
      used_at: null,
    },
    NOW_MS,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 401);
});
