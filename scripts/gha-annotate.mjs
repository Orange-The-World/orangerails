#!/usr/bin/env node
// Emit ONE GitHub Actions error annotation carrying multi-line text.
//
// OR-T1782, out of OR-T1520. The change-control drift workflow could only
// write to the step summary and the job log, and both of those need an
// authenticated collaborator token to read, so a finding reached a person at
// the Actions tab and no always-on seat. Annotations come back from the
// check-runs API with ordinary read access, so the values can travel without
// a credential being added to a public repository and without the workflow
// token being widened.
//
// usage:  node scripts/gha-annotate.mjs <title> <file>
// prints: ::error title=<title>::<the escaped contents of file>
//
// TITLE is the machine-readable class and it must contain no colon and no
// comma: those are the property delimiters in a workflow command, so a title
// carrying one arrives split or mangled. Hyphens instead.
//
// ESCAPING ORDER MATTERS. Percent has to go first, or the escapes introduced
// for carriage return and newline are themselves escaped a second time and
// the reader sees %250A where a line break should be.

import { readFileSync } from "node:fs";

// GitHub renders a long annotation truncated, and a truncation we did not
// perform is one we cannot label. Cut it ourselves and say so, so nobody
// reads a clipped list of changed settings as the whole list.
const LIMIT = 3000;

const [title, file] = process.argv.slice(2);

if (!title || !file) {
  process.stderr.write("usage: gha-annotate.mjs <title> <file>\n");
  process.exit(2);
}

if (/[:,]/.test(title)) {
  process.stderr.write(
    `gha-annotate: title ${title} contains a colon or a comma, which are the ` +
      "property delimiters of a workflow command. Use hyphens.\n",
  );
  process.exit(2);
}

let text;
try {
  text = readFileSync(file, "utf8");
} catch (err) {
  process.stderr.write(`gha-annotate: cannot read ${file}: ${err.message}\n`);
  process.exit(2);
}

text = text.replace(/\s+$/, "");

if (text.length === 0) {
  // A named emptiness beats an annotation that says nothing at all, because
  // "the step produced no output" is itself a fact worth delivering.
  text = "(the step produced no output; read the job log)";
}

if (text.length > LIMIT) {
  text =
    text.slice(0, LIMIT) +
    `\n[truncated at ${LIMIT} characters; the rest is in the step summary and the job log]`;
}

const escaped = text
  .replace(/%/g, "%25")
  .replace(/\r/g, "%0D")
  .replace(/\n/g, "%0A");

process.stdout.write(`::error title=${title}::${escaped}\n`);
