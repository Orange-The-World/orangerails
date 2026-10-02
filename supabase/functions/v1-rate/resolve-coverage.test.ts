// Unit tests for resolveCoverage, the bounded two-step coverage probe
// introduced for OR-T0113.
//
// Run with:
//   deno test --no-check --allow-all supabase/functions/v1-rate/resolve-coverage.test.ts

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { resolveCoverage, type CoverageClient, type CoverageQuery } from './coverage.ts'

type Row = { bucket_ts: string }
type Resp = { data: Row | null; error: unknown }
type Call = [method: string, ...args: unknown[]]

// Builds a CoverageClient whose chains record every query-builder operation.
// resolveCoverage issues at most one lte probe and, only when that is empty,
// one gt probe.
function mockClient(
  onLte: Resp,
  onGt?: Resp,
): { client: CoverageClient; probes: Call[][] } {
  const probes: Call[][] = []

  const newChain = (): CoverageQuery => {
    const calls: Call[] = []
    probes.push(calls)
    let which: 'lte' | 'gt' | null = null

    const chain: CoverageQuery = {
      eq: (col, val) => { calls.push(['eq', col, val]); return chain },
      is: (col, val) => { calls.push(['is', col, val]); return chain },
      lte: (col, val) => { calls.push(['lte', col, val]); which = 'lte'; return chain },
      gt: (col, val) => { calls.push(['gt', col, val]); which = 'gt'; return chain },
      order: (col, opts) => { calls.push(['order', col, opts]); return chain },
      limit: (n) => { calls.push(['limit', n]); return chain },
      maybeSingle: () => {
        calls.push(['maybeSingle'])
        return Promise.resolve(which === 'lte' ? onLte : (onGt ?? { data: null, error: null }))
      },
    }
    return chain
  }

  return {
    probes,
    client: {
      from: (table) => ({
        select: (cols) => {
          const chain = newChain()
          probes.at(-1)!.push(['from', table], ['select', cols])
          return chain
        },
      }),
    },
  }
}

const P = {
  asset: 'BTC',
  fiat: 'EUR',
  product: 'ORBI-M',
  granularity: '1m',
  bucketTs: '2026-06-01T00:00:00.000Z',
}

const SCOPE_CALLS: Call[] = [
  ['from', 'exchange_rates'],
  ['select', 'bucket_ts'],
  ['eq', 'source_currency', P.asset],
  ['eq', 'target_currency', P.fiat],
  ['eq', 'granularity', P.granularity],
  ['eq', 'product', P.product],
  ['eq', 'source_authority', 'ORBI'],
  ['eq', 'status', 'CONFIRMED'],
  ['is', 'superseded_by_id', null],
]

Deno.test('covered: the bounded lte probe short-circuits the gt probe', async () => {
  const row = { bucket_ts: '2026-05-01T00:00:00.000Z' }
  const { client, probes } = mockClient({ data: row, error: null })

  assertEquals(await resolveCoverage(client, P), { row, error: null })
  assertEquals(probes, [[
    ...SCOPE_CALLS,
    ['lte', 'bucket_ts', P.bucketTs],
    ['order', 'bucket_ts', { ascending: true }],
    ['limit', 1],
    ['maybeSingle'],
  ]])
})

Deno.test('exact-first: lte includes a row exactly at bucketTs', async () => {
  const row = { bucket_ts: P.bucketTs }
  const { client, probes } = mockClient({ data: row, error: null })

  assertEquals(await resolveCoverage(client, P), { row, error: null })
  assertEquals(probes.length, 1)
})

Deno.test('before_coverage_start: the bounded gt probe finds the first later row', async () => {
  const later = { bucket_ts: '2026-06-02T00:00:00.000Z' }
  const { client, probes } = mockClient(
    { data: null, error: null },
    { data: later, error: null },
  )

  assertEquals(await resolveCoverage(client, P), { row: later, error: null })
  assertEquals(probes.length, 2)
  assertEquals(probes[1], [
    ...SCOPE_CALLS,
    ['gt', 'bucket_ts', P.bucketTs],
    ['order', 'bucket_ts', { ascending: true }],
    ['limit', 1],
    ['maybeSingle'],
  ])
})

Deno.test('unsupported_pair: both bounded probes return empty', async () => {
  const { client, probes } = mockClient(
    { data: null, error: null },
    { data: null, error: null },
  )

  assertEquals(await resolveCoverage(client, P), { row: null, error: null })
  assertEquals(probes.length, 2)
})

Deno.test('an lte probe error surfaces without running the gt probe', async () => {
  const error = { message: 'lte failed' }
  const { client, probes } = mockClient({ data: null, error })

  assertEquals(await resolveCoverage(client, P), { row: null, error })
  assertEquals(probes.length, 1)
})

Deno.test('a gt probe error surfaces after an empty lte probe', async () => {
  const error = { message: 'gt failed' }
  const { client, probes } = mockClient(
    { data: null, error: null },
    { data: null, error },
  )

  assertEquals(await resolveCoverage(client, P), { row: null, error })
  assertEquals(probes.length, 2)
})

Deno.test('mixed batch items resolve through independent probe chains', async () => {
  const covered = { bucket_ts: '2026-05-01T00:00:00.000Z' }
  const a = mockClient({ data: covered, error: null })
  const b = mockClient(
    { data: null, error: null },
    { data: null, error: null },
  )

  const [resultA, resultB] = await Promise.all([
    resolveCoverage(a.client, { ...P, fiat: 'EUR' }),
    resolveCoverage(b.client, { ...P, fiat: 'XYZ' }),
  ])

  assertEquals(resultA, { row: covered, error: null })
  assertEquals(a.probes.length, 1)
  assertEquals(resultB, { row: null, error: null })
  assertEquals(b.probes.length, 2)
})
