/**
 * BitBooks V2 , App Profile, embedded as a TypeScript string export so it
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
export const BITBOOKS_V2_PROFILE_YAML = `# BitBooks V2 , App Profile
#
# RUNTIME SOURCE: this file's TS sibling \`bitbooks-v2.yaml.ts\` is what
# the edge-function bundle ships and what \`profile-loader.ts\` reads.
# This .yaml is kept as a human-readable mirror for diffs and review;
# when you change one, change the other.
#
# Why the TS mirror exists: Supabase Edge Function bundling only includes
# files reachable through TS imports, so a runtime read of this .yaml
# fails with "path not found".
#
# References:
#   - OrangeRails-Protocol.html §9 , App Profile Registry
#   - V2-Integration-Build-Plan.md §3 , V2 App Profile authored against schema.prisma
#   - V2 Prisma schema , bitbooks-v2/prisma/schema.prisma

app: bitbooks-v2
version: 2026.04.29
canonical_version: v0       # current de-facto canonical (NormalizedTransaction). Will move to v1 when CanonicalTransaction lands.
accepts_modules: [bitcoin]  # bitcoin only on day one; banking + exchange when those source adapters land

# ─────────────────────────────────────────────────────────────────────────
# Identity , how OR maps consumer-side identity to its subaccount
# ─────────────────────────────────────────────────────────────────────────
identity:
  # V2 passes its \`Organization.id\` as \`external_user_id\` when calling
  # or-provision. The sink uses that value as \`organizationId\` on every
  # row it emits. One V2 organization = one OR subaccount.
  external_user_id_source: organization_id

# ─────────────────────────────────────────────────────────────────────────
# Output tables , V2 Prisma model targets
# ─────────────────────────────────────────────────────────────────────────
#
# Field rules:
#   from:        copy from a NormalizedTransaction field
#   const:       hardcoded literal value
#   generated:   server-side generation (cuid / uuid / deterministic)
#   __resolve*:  hint passed to V2's sync handler for FK resolution
#                (find-or-create against V2's Prisma client at insert time)
#
# Reserved hint keys:
#   __resolveWalletId      , find Wallet by sourceWalletId UNIQUE
#   __resolveCoa           , find-or-create ChartOfAccount by (accountType, accountSubType, name?, isWallet?, currency?)
#   __resolveContactId     , find-or-create Contact by (name, kind)
#   __resolveSystemUser    , find-or-create the OrangeRails system user (createdById / postedById)

output_tables:

  # 1. Wallet upsert , only emitted on first appearance of a sourceWalletId
  Wallet:
    upsert_on: { sourceWalletId: canonical.source_wallet_id }
    fields:
      sourceWalletId:    { from: canonical.source_wallet_id }
      organizationId:    { from: input.org_id }
      orConnectionId:    { from: input.or_connection_id }
      name:              { from: derived.wallet_default_name }    # "<adapter> <asset>" fallback
      walletType:        { from: derived.wallet_type }            # SOFTWARE for Blink today
      currency:          { from: derived.asset }
      __resolveCoa:      # V2 finds-or-creates the wallet's own CoA row
        accountType:     ASSET
        accountSubType:  WALLETS
        isWallet:        true
        currency:        { from: derived.asset }
      syncStatus:        { const: SYNCED }
      lastSyncAt:        { from: derived.now }

  # 2. JournalEntry header (1 per Transaction)
  JournalEntry:
    fields:
      id:                { generated: uuid }
      organizationId:    { from: input.org_id }
      date:              { from: canonical.timestamp, as: date }
      currency:          { from: derived.asset }
      refNum:            { generated: "JE-OR-\${canonical.id:0:12}" }   # required + unique per org
      memo:              { from: canonical.description, optional: true }
      status:            { const: POSTED }
      sourceType:        { const: ORANGE_RAILS }
      __resolveSystemUser: orange_rails        # createdById / postedById

  # 3. JournalEntryLine , debit + credit pair (more for fee splits when those land)
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

  # 4. Transaction (1:1 with JournalEntry via journalEntryId UNIQUE)
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
      __resolveContactId:                       # optional, only if counterparty is set
        when: has_counterparty
        name: { from: canonical.counterparty }
        kind: { from: canonical.direction, map: { in: CUSTOMER, out: VENDOR } }
      toFromAddress:     { from: canonical.counterparty, optional: true }
      exchangeRate:      { from: canonical.fiat_equivalent.rate, optional: true }
      txFee:             { from: "canonical.fees[0].amount", optional: true }
      __resolveFeeExpAccountId:                 # only when txFee is set
        when: has_fee
        accountType:     EXPENSE
        accountSubType:  OTHER_EXPENSES
        name:            "Network Fees"
      refNum:            { generated: "OR-\${canonical.id:0:12}" }
      memo:              { from: canonical.description, optional: true }
      journalEntryId:    { from: derived.parent_je_id }

# ─────────────────────────────────────────────────────────────────────────
# Account-mapping rules , canonical type → debit/credit CoA hints
# ─────────────────────────────────────────────────────────────────────────
#
# Order matters; first match wins. Default fallback routes both legs to
# accountSubType=SUSPENSE so unmapped types surface in V2's existing review UI.

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

  # Bank deposit IN → bank account (debit), uncategorized income (credit)
  - when: { type: deposit, direction: in }
    debit:
      accountType:        ASSET
      accountSubType:     WALLETS
      isWallet:           true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency:           { from: derived.asset }
    credit:
      accountType:        INCOME
      accountSubType:     SALES
      name:               "Bank Deposits"

  # Bank withdrawal OUT → expense (debit), bank account (credit)
  - when: { type: withdrawal, direction: out }
    debit:
      accountType:        EXPENSE
      accountSubType:     OTHER_EXPENSES
      name:               "Bank Withdrawals"
    credit:
      accountType:        ASSET
      accountSubType:     WALLETS
      isWallet:           true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency:           { from: derived.asset }

  # Bank deposit OUT (debit from bank) → expense, bank account credit
  - when: { type: deposit, direction: out }
    debit:
      accountType:        EXPENSE
      accountSubType:     OTHER_EXPENSES
      name:               "Bank Withdrawals"
    credit:
      accountType:        ASSET
      accountSubType:     WALLETS
      isWallet:           true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency:           { from: derived.asset }

  # Bank withdrawal IN (credit to bank) → bank account debit, income credit
  - when: { type: withdrawal, direction: in }
    debit:
      accountType:        ASSET
      accountSubType:     WALLETS
      isWallet:           true
      targetSourceWalletId: { from: canonical.source_wallet_id }
      currency:           { from: derived.asset }
    credit:
      accountType:        INCOME
      accountSubType:     SALES
      name:               "Bank Deposits"

  # Trade / fee , placeholder, route to SUSPENSE for human classification.
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
  # All upstream "this happened" statuses land as DRAFT , V2's TransactionStatus
  # tracks bookkeeping state (DRAFT = needs review/categorization, POSTED =
  # bookkeeper has accepted), not bitcoin-side settlement. OR cannot post on
  # the user's behalf: the categorization CoA is a hint, not a decision.
  SUCCESS:    DRAFT
  COMPLETE:   DRAFT
  COMPLETED:  DRAFT
  SETTLED:    DRAFT
  PAID:       DRAFT      # Strike invoice , paid in full, still needs categorization
  CONFIRMED:  DRAFT      # on-chain (xpub adapter) , block-confirmed
  PENDING:    DRAFT
  UNCONFIRMED: DRAFT     # on-chain mempool tx
  PROCESSING: DRAFT      # BTCPay invoice , paid but awaiting confirmations
  # Genuinely failed upstream → VOID so they don't sit in the review queue
  # as actionable. User can unvoid if a refund/reversal arrives.
  FAILURE:    VOID
  FAILED:     VOID
  EXPIRED:    VOID
  INVALID:    VOID       # BTCPay invoice , payment problem (timeout, double-spend, etc.)
  CANCELLED:  VOID       # Strike invoice , cancelled before payment
  REVERSED:   VOID
  REFUNDED:   VOID
  default:    DRAFT

# ─────────────────────────────────────────────────────────────────────────
# Per-org overrides
# ─────────────────────────────────────────────────────────────────────────
# Accountants in V2 can remap a specific canonical type to a different CoA
# via V2's UI. Overrides are stored per-organization and consulted by the
# V2 sync handler before falling back to the rules above.
override_path: /api/organizations/{organizationId}/orange-rails/account-mapping

# ─────────────────────────────────────────────────────────────────────────
# Encryption profile
# ─────────────────────────────────────────────────────────────────────────
# V2 stores transactions in plaintext at rest. The sink emits no
# \`requires_encryption\` paths. Source-provider credentials (Blink API key,
# etc.) are encrypted at OR with a key derived in the external platform's browser
# from their vault password , that ZK property stays intact across V2's
# plaintext data tier, because the credential never sits at rest plaintext
# on either OR or V2's server.
encryption: null
`;
