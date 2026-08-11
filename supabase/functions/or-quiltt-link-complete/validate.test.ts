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

// --- inlined from index.ts (keep in sync) ----------------------------------------

const ENCRYPTED_LABEL_MAX = 4096;

interface SourceWalletInput {
  external_wallet_id?: unknown;
  is_synced?: unknown;
  encrypted_metadata?: unknown;
}

interface LinkCompleteBody {
  platform_slug?: unknown;
  app_user_id?:   unknown;
  widget_token?:  unknown;
  encrypted_label?:       unknown;
  quiltt_connection_id?:  unknown;
  accounts?: unknown;
}

type ValidationResult = { ok: true } | { ok: false; status: number; error: string };

function validateBody(body: LinkCompleteBody): ValidationResult {
  if (!body.platform_slug || typeof body.platform_slug !== 'string') {
    return { ok: false, status: 400, error: 'platform_slug required' };
  }
  if (!body.app_user_id || typeof body.app_user_id !== 'string' || (body.app_user_id as string).length > 256) {
    return { ok: false, status: 400, error: 'app_user_id required (string, <=256 chars)' };
  }
  // widget_token absence is an auth failure (401), not a bad-request (400).
  if (!body.widget_token || typeof body.widget_token !== 'string') {
    return { ok: false, status: 401, error: 'widget_token required' };
  }
  if (body.encrypted_label !== undefined) {
    if (
      typeof body.encrypted_label !== 'string' ||
      (body.encrypted_label as string).length > ENCRYPTED_LABEL_MAX
    ) {
      return { ok: false, status: 400, error: 'encrypted_label must be base64 ciphertext <=4 KB' };
    }
  }
  if (body.quiltt_connection_id !== undefined) {
    if (
      typeof body.quiltt_connection_id !== 'string' ||
      (body.quiltt_connection_id as string).length > 256
    ) {
      return { ok: false, status: 400, error: 'quiltt_connection_id must be a string <=256 chars' };
    }
  }
  if (body.accounts !== undefined) {
    if (!Array.isArray(body.accounts)) {
      return { ok: false, status: 400, error: 'accounts must be an array' };
    }
    if ((body.accounts as unknown[]).length > 50) {
      return { ok: false, status: 400, error: 'accounts: max 50 entries per connection' };
    }
    for (const acc of body.accounts as SourceWalletInput[]) {
      if (
        !acc.external_wallet_id ||
        typeof acc.external_wallet_id !== 'string' ||
        (acc.external_wallet_id as string).length > 256
      ) {
        return {
          ok: false, status: 400,
          error: 'accounts[].external_wallet_id required (string, <=256 chars)',
        };
      }
      if (typeof acc.is_synced !== 'boolean') {
        return { ok: false, status: 400, error: 'accounts[].is_synced required (boolean)' };
      }
      if (
        !acc.encrypted_metadata ||
        typeof acc.encrypted_metadata !== 'string' ||
        (acc.encrypted_metadata as string).length > 65536
      ) {
        return {
          ok: false, status: 400,
          error: 'accounts[].encrypted_metadata required (base64 ciphertext, <=64 KB)',
        };
      }
    }
  }
  return { ok: true };
}

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
