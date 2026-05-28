import { describe, expect, it } from "vitest";
import {
  RbiSource,
  type RbiParsedRow,
  dmyToIso,
  extractHiddenInput,
  isoToDmy,
  parseRatesTable,
} from "../../scripts/central-banks/sources/rbi";

/**
 * Synthetic HTML mimicking the RBI archive POST response. The real page is
 * ~284 KB but the rate-bearing pattern is identical: a `DD/MM/YYYY</td>`
 * followed by a `<td...>NN.NNNN</td>` cell. We model two adjacent rows plus
 * surrounding chrome to assert the regex doesn't snap onto stray numerics.
 */
const RESULTS_HTML = `<html><body>
  <table id="tblPrint">
    <tr><th>Date</th><th>USD</th></tr>
    <tr><td>27/05/2026</td><td align="right">95.7883</td></tr>
    <tr><td>26/05/2026</td><td>95.4437</td></tr>
    <!-- noise: not a rate row -->
    <tr><td>Average</td><td>95.6160</td></tr>
    <tr><td>22/05/2026</td><td align="right">95.9588</td></tr>
  </table>
  <span>Page generated 2026-05-28</span>
</body></html>`;

describe("RbiSource helpers", () => {
  it("isoToDmy converts ISO → DD/MM/YYYY", () => {
    expect(isoToDmy("2026-05-27")).toBe("27/05/2026");
    expect(isoToDmy("2022-04-04")).toBe("04/04/2022");
    expect(() => isoToDmy("not-a-date")).toThrow();
  });

  it("dmyToIso converts DD/MM/YYYY → ISO and rejects garbage", () => {
    expect(dmyToIso("27/05/2026")).toBe("2026-05-27");
    expect(dmyToIso("04/04/2022")).toBe("2022-04-04");
    expect(dmyToIso("Average")).toBeNull();
    expect(dmyToIso("")).toBeNull();
  });

  it("extractHiddenInput finds ASP.NET tokens regardless of attribute order", () => {
    const a = `<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="ABC123" />`;
    const b = `<input type="hidden" value="DEF456" id="__EVENTVALIDATION" name="__EVENTVALIDATION" />`;
    expect(extractHiddenInput(a, "__VIEWSTATE")).toBe("ABC123");
    expect(extractHiddenInput(b, "__EVENTVALIDATION")).toBe("DEF456");
    expect(extractHiddenInput("<input />", "__VIEWSTATE")).toBe("");
  });
});

describe("parseRatesTable", () => {
  it("extracts (date, rate) pairs and skips non-numeric rows", () => {
    const rows = parseRatesTable(RESULTS_HTML);
    expect(rows.map((r) => r.date)).toEqual([
      "2026-05-27",
      "2026-05-26",
      "2026-05-22",
    ]);
    expect(rows[0]!.rate).toBeCloseTo(95.7883, 6);
    expect(rows[2]!.rate).toBeCloseTo(95.9588, 6);
  });

  it("returns [] for an empty / non-results page", () => {
    expect(parseRatesTable("<html><body>No data</body></html>")).toEqual([]);
  });
});

describe("RbiSource.toInserts", () => {
  it("emits USD/INR rows tagged with source_authority='RBI'", () => {
    const src = new RbiSource();
    const parsed: RbiParsedRow[] = [
      { date: "2026-05-22", rate: 95.9588 },
      { date: "2026-05-27", rate: 95.7883 },
    ];
    const rows = src.toInserts(parsed, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(first.source_currency).toBe("USD");
    expect(first.target_currency).toBe("INR");
    expect(first.bucket_ts).toBe("2026-05-22T00:00:00.000Z");
    expect(first.rate).toBeCloseTo(95.9588, 6);
    expect(first.source_authority).toBe("RBI");
    expect(first.product).toBe("ORBI-D-authority");
    expect(first.tier).toBe("B-single");
    expect(first.granularity).toBe("1d");
    expect(first.provider_count).toBe(1);
    expect(first.provenance).toBe("historical-backfill");
    expect(first.status).toBe("CONFIRMED");
    expect(first.composite).toBe(false);
  });

  it("drops non-finite and non-positive rates", () => {
    const src = new RbiSource();
    const parsed: RbiParsedRow[] = [
      { date: "2026-05-22", rate: Number.NaN },
      { date: "2026-05-23", rate: 0 },
      { date: "2026-05-24", rate: -83 },
      { date: "2026-05-27", rate: 95.7883 },
    ];
    const rows = src.toInserts(parsed, "2026-05-27T00:00:00.000Z");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bucket_ts).toBe("2026-05-27T00:00:00.000Z");
  });
});

describe("RbiSource.fetch", () => {
  it("propagates non-200 with status + body slice on GET", async () => {
    const src = new RbiSource();
    const fetchImpl = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      src.fetch({ from: "2026-05-01", to: "2026-05-27", fetchImpl }),
    ).rejects.toThrow(/RBI GET 503/);
  });

  it("propagates a missing __VIEWSTATE / __EVENTVALIDATION as an error", async () => {
    const src = new RbiSource();
    const fetchImpl = (async () =>
      new Response("<html><body>no form tokens here</body></html>", {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(
      src.fetch({ from: "2026-05-01", to: "2026-05-27", fetchImpl }),
    ).rejects.toThrow(/__VIEWSTATE/);
  });

  it("posts the harvested tokens + USD checkbox to the archive page", async () => {
    const src = new RbiSource();
    const archiveHtml = `<html><body>
      <input type="hidden" name="__VIEWSTATE" value="VS-TOKEN" />
      <input type="hidden" name="__VIEWSTATEGENERATOR" value="VSG" />
      <input type="hidden" name="__EVENTVALIDATION" value="EV-TOKEN" />
    </body></html>`;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (!init || init.method !== "POST") {
        return new Response(archiveHtml, {
          status: 200,
          headers: { "set-cookie": "ASP.NET_SessionId=abc; Path=/; HttpOnly" },
        });
      }
      return new Response(RESULTS_HTML, { status: 200 });
    }) as unknown as typeof fetch;

    const parsed = await src.fetch({
      from: "2026-05-01",
      to: "2026-05-27",
      fetchImpl,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      "https://www.rbi.org.in/Scripts/ReferenceRateArchive.aspx",
    );
    expect(calls[1]!.init?.method).toBe("POST");
    const body = (calls[1]!.init?.body ?? "") as string;
    expect(body).toMatch(/__VIEWSTATE=VS-TOKEN/);
    expect(body).toMatch(/__EVENTVALIDATION=EV-TOKEN/);
    expect(body).toMatch(/chkUSD=on/);
    expect(body).toMatch(/txtFromDate=01%2F05%2F2026/);
    expect(body).toMatch(/txtToDate=27%2F05%2F2026/);
    expect(parsed.map((r) => r.date)).toEqual([
      "2026-05-27",
      "2026-05-26",
      "2026-05-22",
    ]);
  });
});

describe("RbiSource.fetchRange", () => {
  it("chunks by calendar year and dedupes by date", async () => {
    const src = new RbiSource();
    // Drive fetchRange via a stub that records the [from, to] windows it
    // was called with and returns disjoint synthetic rows per call.
    const windows: Array<[string, string]> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      // Half-baked GET-then-POST emulator: any GET seeds the form,
      // every POST returns a window-specific result table.
      if (!init || init.method !== "POST") {
        return new Response(
          `<html>
            <input type="hidden" name="__VIEWSTATE" value="VS" />
            <input type="hidden" name="__EVENTVALIDATION" value="EV" />
          </html>`,
          { status: 200 },
        );
      }
      const body = (init.body ?? "") as string;
      const from = decodeURIComponent(
        body.match(/txtFromDate=([^&]+)/)![1]!,
      );
      const to = decodeURIComponent(body.match(/txtToDate=([^&]+)/)![1]!);
      windows.push([from, to]);
      // Return one row dated in the middle of the window.
      const ymA = from.slice(3); // "MM/YYYY"
      return new Response(
        `<table><tr><td>15/${ymA}</td><td>80.${windows.length}</td></tr></table>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const rows = await src.fetchRange({
      from: "2023-06-15",
      to: "2025-03-31",
      fetchImpl,
    });
    // Three calendar-year chunks: 2023 (Jun→Dec), 2024 (Jan→Dec), 2025 (Jan→Mar).
    expect(windows).toEqual([
      ["15/06/2023", "31/12/2023"],
      ["01/01/2024", "31/12/2024"],
      ["01/01/2025", "31/03/2025"],
    ]);
    // Each call yields one in-window row; dedup-by-date keeps all three.
    // Each chunk yields a row dated 15/<from-month>/<from-year>:
    //   chunk[2023-06-15..2023-12-31] → 15/06/2023
    //   chunk[2024-01-01..2024-12-31] → 15/01/2024
    //   chunk[2025-01-01..2025-03-31] → 15/01/2025
    expect(rows.map((r) => r.date)).toEqual([
      "2023-06-15",
      "2024-01-15",
      "2025-01-15",
    ]);
  });
});
