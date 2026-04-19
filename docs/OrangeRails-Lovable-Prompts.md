# OrangeRails — Lovable Prompts (Landing Site)
**Date:** 2026-04-17 (SESSION 2026-04-17-DUNE)
**Target domain:** `orangerails.com` (pending availability check — also secure `.io`, `.dev`, `.xyz`)
**Stack:** Lovable (React + Vite + shadcn/ui + Tailwind) + Supabase (waitlist) — matches BitBooks V3 conventions
**Brand family:** Orange (alongside the maintainer's **Orange Bridge** project; future Orange Ledger, Orange Node possible)
**Goal:** Ship a 3-page marketing site to capture waitlist signups and establish the OSS + ZKA positioning before the first code commit. Roark flagged on Jan 19 that "getting the website for [this product] is probably the highest priority."

**Note on naming:** Roark originally called this product "Bitcoin Connector." After availability research (SESSION 2026-04-17-DUNE), renamed to **OrangeRails**. See `OrangeRails-Plan.md` preamble for full rationale.

**Build order:** OR-01 → OR-02 → OR-03. Each prompt is paste-ready for Lovable.

**Before starting:** in Lovable, create a new project named `orangerails-site`. Connect to a fresh Supabase project for waitlist storage. Set brand primary color to `#F7931A` (Bitcoin orange — core to both Bitcoin culture and the OrangeRails name). Fonts: Inter for body, JetBrains Mono for code samples.

---

## LOVABLE OR-01 — Landing Page (Hero + Value Prop + Positioning)

### PROMPT TO PASTE INTO LOVABLE:

---

Build the marketing landing page for **OrangeRails** — "the open-source, zero-knowledge alternative to Plaid, built for Bitcoin."

This is page 1 of 3. Focus: hero, value proposition, ZKA-over-Plaid positioning, competitive differentiation, social proof placeholder, CTAs.

### Design system

- **Primary color**: `#F7931A` (Bitcoin orange) — use for CTAs, highlights, icon accents
- **Secondary**: neutral dark (`#0F172A` slate-900) for text, `#FAFAFA` for backgrounds
- **Accent**: `#22C55E` (green) for "can do" checkmarks, `#EF4444` (red) for "cannot do" X marks
- **Fonts**: Inter for body/headings, JetBrains Mono for code and technical labels
- **Style**: clean, modern, developer-focused. Think Supabase.com or Linear.app — not "crypto bro." Minimal gradients. No stock photos.

### Page structure (top to bottom)

**1. Navbar (sticky, translucent on scroll)**
- Left: "OrangeRails" wordmark (use a simple ⚡ icon prefix in orange)
- Center links: Features, Integrations, Docs, Pricing
- Right: "GitHub" button (placeholder link `#`), "Join Waitlist" primary button (orange)

**2. Hero section (full viewport height)**
- Pre-headline (small, uppercase, orange): **"ORANGERAILS"**
- Headline (large, bold): **"The rails every Bitcoin business runs on."**
- Sub-headline (medium, 80% opacity): "Open source. Zero knowledge. Built for Bitcoin. The alternative to Plaid that can't read your data — because it can't."
- Two CTAs side by side:
  - Primary (orange): "Join the Waitlist" (scrolls to bottom form)
  - Secondary (outline): "View on GitHub" (placeholder link)
- Below CTAs, three small trust badges as text: `Apache 2.0` · `Self-hostable` · `Zero-knowledge by design`
- Right side: a stylized terminal window showing:
  ```bash
  $ npx orangerails init
  ✓ Detected: Bitcoin Core, BTCPay Server
  ✓ Added adapters: Blink, Kraken, Ocean Pool
  ✓ Sync enabled. Zero-knowledge mode: ON
  $ orangerails sync --live
  [14:32] Imported 47 transactions
  ```

**3. "The Plaid Problem" section**
- Heading: "Plaid was built on your data."
- Three cards side by side, each with a red ✗ icon:
  - **"Plaid stores your credentials."** Sub: Bank logins, API keys, OAuth tokens — all held server-side.
  - **"Plaid sees every transaction."** Sub: Descriptions, counterparties, amounts, categories — all plaintext to them.
  - **"Plaid monetizes your data."** Sub: 2020 class-action lawsuit. $58M settlement. The business model is the data.
- Below: big divider line, then heading: **"We took the opposite approach."**
- Three cards with green ✓:
  - **"Your credentials, encrypted."** Sub: AES-256-GCM with your vault password. We can't decrypt them. Ever.
  - **"Transaction descriptions stay encrypted."** Sub: Split-connector architecture. Server does the math. Your browser does the meaning.
  - **"No data moat. Just infrastructure."** Sub: Open source under Apache 2.0. Fork it, audit it, run it yourself.

**4. "Built for Bitcoin, accounting-grade" feature grid**
- Heading: "Everything a Bitcoin business actually needs."
- 2×3 grid of feature cards (icon + title + 2-line description):
  1. **⚡ Bitcoin-native** — Every adapter built for BTC + Lightning. Not watered down by multi-chain noise.
  2. **📊 Accounting-grade** — Minute-precision exchange rates. Immutable records. Journal-entry hints on every transaction.
  3. **🏦 Bank-connected** — Lunar Rails, Blink, BitCredit, Fedi. One connection, your whole financial stack flows in.
  4. **🔌 Open API spec** — Partners build to it. We build to theirs. Either direction works.
  5. **🔐 Zero-knowledge mode** — Split-connector pattern. We process amounts. You process meaning. Nobody in the middle sees both.
  6. **🛠️ Trojan horse for legacy accounting** — QuickBooks plugin. Xero plugin. Keep your GL. Get Bitcoin.

**5. Comparison table: "How we stack up"**
- Heading: "Compare the alternatives."
- Table with 5 rows, 5 columns (use shadcn table component, zebra striping):

| | Plaid | Mesh Connect | Vezgo | Koinly | **OrangeRails** |
|---|:-:|:-:|:-:|:-:|:-:|
| Open source | ✗ | ✗ | ✗ | ✗ | **✓** |
| Bitcoin-first | ✗ | ✗ | ✗ | ✗ | **✓** |
| Accounting-grade | ✗ | ✗ | ✗ | Tax only | **✓** |
| Zero-knowledge | ✗ | ✗ | ✗ | ✗ | **✓** |
| Self-hostable | ✗ | ✗ | ✗ | ✗ | **✓** |
| Published open spec | ✗ | ✗ | ✗ | ✗ | **✓** |

- Highlight the OrangeRails column with a subtle orange background tint.

**6. Integration logos strip**
- Heading: "Connects to the Bitcoin ecosystem."
- Grayscale logo strip (use placeholder brand names in monospace font for now): `Blink` · `BTCPay Server` · `Kraken` · `Lunar Rails` · `Ocean Pool` · `Bitcoin Core` · `Sparrow` · `River` · `Fedi` · `LND` · `Braiins` · `mempool.space`
- Below: link "View all 20+ integrations →" (anchors to the Integrations page, OR-02)

**7. CTA section (pre-footer)**
- Full-width orange band.
- Heading: "Be first to connect."
- Sub: "Join the waitlist for hosted access. Self-host now from GitHub."
- Waitlist form: single email input + "Join waitlist" button. On submit, insert into Supabase `waitlist` table with columns: `id (uuid)`, `email (text)`, `source (text)`, `created_at (timestamptz)`. Show success toast: "You're on the list. We'll email when the OSS repo drops."
- Below form, small text: "We'll email you once. No marketing spam. Unsubscribe is a single click."

**8. Footer**
- Three columns:
  - Product: Features, Integrations, Pricing, Docs
  - Company: About, Blog (placeholder), Security, Open Source Philosophy
  - Connect: GitHub (placeholder), Twitter (placeholder), Nostr (placeholder)
- Bottom row: "© 2026 OrangeRails. Apache 2.0 licensed." + small legend "Part of the BitBooks family."

### Supabase schema

Create migration:
```sql
CREATE TABLE waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  source TEXT DEFAULT 'landing',
  utm_campaign TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
CREATE POLICY waitlist_insert ON waitlist FOR INSERT TO anon WITH CHECK (true);
-- Reads restricted to service_role only (admin dashboard later).
```

### Acceptance criteria
- All sections render without console errors
- Mobile responsive (single column below 768px)
- Waitlist form validates email format client-side and inserts to Supabase
- Success/error toasts use shadcn toast component
- OrangeRails column in comparison table visually highlighted
- Page loads in < 2s on 3G (no large images, prefer SVG icons)

---

## WHAT OR-01 PRODUCES
- Full landing page with hero, positioning, feature grid, comparison table, integration logos, waitlist CTA, footer
- Supabase `waitlist` table + insert policy
- Brand system (color palette, fonts, components) reusable in OR-02 and OR-03

---

## LOVABLE OR-02 — Integrations Page + Developer Docs Hub

### PROMPT TO PASTE INTO LOVABLE:

---

Add a second page to the OrangeRails site at route `/integrations` and a docs hub at `/docs`. Reuse the navbar, footer, and design system from OR-01.

### Page: /integrations

**1. Hero (compact)**
- Heading: "Every Bitcoin integration, in one place."
- Sub: "Banking, exchanges, wallets, mining pools, Lightning, and files. All normalized into a single API shape."

**2. Tier filter tabs** (shadcn tabs component): `All · Banking · Exchanges · Wallets · Mining · Lightning · Files`

**3. Integration cards grid (3 columns on desktop)**

Each card shows: logo placeholder, name, category badge, status badge (Available/Planned/Beta), 2-line description, "Docs →" link.

Cards to include (store this list in a single `integrations.ts` array so it's easy to update):

| Name | Category | Status | Description |
|---|---|---|---|
| Bitcoin Core | Wallet | Available | Connect to your own node via RPC. Full sovereignty. |
| BTCPay Server | Payments | Available | Merchant invoices via webhook. HMAC-signed. |
| Blink (Galoy) | Banking | Available | Lightning + USD stablecoin. GraphQL API. |
| bwt (xpub) | Wallet | Available | Watch-only on-chain wallet. Rust descriptor tracker. |
| Lunar Rails | Banking | Beta | Exchange rates now. Banking Phase 2. |
| Kraken | Exchange | Planned | Spot trading, deposits, withdrawals, fee history. |
| River | Exchange | Planned | DCA and treasury management. |
| Ocean Pool | Mining | Planned | Non-custodial mining payouts (BOLT12 Lightning). |
| Braiins Pool | Mining | Planned | API + CSV/JSON payout export. |
| ViaBTC Pool | Mining | Planned | Mining rewards and payouts. |
| LND | Lightning | Planned | gRPC + Faraday accounting. |
| Core Lightning (CLN) | Lightning | Planned | Self-hosted Lightning node. |
| LDK | Lightning | Planned | Library adapter. WASM-capable. |
| Sparrow Wallet | Wallet | Planned | PSBT import, xpub descriptor. |
| Phoenix | Lightning | Planned | LDK-based mobile Lightning. |
| Mempool.space / Esplora | Explorer | Available | Blockchain query adapter. |
| Coinbase | Exchange | Planned | OAuth read-only. |
| Swan | Exchange | Planned | DCA + treasury. |
| Strike | Banking | Planned | Lightning + USD banking. |
| BitCredit | Banking | Planned | Bitcoin-backed lending. |
| Fedi | Wallet | Planned | Ecash mini-app ecosystem. |
| CSV / OFX / QIF | Files | Available | Universal fallback import. |

Add a footer card: **"Don't see your provider?"** with CTA button "Request an adapter" opening a dialog with email + provider name form → insert to Supabase `adapter_requests` table.

**4. "Build an adapter" section (at bottom of page)**
- Heading: "Adapter SDK — build one in a day."
- Code sample (JetBrains Mono, dark theme, syntax highlighting):
  ```typescript
  import { defineAdapter } from '@orangerails/sdk'

  export default defineAdapter({
    id: 'my-bitcoin-provider',
    displayName: 'My Bitcoin Provider',
    async authenticate(credentials) { /* ... */ },
    async listAccounts() { /* ... */ },
    async *syncTransactions(cursor) { /* ... */ },
    normalize(raw) { /* ... */ },
  })
  ```
- CTA: "Read the SDK docs →" (links to `/docs/adapter-sdk`, placeholder)

### Page: /docs

Simple docs landing. Don't build full MDX for now — just a navigation hub.

**1. Hero**
- "Developer documentation."
- Sub: "Everything you need to integrate, self-host, or build on OrangeRails."

**2. Three card links (large, clickable)**
- **Quickstart** — 10 minutes to your first synced transaction
- **API reference** — REST endpoints, webhook events, normalized data shapes
- **Self-hosting guide** — Docker Compose, Helm, Supabase-compatible schema

**3. Secondary link grid (6 smaller cards)**
- Adapter SDK guide
- Zero-knowledge architecture explainer
- Open API spec (v0 draft)
- Security model & threat model
- Migration from Plaid / Mesh / Vezgo
- Contributing & community

Each card links to `#` placeholder for now — we'll fill MDX in a later session.

### Supabase schema additions

```sql
CREATE TABLE adapter_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE adapter_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY adapter_requests_insert ON adapter_requests FOR INSERT TO anon WITH CHECK (true);
```

### Acceptance criteria
- Integration filter tabs actually filter the card grid
- "Request an adapter" dialog inserts to Supabase and shows toast
- All cards load from a single `integrations.ts` array (easy to update)
- Docs page scaffolded with 9 link placeholders
- Mobile responsive

---

## WHAT OR-02 PRODUCES
- `/integrations` page with 22 provider cards, filter tabs, adapter request form
- `/docs` hub with 9 section placeholders
- Adapter SDK code sample
- Supabase `adapter_requests` table

---

## LOVABLE OR-03 — Pricing Page + Open Source Philosophy + Signup Polish

### PROMPT TO PASTE INTO LOVABLE:

---

Add the pricing page at `/pricing`, an OSS philosophy page at `/open-source`, and polish the waitlist signup flow from OR-01. Reuse the design system.

### Page: /pricing

**1. Hero**
- Heading: "Priced for who you actually are."
- Sub: "Free to self-host. $15/year for individuals. Usage-based for developers. Subscription for teams. Every tier includes zero-knowledge mode — we refuse to gate privacy."

**2. Segmented pricing — three audiences, three models**

Use a top-level tab strip or segmented control with three options: **For Individuals** · **For Teams & Businesses** · **For Developers**. Clicking changes the pricing grid below.

Under each, render a separate pricing card grid:

---

#### Tab 1: For Individuals

Grid of 3 cards:

| **Self-Host** | **Personal** ★ | **Prosumer** |
|---|---|---|
| **Free forever** | **$15/year** (or $2/mo) | **$99/year** (or $10/mo) |
| Unlimited connections | Up to 5 connections | Unlimited connections |
| Zero-knowledge mode | Zero-knowledge mode | Zero-knowledge mode |
| You run the server | We run the server | We run the server |
| Daily sync (your schedule) | Daily sync | Hourly sync + real-time webhooks |
| Community support | Community forum | Email support (72hr) |
| Apache 2.0 licensed | — | — |
| **Get on GitHub** | **Start free 14-day trial** | **Start free 14-day trial** |

Small caption under the grid: *"Pricing benchmarked against SimpleFIN ($15/yr) and Koinly ($99/yr) — both proven willingness-to-pay anchors for self-sovereign users."*

---

#### Tab 2: For Teams & Businesses

Grid of 3 cards:

| **Team** | **Business** ★ | **Enterprise** |
|---|---|---|
| **$49/month** ($490/yr) | **$199/month** ($1,990/yr) | **Contact sales** |
| Up to 25 connections | Unlimited connections | Unlimited connections |
| 5 seats | Unlimited seats | Unlimited + private deployment |
| Zero-knowledge mode | Zero-knowledge mode | Zero-knowledge mode |
| Audit log | SAML / OIDC SSO | SSO + SCIM provisioning |
| Daily backups | Audit log + retention | Audit log + SIEM export |
| Email support (24hr) | Priority support (4hr) | Named CSM + 1hr SLA |
| — | 99.9% SLA | 99.95% SLA |
| — | Verified partner-signed adapters | SOC 2 Type II, HIPAA BAA |
| — | — | HSM / KMS integration |
| **Start free 14-day trial** | **Start free 14-day trial** | **Book a call** |

Caption: *"Team anchors near Xero Growing ($47/mo). Business anchors near QuickBooks Online Advanced ($200/mo). Enterprise is custom because SOC 2/HIPAA paperwork is custom."*

---

#### Tab 3: For Developers

Intro text above the grid: *"Building a product that needs Bitcoin data ingestion? These tiers are usage-based, like Plaid. Benchmark: Plaid charges $0.30–$1.00 per connection per month + per-API-call fees. We match the shape but Bitcoin-first, open-source, and zero-knowledge."*

Grid of 3 cards:

| **Sandbox** | **Production** ★ | **Enterprise API** |
|---|---|---|
| **Free** | **$500/month base** | **Custom contract** |
| Rate-limited | **+ $0.50/connection/month** | Volume discounts >10k connections |
| 5 test connections | **+ $0.001/API call** | Dedicated infrastructure |
| No production traffic | Unlimited test connections | White-label option |
| Sandbox data only | Real bank/wallet data | Custom SLA |
| Community support | Email support (24hr) | Named CSM |
| **Start building** | **Go live** | **Book a call** |

Caption: *"BitBooks itself is our first developer-API customer. Clean intra-company pricing — our own product pays us per connected user."*

---

**3. Comparison: which tier is right for me?**

Heading: "Still not sure? Here's who picks what."

Four short persona cards:

- **You're a Bitcoiner tracking your own stack** → **Personal ($15/year)** or **Self-Host (free)**
- **You're a miner with <50 rigs or a BTC-accepting merchant** → **Prosumer ($99/year)**
- **You're an accounting firm with BTC clients or a multi-entity Bitcoin business** → **Team ($49/mo)** or **Business ($199/mo)**
- **You're building a product that needs Bitcoin data ingestion (fintech, accounting tool, payroll platform, etc.)** → **Production API ($500/mo + usage)**

**4. "Why three pricing models?" explainer section**

Heading: "Why we price differently for different people."

Three columns:

- **Individuals pay a flat annual fee.**
  *SimpleFIN proved individuals will pay $15/year for banking aggregation. Koinly proved they'll pay $99/year for self-custody tax software. We sit exactly in that zone. No per-connection surprises, no usage fees, no metering anxiety.*
- **Teams pay a monthly subscription.**
  *Accounting firms and Bitcoin businesses already pay $47–$200/month for QuickBooks Online or Xero. We price alongside those anchors. You get SSO, audit logs, and SLAs — the operational things that matter when a team depends on the service.*
- **Developers pay per use, like Plaid.**
  *If you're embedding OrangeRails in your own product, you want pricing that scales with your revenue — not a flat fee that either over- or underprices you. Per-connection usage-based pricing aligns your cost with your growth.*

**5. "Why Zero-Knowledge is on every tier" callout**

Orange-bordered callout box:
- Heading: "Zero-knowledge is not an enterprise feature."
- Body: "We refuse to gate privacy behind a paywall. The audience that values open source the most is the same audience that values zero-knowledge the most — splitting them alienates both. ZKA mode runs on the free self-host, the $15/year Personal tier, and the Enterprise contract. Same code. Same guarantees. Same architecture."

**6. FAQ accordion** (below the pricing grids — renumbered from 4 because we added two sections above)
- "Why do you have three different pricing models?"
  - *Because one size never fits all. Plaid charges developers per connected account — that works for fintechs but bankrupts hobbyists. SimpleFIN charges users $15/year flat — that works for individuals but won't support enterprise SLAs. Koinly charges annual tiers — that works for tax filers but doesn't scale for embedded developer use. We use the right model for each audience instead of forcing everyone into one bucket.*
- "Why is zero-knowledge mode included in every tier, even free?"
  - *Because gating privacy behind a paywall contradicts why we built this in the first place. The cypherpunk audience that values OSS is the same audience that values ZKA — we won't split them.*
- "Can I move between tiers or between segments?"
  - *Yes. Upgrade or downgrade within a segment anytime. If you outgrow the Individual tiers and need Team features (SSO, audit log), migrate to the Teams segment — your data stays, billing recalculates.*
- "What happens if I stop paying?"
  - *Your hosted instance pauses (data retained 90 days). You can always self-host from GitHub with full feature parity (minus hosting conveniences) and import your data back.*
- "Do you resell my data?"
  - *We can't — even if we wanted to. Zero-knowledge mode means we literally cannot read transaction descriptions, counterparties, or categorizations. See /open-source for the full threat model.*
- "Is the OSS self-host version crippled?"
  - *No. Same adapters, same ZKA, same API. Paid tiers add operational features (SSO, audit log, SLA, SOC 2) that matter for teams — not individual developers running their own instance.*
- "Why not charge everyone like Plaid (usage-based)?"
  - *Because per-connection metering is hostile to individuals. A Bitcoin miner with 400 rigs shouldn't pay Plaid-style fees to track their own mining rewards. Flat subscriptions respect how users actually use the product.*
- "Why not charge developers a flat fee like the Individual tier?"
  - *Because $99/year doesn't cover the infrastructure a fintech with 10k end users generates. Usage-based pricing aligns our cost with their scale. Plaid does it this way for the same reason.*

### Page: /open-source

Single scrollable page. No complex layout.

**1. Hero**
- "Open source is not a marketing strategy. It's the architecture."

**2. Five sections** (each is a card with icon + heading + 3-paragraph body):

**The license: Apache 2.0.**
Why Apache, not MIT: patent grant clause. Why not AGPL: would block the QuickBooks plugin Trojan horse. Why not BSL: undermines the community trust that makes OSS work. [Link to `LICENSE` on GitHub.]

**The moat is not the code.**
Every line of OrangeRails is forkable. Our moat is: (1) signed partnership agreements with banks and wallets, (2) verified-adapter quality, (3) SOC 2/HIPAA compliance paperwork, (4) network effects from the open spec. None of these are code.

**Our revenue model is honest.**
We sell operational leverage, not crippled features. Hosted SaaS gets you multi-tenant orchestration, SSO, audit logs, SLAs, compliance certifications. The same code runs on your server for free.

**The zero-knowledge guarantee.**
We architecturally cannot read your transaction descriptions, counterparties, or categorizations. Split-connector pattern: server processes plaintext amounts (needed for math); client processes encrypted descriptions (the meaning). Audit the code — the guarantee is mechanical, not promissory.

**Contributing.**
Code contributions welcome. Adapter contributions welcome. Security reports to `security@orangerails.com`. GPG key on the repo. Hall of fame for responsible disclosure.

**3. "Audit yourself" section at bottom**
- Code snippet showing how to verify the ZKA guarantee locally:
  ```bash
  # Clone the repo
  git clone https://github.com/orangerails/core
  # Read the split-connector code — start here:
  less src/connectors/sync-engine.ts
  # Verify no plaintext descriptions leave your machine:
  npm run audit:zka
  ```
- Link: "Read the full threat model →" (placeholder)

### OR-01 waitlist polish

Enhance the waitlist form:
- Add optional dropdown: "What are you building?" with options:
  - Personal Bitcoin accounting
  - Small business / merchant
  - Mining operation
  - Bitcoin bank / exchange
  - Accounting firm (clients with BTC)
  - Developer / integrator
  - Other
- Save as `use_case` column in the `waitlist` table.
- After submission, show a post-signup screen with three "What next?" cards:
  - **"Star us on GitHub"** (external link)
  - **"Read the docs"** (links to `/docs`)
  - **"Join the community"** (Discord/Telegram placeholder)

### Supabase migration

```sql
ALTER TABLE waitlist ADD COLUMN use_case TEXT;
```

### Acceptance criteria
- Pricing page renders 4 tiers + FAQ + "why these prices" section
- All ZKA mode rows across tiers are visually emphasized
- /open-source page is scrollable, well-spaced, readable on mobile
- Waitlist form captures use_case and saves it
- Post-signup screen shows 3 next-step cards
- Consistent branding, nav, footer across all 5 pages

---

## WHAT OR-03 PRODUCES
- `/pricing` page with 4 tiers, FAQ, pricing justification
- `/open-source` page with license rationale, moat explanation, ZKA guarantee, contribution path
- Enhanced waitlist form with use_case capture + post-signup flow

---

## AFTER OR-03

Site is live at a Lovable subdomain. Next steps:
1. Point `orangerails.com` DNS at Lovable
2. Add Google Analytics / Plausible
3. Set up Supabase Edge Function to email waitlist signups weekly (via Resend or Postmark)
4. Start the OSS repo scaffold in a separate workstream (Week 1 of the 12-week plan)
5. Begin co-marketing outreach: Lunar Rails, Blink, BTCPay community

When OSS repo is live, replace all `#` placeholders with real GitHub links.
When docs are ready, replace `/docs` card placeholders with MDX pages (separate Lovable session).
