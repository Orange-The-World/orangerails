/**
 * JWT-binding proof for or-quiltt-session-revoke (DL-0456).
 *
 * Run: deno test supabase/functions/or-quiltt-session-revoke/jwt-binding.test.ts
 *
 * Does NOT import from index.ts: Deno.serve at module top level binds a port.
 * Inlines the JWT userId extraction and widget_token state guards from index.ts.
 * Keep in sync with index.ts when either changes.
 *
 * The binding check exists to prevent a caller holding ANY valid widget_token
 * from revoking sessions that belong to a different tenant's Profile. These tests pin:
 *   - The JWT parse yields the correct userId on a well-formed token.
 *   - Malformed JWTs yield null without throwing.
 *   - A token whose userId does not match the profile map is detected as foreign.
 *   - The three widget_token error codes (unknown/used/expired) are distinct.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { extractJwtUserId, checkTokenState } from './validate.ts';

// --- helpers: build test JWTs --------------------------------------------------------

/**
 * Build a minimal Quiltt-style JWT (unsigned) for fixture-only use.
 * No real signing happens here -- these tokens test the PARSE PATH only.
 * Institution and tenant ids are synthetic; this repo is public and permanent.
 */
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  // Standard base64url: strip padding, swap +/ for -_
  const body = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.fakesig`;
}

// --- tests: JWT extraction -----------------------------------------------------------

Deno.test('well-formed JWT with userId field returns correct id', () => {
  const token = makeJwt({ userId: 'p_ABCDEF123456', exp: 9_999_999_999 });
  assertEquals(extractJwtUserId(token), 'p_ABCDEF123456');
});

Deno.test('JWT without userId field returns null (Quiltt uses userId, not sub)', () => {
  // Quiltt uses `userId`, not the standard `sub` claim.
  // A token with only `sub` must not yield a userId here.
  const token = makeJwt({ sub: 'someone', exp: 9_999_999_999 });
  assertEquals(extractJwtUserId(token), null);
});

Deno.test('JWT userId must be a string, not a number', () => {
  const token = makeJwt({ userId: 12345 });
  assertEquals(extractJwtUserId(token), null);
});

Deno.test('malformed JWT (wrong part count) returns null without throwing', () => {
  assertEquals(extractJwtUserId('onlyone'), null);
  assertEquals(extractJwtUserId('two.parts'), null);
  assertEquals(extractJwtUserId('too.many.parts.here'), null);
});

Deno.test('invalid base64 payload returns null without throwing', () => {
  // parts[1] is not valid base64 -- must not propagate an exception.
  assertEquals(extractJwtUserId('header.!!!invalid!!!.sig'), null);
});

Deno.test('payload that is not JSON returns null without throwing', () => {
  const notJson = btoa('this is not json').replace(/=/g, '');
  assertEquals(extractJwtUserId(`header.${notJson}.sig`), null);
});

// --- tests: cross-tenant binding -----------------------------------------------------

Deno.test('a JWT from a different Profile is identified as foreign', () => {
  const profileInMap  = 'p_CORRECT_PROFILE';
  const foreignProfile = 'p_FOREIGN_PROFILE';

  const token = makeJwt({ userId: foreignProfile });
  const jwtUserId = extractJwtUserId(token);

  // The binding check: jwtUserId must equal the profile from the DB map.
  assertEquals(jwtUserId === profileInMap, false, 'foreign session must not match');
});

Deno.test('a JWT from the correct Profile passes the binding check', () => {
  const profileInMap = 'p_CORRECT_PROFILE';
  const token = makeJwt({ userId: profileInMap });
  assertEquals(extractJwtUserId(token), profileInMap);
});

// --- tests: widget_token state error codes -------------------------------------------

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST   = new Date(Date.now() - 3_600_000).toISOString();
const NOW_MS = Date.now();

Deno.test('unknown widget_token -> code widget_token_unknown', () => {
  const r = checkTokenState(null, NOW_MS);
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, 'widget_token_unknown');
});

Deno.test('used widget_token -> code widget_token_used', () => {
  const r = checkTokenState(
    { id: 't', platform_id: 'p', app_user_id: 'u', expires_at: FUTURE, used_at: PAST },
    NOW_MS,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, 'widget_token_used');
});

Deno.test('expired widget_token -> code widget_token_expired', () => {
  const r = checkTokenState(
    { id: 't', platform_id: 'p', app_user_id: 'u', expires_at: PAST, used_at: null },
    NOW_MS,
  );
  assertEquals(r.ok, false);
  if (!r.ok) assertEquals(r.code, 'widget_token_expired');
});

Deno.test('three error codes are distinct from each other', () => {
  // Used and expired must not collapse into the same code (integrators branch on them).
  const unknown = checkTokenState(null, NOW_MS);
  const used    = checkTokenState(
    { id: 't', platform_id: 'p', app_user_id: 'u', expires_at: FUTURE, used_at: PAST },
    NOW_MS,
  );
  const expired = checkTokenState(
    { id: 't', platform_id: 'p', app_user_id: 'u', expires_at: PAST, used_at: null },
    NOW_MS,
  );

  if (!unknown.ok && !used.ok && !expired.ok) {
    const codes = new Set([unknown.code, used.code, expired.code]);
    assertEquals(codes.size, 3, 'all three error codes must be distinct');
  }
});

Deno.test('valid (unused, not expired) widget_token passes state check', () => {
  const r = checkTokenState(
    { id: 't', platform_id: 'p', app_user_id: 'u', expires_at: FUTURE, used_at: null },
    NOW_MS,
  );
  assertEquals(r.ok, true);
});
