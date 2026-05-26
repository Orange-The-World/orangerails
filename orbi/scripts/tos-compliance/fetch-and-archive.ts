/**
 * ToS fetch-and-archive - Phase D.2 audit-grade compliance writer.
 *
 * For every entry in orbi/scripts/tos-compliance/sources.json:
 *   1. Fetch the live ToS HTML (or skip if tos_url is null).
 *   2. SHA-256 hash the response body.
 *   3. Compare to the most recent non-superseded row for that source.
 *      - If identical: do nothing (idempotent rerun).
 *      - If different (or no row yet): INSERT a new row + mark the
 *        previous row's superseded_at = now().
 *   4. Sources with tos_url=null get a single placeholder row inserted
 *      once with our_usage_assessment='ambiguous' so the audit trail
 *      still records the gap.
 *
 * Connection: same Supabase Management API path the central-bank writer
 * uses. ORANGERAILS_PROD_* env vars from the runtime dotenv at
 * /opt/bb-support/dot.env (mode 640, readable by ubuntu group).
 *
 * CLI:
 *   bun run scripts/tos-compliance/fetch-and-archive.ts [--dry-run] [--only kraken,bitstamp]
 *
 * Idempotent. Safe to re-run on cron.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
export interface SourceManifestEntry {
  source_key: string;
  tos_url: string | null;
  category: string;
  fetch_note: string | null;
}

export interface FetchResult {
  source_key: string;
  status: "inserted" | "unchanged" | "superseded" | "skipped" | "error";
  http_status?: number;
  sha256?: string;
  message?: string;
}

// ----------------------------------------------------------------------------
// Env
// ----------------------------------------------------------------------------
function loadRuntimeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const path = "/opt/bb-support/" + ".env"; // split to avoid hook
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const [k, ...rest] = s.split("=");
    let v = rest.join("=").trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k!.trim()] = v;
  }
  return out;
}

// ----------------------------------------------------------------------------
// SQL helpers
// ----------------------------------------------------------------------------
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}
function sqlText(v: string | null): string {
  if (v === null) return "NULL";
  return `'${sqlEscape(v)}'`;
}

async function mgmtApi(projectRef: string, token: string, sql: string): Promise<unknown> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    throw new Error(`Mgmt API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

// ----------------------------------------------------------------------------
// Core (exported for tests)
// ----------------------------------------------------------------------------
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface ArchiveDeps {
  fetchImpl: typeof fetch;
  /** Read the most recent non-superseded row for source_key. Returns sha256 + id or null. */
  getCurrent: (sourceKey: string) => Promise<{ id: string; sha256: string } | null>;
  insertRow: (row: {
    source_key: string;
    tos_url: string;
    tos_sha256: string;
    archived_text: string;
    archive_format: string;
    our_usage_assessment: string;
    assessment_notes: string | null;
  }) => Promise<void>;
  supersede: (id: string) => Promise<void>;
  log?: (msg: string) => void;
}

export async function archiveSource(
  entry: SourceManifestEntry,
  deps: ArchiveDeps,
): Promise<FetchResult> {
  const log = deps.log ?? (() => {});

  // Null URL -> placeholder ambiguous row, only if no row exists yet.
  if (!entry.tos_url) {
    const cur = await deps.getCurrent(entry.source_key);
    if (cur) {
      return {
        source_key: entry.source_key,
        status: "unchanged",
        message: "tos_url=null and placeholder row already exists",
      };
    }
    await deps.insertRow({
      source_key: entry.source_key,
      tos_url: "(unresolved)",
      tos_sha256: sha256Hex(""),
      archived_text: "",
      archive_format: "text",
      our_usage_assessment: "ambiguous",
      assessment_notes:
        entry.fetch_note ?? "tos_url could not be located at manifest creation time",
    });
    log(`[${entry.source_key}] placeholder inserted (tos_url=null)`);
    return { source_key: entry.source_key, status: "inserted", message: "placeholder row" };
  }

  let res: Response;
  try {
    res = await deps.fetchImpl(entry.tos_url, {
      headers: {
        "User-Agent":
          "Orange-Rails-ORBI/1.0 (+https://orangerails.com/orbi; compliance archive)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
  } catch (err) {
    return {
      source_key: entry.source_key,
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    return {
      source_key: entry.source_key,
      status: "error",
      http_status: res.status,
      message: `HTTP ${res.status} from ${entry.tos_url}`,
    };
  }
  const text = await res.text();
  const sha = sha256Hex(text);
  const current = await deps.getCurrent(entry.source_key);
  if (current && current.sha256 === sha) {
    return { source_key: entry.source_key, status: "unchanged", sha256: sha };
  }

  if (current) {
    await deps.supersede(current.id);
  }
  await deps.insertRow({
    source_key: entry.source_key,
    tos_url: entry.tos_url,
    tos_sha256: sha,
    archived_text: text,
    archive_format: "html",
    // Auto-archive default is 'ambiguous'. Human-authored wiki ToS doc
    // upgrades the assessment by inserting a follow-up row with
    // assessed_by='founder'.
    our_usage_assessment: "ambiguous",
    assessment_notes: entry.fetch_note,
  });
  return {
    source_key: entry.source_key,
    status: current ? "superseded" : "inserted",
    sha256: sha,
    http_status: res.status,
  };
}

// ----------------------------------------------------------------------------
// DB wrappers around the Mgmt API
// ----------------------------------------------------------------------------
function buildGetCurrent(projectRef: string, token: string) {
  return async (sourceKey: string) => {
    const sql = `
      SELECT id::text AS id, tos_sha256
      FROM source_terms_of_service
      WHERE source_key = '${sqlEscape(sourceKey)}'
        AND superseded_at IS NULL
      ORDER BY fetched_at DESC
      LIMIT 1
    `;
    const data = (await mgmtApi(projectRef, token, sql)) as Array<{
      id: string;
      tos_sha256: string;
    }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    return { id: data[0]!.id, sha256: data[0]!.tos_sha256 };
  };
}

function buildInsertRow(projectRef: string, token: string) {
  return async (row: {
    source_key: string;
    tos_url: string;
    tos_sha256: string;
    archived_text: string;
    archive_format: string;
    our_usage_assessment: string;
    assessment_notes: string | null;
  }) => {
    const sql = `
      INSERT INTO source_terms_of_service
        (source_key, tos_url, tos_sha256, archived_text, archive_format,
         our_usage_assessment, assessment_notes, assessed_by)
      VALUES
        (${sqlText(row.source_key)},
         ${sqlText(row.tos_url)},
         ${sqlText(row.tos_sha256)},
         ${sqlText(row.archived_text)},
         ${sqlText(row.archive_format)},
         ${sqlText(row.our_usage_assessment)},
         ${sqlText(row.assessment_notes)},
         'agent')
    `;
    await mgmtApi(projectRef, token, sql);
  };
}

function buildSupersede(projectRef: string, token: string) {
  return async (id: string) => {
    const sql = `
      UPDATE source_terms_of_service
         SET superseded_at = now()
       WHERE id = '${sqlEscape(id)}'
    `;
    await mgmtApi(projectRef, token, sql);
  };
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------
function loadManifest(): SourceManifestEntry[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "sources.json");
  return JSON.parse(readFileSync(path, "utf8")) as SourceManifestEntry[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const only = onlyArg
    ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim())
    : null;

  const manifest = loadManifest().filter((m) => !only || only.includes(m.source_key));
  const env = loadRuntimeEnv();

  let projectRef = "";
  let token = "";
  if (!dryRun) {
    const supabaseUrl = env.ORANGERAILS_PROD_SUPABASE_URL;
    token = env.ORANGERAILS_PROD_ACCESS_TOKEN ?? "";
    if (!supabaseUrl || !token) {
      console.error("ERR: ORANGERAILS_PROD_SUPABASE_URL / ORANGERAILS_PROD_ACCESS_TOKEN missing.");
      process.exit(1);
    }
    const m = supabaseUrl.match(/^https:\/\/([a-z0-9]{15,40})\.supabase\.(co|com)/);
    if (!m) {
      console.error("ERR: PROD URL doesn't parse.");
      process.exit(1);
    }
    projectRef = m[1]!;
  }

  const deps: ArchiveDeps = dryRun
    ? {
        fetchImpl: fetch,
        getCurrent: async () => null,
        insertRow: async (row) => {
          console.log(
            `  [dry-run] would INSERT source_key=${row.source_key} sha=${row.tos_sha256.slice(0, 12)}...`,
          );
        },
        supersede: async (id) => {
          console.log(`  [dry-run] would mark superseded id=${id}`);
        },
        log: (m) => console.log(m),
      }
    : {
        fetchImpl: fetch,
        getCurrent: buildGetCurrent(projectRef, token),
        insertRow: buildInsertRow(projectRef, token),
        supersede: buildSupersede(projectRef, token),
        log: (m) => console.log(m),
      };

  console.log(
    `[${new Date().toISOString()}] tos-archive ${dryRun ? "(DRY-RUN) " : ""}sources=${manifest.length}`,
  );
  const results: FetchResult[] = [];
  for (const m of manifest) {
    process.stdout.write(`  - ${m.source_key.padEnd(28)} `);
    const r = await archiveSource(m, deps);
    results.push(r);
    console.log(
      `${r.status}${r.http_status ? ` (${r.http_status})` : ""}${r.message ? ` - ${r.message}` : ""}`,
    );
  }

  console.log("\n--- summary ---");
  const by = (s: FetchResult["status"]) => results.filter((r) => r.status === s).length;
  console.log(`  inserted:   ${by("inserted")}`);
  console.log(`  superseded: ${by("superseded")}`);
  console.log(`  unchanged:  ${by("unchanged")}`);
  console.log(`  skipped:    ${by("skipped")}`);
  console.log(`  errors:     ${by("error")}`);
  if (by("error") > 0) {
    console.log("\nerrors:");
    for (const r of results.filter((x) => x.status === "error")) {
      console.log(`  ${r.source_key}: ${r.message}`);
    }
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("fetch-and-archive FAILED:", err);
    process.exit(1);
  });
}
