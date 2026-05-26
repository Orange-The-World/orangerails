/**
 * csv-parser unit tests — streaming, header handling, skipLines, quoted fields.
 */

import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import {
  parseCsv,
  splitCsvLine,
} from "../../scripts/historical-backfill/lib/csv-parser";

function streamFrom(s: string): Readable {
  return Readable.from([s]);
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("splitCsvLine", () => {
  it("splits a plain comma-separated line", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });
  it("preserves embedded commas inside double quotes", () => {
    expect(splitCsvLine(`a,"b,c",d`)).toEqual(["a", "b,c", "d"]);
  });
  it("handles escaped double quotes inside quoted fields", () => {
    expect(splitCsvLine(`"a""b",c`)).toEqual([`a"b`, "c"]);
  });
});

describe("parseCsv", () => {
  it("yields one row per data line, keyed by header", async () => {
    const csv = "a,b,c\n1,2,3\n4,5,6\n";
    const rows = await collect(parseCsv(streamFrom(csv)));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ a: "1", b: "2", c: "3" });
    expect(rows[1]).toEqual({ a: "4", b: "5", c: "6" });
  });

  it("skips N leading lines (banner) before the header", async () => {
    const csv =
      "https://www.CryptoDataDownload.com\n" +
      "unix,date,close\n" +
      "1622011380,2021-05-26 06:43:00,40675.41\n";
    const rows = await collect(parseCsv(streamFrom(csv), { skipLines: 1 }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unix).toBe("1622011380");
    expect(rows[0]!.close).toBe("40675.41");
  });

  it("preserves ordering of input rows", async () => {
    const csv = "n\n" + Array.from({ length: 50 }, (_, i) => i).join("\n");
    const rows = await collect(parseCsv(streamFrom(csv)));
    expect(rows.map((r) => r.n)).toEqual(Array.from({ length: 50 }, (_, i) => String(i)));
  });

  it("ignores trailing blank lines and CRLF", async () => {
    const csv = "a,b\r\n1,2\r\n\r\n";
    const rows = await collect(parseCsv(streamFrom(csv)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ a: "1", b: "2" });
  });
});
