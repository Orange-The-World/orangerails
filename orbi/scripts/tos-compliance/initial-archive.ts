/**
 * Initial ToS archive - one-off bootstrap.
 *
 * After migration 008_tos_audit.sql is applied to PROD, founder runs this
 * once to populate the source_terms_of_service table with the first row
 * per source.
 *
 * Implementation is just `fetch-and-archive` with the same code path; this
 * file exists as an explicit ergonomic entry point + spot to document
 * bootstrap semantics.
 *
 * Run:
 *   cd /home/ubuntu/AIHUB/REPOS/orangerails/orbi
 *   bun run scripts/tos-compliance/initial-archive.ts
 *
 * Optional first-pass dry-run:
 *   bun run scripts/tos-compliance/initial-archive.ts --dry-run
 *
 * After this completes, subsequent runs (cron, manual) should call
 * `fetch-and-archive.ts` which detects no-change via sha256 and does
 * nothing -- so re-running is safe.
 */

// Just re-export and re-invoke. Bun executes the imported file's top-level
// `if (import.meta.main)` only when that file IS main, so we explicitly
// invoke the same logic by spawning a sub-process? Simpler: import + call.
// The cleanest split is to keep this thin and delegate via require-style
// dynamic import.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "fetch-and-archive.ts");
const args = process.argv.slice(2);
const child = spawn("bun", ["run", target, ...args], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
