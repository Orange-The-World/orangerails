/**
 * BYTEA wire encoding for PostgREST.
 *
 * Postgres BYTEA does not travel as raw bytes over PostgREST: it is a string in
 * hex format, a literal backslash-x followed by two lowercase hex digits per
 * byte. Both directions use it.
 *
 * This exists as its own module, rather than a local helper at the call site,
 * because the failure it prevents is silent. Hand a raw Uint8Array to the
 * client and JSON serialisation turns it into an array or an object, which the
 * column accepts and stores as something other than the bytes you meant. The
 * value is then wrong but perfectly self-consistent: it compares equal to
 * itself, so a dedup key built on it still dedups, against the wrong thing, and
 * nothing ever raises. A typecheck cannot see it. A round-trip test can, which
 * is the point of keeping this importable and tested.
 */

/**
 * Encode bytes for a BYTEA column.
 *
 *   toByteaHex(new Uint8Array([0xde, 0xad])) === "\\xdead"
 *
 * Lowercase, two digits per byte, zero padded. Empty input yields "\\x", which
 * is Postgres's representation of an empty BYTEA rather than NULL.
 */
export function toByteaHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return "\\x" + hex;
}
