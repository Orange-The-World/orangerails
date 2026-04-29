/**
 * BitBooks V2 — App Profile, embedded as a TypeScript string export so it
 * travels with the Supabase Edge Function bundle.
 *
 * Why this file exists alongside `bitbooks-v2.yaml`:
 *
 *   Supabase Edge Functions bundle through esbuild. Only files reachable
 *   via TS/JS imports end up in the deploy. A `.yaml` sibling is NOT
 *   bundled even when present in the source tree, so a runtime
 *   `Deno.readTextFile('./profiles/bitbooks-v2.yaml')` fails at runtime
 *   with "path not found".
 *
 *   This module re-exports the same YAML content as a string literal so
 *   the profile-loader can `import` it. The bundler picks the file up
 *   automatically and the YAML reaches production verbatim.
 *
 * Source of truth: this `.ts` file. The `.yaml` sibling is kept as a
 * human-readable mirror for docs / diffs / readability. When you change
 * one, change the other.
 */
export const BITBOOKS_V2_PROFILE_YAML = `# BitBooks V2 — App Profile
#
# This YAML is the App Profile contract V2 expects when calling or-sync
# with \`format=bitbooks-v2\`. It is load-bearing: editing
# \`account_mapping_rules\` or \`status_to_v2\` changes runtime behavior
# with no TypeScript redeploy needed.
#
# Source of truth lives in profiles/bitbooks-v2.yaml.ts (this file's
# TS sibling) so Supabase Edge Function bundling picks it up. The
# .yaml file is the human-readable mirror; keep them in sync.
#
# References:
#   - OrangeRails-Protocol.html §9 — App Profile Registry
#   - V2-Integration-Build-Plan.md §3 — V2 App Profile authored against schema.prisma
#   - V2 Prisma schema — bitbooks-v2/prisma/schema.prisma

app: bitbooks-v2
version: 2026.04.29
canonical_version: v0       # current de-facto canonical (NormalizedTransaction). Will move to v1 when CanonicalTransaction lands.
accepts_modules: [bitcoin]  # bitcoin only on day one; banking + exchange when those source adapters land

# ─────────────────────────────────────────────────────────────────────────
# Identity — how OR maps consumer-side identity to its subaccount
# ─────────────────────────────────────────────────────────────────────────
identity:
  external_user_id_source: organization_id

# ─────────────────────────────────────────────────────────────────────────
# Output tables — V2 Prisma model targets (advisory, TS sink owns row construction today)
# ─────────────────────────────────────────────────────────────────────────
output_tables:

  Wallet:
    upsert_on: { sourceWalletId: canonical.source_wallet_id }
    fields:
      sourceWalletId:    { from: canonical.source_wallet_id }
      organizationId:    { from: input.org_id }
      orConnectionId:    { from: input.or_connection_id }
      name:              { from: derived.wallet_default_name }
      walletType:        { from: derived.wallet_type }
      currency:          { from: derived.asset }
      __resolveCoa:
        accountType:     ASSET
        accountSubType:  WALLETS
        isWallet:        true
        currency:        { from: derived.asset }
      syncStatus:        { const: SYNCED }
      lastSyncAt:        { from: derived.now }

  JournalEntry:
    fields:
      id:                { generated: uuid }
      organizationId:    { from: input.org_id }
      date:              { from: canonical.timestamp, as: date }
      currency:          { from: derived.asset }
      refNum:            { generated: "JE-OR-\${canonical.id:0:12}" }
      memo:              { from: canonical.description, optional: true }
      status:            { const: POSTED }
      sourceType:        { const: ORANGE_RAILS }
      __resolveSystemUser: orange_rails

  JournalEntryLine:
    derive_from: account_mapping_rules
    fields_per_line:
      id:                { generated: uuid }
      journalEntryId:    { from: derived.parent_je_id }
      __resolveCoa:      { from: derived.line.account_role }
      nativeCurrency:    { from: derived.asset }
      amountNative:      { from: derived.amount }
      pinnedRate:        { from: canonical.fiat_equivalent.rate, optional: true }
      pinnedRateSource:  { const: PROVIDER, when: has_pinned_rate }
      ratePending:       { const: false, when: has_pinned_rate, else: true }
      rateTimestamp:     { from: canonical.timestamp }
      debit:             { from: derived.line.debit, optional: true }
      credit:            { from: derived.line.credit, optional: true }
      memo:              { from: canonical.description, optional: true }

  Transaction:
    fields:
      id:                { generated: uuid }
      organizationId:    { from: input.org_id }
      __resolveWalletId: { sourceWalletId: canonical.source_wallet_id }
      mode:              { const: STANDARD }
      date:              { from: canonical.timestamp, as: date }
      time:              { from: canonical.timestamp, as: time }
      amount:            { from: derived.amount }
      asset:             { from: derived.asset }
      direction:         { from: canonical.direction, map: { in: IN, out: OUT } }
      status:            { from: canonical.status, map_via: status_to_v2 }
      clearedStatus:     { const: NOT_CLEARED }
      __resolveContactId:
        when: has_counterparty
        name: { from: canonical.counterparty }
        kind: { from: canonical.direction, map: { in: CUSTOMER, out: VENDOR } }
      toFromAddress:     { from: canonical.counterparty, optional: true }
      exchangeRate:      { from: canonical.fiat_equivalent.rate, optional: true }
      txFee:             { from: canonical.fees[0].amount, optional: true }
      __resolveFeeExpAccountId:
        when: has_fee
        accountType:     EXPENSE
        accountSubType:  OTHER_EXPENSES
        name:            "Network Fees"
      refNum:            { generated: "OR-\${canonical.id:0:12}" }
      memo:              { from: canonical.description, optional: true }
      journalEntryId:    { from: derived.parent_je_id }

# ─────────────────────────────────────────────────────────────────────────
# Account-mapping rules — canonical type → debit/credit CoA hints
# Order matters; first match wins. Default fallback routes both legs to
# accountSubType=SUSPENSE so unmapped types surface in V2's existing review UI.
# ─────────────────────────────────────────────────────────────────────────

account_mapping_rules:

  # Lightning IN → wallet (debit), Sales income (credit)
  - when: { type: lightning, direction: in }
    debit:
      accountType:        ASSET
      accountSubType:     WALLETS
      isWallet:           true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency:           { from: derived.asset }
    credit:
      accountType:        INCOME
      accountSubType:     SALES
      name:               "Sales"

  # Lightning OUT → Other Expenses (debit), wallet (credit)
  - when: { type: lightning, direction: out }
    debit:
      accountType:        EXPENSE
      accountSubType:     OTHER_EXPENSES
      name:               "Lightning Payments"
    credit:
      accountType:        ASSET
      accountSubType:     WALLETS
      isWallet:           true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency:           { from: derived.asset }

  # On-chain IN → wallet (debit), Bitcoin Clearing (credit, awaits categorization)
  - when: { type: onchain, direction: in }
    debit:
      accountType:        ASSET
      accountSubType:     WALLETS
      isWallet:           true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency:           { from: derived.asset }
    credit:
      accountType:        ASSET
      accountSubType:     OTHER_CURRENT_ASSETS
      name:               "Bitcoin Clearing"

  # On-chain OUT → Bitcoin Clearing (debit), wallet (credit)
  - when: { type: onchain, direction: out }
    debit:
      accountType:        ASSET
      accountSubType:     OTHER_CURRENT_ASSETS
      name:               "Bitcoin Clearing"
    credit:
      accountType:        ASSET
      accountSubType:     WALLETS
      isWallet:           true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency:           { from: derived.asset }

  # Trade / deposit / withdrawal / fee — placeholder, route to SUSPENSE
  # until exchange + bank source adapters land. V2's existing Suspense
  # review UI surfaces these for human classification.
  - default: true
    debit:
      accountType:        ASSET
      accountSubType:     SUSPENSE
      name:               "Suspense"
    credit:
      accountType:        ASSET
      accountSubType:     SUSPENSE
      name:               "Suspense"

# ─────────────────────────────────────────────────────────────────────────
# Status mapping (Blink + future providers → V2's TransactionStatus enum)
# ─────────────────────────────────────────────────────────────────────────
status_to_v2:
  SUCCESS:    COMPLETE
  COMPLETE:   COMPLETE
  COMPLETED:  COMPLETE
  SETTLED:    COMPLETE
  PENDING:    PENDING
  FAILURE:    FAILED
  FAILED:     FAILED
  EXPIRED:    FAILED
  REVERSED:   REVERSED
  REFUNDED:   REVERSED
  default:    INCOMPLETE

# ─────────────────────────────────────────────────────────────────────────
# Per-org overrides
# ─────────────────────────────────────────────────────────────────────────
override_path: /api/organizations/{organizationId}/orange-rails/account-mapping

# ─────────────────────────────────────────────────────────────────────────
# Encryption profile
# ─────────────────────────────────────────────────────────────────────────
# V2 stores transactions in plaintext at rest. Source credentials remain
# end-to-end encrypted at OR with a key derived in the V2 customer's
# browser from their vault password.
encryption: null
`;
