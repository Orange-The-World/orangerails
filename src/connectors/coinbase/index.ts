/**
 * Orange Rails, Coinbase connector public surface.
 *
 * Strategic role: Coinbase is the first exchange CSV ingest in the Upload Data
 * path (the 3rd connection mode, alongside Connect a Bank and Connect a
 * Bitcoin Source). Every provider quirk (report preamble, ISO timestamps,
 * transaction-type vocabulary, multi-asset rows) lives in this folder so V2/V3
 * consume only the canonical StagedImportPayload.
 *
 * CSV-only today (Coinbase has a public API; an api.ts adapter can land later
 * behind the same ingestCoinbase chooser, mirroring strike/).
 *
 * Public entry points:
 *   - parseCoinbaseCsv / buildCoinbaseCsvStagedPayload (from ./csv)
 *   - ingestCoinbase, top-level chooser the UI/CLI calls.
 */

import { readFileSync } from "node:fs";

import type { StagedImportPayload } from "../contract";
import { buildCoinbaseCsvStagedPayload } from "./csv";
import type { CoinbaseCsvRow } from "./types";

// Public surface mirrors strike/: parse + build + the two normalizers. The
// row-mapping and type-direction helpers stay internal to ./csv (imported
// directly by the tests), matching strike's narrower export set.
export {
  parseCoinbaseCsv,
  buildCoinbaseCsvStagedPayload,
  normalizeCoinbaseDate,
  magnitude,
} from "./csv";
export type { CoinbaseCsvRow } from "./types";

export type IngestCoinbaseOptions = {
  csvPath?: string;
  csvBuffer?: Buffer;
  csvText?: string;
  orgHint?: { name?: string; currency?: string };
};

export type IngestCoinbaseResult = {
  payload: StagedImportPayload;
  pathUsed: "csv";
  warnings: string[];
};

function loadCsvText(opts: IngestCoinbaseOptions): {
  text: string;
  bytes?: Uint8Array;
  name: string;
} {
  if (opts.csvText !== undefined) {
    return { text: opts.csvText, name: "coinbase.csv" };
  }
  if (opts.csvBuffer) {
    return {
      text: opts.csvBuffer.toString("utf8"),
      bytes: new Uint8Array(opts.csvBuffer),
      name: "coinbase.csv",
    };
  }
  if (opts.csvPath) {
    const buf = readFileSync(opts.csvPath);
    return {
      text: buf.toString("utf8"),
      bytes: new Uint8Array(buf),
      name: opts.csvPath.split("/").pop() ?? "coinbase.csv",
    };
  }
  throw new Error(
    "ingestCoinbase: csv source requested but no csvPath/csvBuffer/csvText provided.",
  );
}

export function ingestCoinbase(opts: IngestCoinbaseOptions): IngestCoinbaseResult {
  const { text, bytes, name } = loadCsvText(opts);
  const { payload, warnings } = buildCoinbaseCsvStagedPayload({
    csvText: text,
    fileName: name,
    fileBytes: bytes,
    orgHint: opts.orgHint,
  });
  return { payload, pathUsed: "csv", warnings };
}
