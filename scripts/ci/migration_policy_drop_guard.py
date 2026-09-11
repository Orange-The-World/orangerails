#!/usr/bin/env python3
"""CI guard: refuse a migration that drops RLS policies by enumeration or
dynamic construction instead of naming the policy literally (OR-T1376).

WHY. supabase/migrations/20260421200000_platforms_subaccounts.sql contained
a DO block that looped over pg_policies and dropped whatever it found. It
silently ate a co-admin policy created 25 hours earlier by a different
migration, and nobody noticed for four months (OR-T1324). This is a text
lint over the diff, not a schema oracle: there is no machine-readable
"expected policy set" anywhere in this repo, and inventing one would just
recreate the same enumeration problem with extra steps.

WHAT IT FLAGS. Any `DROP POLICY` whose target is not a literal identifier:
  - wrapped in EXECUTE or format(),
  - built with a %I / %s substitution,
  - built with quote_ident() or string concatenation (||),
  - inside a loop over pg_policies / pg_policy.
A literal `DROP POLICY IF EXISTS "name" ON public.table` is always allowed
and must never be flagged.

ESCAPE HATCH. A single-line marker comment directly above the flagged line,
`-- lint-allow-dynamic-policy-drop: <reason>`, silences that one finding.
There is no global off switch, on purpose: an intentional case must be a
thing someone chose and a reviewer can see, not a setting someone forgot.

SILENT-SUCCESS GUARD. Called with zero files, this script refuses instead
of exiting 0. A check that can say "0 of 0, therefore pass" is exactly the
shape that let the original bug through CI unnoticed: a loop that finishes
and reports success without ever having examined anything.
"""

import re
import sys

DYNAMIC_MARKERS = re.compile(r"EXECUTE|format\s*\(|%I|%s|quote_ident\s*\(|\|\|", re.IGNORECASE)
LOOP_HEADER = re.compile(r"FOR\s+\w+\s+IN\s+SELECT.*FROM\s+pg_polic(?:y|ies)\b", re.IGNORECASE | re.DOTALL)
DROP_POLICY = re.compile(r"DROP\s+POLICY", re.IGNORECASE)
ALLOW_MARKER = re.compile(r"--\s*lint-allow-dynamic-policy-drop\s*:\s*\S", re.IGNORECASE)

SAME_STATEMENT_WINDOW = 4   # lines to look back for a wrapped EXECUTE/format() call
LOOP_LOOKBACK_WINDOW = 20   # lines to look back for an unclosed loop-over-pg_policies header


def check_text(path, text):
    """Return a list of (path, lineno, line) findings for one file's content."""
    lines = text.splitlines()
    findings = []
    for i, line in enumerate(lines):
        if not DROP_POLICY.search(line):
            continue
        lineno = i + 1

        window_start = max(0, i - SAME_STATEMENT_WINDOW)
        statement_window = "\n".join(lines[window_start:i + 1])

        back_start = max(0, i - LOOP_LOOKBACK_WINDOW)
        loop_window = "\n".join(lines[back_start:i + 1])

        is_dynamic = bool(DYNAMIC_MARKERS.search(statement_window)) or bool(LOOP_HEADER.search(loop_window))
        if not is_dynamic:
            continue

        if i > 0 and ALLOW_MARKER.search(lines[i - 1]):
            continue

        findings.append((path, lineno, line.strip()))
    return findings


def main(argv):
    files = argv[1:]

    if not files:
        print(
            "::error::examined 0 migration files. Refusing to report success: "
            "a check that finds nothing and exits 0 cannot tell 'nothing to check' "
            "from 'the file selection is broken', and the second one is exactly "
            "how the bug this guard exists for got through CI unnoticed. Pass at "
            "least one file, or do not invoke this script at all."
        )
        return 1

    all_findings = []
    examined = []
    for path in files:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as exc:
            print(f"::error::could not read {path}: {exc}")
            return 1
        examined.append(path)
        all_findings.extend(check_text(path, text))

    print(f"examined {len(examined)} migration file(s): {', '.join(examined)}")

    if all_findings:
        print(
            f"::error::{len(all_findings)} DROP POLICY statement(s) drop policies "
            "by enumeration or dynamic construction instead of naming them:"
        )
        for path, lineno, line in all_findings:
            print(f"::error file={path},line={lineno}::{path}:{lineno}: {line}")
        print(
            "Fix: name the policy literally "
            '(DROP POLICY IF EXISTS "name" ON public.table). If this one is '
            "deliberate, add '-- lint-allow-dynamic-policy-drop: <reason>' on "
            "the line directly above it."
        )
        return 1

    print("OK: no dynamic or enumerated DROP POLICY found.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
