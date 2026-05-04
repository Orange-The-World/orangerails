/**
 * BIP158 matcher loader.
 *
 * Loads the compiled Rust → WebAssembly module from `crates/or-bip158-wasm`
 * and exposes a clean async API to the rest of the widget. The WASM module
 * is built out-of-band by `cd crates/or-bip158-wasm && make`. Until that
 * build runs, the `or_bip158_wasm.js` file in this folder does not exist
 * and `loadBip158Matcher()` will throw a clear error pointing the developer
 * at the build command.
 *
 * The loader keeps a module-level singleton: the WASM init runs at most
 * once per page load, even under concurrent callers.
 */

type MatchAny = (
  filter: Uint8Array,
  blockHash: Uint8Array,
  scripts: Uint8Array[],
) => boolean;

export interface Bip158Matcher {
  matchAny: MatchAny;
}

let cached: Promise<Bip158Matcher> | null = null;

/**
 * Lazily load and initialize the BIP158 WASM matcher.
 *
 * The first caller pays the init cost (fetching and compiling the .wasm
 * binary). Every subsequent caller gets the same already-initialized
 * matcher. If the compiled module is missing, throws an Error whose
 * message tells the developer how to build it.
 */
export function loadBip158Matcher(): Promise<Bip158Matcher> {
  if (!cached) {
    cached = doLoad().catch((err) => {
      // Reset so the next call can retry once the build artifacts exist.
      cached = null;
      throw err;
    });
  }
  return cached;
}

async function doLoad(): Promise<Bip158Matcher> {
  // We load the WASM module via a runtime-built path so that a fresh clone
  // (where the WASM has not been built yet) can still build the rest of
  // the app without Vite trying to statically resolve a missing file.
  // Once the artifacts exist, this resolves to the wasm-pack output.
  const modulePath = "./or_bip158_wasm.js";
  let mod: {
    default: (input?: unknown) => Promise<unknown>;
    match_any: (
      filter: Uint8Array,
      blockHash: Uint8Array,
      scripts: Uint8Array[],
    ) => boolean;
  };
  try {
    // The /* @vite-ignore */ comment tells Vite not to try to resolve this
    // dynamic import at build time. Resolution happens in the browser at
    // runtime, after `make` has produced the artifacts.
    mod = (await import(/* @vite-ignore */ modulePath)) as typeof mod;
  } catch (err) {
    throw new Error(
      "BIP158 WebAssembly module not found. Build it first: " +
        "cd crates/or-bip158-wasm && make. " +
        "Original error: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  await mod.default();

  const matchAny: MatchAny = (filter, blockHash, scripts) =>
    mod.match_any(filter, blockHash, scripts);

  return { matchAny };
}
