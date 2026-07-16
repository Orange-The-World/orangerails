/**
 * Deno tests for the BYTEA wire encoding.
 *
 * Run with:
 *   deno test supabase/functions/_shared/bytea.test.ts
 *
 * The failure being pinned is a silent one. A raw Uint8Array handed to the
 * client serialises to JSON as an array or an object, which the BYTEA column
 * accepts and stores as something other than the intended bytes. The stored
 * value is then wrong but self-consistent: it still compares equal to itself,
 * so a dedup key built on it still dedups, against the wrong thing, and nothing
 * raises. Typechecking cannot see it, so a round trip is the only thing that
 * proves it.
 *
 * decodeByteaHex below is written independently of the production encoder, on
 * purpose. A round trip through a decoder derived from the encoder would agree
 * with a shared bug; this one is the format read back from first principles.
 */

import { assertEquals, assertThrows } from
  'https://deno.land/std@0.224.0/assert/mod.ts';
import { toByteaHex } from './bytea.ts';

/** Independent reader for Postgres hex-format BYTEA: \x then two hex digits per byte. */
function decodeByteaHex(encoded: string): Uint8Array {
  if (!encoded.startsWith('\\x')) {
    throw new Error(`not hex-format BYTEA: ${encoded.slice(0, 8)}`);
  }
  const hex = encoded.slice(2);
  if (hex.length % 2 !== 0) throw new Error('odd number of hex digits');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('non-hex digit');
    out[i] = byte;
  }
  return out;
}

Deno.test('round trip: 32 bytes of fingerprint survive encode then decode unchanged', () => {
  // The real shape: HMAC-SHA256 output is 32 bytes, which is what lands in
  // source_wallets.wallet_fingerprint.
  const original = new Uint8Array(32);
  for (let i = 0; i < 32; i++) original[i] = (i * 7 + 3) & 0xff;

  const decoded = decodeByteaHex(toByteaHex(original));

  assertEquals(decoded.length, 32);
  assertEquals(Array.from(decoded), Array.from(original));
});

Deno.test('round trip: every byte value 0..255 survives', () => {
  const original = new Uint8Array(256);
  for (let i = 0; i < 256; i++) original[i] = i;
  assertEquals(Array.from(decodeByteaHex(toByteaHex(original))), Array.from(original));
});

Deno.test('encodes to the literal Postgres hex format', () => {
  assertEquals(toByteaHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), '\\xdeadbeef');
});

Deno.test('pads each byte to two digits', () => {
  // The bug this catches: a byte below 0x10 rendered as one digit shifts every
  // subsequent byte by a nibble, so the whole value decodes to something else.
  assertEquals(toByteaHex(new Uint8Array([0x00, 0x01, 0x0f, 0xff])), '\\x00010fff');
});

Deno.test('emits lowercase hex', () => {
  // Postgres accepts either case, but the value is compared as a string when
  // read back through PostgREST, so the encoder must not drift between cases.
  const encoded = toByteaHex(new Uint8Array([0xab, 0xcd, 0xef]));
  assertEquals(encoded, encoded.toLowerCase());
  assertEquals(encoded, '\\xabcdef');
});

Deno.test('a 32-byte value encodes to exactly 66 characters', () => {
  // \x plus 64 hex digits. If this is 64 or 32, something upstream handed over
  // a string or an array rather than raw bytes.
  assertEquals(toByteaHex(new Uint8Array(32)).length, 66);
});

Deno.test('empty input encodes to an empty BYTEA, not NULL', () => {
  assertEquals(toByteaHex(new Uint8Array(0)), '\\x');
});

Deno.test('a JSON-serialised array is not mistaken for the hex format', () => {
  // What going wrong actually looks like: JSON.stringify on a Uint8Array yields
  // an object, and passing that through instead of the encoder must not read
  // back as bytes.
  assertThrows(() => decodeByteaHex(JSON.stringify(new Uint8Array([1, 2, 3]))));
  assertThrows(() => decodeByteaHex('[1,2,3]'));
});
