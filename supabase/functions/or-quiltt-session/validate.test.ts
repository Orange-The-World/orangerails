/**
 * Body-validation contract for or-quiltt-session (DL-0456).
 *
 * Run: deno test supabase/functions/or-quiltt-session/validate.test.ts
 *
 * Does NOT import from index.ts: index.ts calls Deno.serve at module top level,
 * so importing it binds a port. Same root issue as or-quiltt-sync (tracked #329).
 *
 * Inlines the body-validation block from index.ts (lines ~96-102 as of DL-0456).
 * If you change those lines, update this file to match so the proof stays honest.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

// --- inlined from index.ts (keep in sync) ----------------------------------------

interface SessionBody {
  app_user_id?: string;
  mode?: string;
  existing_connection_id?: string;
}

type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

function validateBody(body: SessionBody): ValidationResult {
  if (!body.app_user_id || typeof body.app_user_id !== 'string' || body.app_user_id.length > 256) {
    return { ok: false, status: 400, error: 'app_user_id required (string, <=256 chars)' };
  }
  const mode = body.mode ?? 'link';
  if (mode !== 'link' && mode !== 'reconnect') {
    return { ok: false, status: 400, error: "mode must be 'link' or 'reconnect'" };
  }
  if (mode === 'reconnect' && !body.existing_connection_id) {
    return { ok: false, status: 400, error: "existing_connection_id required when mode='reconnect'" };
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

Deno.test('mode=link with no existing_connection_id is valid', () => {
  const r = validateBody({ app_user_id: 'u1', mode: 'link' });
  assertEquals(r.ok, true);
});

Deno.test('mode=reconnect without existing_connection_id is invalid', () => {
  // The silent trap: integrator omits existing_connection_id on reconnect.
  // Without this guard, the handler would attempt a reconnect with no target.
  const r = validateBody({ app_user_id: 'u1', mode: 'reconnect' });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('mode=reconnect with existing_connection_id is valid', () => {
  const r = validateBody({
    app_user_id: 'u1',
    mode: 'reconnect',
    existing_connection_id: 'conn_AAABBBCCC',
  });
  assertEquals(r.ok, true);
});

Deno.test('omitted mode defaults to link, no existing_connection_id required', () => {
  const r = validateBody({ app_user_id: 'u1' });
  assertEquals(r.ok, true);
});

Deno.test('unknown mode string is rejected (400)', () => {
  const r = validateBody({ app_user_id: 'u1', mode: 'replace' });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});
