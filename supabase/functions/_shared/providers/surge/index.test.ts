import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { decodeTokenEnvelope } from './index.ts';
import { classifyUpstreamError } from '../../upstream-errors.ts';

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
  assertEquals(err.message, '[surge] bearer_token is invalid base64url');
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
  assertEquals(err.message, '[surge] bearer_token envelope is invalid JSON');
});

Deno.test('decodeTokenEnvelope: invalid JSON envelope classifies as UPSTREAM_PARSE_FAILED', () => {
  const err = assertThrows(
    () => decodeTokenEnvelope(toBase64url(`{"borrower":"${MARKER}"`)),
    Error,
  ) as Error;
  assertEquals(classifyUpstreamError(err.message), 'UPSTREAM_PARSE_FAILED');
});

Deno.test('decodeTokenEnvelope: all three malformed input paths throw, none silently succeed', () => {
  // Covers the three throw paths: invalid base64url, invalid JSON from a partial
  // object, and invalid JSON from a bare non-object string.
  //
  // The exact-message assertEquals assertions in the tests above are the
  // regression guard for input leakage. The includes(MARKER) assertion that
  // was here was dropped: V8 echoes only ~11 chars of the offending input in
  // its JSON.parse SyntaxError message, making a 29-char marker undetectable
  // in that path regardless of whether the fix is present.
  const bad_inputs = [
    `not-valid-base64url-${MARKER}!!!`,
    toBase64url(`{"borrower":"${MARKER}"`),
    toBase64url(MARKER),
  ];
  for (const bad of bad_inputs) {
    assertThrows(() => decodeTokenEnvelope(bad), Error);
  }
});
