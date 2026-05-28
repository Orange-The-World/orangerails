/**
 * BoJ Playwright runner — drives a headless Chromium through the
 * Bank of Japan stat-search site to retrieve the daily FX reference rates.
 *
 * Why this exists: direct GETs to `https://www.stat-search.boj.or.jp/...`
 * (the famecgi2 CSV endpoint) return an HTML stub ("page cannot be
 * displayed") when called without a real browser session. The site sets
 * session cookies + checks the Referer + serves Shift_JIS content. Playwright
 * lets us hold a real browsing context, follow the documented English flow,
 * and read the response body bytes — which we decode with the existing
 * `BojSource.decodeShiftJis()` helper so the parse logic stays unified.
 *
 * Strategy:
 *   1. Open a Chromium context with a polite UA + ja-JP locale.
 *   2. Navigate to the BoJ time-series search landing page (English).
 *   3. Use `context.request.get(...)` to fetch the famecgi2 CSV URL —
 *      this re-uses the cookies + UA + Referer that the navigation
 *      established. That gets us past the "page cannot be displayed"
 *      blocker without having to script the form-fill UI.
 *   4. Read the response body as bytes, decode Shift_JIS, hand to
 *      BojSource.parseCsv().
 *
 * The brief's "click through English toggle / accept disclaimer" is handled
 * implicitly by `context.request.get` from the English landing (the toggle
 * just routes to a different page tree; the famecgi2 endpoint is the same
 * for both languages, the `cgi=$nme_a000_en` param selects English output).
 *
 * Architecture rules:
 *   - Polite UA with founder contact email.
 *   - Single landing navigation, then one CSV fetch per pair.
 *   - Sleep 600ms between fetches.
 *   - Fail gracefully — log status + body preview on any non-200.
 */

import { BojSource, decodeShiftJis, type BojPair, type BojParsedRow } from "./sources/boj";

const LANDING_URL = "https://www.stat-search.boj.or.jp/index_en.html";
const USER_AGENT =
  "ORBI-Archiver/1.0 (noreply@orangerails.com; +https://orangerails.com/orbi)";
const FETCH_SLEEP_MS = 600;

export interface BojPlaywrightOptions {
  pairs: BojPair[];
  yearFrom: number;
  yearTo: number;
  headed?: boolean;
  log?: (msg: string) => void;
  /** Override landing URL (e.g. when BoJ moves the page). */
  landingUrl?: string;
  /** Optional sink for raw decoded CSV bodies, keyed by pair. */
  dumpPath?: string;
  /** Hard ceiling on overall navigation time per request (default 60s). */
  navTimeoutMs?: number;
}

export interface BojExtractionResult {
  rows: BojParsedRow[];
  /** Per-pair diagnostics (status, body length, first parsed date). */
  diagnostics: Array<{
    pair: BojPair;
    status: number;
    bodyBytes: number;
    parsedRows: number;
    firstDate: string | null;
    lastDate: string | null;
  }>;
}

/**
 * Run the BoJ Playwright flow for the requested pairs and year window.
 * Returns BojParsedRow[] (already filtered for "ND" / weekend gaps).
 */
export async function runBojPlaywright(
  opts: BojPlaywrightOptions,
): Promise<BojExtractionResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const landingUrl = opts.landingUrl ?? LANDING_URL;
  const navTimeoutMs = opts.navTimeoutMs ?? 60_000;

  // Lazy import — see snb-playwright-runner.ts rationale.
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({ headless: !opts.headed });
  const src = new BojSource();
  const dumps: Record<string, string> = {};
  const diagnostics: BojExtractionResult["diagnostics"] = [];
  const allRows: BojParsedRow[] = [];

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "en-US",
      timezoneId: "Asia/Tokyo",
      extraHTTPHeaders: {
        "Accept-Language": "en-US,en;q=0.9,ja;q=0.8",
      },
    });

    const page = await context.newPage();
    log(`[boj-runner] navigating to ${landingUrl} (establish session)`);
    await page.goto(landingUrl, {
      waitUntil: "domcontentloaded",
      timeout: navTimeoutMs,
    });
    await page.waitForTimeout(FETCH_SLEEP_MS);

    for (const pair of opts.pairs) {
      const url = src.urlFor(pair, opts.yearFrom, opts.yearTo);
      log(`[boj-runner] fetching ${pair} -> ${url}`);
      const res = await context.request.get(url, {
        headers: {
          Referer: landingUrl,
          Accept: "text/csv,application/csv,*/*;q=0.8",
        },
        timeout: navTimeoutMs,
      });
      const status = res.status();
      const buf = await res.body();
      const bytes = buf.byteLength;
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      let parsed: BojParsedRow[] = [];
      let firstDate: string | null = null;
      let lastDate: string | null = null;

      if (status === 200 && bytes > 0) {
        try {
          const csv = decodeShiftJis(ab);
          if (opts.dumpPath) dumps[pair] = csv;
          parsed = src.parseCsv(csv, pair);
          allRows.push(...parsed);
          if (parsed.length > 0) {
            firstDate = parsed[0]!.date;
            lastDate = parsed[parsed.length - 1]!.date;
          }
        } catch (err) {
          log(
            `[boj-runner] WARN: parse failed for ${pair}: ${(err as Error).message}. ` +
              `body preview: ${Buffer.from(ab).toString("utf8").slice(0, 200)}`,
          );
        }
      } else {
        log(
          `[boj-runner] WARN: ${pair} status=${status} bytes=${bytes}. ` +
            `Body preview: ${Buffer.from(ab).toString("utf8").slice(0, 200)}`,
        );
      }

      diagnostics.push({
        pair,
        status,
        bodyBytes: bytes,
        parsedRows: parsed.length,
        firstDate,
        lastDate,
      });

      await page.waitForTimeout(FETCH_SLEEP_MS);
    }

    if (opts.dumpPath && Object.keys(dumps).length > 0) {
      const fs = await import("node:fs");
      fs.writeFileSync(opts.dumpPath, JSON.stringify(dumps, null, 2));
      log(`[boj-runner] dumped raw CSV bodies to ${opts.dumpPath}`);
    }
  } finally {
    await browser.close();
  }

  return { rows: allRows, diagnostics };
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = args.includes("--headed");
  // CLI: boj-playwright-runner [--headed] [--from YYYY] [--to YYYY] [--pairs USD/JPY,EUR/JPY]
  const fromIdx = args.indexOf("--from");
  const toIdx = args.indexOf("--to");
  const pairsIdx = args.indexOf("--pairs");
  const yearFrom = fromIdx >= 0 ? Number(args[fromIdx + 1]) : 1973;
  const yearTo = toIdx >= 0 ? Number(args[toIdx + 1]) : new Date().getUTCFullYear();
  const pairsArg = pairsIdx >= 0 ? args[pairsIdx + 1]! : "USD/JPY,EUR/JPY,GBP/JPY";
  const pairs = pairsArg.split(",").map((s) => s.trim()) as BojPair[];

  const result = await runBojPlaywright({ pairs, yearFrom, yearTo, headed });
  console.log(
    JSON.stringify(
      {
        rowCount: result.rows.length,
        sample: result.rows.slice(0, 3),
        diagnostics: result.diagnostics,
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("boj-playwright-runner FAILED:", err);
    process.exit(1);
  });
}
