// Side-effect-free coverage helpers for the v1 rate endpoint.
//
// Keeping this logic separate from index.ts lets focused tests import the
// production query implementation without evaluating the edge entrypoint's
// top-level Deno.serve call.

export interface CoverageRow { bucket_ts: string }

export interface CoverageResult {
  covered: boolean
  errorCode?: 'unsupported_pair' | 'before_coverage_start'
  message?: string
}

// Coverage classification for OR-T0113 (see the two bounded probes in
// resolveCoverage). The three outcomes match the original single unbounded
// probe exactly:
//   atOrBefore present               -> covered: true
//   atOrBefore absent, after present -> before_coverage_start
//   both absent                      -> unsupported_pair
export function classifyCoverage(
  asset: string,
  fiat: string,
  product: string,
  bucketTs: string,
  atOrBefore: CoverageRow | null,
  after: CoverageRow | null,
): CoverageResult {
  if (atOrBefore) return { covered: true }
  if (after) {
    return {
      covered: false,
      errorCode: 'before_coverage_start',
      message: `${asset}/${fiat} on ${product} has no data before ${bucketTs}; coverage starts at ${after.bucket_ts}`,
    }
  }
  return {
    covered: false,
    errorCode: 'unsupported_pair',
    message: `No rate coverage for ${asset}/${fiat} on product ${product}`,
  }
}

// The first probe finds the earliest current row at or before bucketTs. If it
// finds nothing, the second probe finds the earliest current row after
// bucketTs. Both shapes constrain all four leading equality columns and the
// bucket_ts range in idx_rates_lookup; neither can wander into another pair,
// granularity, or product. Keeping the first probe ascending also gives the
// point lookup a known coverage-start lower bound.
export interface CoverageQuery {
  eq(col: string, val: string): CoverageQuery
  is(col: string, val: null): CoverageQuery
  lte(col: string, val: string): CoverageQuery
  gt(col: string, val: string): CoverageQuery
  order(col: string, opts: { ascending: boolean }): CoverageQuery
  limit(n: number): CoverageQuery
  maybeSingle(): PromiseLike<{ data: CoverageRow | null; error: unknown }>
}

export interface CoverageClient {
  from(table: string): { select(cols: string): CoverageQuery }
}

export interface CoverageParams {
  asset: string
  fiat: string
  product: string
  granularity: string
  bucketTs: string
}

export async function resolveCoverage(
  client: CoverageClient,
  p: CoverageParams,
): Promise<{ row: CoverageRow | null; error: unknown }> {
  const scoped = () =>
    client
      .from('exchange_rates')
      .select('bucket_ts')
      .eq('source_currency', p.asset)
      .eq('target_currency', p.fiat)
      .eq('granularity', p.granularity)
      .eq('product', p.product)
      .eq('source_authority', 'ORBI')
      .eq('status', 'CONFIRMED')
      .is('superseded_by_id', null)

  const { data: atOrBefore, error: atOrBeforeErr } = await scoped()
    .lte('bucket_ts', p.bucketTs)
    .order('bucket_ts', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (atOrBeforeErr) return { row: null, error: atOrBeforeErr }
  if (atOrBefore) return { row: atOrBefore, error: null }

  const { data: after, error: afterErr } = await scoped()
    .gt('bucket_ts', p.bucketTs)
    .order('bucket_ts', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (afterErr) return { row: null, error: afterErr }
  return { row: after, error: null }
}
