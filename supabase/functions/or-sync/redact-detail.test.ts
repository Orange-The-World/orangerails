/**
 * DL-1292 (amends audit 2026-05-16 finding #1): the UPSTREAM_OTHER edge-log
 * detail must be human-readable AND must never emit a shape the fingerprint
 * hash path (errorFingerprint) would have scrubbed. These pin that guarantee.
 *
 * Run with:
 *   deno test --no-check --allow-all supabase/functions/or-sync/redact-detail.test.ts
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { redactedUpstreamDetail, upstreamDetailSuffix } from './index.ts';

Deno.test('redacts a provider id', () => {
  const out = redactedUpstreamDetail('Quiltt rejected connection cus_ab12CD34ef for account');
  assert(!out.includes('cus_ab12CD34ef'), out);
  assert(out.includes('cus_[redacted]'), out);
});

Deno.test('redacts a 6+ digit run', () => {
  const out = redactedUpstreamDetail('upstream 402 for member 998877665544');
  assert(!out.includes('998877665544'), out);
  assert(out.includes('[redacted]'), out);
});

Deno.test('redacts a UUID', () => {
  const out = redactedUpstreamDetail('failed on 550e8400-e29b-41d4-a716-446655440000 mid-sync');
  assert(!out.includes('550e8400-e29b-41d4-a716-446655440000'), out);
  assert(out.includes('<uuid>'), out);
});

Deno.test('redacts a base64/token blob', () => {
  const blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9w';
  const out = redactedUpstreamDetail(`token ${blob} was rejected`);
  assert(!out.includes(blob), out);
  assert(out.includes('<token>'), out);
});

Deno.test('only the first line is emitted', () => {
  const out = redactedUpstreamDetail('first line only\nsecond line has cus_secret123456');
  assertEquals(out, 'first line only');
});

Deno.test('redaction runs before the length limit, so truncation cannot cut a secret in half', () => {
  // A UUID that begins near the 300-char boundary must be fully redacted, not
  // left as a fragment by the length limit. Redaction runs on the full line
  // first, so the whole UUID is gone before any slice.
  const filler = 'x'.repeat(285);
  const out = redactedUpstreamDetail(`${filler} 550e8400-e29b-41d4-a716-446655440000 tail`);
  assert(!out.includes('550e8400'), out);
});

Deno.test('detail suffix is present only on UPSTREAM_OTHER', () => {
  const raw = 'boom cus_ab12CD34ef';
  const other = upstreamDetailSuffix('UPSTREAM_OTHER', raw);
  assert(other.startsWith(' detail='), other);
  assert(!other.includes('cus_ab12CD34ef'), other);
  assertEquals(upstreamDetailSuffix('UPSTREAM_AUTH', raw), '');
  assertEquals(upstreamDetailSuffix('RATE_LIMIT', raw), '');
});
