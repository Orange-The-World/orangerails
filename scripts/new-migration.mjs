#!/usr/bin/env node
// Creates a migration file whose version comes from the real UTC clock, to the
// second, rather than being typed by hand.
//
// Why this exists: every version in this repo was hand typed and rounded to the
// hour, which produced four duplicate-version collisions in four days. A
// duplicate is not cosmetic. The ledger holds one row per version, so the second
// file to arrive is recorded as already applied and is silently skipped, and it
// surfaces later as an object missing from a cluster the ledger calls current.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not from the caller's working directory, so it
// behaves the same whether it is run through npm or invoked directly.
const MIG_DIR = fileURLToPath(new URL('../supabase/migrations', import.meta.url));

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error('');
  console.error('usage: npm run migration:new -- <slug>');
  console.error('example: npm run migration:new -- add_keyring_epoch_guard');
  console.error('');
  console.error('slug is lowercase letters, digits and single underscores.');
  process.exit(1);
}

const slug = process.argv[2];
if (!slug) usage('a slug is required, so the filename says what the migration does');
if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(slug)) {
  usage(`invalid slug '${slug}': use lowercase letters, digits and single underscores`);
}

// 14 digits, fixed width, lexically sortable. The out-of-order apply guards
// depend on that ordering, so nothing here may shorten the field or put a
// non-sortable suffix in front of the first underscore.
function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return [
    d.getUTCFullYear(),
    p(d.getUTCMonth() + 1),
    p(d.getUTCDate()),
    p(d.getUTCHours()),
    p(d.getUTCMinutes()),
    p(d.getUTCSeconds()),
  ].join('');
}

mkdirSync(MIG_DIR, { recursive: true });

// Split on the first underscore, which is exactly how the duplicate check in
// .github/workflows/supabase-deploy.yml reads a version (`cut -d_ -f1`). Using
// the same rule here means this script and that check can never disagree about
// what counts as taken.
const taken = new Set(
  readdirSync(MIG_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.split('_')[0]),
);

// Two migrations authored inside the same second would still collide. Step
// forward rather than failing: the goal is that a colliding version cannot be
// authored at all, not that the author gets a tidier error message.
let when = new Date();
let version = stamp(when);
while (taken.has(version)) {
  when = new Date(when.getTime() + 1000);
  version = stamp(when);
}

const name = `${version}_${slug}.sql`;
const path = `${MIG_DIR}/${name}`;
if (existsSync(path)) usage(`${name} already exists`);

writeFileSync(
  path,
  [
    `-- ${name}`,
    '--',
    '-- Why this change is needed (not what it does, the SQL says what):',
    '--',
    '-- How to undo it, or why it cannot be undone:',
    '--',
    '',
    '',
  ].join('\n'),
  'utf8',
);

console.log(path);
