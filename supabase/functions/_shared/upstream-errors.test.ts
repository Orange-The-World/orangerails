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
  _CLASS_NAME_SHAPE_FOR_TEST,
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
  // Object.prototype pollution: inherited names must not escape as taxonomy codes.
  assertEquals(classifyUpstreamError('x', 'toString'), 'UPSTREAM_OTHER');
  assertEquals(classifyUpstreamError('x', 'constructor'), 'UPSTREAM_OTHER');
  assertEquals(classifyUpstreamError('x', 'hasOwnProperty'), 'UPSTREAM_OTHER');

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
// The clamp.
//
// `e.name` is an ordinary writable property, not a structural guarantee like
// `constructor.name`. Its value reaches the edge log's class= field, the error
// tracker's exception type, and the fingerprint input -- the last of which
// concatenates it ahead of the redaction applied to the message. So an
// upstream library that puts a sentence, a URL, or an echoed request body in
// `name` must not be able to push it onto those surfaces.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('a non-identifier name falls back to the constructor', () => {
  class RealTypeSurvives extends Error {}

  const hostile: Array<[string, string]> = [
    ['Auth failed for user@example.com', 'a whole sentence with an address'],
    ['Bearer sk-live-abcdef0123456789', 'a credential-shaped string'],
    ['https://api.example.com/v1/keys?token=abc', 'a URL with a query token'],
    ['Error: {"apiKey":"secret"}', 'an echoed request body'],
    ['line one\nline two', 'a newline, which would forge a second log line'],
    ['A'.repeat(65), 'one character past the 64 character bound'],
    ['9LeadingDigit', 'not a valid identifier start'],
    ['', 'empty'],
  ];

  for (const [name, why] of hostile) {
    const e = new RealTypeSurvives('boom');
    e.name = name;
    assertEquals(
      errorClassName(e),
      'RealTypeSurvives',
      `name that is ${why} must not be returned; expected the constructor`,
    );
  }

  // Exactly at the bound is fine: 1 leading char + 63 more = 64.
  const ok = new RealTypeSurvives('boom');
  ok.name = 'A' + 'b'.repeat(63);
  assertEquals(errorClassName(ok), ok.name);
});

Deno.test('errorClassName always returns an identifier-shaped token', () => {
  // The guarantee three call sites depend on, asserted over every input shape
  // above rather than trusting the implementation to keep honouring it.
  const inputs: unknown[] = [
    new Error('plain'),
    new TypeError('builtin'),
    new C(wire('Invalid signature')),
    'a string',
    undefined,
    null,
    42,
  ];
  const named = new Error('x');
  named.name = 'not an identifier at all!';
  inputs.push(named);

  const noName = new Error('y');
  // Some runtimes hand back a non-string name on exotic objects.
  Object.defineProperty(noName, 'name', { value: 12345 });
  inputs.push(noName);

  for (const input of inputs) {
    const out = errorClassName(input);
    assertEquals(
      _CLASS_NAME_SHAPE_FOR_TEST.test(out),
      true,
      `errorClassName returned ${JSON.stringify(out)}, which is not identifier-shaped`,
    );
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Wiring guard.
//
// This file's other tests all pass against a version of this PR in which the
// module exists, is correct, is fully tested, and IS CALLED BY NOTHING. That
// happened: a stray `git checkout <branch> -- .` staged a revert of the call
// sites, the next commit swept it in, and every check stayed green because the
// unit tests only ever exercised this module directly.
//
// A green suite that cannot tell "wired in" from "dead code" is not measuring
// the thing the PR exists to change. These assertions read the consuming
// sources as text, which is blunt, but bluntness is the point: they fail when
// the call sites disappear, which is the exact failure mode that shipped.
// ─────────────────────────────────────────────────────────────────────────────

const readSource = (rel: string) =>
  Deno.readTextFileSync(new URL(rel, import.meta.url));

Deno.test('or-sync imports the classifier and passes the error class to it', () => {
  const src = readSource('../or-sync/index.ts');

  assertEquals(
    /import\s*\{[^}]*\bclassifyUpstreamError\b[^}]*\}\s*from\s*['"][^'"]*upstream-errors\.ts['"]/.test(src),
    true,
    'or-sync must import classifyUpstreamError from _shared/upstream-errors.ts',
  );
  assertEquals(
    /import\s*\{[^}]*\berrorClassName\b[^}]*\}\s*from\s*['"][^'"]*upstream-errors\.ts['"]/.test(src),
    true,
    'or-sync must import errorClassName from _shared/upstream-errors.ts',
  );

  // The whole fix is that tier 1 actually fires. A call with only the message
  // silently reverts every CCXT error to the regex tier.
  assertEquals(
    /classifyUpstreamError\(\s*raw\s*,\s*errorClass\s*\)/.test(src),
    true,
    'or-sync must pass the error class as the second argument, or tier 1 never fires',
  );

  // No local redefinition: a second copy here is how the two drift apart.
  assertEquals(
    /function\s+classifyUpstreamError\s*\(/.test(src),
    false,
    'or-sync must not define its own classifyUpstreamError',
  );
});

Deno.test('sentry reports the error class rather than the mangled constructor', () => {
  const src = readSource('./sentry.ts');

  assertEquals(
    /import\s*\{[^}]*\berrorClassName\b[^}]*\}\s*from\s*['"]\.\/upstream-errors\.ts['"]/.test(src),
    true,
    'sentry.ts must import errorClassName',
  );
  // The exception `type` is the grouping key. constructor.name there is how
  // unrelated CCXT issues got grouped under "C".
  assertEquals(
    /type:\s*isErr\s*\?\s*errorClassName\(err\)/.test(src),
    true,
    'sentry.ts must report errorClassName as the exception type',
  );
  // Comments in that file discuss constructor.name on purpose, so strip
  // comments before asserting that no code path still reads it.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assertEquals(
    /constructor\s*\.\s*name/.test(code),
    false,
    'sentry.ts must not read constructor.name; minified bundles mangle it',
  );
});

Deno.test('customer copy stays provider neutral', () => {
  const src = readSource('./error-catalog.ts');

  // OR connects to 98 crypto exchanges as well as banks. Bank-specific copy on
  // a shared taxonomy tells a Bitstamp customer their "bank" disconnected.
  const entries = src.split('export const ERROR_CATALOG')[1] ?? '';
  for (const field of ['title', 'body', 'action']) {
    const re = new RegExp(`${field}:\\s*"([^"]*)"`, 'g');
    for (const m of entries.matchAll(re)) {
      assertEquals(
        /\bbank\b/i.test(m[1]),
        false,
        `${field} copy must be provider neutral, found: ${JSON.stringify(m[1])}`,
      );
    }
  }
});
