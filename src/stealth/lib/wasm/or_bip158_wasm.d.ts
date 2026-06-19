/* tslint:disable */
/* eslint-disable */

/**
 * Test whether any of the given script-pubkeys appears in the given block
 * filter, given the block hash that produced the filter.
 *
 * Inputs:
 * - `filter_bytes`: raw bytes of a BIP158 block filter (serialized GCS).
 * - `block_hash`: 32 raw bytes of the block hash, in consensus byte order
 *   (the same order rust-bitcoin uses internally; this is the raw hash,
 *   not the human-readable big-endian display form).
 * - `scripts`: a JS array of `Uint8Array` values, each one a script-pubkey
 *   to check for.
 *
 * Returns true if any of the scripts matches the filter, false otherwise.
 *
 * Errors:
 * - Returns a `JsValue` error if `block_hash` is not exactly 32 bytes, if
 *   any element of `scripts` is not a `Uint8Array`, or if the filter cannot
 *   be matched against (malformed filter bytes, internal I/O error, etc.).
 */
export function match_any(filter_bytes: Uint8Array, block_hash: Uint8Array, scripts: Array<any>): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly match_any: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
