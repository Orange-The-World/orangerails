/**
 * Unit tests for the cursor-advance guard in or-stealth-envelope-update.
 *
 * Tests the pure evaluateForwardOnly() function, which mirrors the database-level
 * condition used in the production UPDATE:
 *   WHERE last_block_scanned IS NULL OR last_block_scanned < incoming
 *
 * Covers: lower, equal, higher, and the interleaved (race) case.
 *
 * Run with: deno test --no-check supabase/functions/or-stealth-envelope-update/
 */

// @ts-nocheck -- matches the --no-check CI flag; type coverage is the ratchet job.

import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { evaluateForwardOnly } from './cursor_guard.ts';

Deno.test('lower: incoming < stored -- cursor stays at stored, no update', () => {
  const result = evaluateForwardOnly(200, 150);
  assertEquals(result.shouldUpdate, false);
  assertEquals(result.effectiveCursor, 200);
});

Deno.test('equal: incoming == stored -- idempotent, no update (equal is not strictly less)', () => {
  const result = evaluateForwardOnly(200, 200);
  assertEquals(result.shouldUpdate, false);
  assertEquals(result.effectiveCursor, 200);
});

Deno.test('higher: incoming > stored -- cursor advances to incoming', () => {
  const result = evaluateForwardOnly(100, 200);
  assertEquals(result.shouldUpdate, true);
  assertEquals(result.effectiveCursor, 200);
});

Deno.test('null stored (never set): incoming=0 still advances cursor', () => {
  const result = evaluateForwardOnly(null, 0);
  assertEquals(result.shouldUpdate, true);
  assertEquals(result.effectiveCursor, 0);
});

Deno.test('null stored (never set): any positive incoming advances cursor', () => {
  const result = evaluateForwardOnly(null, 500);
  assertEquals(result.shouldUpdate, true);
  assertEquals(result.effectiveCursor, 500);
});

Deno.test('interleaved: race between two callers with different tips', () => {
  // Two callers race against stored=100. Caller A carries tip=200, caller B carries tip=150.
  //
  // Case 1: A arrives first (stored=100 -> 200), then B arrives (stored=200, incoming=150).
  // B must be a no-op; cursor stays at 200.
  const callerA_first = evaluateForwardOnly(100, 200);
  assertEquals(callerA_first, { shouldUpdate: true, effectiveCursor: 200 });

  // B sees stored=200 (A already won).
  const callerB_after_A = evaluateForwardOnly(200, 150);
  assertEquals(callerB_after_A, { shouldUpdate: false, effectiveCursor: 200 });

  // Case 2: B arrives first (stored=100 -> 150), then A arrives (stored=150, incoming=200).
  // A must advance; cursor ends at 200.
  const callerB_first = evaluateForwardOnly(100, 150);
  assertEquals(callerB_first, { shouldUpdate: true, effectiveCursor: 150 });

  const callerA_after_B = evaluateForwardOnly(150, 200);
  assertEquals(callerA_after_B, { shouldUpdate: true, effectiveCursor: 200 });

  // In both orderings, cursor ends at max(200, 150) = 200 and never regresses.
});
