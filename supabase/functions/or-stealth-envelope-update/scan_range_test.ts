/**
 * Unit tests for scan-range recording in or-stealth-envelope-update (OR-T1953).
 *
 * Before this fix, buildScanRangeArgs returned a bare null for two unrelated
 * reasons (a malformed request, and a well-formed one whose from_height
 * exceeds last_block_scanned), and recordScanRange dropped both silently.
 * These tests exercise both causes separately and prove each is now logged
 * with a distinct, named reason.
 *
 * Run with: deno test --no-check supabase/functions/or-stealth-envelope-update/
 */

// @ts-nocheck -- matches the --no-check CI flag; type coverage is the ratchet job.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { buildScanRangeArgs, recordScanRange } from './scan_range.ts';

const baseReq = {
  connection_id: 'conn-1',
  app_user_id: 'user-1',
  last_block_scanned: 100,
};

// --- buildScanRangeArgs: the two null causes are now distinguishable ---

Deno.test('valid request: ok=true with RPC args built from the caller identity', () => {
  const decision = buildScanRangeArgs({ ...baseReq, from_height: 50 });
  assertEquals(decision, {
    ok: true,
    args: {
      p_connection_id: 'conn-1',
      p_from_height: 50,
      p_to_height: 100,
      p_app_user_id: 'user-1',
    },
  });
});

Deno.test('malformed: from_height missing -- reason is malformed', () => {
  const decision = buildScanRangeArgs({ ...baseReq });
  assertEquals(decision, { ok: false, reason: 'malformed' });
});

Deno.test('malformed: from_height not an integer -- reason is malformed', () => {
  const decision = buildScanRangeArgs({ ...baseReq, from_height: 1.5 });
  assertEquals(decision, { ok: false, reason: 'malformed' });
});

Deno.test('malformed: from_height negative -- reason is malformed', () => {
  const decision = buildScanRangeArgs({ ...baseReq, from_height: -1 });
  assertEquals(decision, { ok: false, reason: 'malformed' });
});

Deno.test('range exceeded: from_height above last_block_scanned -- distinct reason, not malformed', () => {
  const decision = buildScanRangeArgs({ ...baseReq, from_height: 101 });
  assertEquals(decision, { ok: false, reason: 'range_exceeds_last_block_scanned' });
});

Deno.test('boundary: from_height equal to last_block_scanned is valid, not exceeded', () => {
  const decision = buildScanRangeArgs({ ...baseReq, from_height: 100 });
  assertEquals(decision.ok, true);
});

// --- recordScanRange: both causes must log a distinct line, and never call the RPC ---

async function captureConsoleError(fn: () => Promise<void>): Promise<string[]> {
  const calls: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    calls.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return calls;
}

Deno.test('recordScanRange: malformed request logs a line naming "malformed", never calls the RPC', async () => {
  let rpcCalled = false;
  const client = {
    rpc: () => {
      rpcCalled = true;
      return Promise.resolve({ error: null });
    },
  };
  const calls = await captureConsoleError(() => recordScanRange(client, { ...baseReq }));
  assertEquals(rpcCalled, false);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].includes('malformed'), true);
});

Deno.test('recordScanRange: from_height above last_block_scanned logs that exact reason, never calls the RPC', async () => {
  let rpcCalled = false;
  const client = {
    rpc: () => {
      rpcCalled = true;
      return Promise.resolve({ error: null });
    },
  };
  const calls = await captureConsoleError(() =>
    recordScanRange(client, { ...baseReq, from_height: 101 })
  );
  assertEquals(rpcCalled, false);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].includes('range_exceeds_last_block_scanned'), true);
});

Deno.test('recordScanRange: valid request calls the RPC with the built args and logs nothing', async () => {
  let rpcArgs: unknown = null;
  const client = {
    rpc: (_name: string, args: unknown) => {
      rpcArgs = args;
      return Promise.resolve({ error: null });
    },
  };
  const calls = await captureConsoleError(() =>
    recordScanRange(client, { ...baseReq, from_height: 50 })
  );
  assertEquals(calls.length, 0);
  assertEquals(rpcArgs, {
    p_connection_id: 'conn-1',
    p_from_height: 50,
    p_to_height: 100,
    p_app_user_id: 'user-1',
  });
});
