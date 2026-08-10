/**
 * Unit tests for or-sync/_connection-result.ts.
 *
 * Run with:
 *   deno test --no-check --allow-read supabase/functions/or-sync/_connection-result.test.ts
 *
 * Covers readSyncCompleteness: the function that turns an adapter's SyncResult
 * into connection health fields (status + denied_sources) without requiring
 * a live Supabase client or a Deno.serve call.
 */

import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { readSyncCompleteness } from './_connection-result.ts';
import type { SyncResult } from '../_shared/providers/types.ts';

function syncResult(
  opts: Partial<Pick<SyncResult, 'partial' | 'denied_sources'>> = {},
): SyncResult {
  return { transactions: [], next_cursor: null, ...opts };
}

// ── 1. Complete syncs: status='active', no extra keys ────────────────────────

Deno.test('complete sync with no fields: status=active', () => {
  const out = readSyncCompleteness(syncResult());
  assertEquals(out.status, 'active');
  assertEquals(out.denied_sources, undefined);
});

Deno.test('explicit partial=false + no denied: status=active', () => {
  const out = readSyncCompleteness(syncResult({ partial: false }));
  assertEquals(out.status, 'active');
  assertEquals(out.denied_sources, undefined);
});

Deno.test('empty denied_sources array + no partial flag: treated as complete', () => {
  const out = readSyncCompleteness(syncResult({ denied_sources: [] }));
  assertEquals(out.status, 'active');
  assertEquals(out.denied_sources, undefined);
});

// ── 2. Partial via the partial flag ──────────────────────────────────────────

Deno.test('partial=true + no denied: status=partial, no denied_sources key', () => {
  const out = readSyncCompleteness(syncResult({ partial: true }));
  assertEquals(out.status, 'partial');
  assertEquals('denied_sources' in out, false);
});

Deno.test('partial=true + empty denied array: status=partial, no denied_sources key', () => {
  const out = readSyncCompleteness(syncResult({ partial: true, denied_sources: [] }));
  assertEquals(out.status, 'partial');
  assertEquals('denied_sources' in out, false);
});

// ── 3. Partial via denied_sources (denied wins even when partial=false) ───────

Deno.test('partial=false + one denied: denied wins, status=partial', () => {
  const out = readSyncCompleteness(syncResult({ partial: false, denied_sources: ['withdrawals'] }));
  assertEquals(out.status, 'partial');
  assertEquals(out.denied_sources, ['withdrawals']);
});

Deno.test('no partial field + one denied: status=partial, denied_sources forwarded', () => {
  const out = readSyncCompleteness(syncResult({ denied_sources: ['withdrawals'] }));
  assertEquals(out.status, 'partial');
  assertEquals(out.denied_sources, ['withdrawals']);
});

Deno.test('partial=true + one denied: status=partial, denied_sources forwarded', () => {
  const out = readSyncCompleteness(syncResult({ partial: true, denied_sources: ['withdrawals'] }));
  assertEquals(out.status, 'partial');
  assertEquals(out.denied_sources, ['withdrawals']);
});

Deno.test('multiple denied sources: all forwarded in order', () => {
  const denied = ['trades', 'deposits', 'withdrawals'];
  const out = readSyncCompleteness(syncResult({ denied_sources: denied }));
  assertEquals(out.status, 'partial');
  assertEquals(out.denied_sources, denied);
});

// ── 4. Additive contract: field PRESENCE not just value ──────────────────────

Deno.test('additive contract: complete sync result has only the status key', () => {
  const out = readSyncCompleteness(syncResult());
  assertEquals(Object.keys(out), ['status']);
});

Deno.test('additive contract: partial-by-flag result has no denied_sources key', () => {
  const out = readSyncCompleteness(syncResult({ partial: true }));
  assertEquals('denied_sources' in out, false);
});

Deno.test('additive contract: denied result has denied_sources key present', () => {
  const out = readSyncCompleteness(syncResult({ denied_sources: ['withdrawals'] }));
  assert('denied_sources' in out);
});
