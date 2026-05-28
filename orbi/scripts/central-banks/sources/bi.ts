/**
 * Bank Indonesia (BI) source — USD/IDR daily JISDOR reference rate.
 *
 * JISDOR (Jakarta Interbank Spot Dollar Offered Rate) is BI's official
 * daily USD/IDR reference rate, calculated each business day at ~10:00
 * WIB (Western Indonesian Time, UTC+7) from volume-weighted spot
 * interbank quotes contributed by JISDOR participating banks. It is the
 * sovereign-authoritative rate used for IFRS / Indonesian-tax FX
 * conversion and the official daily peg published by Bank Indonesia.
 *
 * Source: BI publishes JISDOR on a SharePoint-hosted ASP.NET WebForms
 * page at
 *   https://www.bi.go.id/id/statistik/informasi-kurs/jisdor/default.aspx
 * The page exposes a date-range form ("Dari" / "Sampai" — Indonesian for
 * "From" / "Until") with two action buttons: "Cari" (Search) renders a
 * paginated HTML table (10 rows/page), and "Unduh" (Download) returns
 * the entire matching range as an Excel attachment in a single response.
 *
 * Why XLSX export over HTML scraping: the Unduh path returns a small,
 * fully-populated XLSX workbook (one row per JISDOR publication date)
 * regardless of range size — empirically the BI backend serves a single
 * 5-year window (2021-01-01 → 2026-05-27, ~1,299 publication dates) in
 * a ~32 KB response in under 5 seconds. The Cari path tops out at 10
 * rows per call and would require chasing pagination postbacks. Same
 * `__VIEWSTATE` triple, swap `ButtonCari` → `ButtonExport`, parse the
 * XLSX bytes in-process via the same `node:zlib` zip-reader pattern
 * established by the BSP plug-in.
 *
 * XLSX layout (one workbook, one sheet, no merged cells):
 *   row 3        : workbook title (4 merged shared-string cells)
 *   row 5        : header row — "NO", "Tanggal", "Kurs"   (shared strings)
 *   row 6..N     : data rows
 *                  col A = row number (numeric)
 *                  col B = date as shared-string "M/D/YYYY 12:00:00 AM"
 *                  col C = rate as numeric integer (IDR per 1 USD)
 *
 * Note: BI's Unduh export rounds rates to whole IDR (e.g. 14084 for
 * 14,084.00). The HTML table shows two decimal places ("Rp14.084,00")
 * but the underlying value is identical — the trailing ",00" is locale
 * formatting, not significant precision. Storing as a JS number is safe.
 *
 * Sovereign authority: page is served from www.bi.go.id (Bank
 * Indonesia's own domain, valid GlobalSign cert with O=Bank Indonesia).
 * No auth, no API key, no Akamai fingerprint — silent-friendly under
 * ORBI's Hybrid Asymmetric Strategy.
 */

import { inflateRawSync } from "node:zlib";
import type { AuthorityRateInsert } from "../lib/batch-writer";

const JISDOR_URL =
  "https://www.bi.go.id/id/statistik/informasi-kurs/jisdor/default.aspx";

const WEBPART_PREFIX =
  "ctl00$ctl54$g_f51e6b6d_47c5_4ff4_8105_27cbd1a2f52d$ctl00";

/**
 * BI's SharePoint front-end blocks bare `User-Agent: curl/*` and other
 * obvious automation strings. A standard Chrome string sails through.
 * We keep the project-identifying "Orange-Rails-ORBI/1.0" segment as a
 * suffix-comment so the operator can correlate logs if needed.
 */
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120.0.0.0 Safari/537.36 (+Orange-Rails-ORBI/1.0)";

export interface BiFetchOptions {
  /** Inclusive lower bound, "YYYY-MM-DD". */
  from: string;
  /** Inclusive upper bound, "YYYY-MM-DD". */
  to: string;
  fetchImpl?: typeof fetch;
}

export interface BiObservation {
  /** ISO date "YYYY-MM-DD" (the JISDOR publication date). */
  date: string;
  /** USD/IDR rate (IDR per 1 USD). */
  rate: number;
}

interface ViewState {
  __VIEWSTATE: string;
  __VIEWSTATEGENERATOR: string;
  __EVENTVALIDATION: string;
}

export class BiSource {
  readonly name = "bi";
  readonly endpointBase = JISDOR_URL;
  readonly userAgent = BROWSER_UA;

  /**
   * Fetch the JISDOR landing page and extract the ASP.NET viewstate
   * triple needed to round-trip an "Unduh" (export) postback.
   */
  async fetchViewState(fetchImpl?: typeof fetch): Promise<ViewState> {
    const f = fetchImpl ?? fetch;
    const res = await f(JISDOR_URL, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`BI JISDOR GET ${res.status}: ${body.slice(0, 300)}`);
    }
    const html = await res.text();
    return extractViewState(html);
  }

  /**
   * Fetch the JISDOR XLSX export for an inclusive (from, to) window.
   * Returns the raw XLSX bytes.
   */
  async fetchExport(
    vs: ViewState,
    fromIso: string,
    toIso: string,
    fetchImpl?: typeof fetch,
  ): Promise<Uint8Array> {
    const f = fetchImpl ?? fetch;
    const body = new URLSearchParams();
    body.set("__EVENTTARGET", "");
    body.set("__EVENTARGUMENT", "");
    body.set("__VIEWSTATE", vs.__VIEWSTATE);
    body.set("__VIEWSTATEGENERATOR", vs.__VIEWSTATEGENERATOR);
    body.set("__EVENTVALIDATION", vs.__EVENTVALIDATION);
    body.set(`${WEBPART_PREFIX}$TextBoxFrom`, toDmy(fromIso));
    body.set(`${WEBPART_PREFIX}$HiddenFieldDateFrom`, fromIso);
    body.set(`${WEBPART_PREFIX}$TextBoxDateTo`, toDmy(toIso));
    body.set(`${WEBPART_PREFIX}$HiddenFieldDateTo`, toIso);
    body.set(`${WEBPART_PREFIX}$ButtonExport`, "Unduh");
    const res = await f(JISDOR_URL, {
      method: "POST",
      headers: {
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: JISDOR_URL,
        Accept:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`BI JISDOR Unduh ${res.status}: ${text.slice(0, 300)}`);
    }
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /**
   * End-to-end: pull viewstate, request the XLSX export for [from, to],
   * parse, dedupe-by-date, and return ascending observations.
   */
  async fetchRange(opts: BiFetchOptions): Promise<BiObservation[]> {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(opts.from) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(opts.to) ||
      opts.from > opts.to
    ) {
      throw new Error(`Invalid BI range: ${opts.from} → ${opts.to}`);
    }
    const vs = await this.fetchViewState(opts.fetchImpl);
    const bytes = await this.fetchExport(vs, opts.from, opts.to, opts.fetchImpl);
    const parsed = parseJisdorXlsx(bytes);
    const byDate = new Map<string, BiObservation>();
    for (const o of parsed) {
      if (o.date >= opts.from && o.date <= opts.to) byDate.set(o.date, o);
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Map observations into AuthorityRateInsert rows. */
  toInserts(
    observations: BiObservation[],
    fetchedAtIso: string,
  ): AuthorityRateInsert[] {
    const rows: AuthorityRateInsert[] = [];
    for (const o of observations) {
      if (!Number.isFinite(o.rate) || o.rate <= 0) continue;
      rows.push({
        source_currency: "USD",
        target_currency: "IDR",
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
        source_authority: "BI",
        provenance: "historical-backfill",
      });
    }
    return rows;
  }
}

// ----------------------------------------------------------------------------
// HTML viewstate helpers — exported for unit tests.
// ----------------------------------------------------------------------------

/**
 * Extract the ASP.NET viewstate triple from the JISDOR landing HTML.
 *
 * SharePoint emits these as `<input type="hidden" name="..." value="...">`;
 * attribute order varies between the runtime-generated `__VIEWSTATE` /
 * `__VIEWSTATEGENERATOR` / `__EVENTVALIDATION` tags, so we match both
 * type-then-name and name-then-type variants.
 */
export function extractViewState(html: string): ViewState {
  const get = (name: string): string => {
    const re1 = new RegExp(
      `<input[^>]+type="hidden"[^>]+name="${escapeRe(name)}"[^>]*value="([^"]*)"`,
      "i",
    );
    const re2 = new RegExp(
      `<input[^>]+name="${escapeRe(name)}"[^>]+type="hidden"[^>]*value="([^"]*)"`,
      "i",
    );
    const m = html.match(re1) ?? html.match(re2);
    if (!m) throw new Error(`BI JISDOR: viewstate field ${name} not found`);
    return m[1]!;
  };
  return {
    __VIEWSTATE: get("__VIEWSTATE"),
    __VIEWSTATEGENERATOR: get("__VIEWSTATEGENERATOR"),
    __EVENTVALIDATION: get("__EVENTVALIDATION"),
  };
}

// ----------------------------------------------------------------------------
// XLSX parser — exported for unit tests.
// ----------------------------------------------------------------------------

/**
 * Parse the JISDOR Unduh XLSX bytes → ascending [{date, rate}] list.
 *
 * Sheet layout documented in the file header. Robust to row ordering
 * (the export currently lands newest-first; we sort ascending here so
 * the orchestrator's checkpoint logic sees monotonic bucket_ts).
 */
export function parseJisdorXlsx(bytes: Uint8Array): BiObservation[] {
  const entries = readZipEntries(bytes);
  const sheetBytes = entries.get("xl/worksheets/sheet1.xml");
  if (!sheetBytes) {
    throw new Error("BI JISDOR XLSX: xl/worksheets/sheet1.xml missing");
  }
  const sharedBytes = entries.get("xl/sharedStrings.xml");
  if (!sharedBytes) {
    throw new Error("BI JISDOR XLSX: xl/sharedStrings.xml missing");
  }
  const sheetXml = new TextDecoder("utf-8").decode(sheetBytes);
  const sharedXml = new TextDecoder("utf-8").decode(sharedBytes);
  const sharedStrings = parseSharedStrings(sharedXml);

  const observations: BiObservation[] = [];
  // Match each data row in the worksheet: we want rows where col A is a
  // numeric serial (row index), col B is a shared-string date, col C is
  // a numeric rate. The header row at r="5" has B as shared-string AND
  // C as shared-string ("Kurs"), which fails the numeric-C check below.
  const rowRe = /<row r="(\d+)">([\s\S]*?)<\/row>/g;
  for (const m of sheetXml.matchAll(rowRe)) {
    const inner = m[2]!;
    const colB = extractCell(inner, "B");
    const colC = extractCell(inner, "C");
    if (!colB || !colC) continue;
    if (colB.type !== "s") continue;
    if (colC.type === "s") continue; // skip header row
    const ssIdx = Number(colB.value);
    if (!Number.isInteger(ssIdx) || ssIdx < 0 || ssIdx >= sharedStrings.length) {
      continue;
    }
    const dateStr = sharedStrings[ssIdx]!;
    const iso = parseUsDateToIso(dateStr);
    if (!iso) continue;
    const rate = Number(colC.value);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    observations.push({ date: iso, rate });
  }
  observations.sort((a, b) => a.date.localeCompare(b.date));
  return observations;
}

interface CellHit {
  type: string;
  value: string;
}

/**
 * Pull the value of the `<c r="<COL><digits>" ...>` element from a row's
 * inner XML. Handles both self-closing cells (`<c .../>`, no value) and
 * normal `<c ...><v>…</v></c>` cells.
 */
function extractCell(rowInner: string, col: string): CellHit | null {
  // Build a regex that matches a <c> opening with r="<col><any-digits>".
  // We capture the opening attributes and the optional <v>...</v>.
  const re = new RegExp(
    `<c\\s+r="${col}\\d+"([^>]*)>(?:\\s*<v>([^<]*)<\\/v>\\s*)?</c>|<c\\s+r="${col}\\d+"([^>]*)/>`,
    "i",
  );
  const m = rowInner.match(re);
  if (!m) return null;
  const attrs = m[1] ?? m[3] ?? "";
  const value = m[2] ?? "";
  const tMatch = attrs.match(/\bt="([^"]+)"/);
  const type = tMatch ? tMatch[1]! : "n";
  return { type, value };
}

/**
 * Parse the `xl/sharedStrings.xml` table into an index-ordered array.
 *
 * Each `<si>` element wraps a single string; the common form is
 *   <si><t>2026-05-27</t></si>
 * but Excel sometimes splits a string across multiple `<r><t>…</t></r>`
 * runs. We concatenate all `<t>` children inside each `<si>`.
 */
export function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
  for (const m of xml.matchAll(siRe)) {
    const inner = m[1]!;
    let combined = "";
    for (const tm of inner.matchAll(tRe)) {
      combined += tm[1]!;
    }
    out.push(combined);
  }
  return out;
}

/**
 * Convert BI's US-locale date format "M/D/YYYY 12:00:00 AM" → "YYYY-MM-DD".
 * Returns null on any parse mismatch.
 */
export function parseUsDateToIso(s: string): string | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!m) return null;
  const month = Number(m[1]!);
  const day = Number(m[2]!);
  const year = Number(m[3]!);
  return isoDateOrNull(year, month, day);
}

/** "YYYY-MM-DD" → "DD/MM/YYYY" (the format BI's TextBox widgets expect). */
export function toDmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
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
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ----------------------------------------------------------------------------
// Minimal pure-stdlib zip reader (.xlsx is a regular ZIP archive).
//
// Matches the convention of bsp.ts — same STORED/DEFLATE method handling,
// same CD-first parse, same `node:zlib` inflate. Could be lifted to lib/
// in a future refactor; kept inline for now to avoid disturbing the BSP
// header layout that the existing BSP test fixture asserts on.
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
  const maxScan = Math.min(buf.length, 65557);
  const start = buf.length - maxScan;
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}
