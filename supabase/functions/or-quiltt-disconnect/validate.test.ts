/**
 * Body-validation contract for or-quiltt-disconnect (DL-0456).
 *
 * Run: deno test supabase/functions/or-quiltt-disconnect/validate.test.ts
 *
 * Does NOT import from index.ts: Deno.serve at module top level binds a port.
 * Inlines the body-validation block from index.ts.
 * Keep in sync with index.ts when either changes.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

// --- inlined from index.ts (keep in sync) ----------------------------------------

interface DisconnectBody {
  app_user_id?: string;
  connection_id?: unknown;
  full_unlink?:  unknown;
}

type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

function validateBody(body: DisconnectBody): ValidationResult {
  if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
    return { ok: false, status: 400, error: 'app_user_id required (string, <=256 chars)' };
  }
  if (
    body.connection_id !== undefined &&
    (typeof body.connection_id !== 'string' || (body.connection_id as string).length > 256)
  ) {
    return { ok: false, status: 400, error: 'connection_id must be a string <=256 chars' };
  }
  return { ok: true };
}

// --- tests ---------------------------------------------------------------------------

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

Deno.test('app_user_id at exactly 256 chars is accepted', () => {
  const r = validateBody({ app_user_id: 'x'.repeat(256) });
  assertEquals(r.ok, true);
});

Deno.test('connection_id absent is valid (full-profile disconnect path)', () => {
  // When omitted, or-quiltt-disconnect removes the OR connections row for all
  // Quiltt links under this user. The absence is intentional, not a mistake.
  const r = validateBody({ app_user_id: 'u1' });
  assertEquals(r.ok, true);
});

Deno.test('connection_id as string <=256 chars is valid', () => {
  const r = validateBody({ app_user_id: 'u1', connection_id: 'conn_EXAMPLE' });
  assertEquals(r.ok, true);
});

Deno.test('connection_id at 257 chars is rejected', () => {
  const r = validateBody({ app_user_id: 'u1', connection_id: 'c'.repeat(257) });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('connection_id as non-string is rejected', () => {
  const r = validateBody({ app_user_id: 'u1', connection_id: 42 });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('full_unlink omitted is valid (defaults to false in handler)', () => {
  // full_unlink is optional. Its absence keeps the quiltt_profile_map row so
  // a future or-quiltt-session call can reuse the same Quiltt Profile cheaply.
  const r = validateBody({ app_user_id: 'u1' });
  assertEquals(r.ok, true);
});

Deno.test('full_unlink=true with valid app_user_id is valid', () => {
  const r = validateBody({ app_user_id: 'u1', full_unlink: true });
  assertEquals(r.ok, true);
});
