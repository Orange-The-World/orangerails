/**
 * Streaming CSV parser for historical-backfill source bundles.
 *
 * Goals:
 *   - Yield rows one at a time so we never load the whole file into memory.
 *     A full Bitstamp BTC/USD minute history can run to 8M+ rows.
 *   - Tolerate banner lines (cryptodatadownload.com prefixes their CSVs
 *     with a single URL line before the real header).
 *   - Tolerate trailing blank lines and Windows CRLF.
 *
 * Each yielded row is a Record<columnName, string>. Numeric coercion
 * happens in the source-specific mapper (e.g. bitstamp-csv.ts).
 *
 * Usage:
 *   for await (const row of parseCsv(stream, { skipLines: 1 })) { ... }
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export interface CsvParseOptions {
  /** Number of leading lines to skip BEFORE the header row (e.g. banner). */
  skipLines?: number;
  /** Custom delimiter (default ","). */
  delimiter?: string;
}

export interface CsvRow {
  [column: string]: string;
}

/**
 * Stream-parse a CSV from any Readable (file stream, fetch body, fixture buffer).
 *
 * Async generator: the caller pulls rows at their own cadence, so a slow
 * downstream consumer (DB writer) backpressures the parser naturally.
 */
export async function* parseCsv(
  stream: Readable,
  opts: CsvParseOptions = {},
): AsyncIterable<CsvRow> {
  const skip = opts.skipLines ?? 0;
  const delim = opts.delimiter ?? ",";

  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  let header: string[] | null = null;

  for await (const raw of rl) {
    lineNo++;
    if (lineNo <= skip) continue;
    const line = raw.trim();
    if (!line) continue;

    if (!header) {
      header = splitCsvLine(line, delim);
      continue;
    }

    const fields = splitCsvLine(line, delim);
    const row: CsvRow = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]!] = fields[i] ?? "";
    }
    yield row;
  }
}

/**
 * Convenience wrapper: stream from a file path.
 */
export function parseCsvFile(path: string, opts: CsvParseOptions = {}): AsyncIterable<CsvRow> {
  return parseCsv(createReadStream(path, { encoding: "utf8" }), opts);
}

/**
 * Split a CSV line. Handles double-quoted fields with embedded commas
 * and escaped double-quotes (""). Not RFC-4180-perfect (no newline-inside-
 * field support) but the OHLCV bundles we ingest don't use it.
 */
export function splitCsvLine(line: string, delim = ","): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out;
}
