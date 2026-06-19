# Surge → Orange Rails , Accounting Translation

**Audience: internal only.** This is how we (BitBooks / Orange Rails) interpret Surge data as journal entries on the customer's books. Surge does not need to see this.



---

## 1. The narrative

A Surge customer is a Bitcoin holder borrowing USDC against pledged BTC collateral on Base. From a bookkeeping point of view, the customer goes through five economic moments per loan:

1. **Loan opens** , Surge mints a position NFT. Nothing moves yet.
2. **Collateral pledged** , BTC moves from the customer's self-custody into the Surge vault. Beneficial ownership stays with the customer; legal control is restricted. **Not a disposition.**
3. **Funds borrowed** , USDC arrives in the customer's wallet. New liability on the books.
4. **Interest accrues** , continuously. Not an event; a calculation.
5. **Settled** , partially or fully, by repayment, collateral withdrawal, or liquidation.

Each Surge `event` in the API corresponds to one of these moments. The `accounting-state` endpoint is the period-end snapshot of where things stand right now.

---

## 2. New accounts introduced on the customer's chart of accounts

| Type      | Account                                  | Why                                                                |
| --------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Asset     | `Bitcoin, Pledged to Surge`              | Restricted BTC. Cost basis carried over from `Bitcoin, Self-Custody`. |
| Asset     | `USDC, Operating Wallet` (likely exists) | Where borrowed USDC lands.                                         |
| Liability | `Surge Line of Credit , Principal`       | USDC principal owed.                                               |
| Liability | `Accrued Interest Payable , Surge`       | Interest accumulated, not yet repaid.                              |
| Expense   | `Interest Expense , Surge`               | Periodic interest cost.                                            |
| P&L       | `Realized Gain/Loss on BTC Disposal`     | Only fires on liquidation (or sale).                               |

The account names `Bitcoin, Pledged to Surge` and `Surge Line of Credit` are **the same strings Surge returns** in `accounting-state.positions[].accounts.*.account_name`. Adopting them verbatim means zero mapping table and a UI label that matches what the customer sees in the Surge app.

Multi-position customers get sub-accounts: `Surge Line of Credit / Position 226`.

---

## 3. Event → entries cheat-sheet

Worked against a representative test loan (0.005 BTC pledged, 2,000 USDC borrowed at 5.97% APR; customer cost basis $60,000/BTC; functional currency USD).

### 3.1 `loan_opened` , no posting

NFT mint event only. Orange Rails records position metadata (`position_id`, `market_id`, opening timestamp). No money/BTC has moved yet.

### 3.2 `collateral_added` , pledge BTC

BTC leaves self-custody, enters the Surge vault. Cost basis transfers with the asset; **no realization event** under standard treatment.

```
DR  Bitcoin, Pledged to Surge          0.005 BTC  @ $60,000 = $300.00
   CR  Bitcoin, Self-Custody           0.005 BTC  @ $60,000 = $300.00
```

If customer policy is fair-value remeasurement at period-end, an adjusting entry runs separately , not driven by this event.

### 3.3 `borrowed` , receive USDC

USDC arrives in the wallet, principal grows.

```
DR  USDC, Operating Wallet                                    $2,000.00
   CR  Surge Line of Credit , Principal                        $2,000.00
```

### 3.4 Interest accrual , derived, not eventful

Surge does not currently emit an accrual event. Two options:

**Option A , wait for `accrued_interest_now` (Phase 2 from Surge).** Then post once per accounting period:

```
DR  Interest Expense , Surge                                  $X
   CR  Accrued Interest Payable , Surge                        $X
```

where `$X = accrued_interest_now − accrued_interest_at(period_start)`.

**Option B , estimate client-side now.** `accrued = principal × (apr_bps/10000) × (days/365)`. Tag the entry with `provenance: "estimated, Orange Rails"` so the bookkeeper can true it up when Surge ships the real number.

We default to Option B and switch to Option A the day Surge ships it. **This is the single biggest accounting gap in the v1 spec.**

### 3.5 `repaid` , pay back

Two sub-cases depending on whether Surge capitalizes interest:

**Interest-first repayment (most common bookkeeping treatment):**

```
DR  Accrued Interest Payable , Surge                          $X    (clear accrued first)
DR  Surge Line of Credit , Principal                          $Y    (remainder reduces principal)
   CR  USDC, Operating Wallet                                  $X + $Y
```

**Capitalized interest (if Surge rolls unpaid interest into principal under the hood):**

```
DR  Surge Line of Credit , Principal                          full repayment
   CR  USDC, Operating Wallet                                  full repayment
```

**This is open question #11 to Surge:** does interest sit separately, or capitalize into principal? Bookkeeping depends on it.

### 3.6 `collateral_withdrawn` , pull BTC back

Inverse of pledge. Cost basis travels back. Customer policy decides FIFO / LIFO / Spec-ID for which lot moves.

```
DR  Bitcoin, Self-Custody              0.00494284 BTC @ cost   $296.57
   CR  Bitcoin, Pledged to Surge       0.00494284 BTC @ cost   $296.57
```

### 3.7 Liquidation , not in v1 vocabulary, **must be added**

Surge seizes pledged BTC to cover debt. This **is** a disposition for tax purposes , realized gain/loss vs cost basis.

```
DR  Surge Line of Credit , Principal              (cleared)
DR  Accrued Interest Payable , Surge              (cleared)
DR  Realized Loss on BTC Disposal                 (plug, if applicable)
   CR  Bitcoin, Pledged to Surge       @ cost basis of seized BTC
   CR  Realized Gain on BTC Disposal              (plug, if applicable)
```

Two prices needed at the moment of seizure: customer's cost basis (we have it on our side) and BTC FMV at seizure block (= proceeds). The latter has to come from either Surge's event payload (preferred) or a price feed pegged to the block timestamp.

### 3.8 Position `status: "closed"` , metadata only

No entry. The closure is implied by prior `repaid` + `collateral_withdrawn` (or `liquidation`) bringing both sides to zero. Orange Rails surfaces it as a state transition in the UI.

---

## 4. Where the journal derivation lives in our stack

This matters because of our zero-knowledge architecture.

```
Surge API
   │
   │ proxy (server/adapters/surge.js , Orange Rails server)
   ▼
Server cache (ciphertext at rest)
   │
   │ deliver to browser
   ▼
Browser, after vault unlock
   │
   │ surge-journal-engine.ts      ← derive postings HERE, in the client
   ▼
Ciphertext journal entries written to customer's books
```

The **server** sees: Surge JSON (kept opaque blob, encrypted at rest under the customer's vault key). The **browser** sees: decrypted JSON, runs the derivation, re-encrypts before write. The chart-of-accounts names live in the browser too. Server never sees plaintext amounts, account names, or memos.

So `server/adapters/surge.js` is a thin proxy. `surge-journal-engine.ts` (to be built on the V3/OW client side) is where the table above turns into real entries.

---

## 5. Three-currency model implications

BitBooks tracks transactional / functional / reporting currencies per account. For a Surge loan:

| Field                                     | Transactional | Functional (typically) | Reporting (typical)         |
| ----------------------------------------- | ------------- | ---------------------- | --------------------------- |
| `Bitcoin, Pledged to Surge` balance       | BTC           | USD @ cost basis       | USD or customer-chosen      |
| `Surge Line of Credit , Principal`        | USDC          | USD ≈ 1:1              | USD                         |
| `Accrued Interest Payable , Surge`        | USDC          | USD ≈ 1:1              | USD                         |
| Period BTC fair-value remeasurement       | BTC           | USD spot on period-end | reporting currency on date  |

USDC ≈ USD is the default; if a customer's policy is "USDC is a separate FX asset, mark at par minus depeg risk," that lives in their org policy, not in this connector.

For BTC FMV at event timestamps (needed for liquidation realized gain/loss), we use the Orange Rails Bitcoin Index (ORBI) feed, keyed on the event's `occurred_at`.

---

## 6. What we hand to the bookkeeper

For each Surge event, Orange Rails produces a draft journal entry (per the OR-synced txs always land as DRAFT rule). Draft includes:

- Posting date = `occurred_at` from the event
- Memo = `Surge ${action} on position ${position_id} (tx ${transaction_hash})`
- Accounts + amounts per the table in §3
- Provenance = `surge.events[id]` so the bookkeeper can click through to the source
- Tag = `requires-confirmation` if any field was estimated (e.g. interest accrual under §3.4 Option B, BTC FMV before vault-history endpoint ships, etc.)

Bookkeeper categorizes, edits if needed, and posts. Same DRAFT-then-POSTED flow as every other connector.

---

## 7. Open questions that change the bookkeeping

These all sit in the integration questions list, repeated here so future you can find them when scoping the derivation engine:

1. **Capitalized interest vs separate accrual** (§3.5) , changes how `repaid` splits.
2. **`accrued_interest_now`** (§3.4) , without it we estimate, and every period-end needs a true-up.
3. **Liquidation event + proceeds** (§3.7) , without it, books silently mis-state on a liquidation.
4. **`status` enum beyond `active`/`closed`** , `liquidated`, `defaulted`, `repaid` each map differently.
5. **Amount basis convention** , atomic units (6dp for USDC, 8dp for sats) vs decimal. Off-by-six-decimals is a fatal class of bug.
6. **Multi-position concurrency** , confirm one position = one NFT = one sub-account; no implicit netting across positions.
