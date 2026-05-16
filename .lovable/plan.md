# OrangeRails: 102-provider picker, landing refresh, and full migration off the static catalog

This PR ships the widget picker rebuild, the public `/providers` browser, the landing-page overhaul (hero + beta block + xpub explainer placeholder + MCP teaser), the new `/mcp` redirect route, and the complete migration off `src/data/integrations.ts` onto the live `or-providers` edge function. All of it ships together so we never have two sources of truth for the catalog.

Target environment: `dev.orangerails.com` (push to `main` → Cloudflare Pages auto-build). `prod` branch is untouched.

---

## 0. Ground rules applied to every file in this PR

These are non-negotiable and I'll audit them on every change before finishing:

- **No hardcoded provider lists.** The catalog only comes from `or-providers`. The 22-entry `src/data/integrations.ts` is deleted in this PR, not deprecated.
- **Zero-knowledge is structural.** Credential blobs are encrypted client-side via the existing widget crypto helper before any network call. No plaintext credential ever hits `fetch`, `localStorage`, `sessionStorage`, `console.log`, PostHog, Sentry, or React DevTools props. Inputs use `autoComplete="off"`, `data-1p-ignore`, `data-lpignore="true"`, and never echo the value into `aria-label` or `title` attributes.
- **PostHog masking stays on.** The `app=orangerails` tag is already wired; I won't add new event payloads that include credential fields, slugs of just-connected accounts, or anything user-identifying beyond what's already captured.
- **Widget postMessage protocol is load-bearing.** V2, V3, and OW depend on the `INIT` / `READY` / `COMPLETE` shapes in `src/stealth/lib/postmessage.ts`. This PR does not change those shapes, so no `protocol_version` bump is needed. If during implementation I find that the picker rebuild forces a shape change, I'll stop, add a backward-compatible shim, and bump `protocol_version` before continuing — and flag it to you before merging.
- **No em-dashes.** Anywhere. Not in copy, not in code comments that render to users, not in JSDoc that surfaces in hover tooltips. I'll grep the diff for `—` before finishing.
- **No compound-word hyphens in customer-facing copy.** "Customer facing", "self serve", "zero knowledge" (as adjective phrases) stay unhyphenated. Hyphens only survive in code identifiers (`zero-knowledge` as a CSS class is fine) and in URLs.
- **Plain English on user surfaces only.** Banned in customer copy: "rotate", "encrypt", "decrypt", "ciphertext", "API key", "credential", "JWT", "OAuth". Allowed substitutions: "lock", "open the box", "scrambled bytes", "secret token", "sign-in", "permission". Engineering-facing admin pages keep technical terms — I won't downgrade those.
- **Accessibility.** Picker is fully keyboard-navigable (covered in detail in §2). Tier badges have `aria-label` with the plain-English meaning. Credential form fields have visible labels and `aria-describedby` for the eye toggle.

---

## 1. Data layer migration (the foundation everything else sits on)

### 1.1 New: `src/lib/providers.ts`

A single typed module that owns all communication with `or-providers`.

- **Types** — re-declared client-side from the edge function's response (mirrors `ProviderManifest` and `CategoryManifest` from `supabase/functions/_shared/providers/types.ts`):
  ```ts
  type Tier = "t0" | "t1" | "t2" | "t3";
  type ProviderStatus = "live" | "beta" | "coming_soon";
  type CredentialField = { name: string; type: "secret" | "string"; label: string; placeholder?: string };
  type Capabilities = { trades?: boolean; deposits?: boolean; withdrawals?: boolean };
  type ProviderManifest = {
    slug: string; displayName: string; description: string;
    status: ProviderStatus; multiWallet: boolean;
    credentialFields: CredentialField[]; capabilities?: Capabilities;
    tags?: string[]; popularity?: number; categorySlug?: string; logoUrl?: string;
  };
  type CategoryManifest = { slug: string; displayName: string; providerCount: number };
  ```
- **`fetchProviderCatalog()`** — unauthenticated GET to the edge function's URL (resolved from `VITE_SUPABASE_URL` + `/functions/v1/or-providers`). Honors the edge's `cache-control: max-age=300`. Throws on non-2xx with a typed error so loaders can render the right `errorComponent`.
- **`useProviderCatalog()`** — TanStack Query hook, `staleTime: 5 * 60_000`, `gcTime: 30 * 60_000`. Used by the widget picker, `/providers`, `<LiveConnectionCount />`, and any future surface.
- **Helpers**:
  - `getTier(manifest): Tier` — reads `t0|t1|t2|t3` from `manifest.tags`. Fallback rules: self-custody wallets (slug includes `xpub`, `bitcoin-core`, `sparrow`, `ldk`, `phoenix`, `cln`, `lnd`) → T0; CCXT-backed exchanges → T1; aggregator-backed → T2; file imports → T3.
  - `filterProviders(list, { categorySlug, query })` — `query` matches case-insensitively across `displayName`, `description`, and `tags`. Whitespace trimmed, multi-word AND-ed.
  - `sortByPopularity(list)` — DESC, stable secondary sort by `displayName` ASC for deterministic order when popularity ties (which it will, often).
  - `countLive(list)` — used by the hero counter.

### 1.2 Delete: `src/data/integrations.ts`

Audit pass first — `rg "from \"@/data/integrations\""` to find every importer. Today that includes at minimum `src/components/landing/Integrations.tsx` and `src/routes/integrations.tsx`. Each importer is migrated to `useProviderCatalog()` in the same commit. I'll grep again at the end to confirm zero references remain before deleting the file. The file is removed via `rm`, not left as a stub.

### 1.3 Existing `/integrations` route

This route currently renders the static list. Since the new `/providers` page is the canonical browsable catalog, I'll redirect `/integrations` → `/providers` via `beforeLoad` in `src/routes/integrations.tsx` (preserves any inbound links, including the SEO ones from `public/sitemap.xml` and the JSON-LD on the home route). I'll also update `public/sitemap.xml` and the structured-data `featureList` on `src/routes/index.tsx` to mention 102 adapters instead of 22+.

---

## 2. Picker that scales past 100 providers

### 2.1 Component: `src/components/ProviderPicker.tsx`

Single component used in two modes:
- `mode="connect"` — inside the widget, with credential form on selection.
- `mode="browse"` — on `/providers`, read-only, no connect button, no credential form.

**Three-pane layout** (responsive — stacks vertically below `md`):

```text
┌──────────────┬──────────────────────────────────┬──────────────────┐
│ Categories   │  [ / search providers …      ]   │  Preview pane    │
│              │                                   │                  │
│ All     102  │  ┌──────┐ ┌──────┐ ┌──────┐      │  Logo + name     │
│ Lightning 8  │  │ tile │ │ tile │ │ tile │      │  Tier badge      │
│ On-chain  6  │  └──────┘ └──────┘ └──────┘      │  One-line desc   │
│ Exchanges 84 │  …                                │  Capabilities    │
│ Cards     1  │                                   │  (Trades ✓ etc)  │
│ Mining    3  │                                   │                  │
│ Banks     0  │                                   │  [Connect] (only │
│ Lenders   0  │                                   │   in connect    │
│              │                                   │   mode)          │
└──────────────┴──────────────────────────────────┴──────────────────┘
```

- **Left sidebar** — categories from `listCategoryManifests()`. "All" pinned to top. Each row shows name + a small pill with `providerCount`. Empty categories (count 0) render greyed out and aren't selectable. Active category has the primary accent.
- **Center** — search box at top (placeholder: "Search 102 connections"), then a CSS grid of tiles (`grid-cols-2 lg:grid-cols-3`, no virtualization — 102 tiles renders fine without it). Sort: `popularity` DESC. Each tile shows logo (via `<ProviderLogo />`), display name, one-line description (line-clamp-2), and `<PrivacyTierBadge tier={…} />` in the corner. Coming-soon tiles render at reduced opacity and aren't selectable but ARE focusable (so screen-reader users learn they exist).
- **Right preview pane** — appears on hover (desktop) or on tap-to-select (mobile/touch). Shows: large logo, display name, full description, tier badge with full tooltip text expanded inline, capabilities checklist (Trades / Deposits / Withdrawals from `manifest.capabilities`), and in `connect` mode a "Connect" button that opens the credential form step.

### 2.2 Keyboard navigation (full spec)

- `/` from anywhere inside the picker focuses the search input. If focus is already in an input, `/` types a slash normally.
- Arrow keys move tile selection in the grid (Left/Right within row, Up/Down across rows). Wraps at edges.
- `Enter` on a focused tile selects it (opens preview pane on desktop, advances to credential step in connect mode on mobile).
- `Escape` clears the search query if the search box is focused, otherwise closes the preview pane.
- Tab order: search → category sidebar → grid → preview pane → connect button. Focus rings are visible (not the suppressed shadcn default — I'll confirm `:focus-visible` styles render).
- `aria-live="polite"` on a hidden status region announces "Showing 84 of 102 connections" after each filter change so screen-reader users get feedback.

### 2.3 Component: `src/components/ProviderLogo.tsx`

- Renders `<img src={manifest.logoUrl} alt="" />` with `loading="lazy"`.
- On `onError` or when `logoUrl` is missing, falls back to a coloured circle showing the first 2 letters of `displayName`. Background colour derived from a deterministic hash of the slug (so Kraken always gets the same colour). Foreground is white at AA contrast against the chosen background.
- `aria-hidden="true"` on the fallback (the tile already announces the provider name).

### 2.4 Widget refactor

- `src/connect/components/...` (current bespoke per-provider tiles) is replaced by `<ProviderPicker mode="connect" onSelect={…} />`.
- The route `/connect` mounts the widget shell, reads URL params (`?protocol_version=…&app=…`) the same way it does today, and renders `<ProviderPicker>` as the first step.
- On `onSelect(slug)`, the widget transitions to step 2: `<CredentialForm manifest={selected} onSubmit={…} onBack={…} />`.
- All existing `postMessage` emissions (`READY` on mount, `COMPLETE` on successful connect, `CANCEL` on close) remain identical in shape and timing.
- I'll diff `src/stealth/lib/postmessage.ts` before and after to confirm zero changes.

---

## 3. Privacy tier badge

### 3.1 Component: `src/components/PrivacyTierBadge.tsx`

- Props: `{ tier: "t0" | "t1" | "t2" | "t3"; size?: "sm" | "md" }`.
- Variants:
  - **T0 — green** — "Just you" — tooltip: "Your secrets stay on your device. Nothing in the middle."
  - **T1 — blue** — "You and the wallet" — tooltip: "You and the wallet provider. Nobody else in between."
  - **T2 — amber** — "Powered by an aggregator" — tooltip: "A third party helps connect. They see what you connect, not your money."
  - **T3 — grey** — "Manual upload" — tooltip: "You drop in a file. Nothing connects automatically."
- Shadcn `Tooltip`. Tooltip text is also exposed via `aria-label` for keyboard/screen-reader users without hover.
- Uses CSS variables from `src/styles.css` (defines four new tokens: `--tier-t0`, `--tier-t1`, `--tier-t2`, `--tier-t3` in `oklch`) so the colours stay consistent with the design system and respect dark mode.
- Used in: picker tile (size `sm`, corner-positioned), preview pane (size `md`, with full label visible), and credential form consent header (size `md`, with tooltip text expanded inline as a sentence).

---

## 4. Generic credential form

### 4.1 Component: `src/components/CredentialForm.tsx`

- Props: `{ manifest: ProviderManifest; onSubmit: (encryptedBlob: Uint8Array) => Promise<void>; onBack: () => void }`.
- Renders one input per `manifest.credentialFields` entry:
  - `type: "string"` → `<Input type="text">`.
  - `type: "secret"` → `<Input type="password">` with show/hide eye toggle (right-aligned button, `aria-label="Show secret token" / "Hide secret token"`, never reveals value to screen readers when hidden).
- Paste handler on every field: silently `String(value).trim()` to strip surrounding whitespace. Common UX bug — users paste API keys with trailing newlines from terminal copy.
- Submit flow:
  1. Build `{ [fieldName]: trimmedValue, ... }` object in memory.
  2. Encrypt via the existing widget crypto helper (see Open Question 4 — will confirm exact module path on first read; based on the file tree it's likely `src/lib/crypto-fields.ts` and/or `src/lib/vault.ts`, with key material from `src/context/VaultContext.tsx`).
  3. Zero out the plaintext object reference (best-effort — JS doesn't guarantee it, but we don't keep references).
  4. POST encrypted blob to `or-connection-create`.
  5. On success, call `onSubmit` (parent emits `COMPLETE` postMessage and closes widget).
- **Hard rules I'll enforce**:
  - No `console.log` in this file at all.
  - No PostHog `capture()` with field values (only event names like `credential_form_submitted`, `credential_form_failed` with `{ provider_slug }`).
  - Form never serializes to URL, never persists draft state to `localStorage` or `sessionStorage`.
  - React DevTools props for the form component never include the value (managed via `useRef` for secret fields, not `useState`, so they don't show up in the props inspector).
- Error states: per-field validation errors (e.g. "Secret token can't be empty") render inline with `aria-describedby`. Network errors render at the form footer with a "Try again" button that resubmits without clearing fields.
- "Back" button returns to picker without clearing fields if the user re-selects the same provider in the same session (held in component-local ref; cleared on widget close).

---

## 5. Landing-page hero refresh

### 5.1 Component: `src/components/LiveConnectionCount.tsx`

- Renders the string "100+" immediately on mount (synchronously, no skeleton, no spinner — that's the fallback).
- Kicks off a `fetchProviderCatalog()` call on mount.
- If the response resolves within 200 ms, swaps in the live count of `status === "live"` providers (formatted as `${n}+` if `n >= 100`, else `${n}`).
- If it takes longer than 200 ms, the fallback string stays — we don't want layout shift after the user has already started reading. (Implementation: `setTimeout(() => setShowLive(false), 200)` race against the fetch; only updates state if both the fetch resolved AND the deadline hasn't passed.)
- If the fetch fails, fallback stays. No error UI.
- The number is wrapped in a `<span>` with `aria-live="off"` so screen readers don't get a flash of "one hundred plus" and then "one hundred two".

### 5.2 Hero copy and layout in `src/routes/index.tsx`

Replace the current `<Hero />` content. New copy, exact wording:

> **The first zero knowledge connector with an MCP layer.**
> `<LiveConnectionCount />` connections. Open source. Value for value.

(Note: "zero knowledge" without hyphen per the copy rule. The "100+" string comes from the live counter component — fallback, not hardcoded duplicated text.)

Three CTA chips below, in order:
1. **Connect a wallet** → `/connect` — primary button styling.
2. **Read the docs** → `https://docs.orangerails.com` — `target="_blank" rel="noreferrer"`, link-style (text + arrow, no button background).
3. **Self-host** → `https://github.com/MorningRevolution/orangerails#quickstart` — `target="_blank" rel="noreferrer"`, link-style.

The existing `<Terminal />` visual on the right of the current hero stays — it's a strong asset. I'll keep the two-column layout and only change the left-column text and CTAs. If on review you'd rather drop the Terminal, that's a one-line change.

---

## 6. New `/providers` page

### 6.1 File: `src/routes/providers.tsx`

- TanStack route, public, no auth.
- `loader: ({ context }) => context.queryClient.ensureQueryData(providerCatalogQueryOptions())` — primes the cache so SSR / initial render has data.
- Component renders `<ProviderPicker mode="browse" />` full-width inside the existing landing-page chrome (Navbar + Footer).
- `head()` metadata:
  - `<title>` — "All 102 connections supported by OrangeRails"
  - `<meta name="description">` — "Browse every wallet, exchange, payment processor, mining pool, and bank that connects through OrangeRails. Open source, zero knowledge, value for value."
  - `og:title`, `og:description`, `twitter:title`, `twitter:description` — same text, slight variation for social.
  - No `og:image` until a dedicated share image exists (per the route-architecture rule: omit rather than inherit a generic).
- `errorComponent` and `notFoundComponent` defined per the strict-build rule.
- Linked from: hero CTA chip area is already crowded, so I'll add a small "or browse all 102 connections →" text link directly under the three CTA chips. Also linked from the footer under a new "Product" column.

---

## 7. Beta invite block

### 7.1 Section in `src/routes/index.tsx`, immediately below hero

Exact copy:

> **In beta. Inviting people to join.**
> Value for value. The connector itself is free and open source. Encrypted backup, recovery, AI access, and accountant flow are the paid add-ons.
> [**Join the beta →**]

Wait — "Encrypted backup" violates the plain-English rule on customer copy. I'll change it to:

> Locked backup, recovery, AI access, and accountant flow are the paid add-ons.

Flagging this explicitly so you can override if you'd rather keep "Encrypted" for clarity (it IS more recognizable to a Bitcoin-savvy audience, and this block is below the hero where the user has already opted in to reading more). I'll default to "Locked" per the rule unless you say otherwise in the review.

CTA target: `/signup?ref=beta-landing`. Maps cleanly to the existing `src/routes/signup.tsx`. The signup form already exists; I'll just confirm it reads `ref` from search params and stores it on the user record (or fires a PostHog event with `{ ref }`) so attribution works. If `signup.tsx` doesn't currently handle `ref`, I'll add a 2-line change to capture it.

The dashboard chrome should label beta state clearly. I'll add a small "Beta" pill in the app's existing top nav (`src/routes/app.tsx` or wherever the authenticated layout lives) — visible only when the user signed up via `?ref=beta-landing` (read from a flag on their profile or a localStorage marker set at signup).

### 7.2 Replace the existing `<WaitlistCta />`

Today the landing page has both `<WaitlistCta />` and the in-hero "Join the Waitlist" button. Both are replaced by the beta block. I'll delete `src/components/landing/WaitlistCta.tsx` if no other route imports it (`rg` first to confirm).

---

## 8. Visual explainer placeholder for "How an xpub stays private"

### 8.1 Section below the providers preview on `src/routes/index.tsx`

Layout reserved as a 16:9 area inside the page width, with title and teaser text below it.

Exact copy:
> **How an xpub stays private**
> Your wallet's public key never leaves your browser. Watch the 30 second walkthrough →

(Note: "30 second" without hyphen per the copy rule.)

For this PR:
- Static placeholder image at `/public/og/xpub-explainer-placeholder.svg`. I'll generate a neutral schematic (browser → encrypted blob → server, with the xpub never crossing the boundary) at the right aspect ratio so the layout doesn't shift when the real animation drops in.
- Alt text: "Diagram showing your wallet's public key staying inside your browser while only scrambled bytes reach the OrangeRails server."
- The teaser link is **inert** for this PR (no `href`, rendered as `<span>` styled like a link with `aria-disabled="true"`). I'll add a TODO comment pointing to the future `/explain/xpub` route or external video URL.

If you want me to wire it to a real Figma frame URL or a temp Loom link instead, send the URL in the review and I'll swap the inert link for a real one in a follow-up.

---

## 9. MCP teaser block + redirect route

### 9.1 Section below the xpub explainer on `src/routes/index.tsx`

Exact copy:
> **First aggregator with an MCP layer.**
> Connect any wallet, exchange, or bank to ChatGPT, Claude, or Gemini with explicit per tool scopes. Read only by default. Write tools require user confirmation. Full audit log.
> [**Learn more →**]

(Note: "per tool", "Read only", "Write tools" — no hyphens per the copy rule. "MCP" and "ChatGPT", "Claude", "Gemini" are product names and stay as-is.)

CTA target: `/mcp`.

### 9.2 File: `src/routes/mcp.tsx`

- Pure redirect route, no UI.
- `beforeLoad: () => { throw redirect({ href: "https://docs.orangerails.com/mcp" }) }`.
- Standalone styled `/mcp` page lands in Sprint 3 — out of scope here.

---

## 10. Existing landing sections — what stays, what goes

Current `src/routes/index.tsx` renders, in order: `Navbar`, `Hero`, `PlaidProblem`, `Features`, `Comparison`, `WhyOrangeRails`, `Integrations`, `WaitlistCta`, `Footer`.

New order:
1. `Navbar` (unchanged)
2. `Hero` (overhauled per §5)
3. **NEW: Beta invite block** (§7)
4. `PlaidProblem` (kept — strong narrative anchor)
5. `Features` (kept)
6. `Comparison` (kept — but I'll update the "Adapters" row to read "102+" instead of "22+")
7. `WhyOrangeRails` (kept)
8. `Integrations` (refactored to read from `useProviderCatalog()`, shows top ~12 by popularity with a "browse all 102 →" link to `/providers`)
9. **NEW: xpub explainer placeholder** (§8)
10. **NEW: MCP teaser** (§9)
11. ~~`WaitlistCta`~~ (deleted, replaced by beta block at top)
12. `Footer` (add "Browse providers" link to a new "Product" column)

I'll update the JSON-LD `featureList` in `src/routes/index.tsx` (currently mentions "22+ adapters") to "102+ adapters" so SEO matches the new number.

---

## 11. Files touched

**New**:
- `src/lib/providers.ts`
- `src/components/PrivacyTierBadge.tsx`
- `src/components/ProviderLogo.tsx`
- `src/components/CredentialForm.tsx`
- `src/components/ProviderPicker.tsx`
- `src/components/LiveConnectionCount.tsx`
- `src/routes/providers.tsx`
- `src/routes/mcp.tsx`
- `public/og/xpub-explainer-placeholder.svg`

**Overhauled**:
- `src/routes/index.tsx` (hero + new sections + section reorder + JSON-LD update)
- `src/routes/integrations.tsx` (becomes a redirect to `/providers`)
- `src/components/landing/Integrations.tsx` (reads from `useProviderCatalog()`, "browse all" link)
- `src/components/landing/Hero.tsx` (or replace with inline JSX in `index.tsx` if cleaner)
- `src/components/landing/Comparison.tsx` (the "22+" → "102+" cell)
- `src/components/landing/Footer.tsx` (new Product column with /providers link)
- `src/connect/...` (widget step 1 swapped for `<ProviderPicker mode="connect">`, step 2 for `<CredentialForm>`)
- `src/routes/signup.tsx` (capture `?ref=beta-landing` if not already)
- `src/styles.css` (four new `--tier-t0`..`--tier-t3` tokens)
- `public/sitemap.xml` (add `/providers` and `/mcp`, drop `/integrations` or leave as redirect target)

**Deleted**:
- `src/data/integrations.ts`
- `src/components/landing/WaitlistCta.tsx` (after grep confirms no other importers)

---

## 12. Verification before I claim done

- `rg "from \"@/data/integrations\""` → must return zero matches before I delete the file.
- `rg "—"` across `src/` and `public/` → must return zero matches in user-facing strings (will manually skim hits in `.gen.ts` / `node_modules` style false positives).
- `rg -i "api key|encrypt|decrypt|ciphertext|rotate"` across user-facing copy in `src/routes/index.tsx`, `src/routes/providers.tsx`, `src/components/landing/**`, `src/components/PrivacyTierBadge.tsx`, `src/components/CredentialForm.tsx` (this one's tricky — the form labels come from the manifest, so any "api key" in a label is server-controlled; I'll note that as a follow-up to fix in the manifests, not in this PR).
- `diff` `src/stealth/lib/postmessage.ts` before/after → must show zero changes.
- Open the widget at `/connect` in the preview and walk through: pick a category, search for "kraken", select it, see preview, click connect, fill credentials, submit. Confirm no plaintext credential in Network tab payloads (request body is the encrypted blob).
- Open `/providers` and confirm full catalog renders, search works, keyboard nav works (tab through, slash to focus search, arrows to move, enter to preview).
- Open `/` and confirm hero counter renders "100+" instantly, swaps to live count if fetch is fast.
- Confirm `/mcp` 302s to `docs.orangerails.com/mcp`.
- Confirm `/integrations` 302s to `/providers`.
- Run the build (it runs automatically in the harness); zero TS errors.

---

## 13. Open questions before I start coding

These are the only places where I genuinely need your input rather than just a confirmation. I can default to my proposed answer on each, but flagging them so you can override:

1. **`?ref=beta-landing` on signup** — does `src/routes/signup.tsx` already capture this, or should I add the 2-line change to read it from search params and forward it as a PostHog event + a `signup_ref` column on the profile? My default: add it.
2. **Beta block copy** — keep "Encrypted backup" for clarity to a Bitcoin audience, or follow the plain-English rule strictly and use "Locked backup"? My default: "Locked backup" per the rule.
3. **xpub explainer placeholder** — do you have a Figma frame URL or temp illustration to drop in, or should I generate a neutral SVG schematic? My default: generate a neutral SVG placeholder so the layout is reserved correctly.
4. **Widget crypto helper path** — the brief references `src/lib/widget-crypto.ts`, but that file isn't in the current tree. I see `src/lib/crypto-fields.ts`, `src/lib/vault.ts`, `src/lib/key-derivation.ts`, `src/lib/key-wrapping.ts`, and `src/context/VaultContext.tsx`. Is the widget supposed to use `crypto-fields.ts` (which looks like the field-level encryption helper), or does `widget-crypto.ts` need to be created in this PR as a thin wrapper around those primitives? My default: create `src/lib/widget-crypto.ts` as a thin facade over the existing primitives, so the brief's import path works and future widget surfaces have one canonical entry point.
5. **`<Terminal />` in the hero** — the current hero has a strong terminal animation on the right. Keep it next to the new copy, or drop it for a cleaner hero? My default: keep it.
6. **Widget consumers and `protocol_version`** — confirming you do NOT want a `protocol_version` bump in this PR (since message shapes don't change). If you want a bump anyway as a "we shipped a major picker rework" signal to V2/V3/OW, say so and I'll wire it with a backward-compat shim.

If you want me to just pick my defaults and start, say "use defaults" and I'll proceed without waiting for answers.
