import { describe, expect, it, vi } from "vitest";
import {
  archiveSource,
  sha256Hex,
  type ArchiveDeps,
  type SourceManifestEntry,
} from "../../scripts/tos-compliance/fetch-and-archive";

function makeDeps(opts: {
  currentByKey?: Record<string, { id: string; sha256: string } | null>;
  fetchResponse?: { status: number; body: string };
  fetchThrows?: Error;
}): {
  deps: ArchiveDeps;
  inserts: any[];
  supersededIds: string[];
} {
  const inserts: any[] = [];
  const supersededIds: string[] = [];
  const fetchImpl = vi.fn(async () => {
    if (opts.fetchThrows) throw opts.fetchThrows;
    const r = opts.fetchResponse ?? { status: 200, body: "<html>terms</html>" };
    return new Response(r.body, { status: r.status });
  }) as unknown as typeof fetch;

  const deps: ArchiveDeps = {
    fetchImpl,
    getCurrent: async (k) => (opts.currentByKey ? (opts.currentByKey[k] ?? null) : null),
    insertRow: async (row) => {
      inserts.push(row);
    },
    supersede: async (id) => {
      supersededIds.push(id);
    },
  };
  return { deps, inserts, supersededIds };
}

const ENTRY: SourceManifestEntry = {
  source_key: "kraken",
  tos_url: "https://www.kraken.com/legal",
  category: "exchange",
  fetch_note: null,
};

describe("tos-compliance fetch-and-archive", () => {
  it("sha256Hex is stable for equal input", () => {
    const a = sha256Hex("hello");
    const b = sha256Hex("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("first-time insert when no current row exists", async () => {
    const { deps, inserts, supersededIds } = makeDeps({
      currentByKey: { kraken: null },
      fetchResponse: { status: 200, body: "<html>terms v1</html>" },
    });
    const r = await archiveSource(ENTRY, deps);
    expect(r.status).toBe("inserted");
    expect(r.sha256).toBe(sha256Hex("<html>terms v1</html>"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0].source_key).toBe("kraken");
    expect(inserts[0].tos_url).toBe(ENTRY.tos_url);
    expect(inserts[0].archive_format).toBe("html");
    expect(inserts[0].our_usage_assessment).toBe("ambiguous");
    expect(supersededIds).toEqual([]);
  });

  it("unchanged when current sha matches", async () => {
    const body = "<html>terms v1</html>";
    const sha = sha256Hex(body);
    const { deps, inserts, supersededIds } = makeDeps({
      currentByKey: { kraken: { id: "uuid-1", sha256: sha } },
      fetchResponse: { status: 200, body },
    });
    const r = await archiveSource(ENTRY, deps);
    expect(r.status).toBe("unchanged");
    expect(inserts).toEqual([]);
    expect(supersededIds).toEqual([]);
  });

  it("supersedes prior row when sha changes", async () => {
    const { deps, inserts, supersededIds } = makeDeps({
      currentByKey: { kraken: { id: "uuid-old", sha256: "abc" } },
      fetchResponse: { status: 200, body: "<html>terms v2</html>" },
    });
    const r = await archiveSource(ENTRY, deps);
    expect(r.status).toBe("superseded");
    expect(supersededIds).toEqual(["uuid-old"]);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].tos_sha256).toBe(sha256Hex("<html>terms v2</html>"));
  });

  it("returns error status on non-OK HTTP without writing", async () => {
    const { deps, inserts, supersededIds } = makeDeps({
      fetchResponse: { status: 503, body: "down" },
    });
    const r = await archiveSource(ENTRY, deps);
    expect(r.status).toBe("error");
    expect(r.http_status).toBe(503);
    expect(inserts).toEqual([]);
    expect(supersededIds).toEqual([]);
  });

  it("returns error status when fetch throws", async () => {
    const { deps, inserts } = makeDeps({
      fetchThrows: new Error("network down"),
    });
    const r = await archiveSource(ENTRY, deps);
    expect(r.status).toBe("error");
    expect(r.message).toContain("network down");
    expect(inserts).toEqual([]);
  });

  it("inserts ambiguous placeholder for tos_url=null on first encounter", async () => {
    const entry: SourceManifestEntry = {
      source_key: "banxico",
      tos_url: null,
      category: "central-bank",
      fetch_note: "could not locate",
    };
    const { deps, inserts } = makeDeps({ currentByKey: { banxico: null } });
    const r = await archiveSource(entry, deps);
    expect(r.status).toBe("inserted");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].our_usage_assessment).toBe("ambiguous");
    expect(inserts[0].tos_url).toBe("(unresolved)");
    expect(inserts[0].assessment_notes).toBe("could not locate");
  });

  it("does not re-insert placeholder when one already exists", async () => {
    const entry: SourceManifestEntry = {
      source_key: "banxico",
      tos_url: null,
      category: "central-bank",
      fetch_note: null,
    };
    const { deps, inserts } = makeDeps({
      currentByKey: { banxico: { id: "uuid-placeholder", sha256: sha256Hex("") } },
    });
    const r = await archiveSource(entry, deps);
    expect(r.status).toBe("unchanged");
    expect(inserts).toEqual([]);
  });
});
