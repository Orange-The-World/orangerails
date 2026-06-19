# QuickBooks Connector

Reads QuickBooks Desktop / Online exports and produces a StagedImportPayload
in OR's standard contract format. Drop-in replacement for V3's in-browser QB
import wizard, scheduled to deprecate that wizard once V3's "Import from
Orange Rails" wizard is built.

## What it consumes

A QuickBooks export normally ships as a zip containing up to 8 xlsx files:

- Trial Balance
- Journal (or General Journal)
- Customers
- Vendors
- Employees
- Balance Sheet (used for reconciliation in V3, not for staging)
- Profit & Loss (same)
- General Ledger (same)

The connector fingerprints each file by scanning the first six rows for
report-name keywords. Files of unknown type are flagged but not staged.

## What it produces

A single `StagedImportPayload` (see `src/connectors/contract.ts`) with:

- `staged.accounts` , from Trial Balance rows, classified by name pattern
- `staged.contacts` , from Customers / Vendors / Employees files
- `staged.journalEntries` , from the Journal file
- `reconciliation.accountClassifications` , confidence hints the V3 wizard
  surfaces for user override

## Mapping decisions

### Accounts (Trial Balance → V3 COA)
- `name` = parsed account name (code prefix split off if present, e.g. `1010 Cash` → code `1010`, name `Cash`)
- `code` = parsed code or empty
- `type` / `subtype` / `normal_balance` = classifier output, derived from the
  account name regex rules in `classifyAccounts.ts`. Names that don't match
  any rule become "ambiguous" and surface as a warning + go through the
  reconciliation step in V3's wizard.

### Contacts (Customers / Vendors / Employees → V3 Contacts)
- `kind: CUSTOMER` → `type: Customer`, etc. (Employee is supported.)
- Empty fields stay empty (never `null`).

### Journal Entries (Journal → V3 JEs)
- `je_ref_#` = synthesized stable ref `QB-YYYYMMDD-TYPE-REF-N` (see `parsers.ts`)
- `je_status` = `POSTED` (QB exports don't ship drafts)
- `wallet_currency` = each line's native currency if set, else the bundle's
  business currency, else USD

## ZKA boundary

Runs locally on the founder's machine. Reads xlsx files, writes plaintext
JSON. The plaintext never leaves the local box; V3 encrypts on upload.

## Usage

```bash
bun run scripts/qb-convert.ts <qb-export.zip> <output-dir>
```

Writes `staged-import.json` to `<output-dir>`. Upload that file to V3's
"Import from Orange Rails" wizard (planned).

## Origin

These modules moved here from V3's `src/lib/imports/quickbooks/`. The pure
parsers + classifier + workbook helpers are the canonical OR copy. V3's
copy stays until its wizard is rewired to consume `staged-import.json`.
