/**
 * Deno tests for the upstream error taxonomy.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/_shared/upstream-errors.test.ts
 *
 * This is the decision that picks which sentence a customer reads when a sync
 * fails, and until DL-0421 it had no test at all: it lived inside
 * or-sync/index.ts, which calls Deno.serve() at import time, so any test that
 * imported it bound a port and died.
 *
 * The cases below are not illustrative. Every "bitstamp" string is the real
 * wire shape (CCXT builds its message as `exchangeId + ' ' + rawBody`), and
 * the class names are the ones ccxt@4.4.30 actually throws for those reasons.
 */

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  classifyUpstreamError,
  errorClassName,
  _CCXT_ERROR_CODES_FOR_TEST,
} from './upstream-errors.ts';

/** The real wire shape: CCXT feedback is the exchange id then the raw body. */
const wire = (reason: string, code = 'APIxxxx') =>
  `bitstamp {"status": "error", "reason": "${reason}", "code": "${code}"}`;

// ─────────────────────────────────────────────────────────────────────────────
// The regression that opened DL-0421.
//
// Marina's connection stored UPSTREAM_OTHER, whose copy is "Something went
// wrong", for what these tests pin as authentication failures.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('bitstamp auth failures classify as auth, not OTHER', () => {
  const authReasons: Array<[string, string]> = [
    ['Invalid signature', 'AuthenticationError'],
    ['Authentication failed', 'AuthenticationError'],
    ['Missing key, signature and nonce parameters', 'AuthenticationError'],
    ['Wrong API key format', 'AuthenticationError'],
    ['API key not found', 'AuthenticationError'],
    ['No permission found', 'PermissionDenied'],
    ['IP address not allowed', 'PermissionDenied'],
    ['Your account is frozen', 'PermissionDenied'],
    ['Please update your profile with your FATCA information, before using API.', 'PermissionDenied'],
  ];
  for (const [reason, cls] of authReasons) {
    assertEquals(
      classifyUpstreamError(wire(reason), cls),
      'UPSTREAM_AUTH_FAILED',
      `"${reason}" (${cls}) must classify as UPSTREAM_AUTH_FAILED`,
    );
  }
});

Deno.test('bitstamp transient failures classify as unavailable', () => {
  assertEquals(
    classifyUpstreamError(wire("Bitstamp.net is under scheduled maintenance. We'll be back soon."), 'OnMaintenance'),
    'UPSTREAM_UNAVAILABLE',
  );
  assertEquals(
    classifyUpstreamError(wire('Order could not be placed.'), 'ExchangeNotAvailable'),
    'UPSTREAM_UNAVAILABLE',
  );
  assertEquals(classifyUpstreamError(wire('Invalid nonce'), 'InvalidNonce'), 'UPSTREAM_UNAVAILABLE');
});

Deno.test('bitstamp malformed-request failures classify as bad request', () => {
  assertEquals(classifyUpstreamError(wire('Invalid offset.'), 'BadRequest'), 'UPSTREAM_BAD_REQUEST');
});

// ─────────────────────────────────────────────────────────────────────────────
// The trap. This is the case that makes the fix real rather than local-only.
//
// CCXT is loaded from a minified CDN bundle, where every error class is an
// anonymous class expression: the constructor name is mangled to a letter and
// only `this.name` survives. A classifier keyed on `constructor.name` passes
// against the unminified npm package and fails in production.
// ─────────────────────────────────────────────────────────────────────────────

// Reproduces exactly how the shipped bundle emits these classes, down to the
// binding names: an anonymous class expression assigned to a short identifier,
// with the real name recoverable only from the `this.name` string literal.
// The short bindings are deliberate -- a descriptive const name here would
// give the class an inferred .name and quietly destroy the thing under test.
const bs = class extends Error {
  constructor(m: string) {
    super(m);
    this.name = 'BaseError';
  }
};
const T = class extends bs {
  constructor(m: string) {
    super(m);
    this.name = 'ExchangeError';
  }
};
const C = class extends T {
  constructor(m: string) {
    super(m);
    this.name = 'AuthenticationError';
  }
};

Deno.test('minified CCXT error is still identified (the constructor.name trap)', () => {
  const e = new C(wire('Invalid signature'));

  // Precondition: this is what the bundle actually looks like. If a future
  // build stops mangling, this assertion fails loudly rather than letting the
  // test quietly stop covering the thing it exists to cover.
  assertEquals(
    e.constructor.name.length <= 2,
    true,
    'expected a mangled constructor name; the minification premise no longer holds',
  );

  assertEquals(errorClassName(e), 'AuthenticationError');
  assertEquals(
    classifyUpstreamError(e.message, errorClassName(e)),
    'UPSTREAM_AUTH_FAILED',
    'a minified CCXT auth error must not fall through to UPSTREAM_OTHER',
  );

  // And the negative: the old implementation, pinned so a regression to
  // constructor.name cannot pass this file.
  assertEquals(
    classifyUpstreamError(e.message, e.constructor.name),
    'UPSTREAM_OTHER',
    'constructor.name must NOT resolve the class -- if this now passes, the fix has been reverted',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Safe degradation: unknown classes must not be guessed at.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('unrecognised classes fall through rather than being guessed', () => {
  // A reason Bitstamp reworded: CCXT throws bare ExchangeError, which is
  // deliberately unmapped. It must degrade to OTHER, never to a confident
  // wrong category.
  assertEquals(
    classifyUpstreamError(wire('Some entirely new wording we have never seen'), 'ExchangeError'),
    'UPSTREAM_OTHER',
  );
  assertEquals(classifyUpstreamError('totally unknown', 'NoSuchErrorClass'), 'UPSTREAM_OTHER');
  assertEquals(classifyUpstreamError('totally unknown'), 'UPSTREAM_OTHER');

  // Trading-branch errors are intentionally absent from the map.
  assertEquals(classifyUpstreamError('order rejected', 'InvalidOrder'), 'UPSTREAM_OTHER');
  // NotSupported must NOT become ADAPTER_CONFIG_ERROR: that code tells the
  // customer to reconnect, which cannot fix a capability the exchange lacks.
  assertEquals(classifyUpstreamError('not implemented', 'NotSupported'), 'UPSTREAM_OTHER');
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 must be untouched: every non-CCXT provider still rides the regexes.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('regex tier is unchanged for non-CCXT providers', () => {
  assertEquals(classifyUpstreamError('HTTP 401 Unauthorized'), 'UPSTREAM_AUTH_FAILED');
  assertEquals(classifyUpstreamError('429 rate limit exceeded'), 'UPSTREAM_RATE_LIMITED');
  assertEquals(classifyUpstreamError('error sending request for url'), 'UPSTREAM_UNAVAILABLE');
  assertEquals(classifyUpstreamError('503 service unavailable'), 'UPSTREAM_UNAVAILABLE');
  assertEquals(classifyUpstreamError('400 Bad Request'), 'UPSTREAM_BAD_REQUEST');
  assertEquals(classifyUpstreamError('SyntaxError: Unexpected token < in JSON'), 'UPSTREAM_PARSE_FAILED');
  assertEquals(classifyUpstreamError('[bitstamp] credentials.apiKey required'), 'ADAPTER_CONFIG_ERROR');
  assertEquals(classifyUpstreamError('QUILTT_API_KEY is not set on this Supabase project'), 'ADAPTER_CONFIG_ERROR');
});

Deno.test('tier 1 wins over tier 2 when both would match', () => {
  // The message says "not found", which tier 2 reads as UPSTREAM_BAD_REQUEST.
  // CCXT typed it as an authentication failure, and CCXT is right: the key is
  // rejected, not the request. This single case is why "API key not found"
  // was reaching customers as "Your bank rejected the request".
  assertEquals(classifyUpstreamError(wire('API key not found'), undefined), 'UPSTREAM_BAD_REQUEST');
  assertEquals(
    classifyUpstreamError(wire('API key not found'), 'AuthenticationError'),
    'UPSTREAM_AUTH_FAILED',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// errorClassName's fallback behaviour.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('errorClassName prefers a meaningful name, falls back to the constructor', () => {
  // Built-in subclasses set .name themselves.
  assertEquals(errorClassName(new TypeError('x')), 'TypeError');

  // A plain Error has nothing more specific to offer.
  assertEquals(errorClassName(new Error('x')), 'Error');

  // supabase-js / Postgres shape: name left generic, constructor carries the
  // real type. The constructor fallback must still find it.
  class PostgrestError extends Error {}
  const pg = new PostgrestError('duplicate key value violates unique constraint');
  assertEquals(pg.name, 'Error');
  assertEquals(errorClassName(pg), 'PostgrestError');

  // Non-Error throws keep the previous typeof behaviour.
  assertEquals(errorClassName('a string'), 'string');
  assertEquals(errorClassName(undefined), 'undefined');
  assertEquals(errorClassName(null), 'object');
});

// ─────────────────────────────────────────────────────────────────────────────
// The map itself.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('every mapped class points at a real taxonomy code', () => {
  const valid = new Set([
    'UPSTREAM_AUTH_FAILED',
    'UPSTREAM_RATE_LIMITED',
    'UPSTREAM_UNAVAILABLE',
    'UPSTREAM_BAD_REQUEST',
    'UPSTREAM_PARSE_FAILED',
    'ADAPTER_CONFIG_ERROR',
    'UPSTREAM_OTHER',
  ]);
  for (const [cls, code] of Object.entries(_CCXT_ERROR_CODES_FOR_TEST)) {
    assertEquals(valid.has(code), true, `${cls} maps to unknown code ${code}`);
  }
});

Deno.test('the generic CCXT parents stay unmapped on purpose', () => {
  // If someone adds these to the map, unknown exchange errors start being
  // asserted as a category we have not earned. Pin it.
  for (const generic of ['BaseError', 'ExchangeError']) {
    assertEquals(
      generic in _CCXT_ERROR_CODES_FOR_TEST,
      false,
      `${generic} must stay unmapped so unknown reasons degrade to UPSTREAM_OTHER`,
    );
  }
});
