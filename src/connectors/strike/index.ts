/**
 * Orange Rails — Strike connector public surface.
 *
 * Strategic role: Strike is the first of N customer-trigger CSV ingests
 * (Strike, ShakePay, Blink, etc.). Every provider quirk (delimiter, date
 * format, direction labels, sign handling) lives in this folder so V2/V3
 * consume only the canonical StagedImportPayload.
 *
 * Public entry points:
 *   - parseStrikeCsv / buildStrikeCsvStagedPayload (from ./csv)
 *   - StrikeApiClient, StrikeApiAdapter, buildStrikeApiStagedPayload (./api)
 *   - suggestCategorization (./categorize)
 *   - ingestStrike — top-level chooser, the thing CLI/UI calls.
 */

import { readFileSync } from "node:fs";

import type { StagedImportPayload } from "../contract";
import { buildStrikeCsvStagedPayload } from "./csv";
import { StrikeApiAdapter, StrikeApiClient, buildStrikeApiStagedPayload } from "./api";
import { suggestCategorization, type CategorizationSuggestion } from "./categorize";
import { StrikeApiUnavailableError, type StrikeCsvRow } from "./types";

export { parseStrikeCsv, buildStrikeCsvStagedPayload, normalizeStrikeDate, magnitude } from "./csv";
export { suggestCategorization } from "./categorize";
export type { CategorizationSuggestion } from "./categorize";
export {
  StrikeApiClient,
  StrikeApiAdapter,
  buildStrikeApiStagedPayload,
  apiTransactionToCsvRow,
} from "./api";
export { StrikeApiUnavailableError } from "./types";
export type { StrikeCsvRow, StrikeApiAccount, StrikeApiTransaction, StrikeAdapter } from "./types";

export type IngestStrikeOptions = {
  source: "auto" | "api" | "csv";
  apiKey?: string;
  csvPath?: string;
  csvBuffer?: Buffer;
  csvText?: string;
  orgHint?: { name?: string; currency?: string };
  /** Inject for tests. Forwarded to StrikeApiClient. */
  fetchImpl?: typeof fetch;
};

export type IngestStrikeResult = {
  payload: StagedImportPayload;
  pathUsed: "api" | "csv";
  warnings: string[];
  categorizationSuggestions: CategorizationSuggestion[];
};

function loadCsvText(opts: IngestStrikeOptions): {
  text: string;
  bytes?: Uint8Array;
  name: string;
} {
  if (opts.csvText !== undefined) {
    return { text: opts.csvText, name: "strike.csv" };
  }
  if (opts.csvBuffer) {
    return {
      text: opts.csvBuffer.toString("utf8"),
      bytes: new Uint8Array(opts.csvBuffer),
      name: "strike.csv",
    };
  }
  if (opts.csvPath) {
    const buf = readFileSync(opts.csvPath);
    return {
      text: buf.toString("utf8"),
      bytes: new Uint8Array(buf),
      name: opts.csvPath.split("/").pop() ?? "strike.csv",
    };
  }
  throw new Error("ingestStrike: csv source requested but no csvPath/csvBuffer/csvText provided.");
}

async function ingestViaApi(opts: IngestStrikeOptions): Promise<{
  payload: StagedImportPayload;
  warnings: string[];
  rows: StrikeCsvRow[];
}> {
  if (!opts.apiKey) {
    throw new StrikeApiUnavailableError("ingestStrike: apiKey required for api source.");
  }
  const client = new StrikeApiClient({ apiKey: opts.apiKey, fetchImpl: opts.fetchImpl });
  const adapter = new StrikeApiAdapter(client, opts.orgHint);
  return adapter.ingest();
}

function ingestViaCsv(opts: IngestStrikeOptions): {
  payload: StagedImportPayload;
  warnings: string[];
  rows: StrikeCsvRow[];
} {
  const { text, bytes, name } = loadCsvText(opts);
  return buildStrikeCsvStagedPayload({
    csvText: text,
    fileName: name,
    fileBytes: bytes,
    orgHint: opts.orgHint,
  });
}

export async function ingestStrike(opts: IngestStrikeOptions): Promise<IngestStrikeResult> {
  if (opts.source === "api") {
    const { payload, warnings, rows } = await ingestViaApi(opts);
    return {
      payload,
      pathUsed: "api",
      warnings,
      categorizationSuggestions: suggestCategorization(rows),
    };
  }

  if (opts.source === "csv") {
    const { payload, warnings, rows } = ingestViaCsv(opts);
    return {
      payload,
      pathUsed: "csv",
      warnings,
      categorizationSuggestions: suggestCategorization(rows),
    };
  }

  // auto: try API first; on any failure fall back to CSV if a csv source was
  // provided. If no CSV is supplied, rethrow so caller can prompt for upload.
  if (opts.apiKey) {
    try {
      const { payload, warnings, rows } = await ingestViaApi(opts);
      return {
        payload,
        pathUsed: "api",
        warnings,
        categorizationSuggestions: suggestCategorization(rows),
      };
    } catch (err) {
      const hasCsv =
        opts.csvPath !== undefined || opts.csvBuffer !== undefined || opts.csvText !== undefined;
      if (!hasCsv) {
        if (err instanceof StrikeApiUnavailableError) throw err;
        throw new StrikeApiUnavailableError(
          `Strike API ingest failed and no CSV fallback provided: ${(err as Error).message}`,
          err,
        );
      }
      const { payload, warnings, rows } = ingestViaCsv(opts);
      return {
        payload,
        pathUsed: "csv",
        warnings: [
          `Strike API unavailable, fell back to CSV: ${(err as Error).message}`,
          ...warnings,
        ],
        categorizationSuggestions: suggestCategorization(rows),
      };
    }
  }

  // auto + no apiKey → CSV only.
  const { payload, warnings, rows } = ingestViaCsv(opts);
  return {
    payload,
    pathUsed: "csv",
    warnings,
    categorizationSuggestions: suggestCategorization(rows),
  };
}
