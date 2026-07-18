import { describe, expect, it } from 'vitest';

import { toLNSettledState, toIsoSettledAt } from './client';
import type { LNSettledState } from './types';

describe('toIsoSettledAt', () => {
  it('converts a positive Unix-seconds integer to ISO-8601', () => {
    // 1706745600 = 2024-02-01T00:00:00.000Z
    expect(toIsoSettledAt(1706745600)).toBe('2024-02-01T00:00:00.000Z');
  });

  it('returns null for zero (the unsettled sentinel value)', () => {
    expect(toIsoSettledAt(0)).toBeNull();
  });

  it('returns null for negative values', () => {
    expect(toIsoSettledAt(-1)).toBeNull();
  });

  it('passes through a non-empty ISO string unchanged', () => {
    expect(toIsoSettledAt('2024-02-01T00:00:00.000Z')).toBe('2024-02-01T00:00:00.000Z');
  });

  it('returns null for null and undefined', () => {
    expect(toIsoSettledAt(null)).toBeNull();
    expect(toIsoSettledAt(undefined)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(toIsoSettledAt('')).toBeNull();
  });
});

describe('toLNSettledState', () => {
  it('settled:true with a valid Unix timestamp yields the terminal settled state', () => {
    const state: LNSettledState = toLNSettledState(true, 1706745600);
    expect(state).toEqual({ settled: true, settled_at: '2024-02-01T00:00:00.000Z' });
  });

  it('settled:false with null settledAt yields non-terminal state (pending case)', () => {
    const pending: LNSettledState = toLNSettledState(false, null);
    expect(pending).toEqual({ settled: false, settled_at: null });
  });

  it('settled:false ignores a non-null settledAt (failed-with-timestamp case)', () => {
    // A provider may return a timestamp even for a failed invoice.
    // The ingest contract still maps this to settled:false/settled_at:null.
    const failed: LNSettledState = toLNSettledState(false, 1706745600);
    expect(failed).toEqual({ settled: false, settled_at: null });
  });

  it('pending and failed produce identical shapes (ingest boundary rule)', () => {
    const pending = toLNSettledState(false, null);
    const failed = toLNSettledState(false, 1706745600);
    expect(pending).toEqual(failed);
  });

  it('settled:true with null settledAt still marks settled:true', () => {
    // Edge case: provider confirms settlement but omits the timestamp.
    const state = toLNSettledState(true, null);
    expect(state.settled).toBe(true);
    expect(state.settled_at).toBeNull();
  });
});
