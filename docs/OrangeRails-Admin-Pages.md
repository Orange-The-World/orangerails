# OrangeRails Admin Pages

**Status**: Draft, 2026-05-05 (session 2026-05-05-MESA).
**Audience**: developers building OrangeRails, founder, future contributors.
**Companion docs**: `OrangeRails-Platform-Design.md` (the platform / subaccount model), `OrangeRails-CoAdmins.md` (workspace co-admin grants).

---

## 1. The two pages

This document specifies two new top-level pages.

- **Super admin**, at `/admin`. The page OrangeRails staff log into to run the business. One list of every paying customer, what they pay, what state they are in, with the buttons to change those things.
- **Client portal**, at `/portal`. The page each paying customer logs into to look after their own account. One page that adapts to who is logged in. Three faces, one codebase.

These pages are billing and customer management. They sit alongside `/app` (the existing consumer accounting UI) and the platform integrator API. They do not replace either.

## 2. Three customer types, one client portal

| Type | Sections shown in `/portal` |
|---|---|
| Individual (Self-Host, Personal, Prosumer) | Invoices, payment method, plan, billing history. |
| Team or Business | All of the above, plus a list of teammates and which of them have admin rights. |
| Developer or company embedding OrangeRails | All of the above, plus a control panel: which Bitcoin vendors their end users may connect to, what tier of access they pass to those end users, their platform connection key, and a live usage meter. |

The portal looks at the logged in customer's plan and decides which sections to render. Same code, three faces.

## 3. Super admin surface

Top of the page: four numbers across the top. Total customers. Paying customers. Money collected this month. Money overdue.

Below: one table of every customer. Columns: name, type, plan, status (active / overdue / suspended), join date, balance, action buttons (view, pause, refund, message, change plan).

Click into a customer: full picture on one screen. Every invoice, every payment, every login, every connection their end users own, every change they have made in the portal. Single screen, no clicking around.

## 4. Payment plumbing (Stripe first, Flash later)

The customer sees one invoice with two pay buttons. Today only the card button is live. Later the Bitcoin button lights up.

To make that swap painless, payments live behind a thin internal layer named `payment-provider`. The layer exposes one shape: `payments.charge(invoice)`. Inside, today, only Stripe is wired. When Pay with Flash is ready, a second provider lands inside the same layer and the rest of the app does not change.

**Phase 1 plumbing**: Stripe is the only provider. Cards work end to end. Stripe webhooks tell us when an invoice is paid.

**Future**: Flash becomes a second provider inside the layer. Same shape, different network.

For invoices, BitBooks is the eventual single source of truth, but the build does not block on it. Phase 1 stores invoices in an `invoices` table inside OrangeRails. When BitBooks is ready, a sync job pushes them across and the portal keeps working unchanged.

## 5. Database additions

Five new tables, all small.

| Table | Purpose |
|---|---|
| `customers` | One row per paying entity. Name, type (individual / team / developer), plan, status, contact email. Linked to a Supabase auth user for login. |
| `subscriptions` | What plan a customer is on, when it renews, the Stripe subscription id. |
| `invoices` | One row per bill. Amount, due date, paid date, the Stripe invoice id, link to the customer. |
| `payments` | One row per attempt to pay an invoice. Which rail (stripe today, flash later), success or fail, amount, timestamp. |
| `audit_events` | Every meaningful action, who did it, when. Used by both pages. |

The existing `platforms` table from the Platform Design doc gains a foreign key to `customers`, so a developer customer is linked to the platform they own.

RLS rules:
- `customers`, `subscriptions`, `invoices`, `payments`, `audit_events`: a customer may SELECT only rows where `customer_id` matches their own.
- Staff (a flag on `auth.users`) bypass these via a service role edge function. No RLS escape hatch from the browser.

## 6. Build order, six phases

Each phase ends in something usable. No half built bits sitting unused.

### Phase 1, foundation (about 1 week)
- Database tables in a new migration `YYYYMMDDHHMMSS_admin_pages_schema.sql`.
- A `useRole` hook returning `staff | customer-admin | end-user`.
- Two empty page shells at `/admin` and `/portal` that say "you are signed in as X."
- Seed data: 5 fake customers across the three types, plus 10 fake invoices.

### Phase 2, super admin read only (about 1 week)
- Customer list with the four top-of-page numbers.
- Per customer detail page.
- Read only. No buttons that mutate data. Purely a view.

### Phase 3, client portal read only (about 1 week)
- Portal shell with the three faces wired to the customer type.
- Invoices section (showing fake invoices for now).
- Plan section. Billing history section.
- The two pay buttons are visible but greyed out.

### Phase 4, Stripe wired in (about 1.5 weeks)
- Stripe account connected (test mode first, live mode later).
- Real subscriptions and invoices generated by Stripe, mirrored into our `invoices` table.
- The card pay button works end to end.
- Webhook endpoint at `supabase/functions/stripe-webhook/`. Validates the signature, updates `invoices` and `payments`.
- This is the right moment to migrate from Lovable Supabase to self-hosted Supabase if not done already, so the webhook URL only ever points at one box.

### Phase 5, super admin actions (about 1 week)
- Pause a customer. Issue a refund (calls Stripe). Change a customer's plan. Cancel a subscription. Send a message (email via Resend).
- Every action writes an `audit_events` row with who, what, when.

### Phase 6, developer customer extras (about 1.5 weeks)
- The third face of the portal turns on.
- Platform connection key visible, with a rotate button.
- Vendor allow list (which Bitcoin providers the developer's end users may connect to).
- Tier passthrough setting (what limits the developer extends to its own customers).
- Live usage meter, fed by counting subaccounts and API calls per platform.
- Usage based charges flow into invoices.

**Total**: roughly 7 weeks of focused work for one person, faster with parallel work on the front end and back end.

## 7. What is stubbed in phase 1 vs real

| Thing | Phase 1 | Becomes real in |
|---|---|---|
| Login and roles | Real | Phase 1 |
| Customer list | Seeded fake rows | Phase 4 |
| Invoices | Local table, fake rows | Phase 4 (Stripe), later swappable to BitBooks |
| Card payment | Greyed out | Phase 4 |
| Bitcoin payment | Greyed out | Whenever Flash is ready |
| Refunds, plan changes, suspends | Greyed out | Phase 5 |
| Vendor toggles for developer customers | Greyed out | Phase 6 |

## 8. Self-hosted Supabase migration

The admin pages use only plain Supabase features (Postgres, Auth, Edge Functions, RLS). All of those exist on self-hosted Supabase. The migration is a `pg_dump` and `pg_restore`, plus changing the Supabase URL and anon key in two config files. No code changes.

Recommended cut-over moment: between Phase 3 and Phase 4, before Stripe webhooks are configured. That way the Stripe dashboard only ever holds one webhook URL.

If self-hosted slips past Phase 4, the cut-over still works. The Stripe webhook URL gets updated in the dashboard once during the migration window, about 30 seconds.

## 9. Open questions

These do not block Phase 1.

- Self-serve sign up vs operator-created accounts. Recommendation: self-serve for individuals, operator-created for developer customers (those need a contract).
- Tax. Stripe Tax handles this if turned on. Worth it.
- Email. Use Resend (already in the bb-support stack) for transactional mail.
- BitBooks as customer of OrangeRails. Recommendation: real arms length relationship, not internal-only. Better story, cleaner books.

## 10. Glossary (plain English)

- **Customer**: a person or company that pays OrangeRails. Three kinds, see section 2.
- **Plan**: which pricing tier a customer is on. Listed on the public `/pricing` page.
- **Invoice**: a bill we send to a customer.
- **Subscription**: an agreement that says "this customer pays this plan every month."
- **Webhook**: a small note Stripe sends our server when something happens (a payment cleared, a card failed). The server reads it and updates our records.
- **RLS**: row level security. A rule on the database that decides which rows a logged in person is allowed to see.
- **Edge function**: a small program that runs on Supabase's servers. Used when the browser must not do something itself, for example holding a Stripe secret key.

---

**End of OrangeRails Admin Pages plan, draft 2026-05-05.**
