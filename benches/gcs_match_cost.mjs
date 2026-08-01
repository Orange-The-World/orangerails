#!/usr/bin/env node
/**
 * benches/gcs_match_cost.mjs
 *
 * GCS block-filter match cost bench.
 *
 * Label: fixed-window cost only -- does not price #353's rolling window
 * (K-pass) cost.
 *
 * Measures the CPU cost of matchAny() at three gap_limit values (20, 250,
 * 1000) across three scenarios. Reports median + p95 per-block cost and
 * extrapolated wall time for an old-wallet backfill scan.
 *
 * Requires: node v22+ (global fetch, WebAssembly, node:zlib)
 * Run from repo root: node benches/gcs_match_cost.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const REPO_ROOT  = path.resolve(__dirname, '..');

// ---------- load WASM via initSync (no browser needed) ----------
// The wasm.js glue exports initSync which takes a pre-compiled Module.
// This bypasses the default export's fetch() path, which requires a
// browser or HTTP server for file:// URLs.

const wasmJsPath  = path.join(REPO_ROOT, 'src/stealth/lib/wasm/or_bip158_wasm.js');
const wasmBinPath = path.join(REPO_ROOT, 'src/stealth/lib/wasm/or_bip158_wasm_bg.wasm');

const { match_any, initSync } = await import(wasmJsPath);
const wasmBytes = readFileSync(wasmBinPath);
initSync({ module: new WebAssembly.Module(wasmBytes) });

// ---------- bench config ----------

// gap_limit values from issue #357.
// windowSize = gap_limit * 2 per chain, 2 chains => scriptCount = gap_limit * 4.
const POINTS = [
  { gapLimit:   20, scriptCount:   80 },
  { gapLimit:  250, scriptCount: 1000 },
  { gapLimit: 1000, scriptCount: 4000 },
];

// 20 real mainnet blocks sampled at 500-block intervals near tip.
const TIP_APPROX    = 860_000;
const SAMPLE_COUNT  = 20;
const SAMPLE_STEP   = 500;
const SAMPLE_HEIGHTS = Array.from(
  { length: SAMPLE_COUNT },
  (_, i) => TIP_APPROX - (SAMPLE_COUNT - i) * SAMPLE_STEP,
);

// Decision rule constants.
const OLD_WALLET_BLOCKS = 500_000;  // birthday at ~block 360k to current tip
const PER_BLOCK_MAX_MS  = 5;        // per-block match cost cap (ms); pipelined under async fetch

const SCENARIOS = [
  {
    name:       'fresh-wallet',
    blockCount: 100,
    label:      '100 blocks (recent birthday)',
  },
  {
    name:       'old-wallet',
    blockCount: OLD_WALLET_BLOCKS,
    label:      `~${(OLD_WALLET_BLOCKS / 1000).toFixed(0)}k blocks (backfill, extrapolated from ${SAMPLE_COUNT}-block sample)`,
  },
  {
    name:       'incremental',
    blockCount: 1,
    label:      '1 block (tip-following)',
  },
];

// ---------- helpers ----------

// Synthetic P2WPKH scripts: OP_0 <PUSH20> <20 bytes>.
// Using distinct byte patterns so each script is unique; none will match
// real filters, which is the common case (hot path for a non-matching wallet)
function makeScripts(count) {
  return Array.from({ length: count }, (_, i) => {
    const s = new Uint8Array(22);
    s[0] = 0x00;  // OP_0
    s[1] = 0x14;  // PUSH 20 bytes
    s[2] = (i >>> 24) & 0xff;
    s[3] = (i >>> 16) & 0xff;
    s[4] = (i >>>  8) & 0xff;
    s[5] =  i         & 0xff;
    return s;
  });
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Fetch a BIP158 compact filter from stealth.orangerails.com (public static files).
// Returns { filter: Uint8Array, blockHashLE: Uint8Array } or null on 404.
async function fetchFilter(height) {
  const base = 'https://stealth.orangerails.com';
  const [gzResp, jsonResp] = await Promise.all([
    fetch(`${base}/${height}.gcs.gz`),
    fetch(`${base}/${height}.json`),
  ]);
  if (gzResp.status === 404 || jsonResp.status === 404) return null;
  if (!gzResp.ok)   throw new Error(`filter ${height} gz: HTTP ${gzResp.status}`);
  if (!jsonResp.ok) throw new Error(`filter ${height} json: HTTP ${jsonResp.status}`);

  const sidecar    = await jsonResp.json();
  const gzBuf      = new Uint8Array(await gzResp.arrayBuffer());
  const filter     = gunzipSync(gzBuf);
  // match_any expects the block hash in little-endian (consensus) byte order,
  // matching how sync.ts calls reverseBytes(hexToBytes(f.blockHashHex)).
  const blockHashLE = hexToBytes(sidecar.block_hash).reverse();
  return { filter, blockHashLE };
}

function percentile(sorted, p) {
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

function stats(times) {
  const s = [...times].sort((a, b) => a - b);
  return {
    median: percentile(s, 0.50),
    p95:    percentile(s, 0.95),
    min:    s[0],
    max:    s[s.length - 1],
    n:      s.length,
  };
}

// ---------- main ----------

console.log('Fetching sample filters...');
const samples = (await Promise.all(SAMPLE_HEIGHTS.map(fetchFilter))).filter(Boolean);
if (samples.length < 5) {
  console.error(
    `Only ${samples.length} filters fetched (need >= 5). ` +
    'Check network access to stealth.orangerails.com.',
  );
  process.exit(1);
}
console.log(`Fetched ${samples.length} of ${SAMPLE_COUNT} requested filters.\n`);

console.log(
  'Label: fixed-window cost only -- does not price #353\'s rolling window (K-pass) cost.\n' +
  `Veto: per-block match cost must be < ${PER_BLOCK_MAX_MS}ms (match is pipelined under\n` +
  '  async fetch; old-wallet totals below are CPU-only extrapolations, not wall time).\n' +
  'Rule: recommend smallest gap_limit >= 20 where median < per-block cap.\n',
);

const rows = [];

for (const { gapLimit, scriptCount } of POINTS) {
  const scripts = makeScripts(scriptCount);

  // Warm up (3 runs, not recorded).
  for (const s of samples.slice(0, 3)) {
    match_any(s.filter, s.blockHashLE, scripts);
  }

  // Measure: one timing per sample filter.
  const perBlockMs = samples.map(({ filter, blockHashLE }) => {
    const t0 = performance.now();
    match_any(filter, blockHashLE, scripts);
    return performance.now() - t0;
  });

  const st = stats(perBlockMs);
  const pointVerdict = st.median <= PER_BLOCK_MAX_MS
    ? `PASS (<= ${PER_BLOCK_MAX_MS}ms/block)`
    : `FAIL (> ${PER_BLOCK_MAX_MS}ms/block)`;
  console.log(`gap_limit=${gapLimit}  scripts=${scriptCount}  [${pointVerdict}]`);
  console.log(
    `  per-block: median=${st.median.toFixed(3)}ms  p95=${st.p95.toFixed(3)}ms` +
    `  min=${st.min.toFixed(3)}ms  max=${st.max.toFixed(3)}ms  n=${st.n}`,
  );

  for (const sc of SCENARIOS) {
    const totalMs = st.median * sc.blockCount;
    const totalS  = (totalMs / 1000).toFixed(1);
    const cpuNote = sc.name === 'old-wallet'
      ? '  (CPU-only; pipelined under fetch in real sync)'
      : '';
    console.log(`  ${sc.name.padEnd(14)} ~${totalS.padStart(6)}s  ${sc.label}${cpuNote}`);
    rows.push({ gapLimit, scriptCount, scenario: sc.name, totalMs, perBlockMs: st.median });
  }
  console.log();
}

// Recommendation
console.log('--- Recommendation ---');
const passing = rows
  .filter(r => r.scenario === 'old-wallet')
  .filter(r => r.perBlockMs <= PER_BLOCK_MAX_MS);

if (passing.length === 0) {
  console.log(
    `FINDING: all tested gap_limit values exceed the ${PER_BLOCK_MAX_MS}ms/block cap. ` +
    'Review match cost relative to network fetch latency before setting a default. ' +
    'Do not pick below 20.',
  );
} else {
  const rec = passing[0];
  console.log(
    `Recommend gap_limit=${rec.gapLimit} (${rec.scriptCount} scripts, ` +
    `${rec.perBlockMs.toFixed(3)}ms/block match cost).`,
  );
  console.log(
    `Note: at any fetch latency > ${PER_BLOCK_MAX_MS}ms/block, match is hidden under I/O ` +
    'and adds nothing to user-visible sync time.',
  );
}
