/**
 * BIP158 matcher loader.
 *
 * Loads the compiled Rust to WebAssembly module from `crates/or-bip158-wasm`
 * and exposes a clean async API to the rest of the widget. The artifacts
 * (`or_bip158_wasm.js`, `or_bip158_wasm_bg.wasm`, and the matching `.d.ts`
 * files) are committed to this directory so a fresh clone produces a
 * working production build without a separate Rust toolchain step. Rebuild
 * them with `cd crates/or-bip158-wasm && make` whenever the Rust source
 * changes; the existing artifacts will be replaced in place.
 *
 * The loader keeps a module-level singleton: the WASM init runs at most
 * once per page load, even under concurrent callers.
 *
 * License note: this is the only AGPL-3.0-or-later component in the widget
 * (see /LICENSE-NOTICE.md). The rest of the bundle stays Apache-2.0.
 */

type MatchAny = (filter: Uint8Array, blockHash: Uint8Array, scripts: Uint8Array[]) => boolean;

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
  // Vite resolves this dynamic import at build time and emits the
  // wasm-pack output (./or_bip158_wasm.js plus the .wasm bytes) as a
  // hashed chunk under /assets/. The artifacts live in this directory
  // and are committed to the repo so a fresh clone can produce a
  // working build without rebuilding the WASM crate first. Rebuild
  // them with `cd crates/or-bip158-wasm && make` when the Rust source
  // changes.
  //
  // Previously this used `await import(/* @vite-ignore */ modulePath)`
  // with a runtime path so a clone with no artifacts could still build
  // the rest of the app. The trade-off was that production deploys
  // never bundled the shim, so the dynamic import resolved against the
  // serving origin's static assets, hit the SPA fallback, and threw
  // "Failed to fetch dynamically imported module". Letting Vite handle
  // the import fixes production at the cost of failing the build fast
  // when artifacts are missing locally, which is what we want anyway.
  let mod: {
    default: (input?: unknown) => Promise<unknown>;
    match_any: (filter: Uint8Array, blockHash: Uint8Array, scripts: Uint8Array[]) => boolean;
  };
  try {
    mod = (await import("./or_bip158_wasm.js")) as typeof mod;
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
