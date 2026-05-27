/**
 * SNB Playwright runner — renders the SNB cube SPA and extracts the
 * daily-rates table.
 *
 * Why this exists: the SNB SDMX CSV endpoint for the *daily* cube returns
 * 404 (validated 2026-05-26 in DEFERRED_SOURCES.md). The only reliable path
 * to daily reference rates is the SPA at:
 *
 *   https://data.snb.ch/en/topics/ziredev/cube/devkua
 *
 * This module launches a headless Chromium, navigates to the cube page,
 * waits for the table to render, scrolls the viewport to force lazy-loaded
 * rows, then extracts the headers + rows as plain string arrays. It then
 * hands those to the existing SnbSource.parseTable() parser so the row
 * mapping logic stays in one place (and is covered by unit tests against
 * captured fixtures).
 *
 * Architecture rules (from feat/central-banks-snb-boj-runners brief):
 *   - Polite UA with founder contact email.
 *   - Single navigation per invocation; sleep 600ms between page actions.
 *   - Fail gracefully if the SPA structure changes — log diagnostic info
 *     (URL, table count, sample header) instead of crashing opaquely.
 *
 * Two entry points:
 *   1. `runSnbPlaywright(opts)` — programmatic; returns SnbParsedRow[].
 *      Used by orchestrator.ts when authority === 'snb'.
 *   2. CLI: `node snb-playwright-runner.ts [--headed] [--dump <path>]` —
 *      prints JSON to stdout. Used for ad-hoc verification.
 */

import { SnbSource, type SnbParsedRow } from "./sources/snb";

const DEFAULT_URL = "https://data.snb.ch/en/topics/ziredev/cube/devkua";
const USER_AGENT =
  "ORBI-Archiver/1.0 (noreply@orangerails.com; +https://orangerails.com/orbi)";
const NAV_SLEEP_MS = 600;

export interface SnbPlaywrightOptions {
  /** Override the SPA URL (default: SNB devkua cube). */
  url?: string;
  /** Launch a visible browser instead of headless. Useful for debugging. */
  headed?: boolean;
  /** Optional sink for the raw extracted { headers, rows } tuple (JSON). */
  dumpPath?: string;
  /** Optional log hook (defaults to console.log). */
  log?: (msg: string) => void;
  /** Hard ceiling on overall navigation time (default 60s). */
  navTimeoutMs?: number;
}

export interface SnbExtraction {
  headers: string[];
  rows: string[][];
  /** Diagnostic: how many <table> elements were on the page when scraped. */
  tableCount: number;
  /** The first table's first header — helps spot SPA layout changes fast. */
  firstHeaderSample: string;
}

/**
 * Extract the SNB daily-rates table from the rendered SPA.
 *
 * Strategy:
 *   1. Goto cube page, wait for `networkidle`.
 *   2. Scroll to the bottom to force any virtualised rows to render.
 *   3. Wait an extra 600ms for any final XHR-driven repaint.
 *   4. Pick the table with the most data rows (the cube page has a header
 *      table + the rates table; the rates table is always larger).
 *   5. Return { headers, rows } for the parser.
 */
export async function extractSnbTable(
  opts: SnbPlaywrightOptions = {},
): Promise<SnbExtraction> {
  const url = opts.url ?? DEFAULT_URL;
  const log = opts.log ?? ((m: string) => console.log(m));
  const navTimeoutMs = opts.navTimeoutMs ?? 60_000;

  // Lazy import so this module can be loaded by the orchestrator even on
  // hosts where `playwright` isn't installed (the orchestrator routes
  // SNB-via-Playwright invocations to bb-support / jarvis).
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({ headless: !opts.headed });
  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "en-CH",
      timezoneId: "Europe/Zurich",
    });
    const page = await context.newPage();
    log(`[snb-runner] navigating to ${url}`);
    await page.goto(url, { waitUntil: "networkidle", timeout: navTimeoutMs });
    await page.waitForTimeout(NAV_SLEEP_MS);

    // Scroll the page in chunks to flush lazy rows. SNB renders the daily
    // cube into a scrollable container; one scrollTo to the bottom may not
    // be enough if the inner container has its own scrollbar.
    await page.evaluate(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      window.scrollTo(0, 0);
      for (let i = 0; i < 6; i++) {
        window.scrollBy(0, window.innerHeight);
        await sleep(150);
      }
      // Also scroll any inner scrollable containers (e.g. ag-grid, custom
      // divs). Cheap and harmless if they don't exist.
      const scrollables = Array.from(document.querySelectorAll<HTMLElement>("*"))
        .filter((el) => {
          const s = getComputedStyle(el);
          return /auto|scroll/.test(s.overflowY) && el.scrollHeight > el.clientHeight;
        });
      for (const el of scrollables.slice(0, 4)) {
        el.scrollTop = el.scrollHeight;
        await sleep(150);
      }
    });
    await page.waitForTimeout(NAV_SLEEP_MS);

    const extraction = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll("table"));
      // Pick the table with the most <tr> rows.
      let best: HTMLTableElement | null = null;
      let bestRowCount = -1;
      for (const t of tables) {
        const rc = t.querySelectorAll("tr").length;
        if (rc > bestRowCount) {
          best = t as HTMLTableElement;
          bestRowCount = rc;
        }
      }
      if (!best) {
        return { headers: [], rows: [], tableCount: tables.length, firstHeaderSample: "" };
      }
      const trs = Array.from(best.querySelectorAll("tr"));
      // First row with <th> cells wins as the header row; otherwise the
      // first row.
      let headerRowIdx = trs.findIndex((tr) => tr.querySelectorAll("th").length > 0);
      if (headerRowIdx < 0) headerRowIdx = 0;
      const headerCells = Array.from(
        trs[headerRowIdx]!.querySelectorAll("th, td"),
      ).map((c) => (c.textContent ?? "").trim());
      const rows: string[][] = [];
      for (let i = headerRowIdx + 1; i < trs.length; i++) {
        const cells = Array.from(trs[i]!.querySelectorAll("td, th")).map((c) =>
          (c.textContent ?? "").trim(),
        );
        if (cells.length === 0) continue;
        rows.push(cells);
      }
      return {
        headers: headerCells,
        rows,
        tableCount: tables.length,
        firstHeaderSample: headerCells[0] ?? "",
      };
    });

    log(
      `[snb-runner] tables=${extraction.tableCount} ` +
        `headers=[${extraction.headers.join(",")}] ` +
        `data-rows=${extraction.rows.length}`,
    );

    if (opts.dumpPath) {
      const fs = await import("node:fs");
      fs.writeFileSync(opts.dumpPath, JSON.stringify(extraction, null, 2));
      log(`[snb-runner] dumped raw extraction to ${opts.dumpPath}`);
    }

    return extraction;
  } finally {
    await browser.close();
  }
}

/**
 * Top-level runner: extracts the table and runs it through the parser.
 * Returns canonical SnbParsedRow[] (foreign-per-CHF). The orchestrator
 * calls SnbSource.toInserts() to flatten these into AuthorityRateInsert.
 */
export async function runSnbPlaywright(
  opts: SnbPlaywrightOptions = {},
): Promise<SnbParsedRow[]> {
  const extraction = await extractSnbTable(opts);
  if (extraction.headers.length === 0 || extraction.rows.length === 0) {
    const log = opts.log ?? ((m: string) => console.log(m));
    log(
      `[snb-runner] WARN: no usable table on page ` +
        `(tables=${extraction.tableCount}, firstHeader='${extraction.firstHeaderSample}')`,
    );
    return [];
  }
  const src = new SnbSource();
  return src.parseTable(extraction.headers, extraction.rows);
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = args.includes("--headed");
  const dumpIdx = args.indexOf("--dump");
  const dumpPath = dumpIdx >= 0 ? args[dumpIdx + 1] : undefined;
  const urlIdx = args.indexOf("--url");
  const url = urlIdx >= 0 ? args[urlIdx + 1] : undefined;

  const rows = await runSnbPlaywright({ headed, dumpPath, url });
  console.log(JSON.stringify({ rowCount: rows.length, sample: rows.slice(0, 3) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("snb-playwright-runner FAILED:", err);
    process.exit(1);
  });
}
