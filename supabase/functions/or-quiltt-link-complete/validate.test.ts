/**
 * Body-validation contract for or-quiltt-link-complete (DL-0456).
 *
 * Run: deno test supabase/functions/or-quiltt-link-complete/validate.test.ts
 *
 * Does NOT import from index.ts: Deno.serve at module top level binds a port.
 * Inlines the body-validation block from index.ts.
 * Keep in sync with index.ts when either changes.
 *
 * Notable contracts asserted here:
 *   - missing widget_token returns 401, NOT 400. An absent credential is an
 *     auth failure, not a bad request. The status matters to integrators who
 *     branch on it to decide whether to retry vs re-authenticate.
 *   - accounts[] capped at 50 entries (DL-0442: this limit was discovered in
 *     prod as a silent 400 with no warning when a user had more accounts).
 *   - encrypted_label ceiling is ENCRYPTED_LABEL_MAX = 4096 bytes.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { validateBody } from './validate.ts';

// --- tests ---------------------------------------------------------------------------

Deno.test('missing platform_slug is invalid (400)', () => {
  const r = validateBody({ app_user_id: 'u1', widget_token: 'tok' });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('missing app_user_id is invalid (400)', () => {
  const r = validateBody({ platform_slug: 'ps', widget_token: 'tok' });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('missing widget_token returns 401, not 400', () => {
  // An absent credential is an auth failure: integrators branch on this status.
  const r = validateBody({ platform_slug: 'ps', app_user_id: 'u1' });
  assertEquals(r.ok, false);
  if (!r.ok) {
    assertEquals(r.status, 401, 'widget_token absence must be 401, not 400');
  }
});

Deno.test('all required fields present is valid', () => {
  const r = validateBody({ platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok' });
  assertEquals(r.ok, true);
});

Deno.test('encrypted_label at 4097 chars is rejected (400)', () => {
  const r = validateBody({
    platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok',
    encrypted_label: 'x'.repeat(4097),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('encrypted_label at exactly 4096 chars is accepted', () => {
  const r = validateBody({
    platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok',
    encrypted_label: 'x'.repeat(4096),
  });
  assertEquals(r.ok, true);
});

Deno.test('accounts array capped at 50 -- DL-0442 silent limit', () => {
  // DL-0442: users with many accounts hit this limit silently in prod.
  // Pinned so it cannot be raised accidentally without a deliberate review.
  const oneAccount = { external_wallet_id: 'w0', is_synced: true, encrypted_metadata: 'enc' };
  const r = validateBody({
    platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok',
    accounts: Array.from({ length: 51 }, (_, i) => ({ ...oneAccount, external_wallet_id: `w${i}` })),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('50 accounts is exactly the accepted limit', () => {
  const oneAccount = { external_wallet_id: 'w0', is_synced: true, encrypted_metadata: 'enc' };
  const r = validateBody({
    platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok',
    accounts: Array.from({ length: 50 }, (_, i) => ({ ...oneAccount, external_wallet_id: `w${i}` })),
  });
  assertEquals(r.ok, true);
});

Deno.test('accounts entry with missing external_wallet_id is rejected', () => {
  const r = validateBody({
    platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok',
    accounts: [{ is_synced: true, encrypted_metadata: 'enc' }],
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('accounts entry with non-boolean is_synced is rejected', () => {
  const r = validateBody({
    platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok',
    accounts: [{ external_wallet_id: 'w1', is_synced: 'true', encrypted_metadata: 'enc' }],
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('accounts entry with missing encrypted_metadata is rejected', () => {
  const r = validateBody({
    platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok',
    accounts: [{ external_wallet_id: 'w1', is_synced: true }],
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('quiltt_connection_id at 257 chars is rejected', () => {
  const r = validateBody({
    platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok',
    quiltt_connection_id: 'c'.repeat(257),
  });
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.status, 400);
});

Deno.test('quiltt_connection_id absent is valid', () => {
  const r = validateBody({ platform_slug: 'ps', app_user_id: 'u1', widget_token: 'tok' });
  assertEquals(r.ok, true);
});
