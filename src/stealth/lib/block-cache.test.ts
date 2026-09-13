import { describe, expect, it, vi } from "vitest";

import {
  cachedSyncFetchers,
  formatCacheSize,
  type BlockCache,
  type BlockCacheStats,
} from "./block-cache";
import type { BlockRecord, FilterRecord } from "./sync";

class MemoryBlockCache implements BlockCache {
  readonly location = "opfs" as const;
  readonly displayPath = "test cache";
  readonly filters = new Map<number, FilterRecord>();
  readonly blocks = new Map<string, BlockRecord>();
  readonly wallets = new Set<string>();

  async readFilter(height: number) {
    return this.filters.get(height) ?? null;
  }

  async writeFilter(record: FilterRecord) {
    this.filters.set(record.height, record);
  }

  async readBlock(blockHashHex: string) {
    return this.blocks.get(blockHashHex) ?? null;
  }

  async writeBlock(record: BlockRecord) {
    this.blocks.set(record.blockHashHex, record);
  }

  async registerWallet(connectionId: string) {
    this.wallets.add(connectionId);
  }

  async stats(): Promise<BlockCacheStats> {
    return {
      bytes:
        [...this.filters.values()].reduce((sum, record) => sum + record.filter.length, 0) +
        [...this.blocks.values()].reduce((sum, record) => sum + record.raw.length, 0),
      walletCount: this.wallets.size,
    };
  }

  async clear() {
    this.filters.clear();
    this.blocks.clear();
    this.wallets.clear();
  }
}

const HASH = "ab".repeat(32);

describe("cachedSyncFetchers", () => {
  it("serves overlapping filter and block reads without a second network fetch", async () => {
    const cache = new MemoryBlockCache();
    const filter: FilterRecord = {
      height: 840_000,
      blockHashHex: HASH,
      filter: new Uint8Array([1, 2, 3]),
    };
    const block: BlockRecord = {
      height: 840_000,
      blockHashHex: HASH,
      raw: new Uint8Array([4, 5, 6]),
    };
    const fetchFilter = vi.fn(async () => filter);
    const fetchBlock = vi.fn(async () => block);

    const firstWallet = cachedSyncFetchers(cache, { fetchFilter, fetchBlock });
    expect(await firstWallet.fetchFilter(filter.height)).toEqual(filter);
    expect(await firstWallet.fetchBlock(HASH)).toEqual(block);

    const secondWallet = cachedSyncFetchers(cache, { fetchFilter, fetchBlock });
    expect(await secondWallet.fetchFilter(filter.height)).toEqual(filter);
    expect(await secondWallet.fetchBlock(HASH)).toEqual(block);
    expect(fetchFilter).toHaveBeenCalledTimes(1);
    expect(fetchBlock).toHaveBeenCalledTimes(1);
  });

  it("does not let a cache write failure discard a successful network read", async () => {
    const cache = new MemoryBlockCache();
    cache.writeFilter = vi.fn(async () => {
      throw new Error("disk full");
    });
    const filter: FilterRecord = { height: 1, blockHashHex: HASH, filter: new Uint8Array([7]) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fetchers = cachedSyncFetchers(cache, {
      fetchFilter: vi.fn(async () => filter),
      fetchBlock: vi.fn(),
    });

    await expect(fetchers.fetchFilter(1)).resolves.toEqual(filter);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("formatCacheSize", () => {
  it("formats the units used by the storage readout", () => {
    expect(formatCacheSize(0)).toBe("0 B");
    expect(formatCacheSize(1536)).toBe("1.5 KB");
    expect(formatCacheSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
