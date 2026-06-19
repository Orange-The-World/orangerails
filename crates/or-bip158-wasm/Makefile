# Build the BIP158 matcher to WebAssembly and place the artifacts where the
# browser-side widget expects them. Idempotent: re-running rebuilds in place.
#
# Requires: rustup with the wasm32-unknown-unknown target, and wasm-pack.

OUT_DIR := ../../src/stealth/lib/wasm

.PHONY: build clean

build:
	wasm-pack build --target web --out-dir $(OUT_DIR) --release

clean:
	rm -rf target $(OUT_DIR)/*.wasm $(OUT_DIR)/*.js $(OUT_DIR)/*.d.ts $(OUT_DIR)/package.json
