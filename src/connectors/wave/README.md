# Wave Accounting Connector

Source connector for Wave Accounting → V3 BitBooks Vault. Lives inside Orange
Rails because Orange Rails owns all source specific import logic; V3 owns the
books.

## What it does

Three pure converter modules, plus a CLI:

| Module | Wave input | V3 output |
|---|---|---|
| `accounts-to-coa.ts` | `accounts.json` (GraphQL dump) | Chart of Accounts CSV |
| `parties-to-contacts.ts` | `customers.json` + `vendors.json` | Contacts CSV |
| `journal-csv-to-v3.ts` | `accounting.csv` (UI export) | Journal Entries CSV |

The V3 CSV column shapes are pulled from `v3/src/lib/csv/*.ts` so the output
imports cleanly into V3's existing CSV import wizard (and through it into
`import_jobs`, where the browser encrypts before storage).

## What it does NOT do

- It does not call Wave's API. Use the existing `scripts/wave-backup.py` on
  jarvis for that; this module consumes the JSON files that produces.
- It does not import transactions via API. Wave's API has no transaction
  endpoint — money transactions must come from Wave's UI CSV export. See
  `notes/wave-accounting/backups/2026-05-19/homesweethome/_unavailable_via_api.json`.
- It does not push to V3 directly. Output is plaintext CSV that the founder
  feeds into V3's import wizard, which handles encryption + commit.

## Mapping decisions

### Chart of Accounts
- `Type` ← Wave `type.value`, already one of ASSET / LIABILITY / EQUITY / INCOME / EXPENSE.
- `SubType` ← Wave `subtype.name`, falling back to `subtype.value` when name is empty.
- `Normal Balance` ← Wave `type.normalBalanceType` (DEBIT / CREDIT).
- `Code` ← Wave `displayId` when set, otherwise a deterministic `W-XXXXX`
  derived from the Wave account ID. Same Wave ID always produces the same
  code, so re-runs are idempotent.
- Archived accounts are included with `[archived]` appended to Description.
  They have to be present because Wave's transaction history references them.

### Contacts
- Customers tagged `Customer`, vendors tagged `Vendor`.
- `Name` ← `node.name`, falling back to "firstName lastName", finally `(unnamed)`.
- `Phone` ← `node.phone`, falling back to `node.mobile`.
- Address joined: `addressLine1, addressLine2` into Street.
- Empty cells stay empty (never the literal string "null").

### Journal Entries
- One Wave Transaction ID → one V3 JE (group of lines sharing date / ref / memo / currency).
- `JE ref #` is the Wave Transaction ID.
- `JE memo` is the first non-empty Notes / Memo in the group; falls back to
  Transaction Description.
- `JE status` is always POSTED (Wave exports posted history only).
- `Account code` is looked up from the Wave Account ID column, not the name —
  so renamed accounts in Wave still link correctly.
- `Wallet Currency` is looked up from `accounts.json` (Wave's CSV does not
  include account currency per line).
- Mixed currency transactions are split into one V3 group per currency,
  with the ref suffixed (`TX123:CAD`, `TX123:USD`). A warning is logged.
- Unbalanced groups (Dr ≠ Cr per currency) are emitted but flagged as errors.

## Usage

```bash
bun run scripts/wave-convert.ts <input-dir> <output-dir>
```

`<input-dir>` must contain `accounts.json`. Optional siblings:
`customers.json`, `vendors.json`, `accounting.csv` — each unlocks one more
output CSV. The accompanying `scripts/wave-backup.py` (on jarvis) writes the
JSON shape this connector expects.

Wave's `accounting.csv` is not produced by the API. Export it from the Wave
UI: Accounting → Transactions → Export → All transactions.

## ZKA boundary

The converter runs on the founder's box, never on a shared server. Wave
plaintext data is sensitive. Output CSVs stay local until the founder uploads
them through V3's wizard, which encrypts in the browser before storage.

## Tests

```bash
bun run test src/connectors/wave
```

Covers: header shapes, type passthrough, code-map determinism, archived
handling, mixed-currency splits, balance validation, missing-column errors,
CSV round-trip.

## Known gaps

- Sales tax: Wave's CSV has `Sales Tax Amount` / `Sales Tax Name` columns
  that are not currently propagated. V3 has no tax-tracking field on JE
  lines yet; this needs a product decision before we wire it through.
- Customer / Vendor linkage on JE lines: Wave's `Customer` and `Vendor`
  columns identify which contact a transaction relates to, but V3's JE
  CSV has no contact reference field today. The data is preserved in
  Description as a fallback (TODO).
- Bills (AP) and Estimates: not exposed via API; not handled by this
  converter. Customer to surface them manually if needed.
