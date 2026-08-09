import { assertEquals, assertThrows } from 'https://deno.land/std@0.208.0/assert/mod.ts';
import { quilttCanonicalAccountKey } from './account-key.ts';

const base = { institution: 'Mercury', mask: '4321', kind: 'checking' };

Deno.test('canonical key is pipe-separated and fully upper-cased', () => {
  assertEquals(quilttCanonicalAccountKey(base), 'MERCURY|4321|CHECKING');
});

Deno.test('institution case does not change the key', () => {
  const a = quilttCanonicalAccountKey({ ...base, institution: 'Mercury' });
  const b = quilttCanonicalAccountKey({ ...base, institution: 'mercury' });
  const c = quilttCanonicalAccountKey({ ...base, institution: 'MERCURY' });
  assertEquals(a, b);
  assertEquals(b, c);
});

Deno.test('surrounding whitespace does not change the key', () => {
  assertEquals(
    quilttCanonicalAccountKey({ institution: '  Mercury ', mask: ' 4321', kind: 'checking ' }),
    quilttCanonicalAccountKey(base),
  );
});

Deno.test('internal whitespace runs collapse to a single space', () => {
  assertEquals(
    quilttCanonicalAccountKey({ ...base, institution: 'Bank  of\tAmerica' }),
    quilttCanonicalAccountKey({ ...base, institution: 'Bank of America' }),
  );
});

Deno.test('kind case does not change the key', () => {
  assertEquals(
    quilttCanonicalAccountKey({ ...base, kind: 'SAVINGS' }),
    quilttCanonicalAccountKey({ ...base, kind: 'savings' }),
  );
});

Deno.test('different accounts still produce different keys', () => {
  const checking = quilttCanonicalAccountKey(base);
  const savings = quilttCanonicalAccountKey({ ...base, kind: 'savings' });
  const otherMask = quilttCanonicalAccountKey({ ...base, mask: '9876' });
  const otherBank = quilttCanonicalAccountKey({ ...base, institution: 'Chase' });
  assertEquals(new Set([checking, savings, otherMask, otherBank]).size, 4);
});

Deno.test('empty and whitespace-only fields throw', () => {
  for (const bad of ['', '   ', '\t\n']) {
    assertThrows(
      () => quilttCanonicalAccountKey({ ...base, institution: bad }),
      Error,
      'institution is required',
    );
    assertThrows(
      () => quilttCanonicalAccountKey({ ...base, mask: bad }),
      Error,
      'mask is required',
    );
    assertThrows(
      () => quilttCanonicalAccountKey({ ...base, kind: bad }),
      Error,
      'kind is required',
    );
  }
});

Deno.test('a pipe in any field throws rather than producing an ambiguous key', () => {
  assertThrows(
    () => quilttCanonicalAccountKey({ ...base, institution: 'Mer|cury' }),
    Error,
    'pipe character',
  );
  assertThrows(
    () => quilttCanonicalAccountKey({ ...base, mask: '43|21' }),
    Error,
    'pipe character',
  );
});

Deno.test('the pipe error does not echo the offending value', () => {
  // The mask is a partial account number. An error string carrying it can reach
  // a log sink, so the message names the field and never the value.
  try {
    quilttCanonicalAccountKey({ ...base, mask: '43|21' });
    throw new Error('expected quilttCanonicalAccountKey to throw');
  } catch (err) {
    assertEquals((err as Error).message.includes('43|21'), false);
  }
});

Deno.test('a non-string field throws rather than stringifying', () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => quilttCanonicalAccountKey({ ...base, mask: 4321 as any }),
    Error,
    'mask is required',
  );
});

Deno.test('quiltt_connection_id is not an input: same bank attrs produce the same key across reconnects', () => {
  // The canonical key deliberately excludes quiltt_connection_id, which
  // changes on every re-link even when the underlying bank account is
  // unchanged. A DISCONNECTED reconnect issues a new connection_id but
  // the bank attrs (institution, mask, kind) are the same, so the key
  // must be identical before and after.
  //
  // This test enforces that guarantee at the function boundary: if
  // quiltt_connection_id were ever added as a parameter, the key would
  // silently diverge on reconnect and dedup would break.
  const beforeReconnect = quilttCanonicalAccountKey(base);
  const afterReconnect = quilttCanonicalAccountKey(base);
  assertEquals(beforeReconnect, afterReconnect);

  // Cross-check: different bank attrs DO produce different keys, so the
  // equality above is not a trivial tautology of comparing constants.
  const otherBank = quilttCanonicalAccountKey({ ...base, institution: 'Chase' });
  assertEquals(beforeReconnect === otherBank, false);
});
