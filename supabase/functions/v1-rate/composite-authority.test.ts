// supabase/functions/v1-rate/composite-authority.test.ts
// Unit tests for extractCompositeAuthority parser (DL-1361)
//
// Covers the real stored composite_via forms found in prod:
//   standard  BTC-USD * USD-CCY-AUTH          (e.g. USD-NGN-CBN)
//   peg       BTC-USD * USD-CCY-PEG           dominant form, 373k+ rows, 22 currencies
//   dated     BTC-USD * USD-CCY-AUTH-YYYY-MM-DD  (e.g. USD-CNY-ECB-2026-06-19)
//   null/malformed inputs
//
// Run with:
//   deno test --no-check --allow-all supabase/functions/v1-rate/composite-authority.test.ts

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { extractCompositeAuthority } from './index.ts'

// --- null / missing input ---

Deno.test('null input returns null', () => {
  assertEquals(extractCompositeAuthority(null), null)
})

Deno.test('undefined input returns null', () => {
  assertEquals(extractCompositeAuthority(undefined), null)
})

Deno.test('empty string returns null', () => {
  assertEquals(extractCompositeAuthority(''), null)
})

// --- no star segment (non-composite rows) ---

Deno.test('no star segment returns null', () => {
  assertEquals(extractCompositeAuthority('BTC-USD'), null)
})

Deno.test('star present but nothing after it returns null', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * '), null)
})

// --- too few segments after star ---

Deno.test('one segment after star (USD only) returns null', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD'), null)
})

Deno.test('two segments after star (USD-CCY only) returns null', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-NGN'), null)
})

// --- standard form: BTC-USD * USD-{TARGET}-{AUTHORITY} ---

Deno.test('standard form: USD-NGN-CBN -> CBN', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-NGN-CBN'), 'CBN')
})

Deno.test('standard form: USD-UAH-NBU -> NBU', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-UAH-NBU'), 'NBU')
})

Deno.test('standard form: USD-RUB-CBR -> CBR', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-RUB-CBR'), 'CBR')
})

// --- peg-derived form: BTC-USD * USD-{TARGET}-PEG ---
// PEG is a construction method, not a data-source institution.
// These are the dominant form: 373,213 rows across 22 currencies in prod.
// They should surface data_source_authority:null and rate_type:'market'.

Deno.test('peg form: USD-HKD-PEG -> null (PEG is not an authority)', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-HKD-PEG'), null)
})

Deno.test('peg form: USD-SAR-PEG -> null', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-SAR-PEG'), null)
})

Deno.test('peg form: USD-AED-PEG -> null', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-AED-PEG'), null)
})

// --- dated form: BTC-USD * USD-{TARGET}-{AUTHORITY}-YYYY-MM-DD ---
// Date suffix is stripped; the segment before the date is the authority.
// 276 rows on date "19", 165 rows on date "23" in prod.

Deno.test('dated form: USD-CNY-ECB-2026-06-19 -> ECB', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-CNY-ECB-2026-06-19'), 'ECB')
})

Deno.test('dated form: USD-CNY-ECB-2026-06-23 -> ECB', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-CNY-ECB-2026-06-23'), 'ECB')
})

Deno.test('dated form: USD-MXN-BANXICO-2026-01-01 -> BANXICO', () => {
  assertEquals(extractCompositeAuthority('BTC-USD * USD-MXN-BANXICO-2026-01-01'), 'BANXICO')
})

// --- rate_type mapping: non-null authority -> 'official_reference', null -> 'market' ---
// Whitelist dropped (DL-1361 round 2): any non-null result from extractCompositeAuthority
// maps to 'official_reference'. PEG rows return null and stay 'market'.

Deno.test('ECB (outside old hardcoded whitelist): non-null authority -> official_reference', () => {
  const auth = extractCompositeAuthority('BTC-USD * USD-CNY-ECB-2026-06-19')
  assertEquals(auth, 'ECB')
  assertEquals(auth !== null ? 'official_reference' : 'market', 'official_reference')
})

Deno.test('CBN: non-null authority -> official_reference', () => {
  const auth = extractCompositeAuthority('BTC-USD * USD-NGN-CBN')
  assertEquals(auth, 'CBN')
  assertEquals(auth !== null ? 'official_reference' : 'market', 'official_reference')
})

Deno.test('PEG: null authority -> market, not official_reference', () => {
  const auth = extractCompositeAuthority('BTC-USD * USD-HKD-PEG')
  assertEquals(auth, null)
  assertEquals(auth !== null ? 'official_reference' : 'market', 'market')
})
