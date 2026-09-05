/**
 * Tests for DL-1490: the connection list must return a sentence, not just a code.
 *
 * Run with:
 *   deno test supabase/functions/or-connection-list/error-copy.test.ts
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { withErrorCopy } from './error-copy.ts';

const AUTH_FAILED_ROW = {
  id: 'conn-1',
  provider_type: 'bitstamp',
  status: 'error',
  encrypted_last_error: 'UPSTREAM_AUTH_FAILED:b1f8c74eef0ed7be',
};

Deno.test('DL-1490: a sink-mode failure gains copy a person can read', () => {
  const out = withErrorCopy(AUTH_FAILED_ROW, true) as Record<string, unknown>;

  assertEquals(out.error, 'UPSTREAM_AUTH_FAILED', 'the machine-readable code is surfaced separately');
  assertEquals(out.correlation_id, 'b1f8c74eef0ed7be', 'the correlation id is split out so it can be matched against the edge logs');
  assertEquals(
    out.message,
    'This account needs to be reconnected',
    'this is the whole point of the ticket: the list endpoint must return a sentence, not just a code',
  );
  assertEquals(out.action, 'Reconnect this account', 'the action tells the customer what to do');
  assertEquals(typeof out.detail, 'string', 'the body copy is present');
});

Deno.test('DL-1490: the change is additive, every existing field survives', () => {
  const out = withErrorCopy(AUTH_FAILED_ROW, true) as Record<string, unknown>;

  assertEquals(out.id, 'conn-1');
  assertEquals(out.provider_type, 'bitstamp');
  assertEquals(out.status, 'error');
  assertEquals(
    out.encrypted_last_error,
    'UPSTREAM_AUTH_FAILED:b1f8c74eef0ed7be',
    'the raw column must be preserved: existing clients read it and must keep working',
  );
});

Deno.test('DL-1490: a non-sink platform is never decorated', () => {
  // On a legacy platform the column is ciphertext. Interpreting it would hand
  // the caller a confident wrong sentence, which is worse than no sentence.
  const out = withErrorCopy(AUTH_FAILED_ROW, false);
  assertEquals('message' in out, false);
  assertEquals('error' in out, false);
});

Deno.test('DL-1490: ciphertext is not mistaken for a code', () => {
  const ciphertext = {
    id: 'conn-2',
    encrypted_last_error: 'k4Xq+9zZ0aBcD3ef/GhIjKlMnOpQrStUvWxYz01234567==',
  };
  const out = withErrorCopy(ciphertext, true);
  assertEquals(
    'message' in out,
    false,
    'the shape guard is the second line of defence behind the sink-mode gate',
  );
});

Deno.test('DL-1490: a healthy connection is left exactly as it was', () => {
  const healthy = { id: 'conn-3', status: 'active', encrypted_last_error: null };
  const out = withErrorCopy(healthy, true);
  assertEquals(out, healthy);
});

Deno.test('DL-1490: an unrecognised code still yields copy rather than crashing', () => {
  // lookupErrorCopy falls back to UPSTREAM_OTHER by design, so a code shipped
  // by a newer function than this one still produces something showable.
  const out = withErrorCopy(
    { id: 'conn-4', encrypted_last_error: 'UPSTREAM_SOMETHING_NEW:0123456789abcdef' },
    true,
  ) as Record<string, unknown>;

  assertEquals(out.error, 'UPSTREAM_SOMETHING_NEW', 'the real code is reported, not the fallback code');
  assertEquals(typeof out.message, 'string');
  assertEquals(String(out.message).length > 0, true, 'a future code must never surface as an empty message');
});
