/**
 * Bangko Sentral ng Pilipinas (BSP) source — USD/PHP daily reference rate.
 *
 * Why this exists: Philippine tax (BIR) and IFRS reporting in the
 * Philippines require the BSP-published daily Peso-per-US-Dollar reference
 * rate for converting foreign-currency transactions. Customers in PH need
 * this rate side-by-side with our ORBI VW-median for compliance.
 *
 * Source: BSP publishes a comprehensive historical Excel workbook at
 *   https://www.bsp.gov.ph/statistics/external/pesodollar.xlsx
 * that contains daily, monthly, and annual Peso/USD rates back to 1978.
 * The file is sovereign-authoritative (published directly by BSP from the
 * sharepoint path "Shared Documents/LEID/IND/Exchange Rate/01 Daily/01
 * Peso-Dollar/"), free, no auth, no ToS restriction beyond the standard
 * "data is publicly available" stance, and the URL is stable (referenced
 * from the BSP ExchangeRate.aspx landing page).
 *
 * The workbook has three sheets:
 *   - monthly (sheet1)
 *   - annual  (sheet2)
 *   - daily   (sheet3)  ← what we consume
 *
 * Daily sheet layout (one year-block per ~33 rows, newest first):
 *   row N    : col A = year (e.g. "2026"), cols B..M empty
 *   row N+1  : col A = "Day", cols B..M = month labels (Jan..Dec)
 *   row N+2  : col A = 1,  cols B..M = USD/PHP rate for that (day, month)
 *     ...    : ...
 *   row N+32 : col A = 31, cols B..M = USD/PHP rate for that (day, month)
 *
 * Cells with no observation (weekends, holidays, days outside the month)
 * are shared-string indices pointing at "..", "n.a.", or empty space —
 * always non-numeric. We filter those out.
 *
 * Bun's `node:zlib` provides `inflateRawSync` which is enough to decode
 * STORED/DEFLATED zip entries; we read the central directory and pull
 * sheet3.xml inline (no external deps — matches the convention of every
 * other central-bank plug-in in this folder).
 */

import { inflateRawSync } from "node:zlib";
import type { AuthorityRateInsert } from "../lib/batch-writer";

export interface BspFetchOptions {
  /** Override fetch (for tests). */
  fetchImpl?: typeof fetch;
}

/** One observation parsed from the daily sheet. */
export interface BspDailyObservation {
  /** ISO date "YYYY-MM-DD". */
  date: string;
  /** USD/PHP daily rate. */
  rate: number;
}

/** Workbook bytes wrapper — exposes the daily sheet XML and shared strings. */
export interface BspWorkbookBytes {
  /** Raw bytes of the .xlsx file. */
  bytes: Uint8Array;
}

const PESODOLLAR_URL =
  "https://www.bsp.gov.ph/statistics/external/pesodollar.xlsx";

const MONTH_INDEX_BY_NAME: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12,
};

export class BspSource {
  readonly name = "bsp";
  readonly endpointBase = PESODOLLAR_URL;
  readonly userAgent =
    "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; contact@orangerails.com)";

  /** Fetch the full BSP pesodollar.xlsx workbook. */
  async fetch(opts: BspFetchOptions = {}): Promise<BspWorkbookBytes> {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(PESODOLLAR_URL, {
      headers: {
        "User-Agent": this.userAgent,
        Accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`BSP ${res.status}: ${body.slice(0, 300)}`);
    }
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf) };
  }

  /**
   * Parse pesodollar.xlsx bytes → daily observations within [from, to].
   *
   * Bounds are inclusive, "YYYY-MM-DD".
   */
  parseDaily(
    wb: BspWorkbookBytes,
    from: string,
    to: string,
  ): BspDailyObservation[] {
    const entries = readZipEntries(wb.bytes);
    const sheet = entries.get("xl/worksheets/sheet3.xml");
    if (!sheet) {
      throw new Error("BSP pesodollar.xlsx: xl/worksheets/sheet3.xml missing");
    }
    const xml = new TextDecoder("utf-8").decode(sheet);
    return parseDailySheetXml(xml, from, to);
  }

  /** Map daily observations into AuthorityRateInsert rows. */
  toInserts(
    observations: BspDailyObservation[],
    fetchedAtIso: string,
  ): AuthorityRateInsert[] {
    const rows: AuthorityRateInsert[] = [];
    for (const o of observations) {
      if (!Number.isFinite(o.rate) || o.rate <= 0) continue;
      rows.push({
        source_currency: "USD",
        target_currency: "PHP",
        bucket_ts: `${o.date}T00:00:00.000Z`,
        granularity: "1d",
        product: "ORBI-D-authority",
        rate: o.rate,
        tier: "B-single",
        composite: false,
        composite_via: null,
        provider_count: 1,
        status: "CONFIRMED",
        fetched_at: fetchedAtIso,
        computed_at: fetchedAtIso,
        source_authority: "BSP",
        provenance: "historical-backfill",
      });
    }
    return rows;
  }
}

// ----------------------------------------------------------------------------
// Daily sheet XML parser
// ----------------------------------------------------------------------------

interface CellValue {
  /** A1-style cell ref, e.g. "B43". */
  ref: string;
  /** Column letter component (one or two letters). */
  col: string;
  /** Row number component. */
  row: number;
  /** Cell type — only "n" (number) values yield rates; "s" cells we ignore. */
  type: string;
  /** Raw inner-text value. */
  value: string;
}

/**
 * Walk the daily sheet XML once, build a {row → {col → numericValue}} map,
 * then re-stitch year/month blocks. The sheet structure is documented in
 * the file header.
 *
 * Exported for unit testing.
 */
export function parseDailySheetXml(
  xml: string,
  from: string,
  to: string,
): BspDailyObservation[] {
  const cells = extractCells(xml);

  // Build a sparse table: rows[row][col] = CellValue.
  const rows = new Map<number, Map<string, CellValue>>();
  for (const c of cells) {
    let r = rows.get(c.row);
    if (!r) {
      r = new Map();
      rows.set(c.row, r);
    }
    r.set(c.col, c);
  }

  // Identify year blocks: a row whose A-cell is a 4-digit number AND whose
  // B..M cells are empty. The next 33 rows (header + 31 days, with some
  // blank thickBot/header rows in between) belong to that year.
  const blocks: Array<{ year: number; startRow: number }> = [];
  for (const [rowNum, rowCells] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    const a = rowCells.get("A");
    if (!a || a.type === "s") continue;
    const yr = Number(a.value);
    if (!Number.isFinite(yr) || yr < 1900 || yr > 2100) continue;
    // Confirm cols B..M are empty (year header row, not a day row).
    let bToMHasNumeric = false;
    for (const col of ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"]) {
      const cell = rowCells.get(col);
      if (cell && cell.value !== "") {
        bToMHasNumeric = true;
        break;
      }
    }
    if (bToMHasNumeric) continue;
    blocks.push({ year: yr, startRow: rowNum });
  }

  // For each year block, walk forward looking for "day" rows.
  // A day row has col A = integer 1..31 (numeric, not shared-string).
  // Cap the per-block scan at 40 rows (year-header + day-header + 31 day
  // rows + a few padding/thickBot rows) so the final block doesn't run
  // off the end of the sheet.
  const maxRow = [...rows.keys()].reduce((a, b) => (b > a ? b : a), 0);
  const PER_BLOCK_ROW_BUDGET = 40;
  const observations: BspDailyObservation[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const blk = blocks[bi]!;
    const nextStart = bi + 1 < blocks.length ? blocks[bi + 1]!.startRow : maxRow + 1;
    const blockEnd = Math.min(nextStart, blk.startRow + PER_BLOCK_ROW_BUDGET);
    for (let r = blk.startRow + 1; r < blockEnd; r++) {
      const rowCells = rows.get(r);
      if (!rowCells) continue;
      const a = rowCells.get("A");
      if (!a || a.type === "s") continue;
      const dom = Number(a.value);
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) continue;
      // Walk B..M = Jan..Dec.
      const monthCols: Array<[string, number]> = [
        ["B", 1], ["C", 2], ["D", 3], ["E", 4], ["F", 5], ["G", 6],
        ["H", 7], ["I", 8], ["J", 9], ["K", 10], ["L", 11], ["M", 12],
      ];
      for (const [col, month] of monthCols) {
        const cell = rowCells.get(col);
        if (!cell) continue;
        if (cell.type === "s") continue; // shared-string: "..", "n.a.", " ", etc.
        if (cell.value === "") continue;
        const rate = Number(cell.value);
        if (!Number.isFinite(rate) || rate <= 0) continue;
        // Skip impossible (day, month) combos (e.g. Feb 30).
        const iso = isoDateOrNull(blk.year, month, dom);
        if (!iso) continue;
        if (iso < from || iso > to) continue;
        observations.push({ date: iso, rate });
      }
    }
  }

  observations.sort((a, b) => a.date.localeCompare(b.date));
  return observations;
}

/** ISO date string if (year, month, day) is a real calendar date, else null. */
export function isoDateOrNull(
  year: number,
  month: number,
  day: number,
): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Extract every cell `<c r="..." [s="..."] [t="..."]/>` or
 * `<c ...><v>...</v></c>` from the sheet XML.
 *
 * Implemented as a forward scanner rather than a single regex because the
 * full daily sheet is ~1 MB and backtracking on a single multi-group regex
 * spans pathological territory. Splitting on the literal `<c ` opener and
 * walking each fragment runs in milliseconds on the same input.
 */
function extractCells(xml: string): CellValue[] {
  const cells: CellValue[] = [];
  // First fragment before the first `<c ` is preamble; skip it.
  const parts = xml.split("<c ");
  for (let i = 1; i < parts.length; i++) {
    const frag = parts[i]!;
    // Locate the end of the opening tag: either `/>` (self-closing) or `>`.
    const closeIdx = frag.indexOf(">");
    if (closeIdx < 0) continue;
    const isSelfClosing = frag.charCodeAt(closeIdx - 1) === 0x2f; // "/"
    const headEnd = isSelfClosing ? closeIdx - 1 : closeIdx;
    const head = frag.slice(0, headEnd);

    const refMatch = head.match(/r="([A-Z]+)(\d+)"/);
    if (!refMatch) continue;
    const col = refMatch[1]!;
    const row = Number(refMatch[2]!);
    const typeMatch = head.match(/\bt="([^"]+)"/);
    const type = typeMatch ? typeMatch[1]! : "n";

    let value = "";
    if (!isSelfClosing) {
      // Body runs from after the `>` to the next `</c>` in this fragment.
      const bodyEnd = frag.indexOf("</c>", closeIdx + 1);
      if (bodyEnd >= 0) {
        const body = frag.slice(closeIdx + 1, bodyEnd);
        const vStart = body.indexOf("<v>");
        if (vStart >= 0) {
          const vEnd = body.indexOf("</v>", vStart + 3);
          if (vEnd >= 0) value = body.slice(vStart + 3, vEnd);
        }
      }
    }
    cells.push({ ref: `${col}${row}`, col, row, type, value });
  }
  return cells;
}

// Silence unused-var linting on the month-name helper while keeping it
// exported for prospective monthly-sheet parsers.
export function monthNumber(name: string): number | null {
  const trimmed = name.trim().slice(0, 3);
  return MONTH_INDEX_BY_NAME[trimmed] ?? null;
}

// ----------------------------------------------------------------------------
// Minimal pure-stdlib zip reader (.xlsx is a regular ZIP archive).
//
// Only handles STORED (method 0) and DEFLATE (method 8) entries — which is
// every entry produced by Excel/Office. We read the central directory at
// the end of the file rather than scanning local headers, because the
// pesodollar.xlsx archive routinely declares zero values in the local
// header data-descriptor section and the CD is the trustworthy source.
// ----------------------------------------------------------------------------

const SIG_EOCD = 0x06054b50;
const SIG_CDIR = 0x02014b50;
const SIG_LFH = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/** Map entry name → uncompressed bytes. */
export function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("ZIP: end-of-central-directory not found");
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const totalEntries = buf.readUInt16LE(eocd + 10);

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let i = 0; i < totalEntries && p < cdEnd; i++) {
    const sig = buf.readUInt32LE(p);
    if (sig !== SIG_CDIR) {
      throw new Error(`ZIP: bad CD entry signature at ${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset: localOff,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const out = new Map<string, Uint8Array>();
  for (const e of entries) {
    const lh = e.localHeaderOffset;
    const sig = buf.readUInt32LE(lh);
    if (sig !== SIG_LFH) {
      throw new Error(`ZIP: bad local-file-header signature for ${e.name}`);
    }
    const lhNameLen = buf.readUInt16LE(lh + 26);
    const lhExtraLen = buf.readUInt16LE(lh + 28);
    const dataStart = lh + 30 + lhNameLen + lhExtraLen;
    const slice = buf.subarray(dataStart, dataStart + e.compressedSize);
    let data: Uint8Array;
    if (e.method === 0) {
      data = new Uint8Array(slice);
    } else if (e.method === 8) {
      data = new Uint8Array(inflateRawSync(slice));
    } else {
      throw new Error(`ZIP: unsupported method ${e.method} for ${e.name}`);
    }
    out.set(e.name, data);
  }
  return out;
}

/** Scan backwards for the End-of-Central-Directory signature. */
function findEocd(buf: Buffer): number {
  const maxScan = Math.min(buf.length, 65557); // 22-byte EOCD + 64KB comment
  const start = buf.length - maxScan;
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}
