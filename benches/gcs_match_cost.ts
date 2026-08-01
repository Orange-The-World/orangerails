/**
 * benches/gcs_match_cost.ts
 *
 * Measures BIP158 GCS match_any cost at 40 / 400 / 4000 scripts.
 * Answers the open measurement question in issues #353 and #357.
 *
 *   Gap limit  ->  window (per chain)  ->  total scripts (both chains)
 *      20      ->        40            ->         40      (current default)
 *     200      ->       400            ->        400      (BitBooks workaround)
 *    2000      ->      4000            ->       4000      (extreme upper bound)
 *
 * Run from the repo root:
 *   deno run --allow-read --allow-net benches/gcs_match_cost.ts
 *
 * Output: microseconds per match_any call and projected single-threaded
 * CPU cost for a full mainnet sweep (~870K blocks) at each script count.
 * Note that actual sync wall time is dominated by network I/O (32 concurrent
 * filter fetches), not match CPU, so the sweep projection is a worst-case
 * for CPU budget, not wall clock.
 */

// @ts-nocheck -- Deno runtime; TypeScript strict mode not enforced here.

import initWasm, {
  match_any,
} from "../src/stealth/lib/wasm/or_bip158_wasm.js";

// Initialize the WASM module. The shim resolves the .wasm binary relative
// to its own import.meta.url, so this works regardless of CWD.
await initWasm();

// ---------------------------------------------------------------------------
// Fetch one real BIP158 filter from the production CDN.
// Block 800000: a well-known mainnet block, representative filter size.
// ---------------------------------------------------------------------------
const BENCHMARK_HEIGHT = 800_000;
const BASE = "https://stealth.orangerails.com";

console.log(`Fetching filter for block ${BENCHMARK_HEIGHT}...`);

const [gzResp, jsonResp] = await Promise.all([
  fetch(`${BASE}/${BENCHMARK_HEIGHT}.gcs.gz`),
  fetch(`${BASE}/${BENCHMARK_HEIGHT}.json`),
]);

if (!gzResp.ok) throw new Error(`GCS fetch failed: ${gzResp.status}`);
if (!jsonResp.ok) throw new Error(`JSON sidecar fetch failed: ${jsonResp.status}`);

// Decompress the filter. The CDN serves raw gzip without Content-Encoding,
// so the browser/Deno will not transparently decompress it -- we must do it.
const gzBuf = new Uint8Array(await gzResp.arrayBuffer());
const ds = new DecompressionStream("gzip");
const writer = ds.writable.getWriter();
const reader = ds.readable.getReader();
writer.write(gzBuf);
writer.close();
const chunks = [];
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value);
}
const totalLen = chunks.reduce((s, c) => s + c.length, 0);
const filterBytes = new Uint8Array(totalLen);
let writePos = 0;
for (const c of chunks) {
  filterBytes.set(c, writePos);
  writePos += c.length;
}

// Block hash: sidecar gives big-endian display form; rust-bitcoin expects
// the raw bytes in little-endian consensus byte order (reversed).
function hexToBytes(hex) {
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

const sidecar = await jsonResp.json();
const blockHashLE = hexToBytes(sidecar.block_hash).reverse();

console.log(`Filter: ${filterBytes.length} bytes (block ${sidecar.block_height})`);

// ---------------------------------------------------------------------------
// Build query script sets for each count.
// These are deterministic fake P2WPKH scripts (OP_0 <20 bytes>) that will
// not match the filter -- we are measuring cost, not correctness. The GCS
// decode path and script hashing are the same whether a match is found.
// ---------------------------------------------------------------------------
function makeScript(i) {
  const s = new Uint8Array(22);
  s[0] = 0x00; // OP_0
  s[1] = 0x14; // PUSH 20
  for (let b = 0; b < 20; b++) {
    s[2 + b] = ((i >>> (b & 3)) ^ (b * 37 + i * 7)) & 0xff;
  }
  return s;
}

const COUNTS = [40, 400, 4000];
const scriptSets = new Map();
for (const n of COUNTS) {
  scriptSets.set(n, Array.from({ length: n }, (_, i) => makeScript(i)));
}

// ---------------------------------------------------------------------------
// Benchmark: time match_any at each script count.
// ---------------------------------------------------------------------------
const ITERS = 1_000;
const WARMUP = 50;
// Approximate mainnet block count from genesis to mid-2026.
const MAINNET_BLOCKS = 870_000;

console.log(
  `\n${"Scripts".padEnd(10)} | ${"us/call".padStart(10)} | Proj. sweep CPU (${(MAINNET_BLOCKS / 1000).toFixed(0)}K blocks, single-thread)`,
);
console.log("-".repeat(70));

for (const n of COUNTS) {
  const scripts = scriptSets.get(n);

  // Warmup -- let the JIT settle.
  for (let w = 0; w < WARMUP; w++) {
    match_any(filterBytes, blockHashLE, scripts);
  }

  const t0 = performance.now();
  for (let i = 0; i < ITERS; i++) {
    match_any(filterBytes, blockHashLE, scripts);
  }
  const elapsedMs = performance.now() - t0;

  const usPerCall = (elapsedMs * 1000) / ITERS;
  const sweepSec = (usPerCall * MAINNET_BLOCKS) / 1_000_000;

  console.log(
    `${String(n).padEnd(10)} | ${usPerCall.toFixed(2).padStart(10)} | ~${sweepSec.toFixed(1)}s`,
  );
}

console.log(
  `\nNote: sync uses 32 concurrent filter fetches. Match runs on the fetch`,
);
console.log(
  `thread, so wall-clock sweep time is network-bound, not CPU-bound.`,
);
console.log(`The sweep column is worst-case single-threaded CPU budget.`);
