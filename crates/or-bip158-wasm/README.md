# or-bip158-wasm

BIP158 compact-block-filter matcher for Orange Rails Stealth Sync, compiled
to WebAssembly and consumed by the in-browser sync widget.

## What it is

A thin wrapper around `bitcoin::bip158::BlockFilter` from rust-bitcoin.
It exposes one function: `match_any(filter_bytes, block_hash, scripts)`,
which returns true when any of the given script-pubkeys is present in the
given block filter.

## Why we wrote our own

BDK's WASM build does not expose the BIP158 matcher. The pure-TypeScript
options were either incomplete or far slower than rust-bitcoin. Stealth
Sync runs the matcher entirely in the user's browser, so we need both
correctness and speed.

## How to build

You need the Rust toolchain and `wasm-pack`:

    rustup target add wasm32-unknown-unknown
    cargo install wasm-pack

Then from this directory:

    make

That runs `wasm-pack build --target web --release` and places the output
at `../../src/stealth/lib/wasm/`. The JS wrapper at
`src/stealth/lib/wasm/index.ts` imports the module from there.
