// Orchestrator for the 2026-05-16 audit-validation Playwright suite.
//
// Runs three spec files in sequence and summarises results.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const specs = [
  'landing.audit.mjs',
  'support.audit.mjs',
  'api.audit.mjs',
];

let totalPass = 0;
let totalFail = 0;

for (const spec of specs) {
  console.log(`\n━━━ ${spec} ━━━`);
  const res = spawnSync(process.execPath, [path.join(__dirname, spec)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status === 0) totalPass++;
  else totalFail++;
}

console.log(`\n━━━ summary: ${totalPass} spec(s) green, ${totalFail} red ━━━`);
process.exit(totalFail > 0 ? 1 : 0);
