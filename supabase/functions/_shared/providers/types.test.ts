import { assert, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { parseCredentials, type ProviderAdapter } from './types.ts';

/**
 * Minimal stand-in for a real adapter. parseCredentials only reads `slug` and
 * `credentialFields`, so the rest is deliberately not built: a fuller fake
 * would drift from the real interface without testing anything more.
 */
const adapter = {
  slug: 'test-provider',
  credentialFields: [{ name: 'api_key' }],
} as unknown as ProviderAdapter;

/**
 * A value that appears nowhere except in the input we hand the parser, so if
 * it turns up in the thrown message the only way it could have got there is
 * out of the input itself.
 */
const MARKER = 'ZZmarkerZZ-not-in-any-message';

Deno.test('parseCredentials: a parse failure throws a fixed string', () => {
  const err = assertThrows(
    () => parseCredentials(adapter, `{"api_key":"${MARKER}"`),
    Error,
  ) as Error;
  assert(
    err.message === '[test-provider] credentials are not valid JSON',
    `expected the fixed message, got: ${err.message.slice(0, 40)}`,
  );
});

Deno.test('parseCredentials: no part of the input reaches the thrown message', () => {
  // The contract is a property, not a wording. Asserting only on the literal
  // above would still pass if someone appended the underlying exception, which
  // is the regression this test exists to catch.
  for (const bad of [`{"api_key":"${MARKER}"`, `${MARKER}`, `{${MARKER}}`]) {
    const err = assertThrows(() => parseCredentials(adapter, bad), Error) as Error;
    assert(
      !err.message.includes(MARKER),
      'the thrown message carried input text',
    );
  }
});

Deno.test('parseCredentials: valid JSON with the required field still parses', () => {
  const out = parseCredentials(adapter, '{"api_key":"abc"}');
  assert(out.api_key === 'abc');
});

Deno.test('parseCredentials: a missing required field is still reported by name', () => {
  const err = assertThrows(
    () => parseCredentials(adapter, '{"other":"abc"}'),
    Error,
  ) as Error;
  // Field NAMES are our own schema, not credential material, and callers rely
  // on them. This pins that the fixed-string rule above did not flatten the
  // other errors in this function along with it.
  assert(err.message === '[test-provider] credentials.api_key required');
});
