#!/usr/bin/env bash
# pre-publish-scan.sh — leak check for the open-source Orange Rails repo.
#
# Runs a categorized grep over the source tree looking for content that
# should never ship to a public repo: legacy brand names, internal
# codenames, personal names, infrastructure hostnames, internal wiki
# URLs, milestone tags from prior internal audits, dead PR refs, and
# personally identifiable email addresses.
#
# Exit code:
#   0  — tree is clean, safe to publish or merge
#   1  — one or more categories reported a leak; review output, clean up,
#        re-run
#
# Run locally before pushing:   bash scripts/pre-publish-scan.sh
# Runs in CI as a required check (see .github/workflows/leak-check.yml).
#
# Updating the allowlist: if you introduce a brand or product reference
# that is intentional and acceptable (for example a new sibling project),
# add it to the EXEMPT_* lists below AND to the leak-check workflow in
# lock-step. PRs that change this script require a second reviewer.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ----------------------------------------------------------------------
# Path scope
# ----------------------------------------------------------------------

EXCLUDE_DIRS=(
  --exclude-dir=node_modules
  --exclude-dir=dist
  --exclude-dir=build
  --exclude-dir=coverage
  --exclude-dir=.git
  --exclude-dir=test-results
  --exclude-dir=playwright-report
  --exclude-dir=.husky
  --exclude-dir=target
)

EXCLUDE_FILES=(
  --exclude=bun.lock
  --exclude=bun.lockb
  --exclude=package-lock.json
  --exclude=yarn.lock
  --exclude=Cargo.lock
  --exclude="*.png"
  --exclude="*.jpg"
  --exclude="*.jpeg"
  --exclude="*.webp"
  --exclude="*.gif"
  --exclude="*.ico"
  --exclude="*.svg"
  --exclude="*.woff"
  --exclude="*.woff2"
  --exclude="*.ttf"
  --exclude="*.eot"
)

# ----------------------------------------------------------------------
# Load-bearing exemptions
# ----------------------------------------------------------------------

EXEMPT_GENERIC=(
  "scripts/pre-publish-scan.sh"
  ".github/PULL_REQUEST_TEMPLATE.md"
  ".github/workflows/leak-check.yml"
  "CONTRIBUTING.md"
  "CODE_OF_CONDUCT.md"
  # CHANGELOG can mention "originally created in the MorningRevolution org" as
  # historical attribution (founder-approved 2026-06-18). Don't flag.
  "CHANGELOG.md"
)

# Migration filenames AND row content for first-customer seed identifiers.
# Founder rule 2026-06-18: BitBooks and Orange Way ARE the first two customers,
# and their slug/filename/seed-row mentions are legitimate, not leaks. Also
# covers the per-customer sink adapter files (bitbooks-v2.{ts,yaml} etc.) and
# platform-auth doc-comments listing customer examples.
EXEMPT_MIGRATION_FILENAMES=(
  "supabase/migrations/.*bitbooks.*\\.sql"
  "supabase/migrations/.*orangeway.*\\.sql"
  "supabase/migrations/.*orange_way.*\\.sql"
  "supabase/migrations/.*platforms_subaccounts\\.sql"
  "supabase/migrations/.*source_wallets\\.sql"
  "supabase/migrations/.*access_tokens\\.sql"
  "supabase/migrations/.*admin_pages_schema\\.sql"
  "supabase/migrations/.*9a9b4c7b.*\\.sql"
  "supabase/functions/_shared/sinks/bitbooks-v2\\.(ts|yaml|yaml\\.ts)"
  "supabase/functions/_shared/sinks/profiles/"
  "supabase/functions/_shared/sinks/profiles/README\\.md"
  "supabase/functions/_shared/platform-auth\\.ts"
)

# Audit-trail breadcrumbs in security-sensitive files. Comments like
# "// Audit 2026-05-16 High #2" tie code to a future security review trail.
# Founder-approved as intentional documentation. Pattern: comment lines that
# start with Audit YYYY-MM-DD inside crypto/auth surfaces.
EXEMPT_AUDIT_BREADCRUMB_FILES=(
  "supabase/functions/"
  "src/lib/vault"
  "src/lib/crypto"
  "src/stealth/"
  "supabase/migrations/"
)

# Wire-protocol headers + signature format — byte-identical strings
# every integrator depends on. References to "X-OR-Signature-V2",
# "X-OR-Event-Id", "t=...,v1=..." cannot be sanitized.
EXEMPT_OR_PROTOCOL=(
  "packages/webhooks"
  "src/lib/webhooks"
  "supabase/functions/or-webhook-dispatch"
  "supabase/functions/_shared/webhook"
  "SECURITY.md"
  "docs/OrangeRails-Architecture.md"
  "docs/OrangeRails-Consumer-Integration-Guide.md"
  "docs/Consumer-Integration-Guide.md"
)

# Edge function URL slugs (or-*, sync-blink, world-gateway, on-demand-resolve,
# client-signup, client-verify-email) are load-bearing — consumers invoke
# them by exact name. References inside the codebase point at these slugs.
EXEMPT_OR_FUNCTION_URLS=(
  "supabase/functions/or-"
  "supabase/functions/sync-blink"
  "supabase/functions/world-gateway"
  "supabase/functions/on-demand-resolve"
  "supabase/functions/client-signup"
  "supabase/functions/client-verify-email"
  "workers/api-gateway"
  "src/lib/or-client"
  "src/lib/api"
)

# Cryptographic literals — HKDF info strings, algorithm identifiers,
# postMessage event names. Changing any of these invalidates deployed
# encrypted data or breaks live consumer SDKs.
EXEMPT_OR_CRYPTO_LITERAL=(
  "src/lib/crypto"
  "src/lib/vault"
  "src/stealth/lib"
  "src/stealth/widget"
  "supabase/functions/_shared/crypto"
  "supabase/functions/_shared/seal"
  "supabase/functions/_shared/envelope"
  "crates/"
  "packages/webhooks/src"
)

# Database table + column names referenced across many files.
EXEMPT_OR_SCHEMA=(
  "supabase/migrations/"
  "src/types/database.ts"
  "src/integrations/supabase/types.ts"
)

EXIT_CODE=0

# ----------------------------------------------------------------------
# scan: run one categorized grep + exemption filter
# ----------------------------------------------------------------------

scan() {
  local name="$1"
  local pattern="$2"
  local flags="$3"
  local extra_exempt="$4"

  local raw
  if [[ -n "$flags" ]]; then
    raw=$(grep -rnE $flags "$pattern" . \
            "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" 2>/dev/null || true)
  else
    raw=$(grep -rnE "$pattern" . \
            "${EXCLUDE_DIRS[@]}" "${EXCLUDE_FILES[@]}" 2>/dev/null || true)
  fi

  if [[ -z "$raw" ]]; then
    printf "  \033[32m✓\033[0m  %s\n" "$name"
    return 0
  fi

  local drop_patterns=""
  for e in "${EXEMPT_GENERIC[@]}"; do
    drop_patterns+="${drop_patterns:+|}$(printf '%s' "$e" | sed 's/[.[\]*]/\\&/g')"
  done
  if [[ -n "$extra_exempt" ]]; then
    drop_patterns+="${drop_patterns:+|}$extra_exempt"
  fi

  local filtered
  if [[ -n "$drop_patterns" ]]; then
    filtered=$(printf '%s\n' "$raw" | grep -Ev "$drop_patterns" || true)
  else
    filtered="$raw"
  fi

  if [[ -z "$filtered" ]]; then
    printf "  \033[32m✓\033[0m  %s\n" "$name"
    return 0
  fi

  local count
  count=$(printf '%s\n' "$filtered" | wc -l)
  printf "  \033[31m✗\033[0m  %s (%d findings)\n" "$name" "$count"
  printf '%s\n' "$filtered" | sed 's/^/      /' | head -20
  if [[ "$count" -gt 20 ]]; then
    printf "      ... %d more\n" "$((count - 20))"
  fi
  EXIT_CODE=1
}

join_pipe() {
  local IFS="|"
  printf '%s' "$*"
}

EXEMPT_PROTOCOL_RE="$(join_pipe "${EXEMPT_OR_PROTOCOL[@]}")"
EXEMPT_FN_RE="$(join_pipe "${EXEMPT_OR_FUNCTION_URLS[@]}")"
EXEMPT_CRYPTO_RE="$(join_pipe "${EXEMPT_OR_CRYPTO_LITERAL[@]}")"
EXEMPT_SCHEMA_RE="$(join_pipe "${EXEMPT_OR_SCHEMA[@]}")"
EXEMPT_MIGRATION_FN_RE="$(join_pipe "${EXEMPT_MIGRATION_FILENAMES[@]}")"
EXEMPT_AUDIT_RE="$(join_pipe "${EXEMPT_AUDIT_BREADCRUMB_FILES[@]}")"

# ----------------------------------------------------------------------
# Header
# ----------------------------------------------------------------------

printf "\n\033[1m▎ Pre-publish leak scan — Orange Rails\033[0m\n"
printf "  repo: %s\n\n" "$REPO_ROOT"

# ----------------------------------------------------------------------
# Category 1 — Sister-product brand references
# ----------------------------------------------------------------------

printf "\033[1m1. Sister-product brand references\033[0m\n"

# NOTE: BitBooks and Orange Way are Orange Rails' first two paying customers
# and are intentionally visible in user-facing copy as such. The Cat 1 scan
# below only flags INTERNAL product-version references (V2 BitBooks, V3
# BitBooks Vault, BitBooksSupport, etc.) and BitBooks-specific business
# entities (Bidvestment, Bid Balances). Customer-name references to plain
# "BitBooks" and "Orange Way" / "OrangeWay" are intentional.

scan "BitBooks internal product variants" \
     "V[23] BitBooks|BitBooks V[23]|BitBooks Vault|BitBooks family|BitBooks Personal|BitBooksSupport|Bid ?Balances|Bidvestment" \
     "" \
     "$EXEMPT_MIGRATION_FN_RE"

# Galoy/GaloyMoney/Blink are public Apache-2.0 OSS projects in the OR
# ecosystem (Blink is a Lightning provider OR ships an adapter for; Galoy
# is its upstream platform). They're credited the same way as BTCPay
# Server and LND. Only Cala (Galoy's ledger sub-project that was an
# internal V3 Vault evaluation) is scrubbed.
scan "Cala ledger (internal V3 evaluation)" \
     "\\bCala\\b" \
     "" \
     ""

scan "Lovable builder platform" \
     "\\bLovable\\b|lovable\\.app|\\.lovable" \
     "" \
     ""

scan "V3 Vault / standalone V[23] product noun" \
     "\\bV3 Vault\\b|\\bV[23] (Test|Issues?|Bug|customer|prod)" \
     "" \
     ""

scan "Hardcoded BitBooks subdomains (should be env config, not literals)" \
     "\\b(v[0-9]+dev|v[0-9]+|app|v3dev|vault|admin|support|dashboard)\\.bitbooks\\.com\\b" \
     "" \
     "src/integrations/supabase/types|supabase/migrations/"

scan "Other personal-project brands" \
     "\\b(a prior internal name|COLE|a prior internal name|a prior internal name)\\b|a prior internal name|petitchou|a prior internal name" \
     "" \
     ""

# ----------------------------------------------------------------------
# Category 2 — Personal names + PII
# ----------------------------------------------------------------------

printf "\n\033[1m2. Personal names + PII\033[0m\n"

# "Tim May" is intentionally kept in README cypherpunk lineage.
scan "Personal first names" \
     "\\b(the maintainer|a contributor|a contributor|a contributor|a contributor|a contributor|a contributor)\\b" \
     "" \
     ""

scan "External contact names" \
     "a contributor|a contributor" \
     "" \
     ""

scan "Personal-domain emails" \
     "@(bitbooks\\.com|abascal\\.ca|tryfaster\\.ca)" \
     "" \
     ""

# ----------------------------------------------------------------------
# Category 3 — Internal infrastructure leaks
# ----------------------------------------------------------------------

printf "\n\033[1m3. Internal infrastructure\033[0m\n"

scan "Internal hostnames" \
     "\\b(jarvis-hosted|bb-support|Jarvis-hosted)\\b|kiwi@jarvis|ubuntu@100\\." \
     "" \
     ""

scan "Internal wiki URLs" \
     "wiki\\.(abascal\\.ca|bitbooks\\.com)" \
     "" \
     ""

scan "Tailscale internal IPs" \
     "\\b100\\.(91|94)\\.[0-9]+\\.[0-9]+\\b" \
     "" \
     ""

scan "Internal bb-support paths" \
     "/opt/bb-support|/mnt/vault/\\.a prior internal name" \
     "" \
     ""

# blocks.orangerails.com (BIP158 block source) and stealth.orangerails.com
# (BIP158 filter CDN) are admin-only infrastructure that's correctly
# documented in caddy/, docs/Stealth-Sync.md, and scripts/README.md for
# maintainer ops. They're not customer-facing leaks when scoped to those
# operator paths.
scan "Admin-only orangerails subdomains in shipping code" \
     "\\b(blocks|stealth)\\.orangerails\\.com\\b" \
     "" \
     "$EXEMPT_PROTOCOL_RE|$EXEMPT_CRYPTO_RE|^./caddy/|docs/Stealth-Sync\\.md|scripts/README\\.md|src/stealth/lib/mock-fixtures|^./CHANGELOG\\.md"

scan "Windows-style internal paths" \
     "C:\\\\CLAUDE|C:\\\\Users\\\\micro" \
     "" \
     ""

scan "Home-path leaks" \
     "/home/(kiwi|cactus|claude|ubuntu)/" \
     "" \
     ""

# ----------------------------------------------------------------------
# Category 4 — Internal milestone tags + dead PR references
# ----------------------------------------------------------------------

printf "\n\033[1m4. Internal milestone tags + dead PR refs\033[0m\n"

scan "D-number milestone tags" \
     "\\bD[0-9]{1,3}[:)] |\\(D[0-9]{1,3}\\)|\\bD[0-9]{1,3} —" \
     "" \
     ""

scan "SEC-N audit tags" \
     "\\bSEC-[0-9]+\\b|#SEC-[0-9]+" \
     "" \
     ""

scan "CQ-N code-quality tags" \
     "\\bCQ-[0-9]+\\b|#CQ-[0-9]+" \
     "" \
     ""

scan "DB-N database-audit tags" \
     "\\bDB-[0-9]+\\b|#DB-[0-9]+" \
     "" \
     ""

scan "PERF-N performance-audit tags" \
     "\\bPERF-[0-9]+\\b|#PERF-[0-9]+" \
     "" \
     ""

scan "Dead PR references" \
     "PR #[0-9]+|V[23] PR\\b|OR PR #" \
     "" \
     ""

# ----------------------------------------------------------------------
# Category 5 — Operational dates in code comments
# ----------------------------------------------------------------------

printf "\n\033[1m5. Operational dates in code comments\033[0m\n"

scan "Audit/observation/verification dates in comments" \
     "(as of |observed |verified |Audit |audited )202[0-9]-[0-1][0-9]-[0-3][0-9]" \
     "" \
     "$EXEMPT_AUDIT_RE"

# ----------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------

printf "\n"
if [[ "$EXIT_CODE" -eq 0 ]]; then
  printf "\033[32m▎ Tree is clean. Safe to publish or merge.\033[0m\n\n"
else
  printf "\033[31m▎ Leaks found. Clean up the items above before publishing.\033[0m\n"
  printf "  See \033[1mCONTRIBUTING.md\033[0m for the rules and exemption process.\n\n"
fi

exit "$EXIT_CODE"
