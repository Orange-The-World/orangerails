/**
 * Mock fixture fetchers for `runSync`.
 *
 * Used by `routes/sync.tsx` when called with `?mock=1` so the route is
 * testable today, before the Milestone 4 filter producer + block source
 * services come up on operator infrastructure. The fixture matcher always returns
 * false, which means a mock sync ends with zero transactions but still
 * exercises every PROGRESS stage end-to-end.
 *
 * Real production fetchers live inline in `routes/sync.tsx`.
 */

import type {
  BlockRecord,
  FilterRecord,
} from './sync';
import type { Bip158Matcher } from './wasm/index';

export const mockFetchTip = async (): Promise<number> => 800_010;

export const mockFetchFilter = async (
  height: number,
): Promise<FilterRecord | null> => {
  // Empty filter for every height in the fixture range.
  if (height < 800_000 || height > 800_010) return null;
  return {
    height,
    blockHashHex:
      '0000000000000000000000000000000000000000000000000000000000000000',
    filter: new Uint8Array([0]),
  };
};

export const mockFetchBlock = async (
  blockHashHex: string,
): Promise<BlockRecord> => {
  // The mock matcher never matches, so this should not be called. We
  // return an empty placeholder so a code path that did call it would not
  // crash mid-run.
  return {
    height: 0,
    blockHashHex,
    raw: new Uint8Array(80 + 1), // 80-byte zero header + varint(0) tx count
  };
};

/** Matcher that never matches; lets every PROGRESS stage fire without
 *  pulling any block data. */
export const mockNeverMatcher: Bip158Matcher = {
  matchAny: () => false,
};
