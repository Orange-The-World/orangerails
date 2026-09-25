/**
 * Persistent cache for the public Bitcoin data used by Stealth Sync.
 *
 * The cache belongs to the widget origin. It can live either below a folder
 * selected through the File System Access API or in the widget origin's OPFS.
 * Wallet secrets and transactions never enter this cache: it contains only
 * public BIP158 filters, public raw blocks, and opaque wallet identifiers used
 * to produce the "wallets using this cache" count.
 */

import type { BlockRecord, FilterRecord } from "./sync";

export type BlockCacheLocation = "directory" | "opfs" | "none";

export interface BlockCachePreference {
  location: BlockCacheLocation;
  /** Browser-exposed folder name. Browsers deliberately do not expose an absolute path. */
  directoryName?: string;
}

export interface BlockCacheStats {
  bytes: number;
  walletCount: number;
}

export interface BlockCache {
  readonly location: Exclude<BlockCacheLocation, "none">;
  readonly displayPath: string;
  readFilter(height: number): Promise<FilterRecord | null>;
  writeFilter(record: FilterRecord): Promise<void>;
  readBlock(blockHashHex: string): Promise<BlockRecord | null>;
  writeBlock(record: BlockRecord): Promise<void>;
  registerWallet(connectionId: string): Promise<void>;
  stats(): Promise<BlockCacheStats>;
  clear(): Promise<void>;
}

interface FileSystemAccessWindow extends Window {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
  }) => Promise<FileSystemDirectoryHandle>;
}

interface PermissionCapableHandle {
  queryPermission?: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
}

interface OpfsStorageManager {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>;
}

interface IterableDirectoryHandle extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  entries(): AsyncIterableIterator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]>;
}

const PREFERENCE_KEY = "or-stealth-block-cache-preference-v1";
const HANDLE_DB = "or-stealth-block-cache-settings-v1";
const HANDLE_STORE = "settings";
const HANDLE_KEY = "directory-handle";
const CACHE_DIRECTORY = "OrangeRails Bitcoin blocks";
const MANIFEST_FILE = "manifest.json";
const FILTER_MAGIC = new Uint8Array([0x4f, 0x52, 0x46, 0x31]); // ORF1
const BLOCK_MAGIC = new Uint8Array([0x4f, 0x52, 0x42, 0x31]); // ORB1
const RECORD_HEADER_BYTES = 40; // magic + uint32 height + 32-byte block hash

function storageAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as FileSystemAccessWindow).showDirectoryPicker === "function"
  );
}

export function getBlockCachePreference(): BlockCachePreference | null {
  if (!storageAvailable()) return null;
  try {
    const raw = window.localStorage.getItem(PREFERENCE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BlockCachePreference>;
    if (
      parsed.location !== "directory" &&
      parsed.location !== "opfs" &&
      parsed.location !== "none"
    ) {
      return null;
    }
    return {
      location: parsed.location,
      ...(typeof parsed.directoryName === "string" ? { directoryName: parsed.directoryName } : {}),
    };
  } catch {
    return null;
  }
}

function savePreference(preference: BlockCachePreference): void {
  if (!storageAvailable()) return;
  window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(preference));
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable; the selected folder cannot be remembered."));
      return;
    }
    const request = indexedDB.open(HANDLE_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE)) {
        request.result.createObjectStore(HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open cache settings."));
  });
}

async function storeDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(HANDLE_STORE, "readwrite");
      transaction.objectStore(HANDLE_STORE).put(handle, HANDLE_KEY);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("Could not remember the selected folder."));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("Could not remember the selected folder."));
    });
  } finally {
    db.close();
  }
}

async function loadDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const db = await openHandleDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db
        .transaction(HANDLE_STORE, "readonly")
        .objectStore(HANDLE_STORE)
        .get(HANDLE_KEY);
      request.onsuccess = () =>
        resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not read the selected folder."));
    });
  } finally {
    db.close();
  }
}

export async function chooseDirectoryBlockCache(): Promise<BlockCachePreference> {
  const picker = (window as FileSystemAccessWindow).showDirectoryPicker;
  if (!picker) throw new Error("Choosing a folder is not supported by this browser.");
  const handle = await picker({ id: "or-stealth-block-cache", mode: "readwrite" });
  await storeDirectoryHandle(handle);
  const preference: BlockCachePreference = {
    location: "directory",
    directoryName: handle.name,
  };
  savePreference(preference);
  return preference;
}

export function chooseBrowserBlockCache(): BlockCachePreference {
  const preference: BlockCachePreference = { location: "opfs" };
  savePreference(preference);
  return preference;
}

export function chooseNoBlockCache(): BlockCachePreference {
  const preference: BlockCachePreference = { location: "none" };
  savePreference(preference);
  return preference;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

function encodeRecord(
  magic: Uint8Array,
  height: number,
  blockHashHex: string,
  payload: Uint8Array,
): Uint8Array {
  const hash = hexToBytes(blockHashHex);
  if (!hash) throw new Error("Cannot cache a record with an invalid block hash.");
  const encoded = new Uint8Array(RECORD_HEADER_BYTES + payload.length);
  encoded.set(magic, 0);
  new DataView(encoded.buffer).setUint32(4, height, false);
  encoded.set(hash, 8);
  encoded.set(payload, RECORD_HEADER_BYTES);
  return encoded;
}

function decodeRecord(
  bytes: Uint8Array,
  magic: Uint8Array,
): { height: number; blockHashHex: string; payload: Uint8Array } | null {
  if (bytes.length < RECORD_HEADER_BYTES) return null;
  if (!magic.every((byte, index) => bytes[index] === byte)) return null;
  return {
    height: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false),
    blockHashHex: bytesToHex(bytes.subarray(8, RECORD_HEADER_BYTES)),
    payload: bytes.slice(RECORD_HEADER_BYTES),
  };
}

async function readFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<Uint8Array | null> {
  try {
    const handle = await directory.getFileHandle(name);
    return new Uint8Array(await (await handle.getFile()).arrayBuffer());
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

async function writeFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  contents: Uint8Array | string,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    if (typeof contents === "string") {
      await writable.write(contents);
    } else {
      const copy = new Uint8Array(contents.byteLength);
      copy.set(contents);
      await writable.write(copy.buffer);
    }
  } finally {
    await writable.close();
  }
}

async function directorySize(directory: FileSystemDirectoryHandle): Promise<number> {
  let bytes = 0;
  for await (const handle of (directory as IterableDirectoryHandle).values()) {
    if (handle.kind === "file") {
      bytes += (await handle.getFile()).size;
    } else {
      bytes += await directorySize(handle);
    }
  }
  return bytes;
}

async function clearDirectory(directory: FileSystemDirectoryHandle): Promise<void> {
  const entries: Array<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> = [];
  for await (const entry of (directory as IterableDirectoryHandle).entries()) {
    entries.push(entry);
  }
  for (const [name, handle] of entries) {
    await directory.removeEntry(name, { recursive: handle.kind === "directory" });
  }
}

class FileSystemBlockCache implements BlockCache {
  private readonly rootPromise: Promise<FileSystemDirectoryHandle>;

  constructor(
    base: FileSystemDirectoryHandle,
    readonly location: "directory" | "opfs",
    readonly displayPath: string,
  ) {
    this.rootPromise = base.getDirectoryHandle(CACHE_DIRECTORY, { create: true });
  }

  private async dataDirectory(name: "filters" | "blocks"): Promise<FileSystemDirectoryHandle> {
    return (await this.rootPromise).getDirectoryHandle(name, { create: true });
  }

  async readFilter(height: number): Promise<FilterRecord | null> {
    const bytes = await readFile(await this.dataDirectory("filters"), `${height}.bin`);
    if (!bytes) return null;
    const decoded = decodeRecord(bytes, FILTER_MAGIC);
    if (!decoded || decoded.height !== height) return null;
    return { height, blockHashHex: decoded.blockHashHex, filter: decoded.payload };
  }

  async writeFilter(record: FilterRecord): Promise<void> {
    await writeFile(
      await this.dataDirectory("filters"),
      `${record.height}.bin`,
      encodeRecord(FILTER_MAGIC, record.height, record.blockHashHex, record.filter),
    );
  }

  async readBlock(blockHashHex: string): Promise<BlockRecord | null> {
    const normalizedHash = blockHashHex.toLowerCase();
    const bytes = await readFile(await this.dataDirectory("blocks"), `${normalizedHash}.bin`);
    if (!bytes) return null;
    const decoded = decodeRecord(bytes, BLOCK_MAGIC);
    if (!decoded || decoded.blockHashHex !== normalizedHash) return null;
    return { height: decoded.height, blockHashHex: decoded.blockHashHex, raw: decoded.payload };
  }

  async writeBlock(record: BlockRecord): Promise<void> {
    const normalizedHash = record.blockHashHex.toLowerCase();
    await writeFile(
      await this.dataDirectory("blocks"),
      `${normalizedHash}.bin`,
      encodeRecord(BLOCK_MAGIC, record.height, normalizedHash, record.raw),
    );
  }

  async registerWallet(connectionId: string): Promise<void> {
    const root = await this.rootPromise;
    const existing = await readFile(root, MANIFEST_FILE);
    let walletIds: string[] = [];
    if (existing) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(existing)) as { walletIds?: unknown };
        if (Array.isArray(parsed.walletIds)) {
          walletIds = parsed.walletIds.filter(
            (value): value is string => typeof value === "string",
          );
        }
      } catch {
        // Replace an unreadable manifest. Public cache data remains usable.
      }
    }
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(connectionId));
    const opaqueId = bytesToHex(new Uint8Array(digest));
    if (!walletIds.includes(opaqueId)) walletIds.push(opaqueId);
    await writeFile(root, MANIFEST_FILE, JSON.stringify({ version: 1, walletIds }));
  }

  async stats(): Promise<BlockCacheStats> {
    const root = await this.rootPromise;
    const manifest = await readFile(root, MANIFEST_FILE);
    let walletCount = 0;
    if (manifest) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(manifest)) as { walletIds?: unknown };
        if (Array.isArray(parsed.walletIds)) walletCount = new Set(parsed.walletIds).size;
      } catch {
        // A corrupt manifest means the usage count is unknown, represented as zero.
      }
    }
    return { bytes: await directorySize(root), walletCount };
  }

  async clear(): Promise<void> {
    await clearDirectory(await this.rootPromise);
  }
}

export async function createActiveBlockCache(
  preference: BlockCachePreference | null = getBlockCachePreference(),
): Promise<BlockCache | null> {
  if (!preference || preference.location === "none") return null;

  if (preference.location === "directory") {
    const handle = await loadDirectoryHandle();
    if (!handle) throw new Error("The selected folder is no longer available. Choose it again.");
    const permission = await (handle as unknown as PermissionCapableHandle).queryPermission?.({
      mode: "readwrite",
    });
    if (permission && permission !== "granted") {
      throw new Error("Access to the selected folder expired. Choose it again to continue.");
    }
    return new FileSystemBlockCache(
      handle,
      "directory",
      `${preference.directoryName ?? handle.name}/${CACHE_DIRECTORY}`,
    );
  }

  const storage = navigator.storage as unknown as OpfsStorageManager;
  if (typeof storage?.getDirectory !== "function") {
    throw new Error("Browser storage is not available in this browser.");
  }
  const root = await storage.getDirectory();
  return new FileSystemBlockCache(root, "opfs", "Browser storage (private to OrangeRails)");
}

export function cachedSyncFetchers(
  cache: BlockCache | null,
  network: {
    fetchFilter: (height: number) => Promise<FilterRecord | null>;
    fetchBlock: (blockHashHex: string) => Promise<BlockRecord>;
  },
): {
  fetchFilter: (height: number) => Promise<FilterRecord | null>;
  fetchBlock: (blockHashHex: string) => Promise<BlockRecord>;
} {
  if (!cache) return network;
  return {
    fetchFilter: async (height) => {
      try {
        const hit = await cache.readFilter(height);
        if (hit) return hit;
      } catch (error) {
        console.warn(`[stealth/cache] could not read filter ${height}:`, error);
      }
      const record = await network.fetchFilter(height);
      if (record) {
        try {
          await cache.writeFilter(record);
        } catch (error) {
          console.warn(`[stealth/cache] could not store filter ${height}:`, error);
        }
      }
      return record;
    },
    fetchBlock: async (blockHashHex) => {
      try {
        const hit = await cache.readBlock(blockHashHex);
        if (hit) return hit;
      } catch (error) {
        console.warn(`[stealth/cache] could not read block ${blockHashHex}:`, error);
      }
      const record = await network.fetchBlock(blockHashHex);
      try {
        await cache.writeBlock(record);
      } catch (error) {
        console.warn(`[stealth/cache] could not store block ${blockHashHex}:`, error);
      }
      return record;
    },
  };
}

export function formatCacheSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
