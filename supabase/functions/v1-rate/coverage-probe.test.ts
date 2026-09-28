// supabase/functions/v1-rate/coverage-probe.test.ts
// Unit tests for classifyCoverage (OR-T0113 follow-up).
//
// classifyCoverage takes the RESULTS of the two bounded coverage probes (the row
// at-or-before the requested bucket, and, only when that is absent, the earliest
// row strictly after it) and returns the same three outcomes the original single
// unbounded probe produced. It does not run a query itself, so these tests do not
// and cannot prove the two live queries are bounded on bucket_ts -- that is a
// property of the `.lte()`/`.gt()` calls in coverage.ts, verified by reading the diff,
// and of the acceptance check on OR-T0113 (a live authenticated call against the
// real endpoint, run by a seat that did not write this fix).
//
// Run with:
//   deno test --no-check --allow-all supabase/functions/v1-rate/coverage-probe.test.ts

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { classifyCoverage } from './coverage.ts'

const ASSET = 'BTC'
const FIAT = 'EUR'
const PRODUCT = 'ORBI-M'
const BUCKET_TS = '2026-09-28T00:05:00.000Z'

Deno.test('covered: a row at-or-before the bucket means the point lookup proceeds', () => {
  const result = classifyCoverage(ASSET, FIAT, PRODUCT, BUCKET_TS, { bucket_ts: '2026-09-28T00:00:00.000Z' }, null)
  assertEquals(result.covered, true)
  assertEquals(result.errorCode, undefined)
})

Deno.test('covered: a row exactly at the requested bucket also counts (the .lte probe includes equality)', () => {
  const result = classifyCoverage(ASSET, FIAT, PRODUCT, BUCKET_TS, { bucket_ts: BUCKET_TS }, null)
  assertEquals(result.covered, true)
})

Deno.test('covered takes priority: an atOrBefore hit is covered even if an after row is also passed', () => {
  const result = classifyCoverage(ASSET, FIAT, PRODUCT, BUCKET_TS, { bucket_ts: '2026-09-28T00:00:00.000Z' }, { bucket_ts: '2026-09-28T00:10:00.000Z' })
  assertEquals(result.covered, true)
})

Deno.test('before_coverage_start: no row at-or-before, but one exists after', () => {
  const result = classifyCoverage(ASSET, FIAT, PRODUCT, BUCKET_TS, null, { bucket_ts: '2026-09-28T00:10:00.000Z' })
  assertEquals(result.covered, false)
  assertEquals(result.errorCode, 'before_coverage_start')
  assertEquals(result.message, `${ASSET}/${FIAT} on ${PRODUCT} has no data before ${BUCKET_TS}; coverage starts at 2026-09-28T00:10:00.000Z`)
})

Deno.test('unsupported_pair: no row at-or-before and none after either', () => {
  const result = classifyCoverage(ASSET, FIAT, PRODUCT, BUCKET_TS, null, null)
  assertEquals(result.covered, false)
  assertEquals(result.errorCode, 'unsupported_pair')
  assertEquals(result.message, `No rate coverage for ${ASSET}/${FIAT} on product ${PRODUCT}`)
})
