// Unit tests for resolveCoverage, the bounded two-step coverage probe
// introduced for OR-T0113.
//
// Run with:
//   deno test --no-check --allow-all supabase/functions/v1-rate/resolve-coverage.test.ts
//
// These are builder-mock tests: they mock the Supabase fluent query-builder
// chain (from/select/eq/is/lte/gt/order/limit/maybeSingle) rather than a real
// database, matching this directory's existing convention in
// composite-authority.test.ts of testing small exported pure functions
// directly instead of the unexported Deno.serve handler.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { resolveCoverage, type CoverageClient, type CoverageQuery } from './index.ts'

type Row = { bucket_ts: string }
type Resp = { data: Row | null; error: unknown }

// Builds a CoverageClient whose chain records which of .lte()/.gt() was
// invoked, then answers .maybeSingle() with the matching canned response.
// resolveCoverage issues at most one lte-probe and, only if that comes back
// empty, at most one gt-probe -- so a single canned value per probe is enough
// to drive every branch.
function mockClient(onLte: Resp, onGt?: Resp): { client: CoverageClient; calls: string[] } {
  const calls: string[] = []
  const chain = (which: 'lte' | 'gt' | ''): CoverageQuery => ({
    eq: () => chain(which),
    is: () => chain(which),
    lte: () => { calls.push('lte'); return chain('lte') },
    gt: () => { calls.push('gt'); return chain('gt') },
    order: () => chain(which),
    limit: () => chain(which),
    maybeSingle: () => Promise.resolve(which === 'lte' ? onLte : (onGt ?? { data: null, error: null })),
  })
  return {
    calls,
    client: { from: () => ({ select: () => chain('') }) },
  }
}

const P = { asset: 'BTC', fiat: 'EUR', product: 'ORBI-M', granularity: '1m', bucketTs: '2026-06-01T00:00:00.000Z' }

// ----- covered -----

Deno.test('covered: a row at or before bucketTs short-circuits, the gt-probe never runs', async () => {
  const row = { bucket_ts: '2026-05-31T23:59:00.000Z' }
  const { client, calls } = mockClient({ data: row, error: null })
  const result = await resolveCoverage(client, P)
  assertEquals(result, { row, error: null })
  assertEquals(calls, ['lte'])
})

// ----- bounds / exact-first -----

Deno.test('exact-first: bucketTs exactly on an existing row is covered (lte is inclusive)', async () => {
  const row = { bucket_ts: P.bucketTs }
  const { client, calls } = mockClient({ data: row, error: null })
  const result = await resolveCoverage(client, P)
  assertEquals(result, { row, error: null })
  assertEquals(calls, ['lte'])
})

// ----- before_coverage_start -----

Deno.test('before_coverage_start: nothing at or before, something strictly after', async () => {
  const later = { bucket_ts: '2026-06-02T00:00:00.000Z' }
  const { client, calls } = mockClient({ data: null, error: null }, { data: later, error: null })
  const result = await resolveCoverage(client, P)
  assertEquals(result, { row: later, error: null })
  assertEquals(calls, ['lte', 'gt'])
})

// ----- unsupported_pair -----

Deno.test('unsupported_pair: nothing at or before, and nothing after either', async () => {
  const { client, calls } = mockClient({ data: null, error: null }, { data: null, error: null })
  const result = await resolveCoverage(client, P)
  assertEquals(result, { row: null, error: null })
  assertEquals(calls, ['lte', 'gt'])
})

// ----- error -----

Deno.test('error on the lte-probe surfaces immediately, the gt-probe never runs', async () => {
  const dbErr = { message: 'boom' }
  const { client, calls } = mockClient({ data: null, error: dbErr })
  const result = await resolveCoverage(client, P)
  assertEquals(result, { row: null, error: dbErr })
  assertEquals(calls, ['lte'])
})

Deno.test('error on the gt-probe surfaces after the lte-probe comes back empty', async () => {
  const dbErr = { message: 'boom' }
  const { client, calls } = mockClient({ data: null, error: null }, { data: null, error: dbErr })
  const result = await resolveCoverage(client, P)
  assertEquals(result, { row: null, error: dbErr })
  assertEquals(calls, ['lte', 'gt'])
})

// ----- mixed-batch -----

Deno.test('mixed-batch: two items in the same batch resolve independently through separate probes', async () => {
  const covered = { bucket_ts: '2026-05-31T23:59:00.000Z' }
  const a = mockClient({ data: covered, error: null })
  const b = mockClient({ data: null, error: null }, { data: null, error: null })

  const [resultA, resultB] = await Promise.all([
    resolveCoverage(a.client, { ...P, asset: 'BTC', fiat: 'EUR' }),
    resolveCoverage(b.client, { ...P, asset: 'BTC', fiat: 'XYZ' }),
  ])

  assertEquals(resultA, { row: covered, error: null })
  assertEquals(a.calls, ['lte'])
  assertEquals(resultB, { row: null, error: null })
  assertEquals(b.calls, ['lte', 'gt'])
})
