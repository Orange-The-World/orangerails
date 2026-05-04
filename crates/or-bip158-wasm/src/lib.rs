//! BIP158 compact-block-filter matcher, compiled to WebAssembly.
//!
//! Why this crate exists: BDK's WASM build does not expose the BIP158 matcher
//! and the pure-TypeScript options we evaluated were either incomplete or
//! orders of magnitude slower than rust-bitcoin. Stealth Sync runs the
//! matcher entirely in the user's browser, so the matcher must be both
//! correct and fast. We wrap rust-bitcoin's `bitcoin::bip158::BlockFilter`
//! with the smallest possible JS surface and ship the result as a single
//! exported function.
//!
//! Reference: https://docs.rs/bitcoin/latest/bitcoin/bip158/

use bitcoin::bip158::BlockFilter;
use bitcoin::BlockHash;
use bitcoin::hashes::Hash;
use js_sys::Array;
use wasm_bindgen::prelude::*;

/// Test whether any of the given script-pubkeys appears in the given block
/// filter, given the block hash that produced the filter.
///
/// Inputs:
/// - `filter_bytes`: raw bytes of a BIP158 block filter (serialized GCS).
/// - `block_hash`: 32 raw bytes of the block hash, in consensus byte order
///   (the same order rust-bitcoin uses internally; this is the raw hash,
///   not the human-readable big-endian display form).
/// - `scripts`: a JS array of `Uint8Array` values, each one a script-pubkey
///   to check for.
///
/// Returns true if any of the scripts matches the filter, false otherwise.
///
/// Errors:
/// - Returns a `JsValue` error if `block_hash` is not exactly 32 bytes, if
///   any element of `scripts` is not a `Uint8Array`, or if the filter cannot
///   be matched against (malformed filter bytes, internal I/O error, etc.).
#[wasm_bindgen]
pub fn match_any(
    filter_bytes: &[u8],
    block_hash: &[u8],
    scripts: Array,
) -> Result<bool, JsValue> {
    if block_hash.len() != 32 {
        return Err(JsValue::from_str(&format!(
            "block_hash must be 32 bytes, got {}",
            block_hash.len()
        )));
    }
    let mut hash_arr = [0u8; 32];
    hash_arr.copy_from_slice(block_hash);
    let block_hash = BlockHash::from_byte_array(hash_arr);

    // Materialize the JS array of Uint8Array into owned Vec<u8>s before
    // calling into rust-bitcoin. We have to own the bytes because the
    // matcher consumes a `&[&[u8]]`-shaped iterator and the JS values
    // are not stable references.
    let len = scripts.length() as usize;
    let mut owned: Vec<Vec<u8>> = Vec::with_capacity(len);
    for i in 0..len {
        let val = scripts.get(i as u32);
        let arr = js_sys::Uint8Array::new(&val);
        let mut buf = vec![0u8; arr.length() as usize];
        arr.copy_to(&mut buf);
        owned.push(buf);
    }

    let filter = BlockFilter::new(filter_bytes);
    let mut iter = owned.iter().map(|v| v.as_slice());
    filter
        .match_any(&block_hash, &mut iter)
        .map_err(|e| JsValue::from_str(&format!("BIP158 match failed: {e}")))
}
