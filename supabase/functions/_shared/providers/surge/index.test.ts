import { assert, assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { decodeTokenEnvelope } from './index.ts';
import { classifyUpstreamError } from '../upstream-errors.ts';

/**
 * A value that appears nowhere except in the input we hand the decoder, so if
 * it turns up in a thrown message the only way it could have got there is out
 * of the input itself.
 */
const MARKER = 'ZZmarkerZZ-not-in-any-message';

function toBase64url(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

Deno.test('decodeTokenEnvelope: invalid base64url throws a fixed string', () => {
  const err = assertThrows(
    () => decodeTokenEnvelope(`not-valid-base64url-${MARKER}!!!`),
    Error,
  ) as Error;
  assertEquals(err.message, '[surge] bearer_token is not valid base64url');
});

Deno.test('decodeTokenEnvelope: invalid base64url classifies as UPSTREAM_PARSE_FAILED', () => {
  // Regression coupling test (OR-T2697, same shape as OR-T2643 on
  // parseCredentials): the fixed string above must stay inside the tier 2
  // pattern in upstream-errors.ts, or this silently reclassifies as
  // UPSTREAM_OTHER with a different customer-facing code.
  const err = assertThrows(
    () => decodeTokenEnvelope(`not-valid-base64url-${MARKER}!!!`),
    Error,
  ) as Error;
  assertEquals(classifyUpstreamError(err.message), 'UPSTREAM_PARSE_FAILED');
});

Deno.test('decodeTokenEnvelope: invalid JSON envelope throws a fixed string', () => {
  const err = assertThrows(
    () => decodeTokenEnvelope(toBase64url(`{"borrower":"${MARKER}"`)),
    Error,
  ) as Error;
  assertEquals(err.message, '[surge] bearer_token envelope is not valid JSON');
});

Deno.test('decodeTokenEnvelope: invalid JSON envelope classifies as UPSTREAM_PARSE_FAILED', () => {
  const err = assertThrows(
    () => decodeTokenEnvelope(toBase64url(`{"borrower":"${MARKER}"`)),
    Error,
  ) as Error;
  assertEquals(classifyUpstreamError(err.message), 'UPSTREAM_PARSE_FAILED');
});

Deno.test('decodeTokenEnvelope: no part of the input reaches either thrown message', () => {
  // The contract is a property, not a wording. Asserting only on the literal
  // above would still pass if someone appended the underlying exception back
  // in, which is the regression this test exists to catch.
  const bad_inputs = [
    `not-valid-base64url-${MARKER}!!!`,
    toBase64url(`{"borrower":"${MARKER}"`),
    toBase64url(MARKER),
  ];
  for (const bad of bad_inputs) {
    const err = assertThrows(() => decodeTokenEnvelope(bad), Error) as Error;
    assert(!err.message.includes(MARKER), 'the thrown message carried input text');
  }
});
