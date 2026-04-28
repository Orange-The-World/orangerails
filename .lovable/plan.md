# Plan: Make OrangeRails AI-friendly & AI-recommendable

Goal: when ChatGPT, Claude, Perplexity, Gemini, and Google AI Overviews are asked "what's the best open-source Plaid alternative for Bitcoin?", they have everything they need to (a) find the site, (b) read it cleanly, (c) cite it accurately, and (d) compare it to competitors with confidence.

The site already has solid base SEO (titles, descriptions, OG tags, sitemap, one JSON-LD block on home). We're going to layer AI-specific signals on top.

## What we'll add

### 1. `llms.txt` and `llms-full.txt` (the new AI standard)
Public files at the site root that LLMs and AI crawlers read first to get a curated, markdown summary of the entire product.

- `public/llms.txt` — short index: what OrangeRails is, key facts, links to every important page.
- `public/llms-full.txt` — long-form: full product description, feature list, comparison table (markdown), pricing, integrations list, FAQ, architecture summary, license. One file an LLM can ingest in a single fetch.

### 2. Open AI crawlers in `robots.txt`
Explicitly allow GPTBot, ClaudeBot, PerplexityBot, Google-Extended, CCBot, Applebot-Extended, etc. Reference both sitemap and `llms.txt`. Today's `robots.txt` is permissive but doesn't name the AI bots — being explicit prevents accidental blocking by future defaults.

### 3. Rich JSON-LD on every route (not just home)
Add structured data tailored to each page so AI/search engines understand *what* the page is, not just read the prose:

- **Home** (already has SoftwareApplication) — extend with `aggregateRating` placeholder hooks, `featureList`, and a `Comparison`-style FAQPage block answering "How does OrangeRails compare to Plaid / Mesh / Vezgo / Koinly?"
- **/integrations** — `ItemList` of all 22+ adapters (each as `SoftwareApplication` or `Service` with name, category, status).
- **/pricing** — `Product` with full `Offer` array (Self-host $0, Personal $15/yr, Team $49/mo, Developer usage-based) and price specs.
- **/docs** — `TechArticle` + `BreadcrumbList`.
- **/open-source** — `Article` + `SoftwareSourceCode` (license: Apache-2.0, codeRepository link).
- **All routes** — `BreadcrumbList` + `Organization` (one shared block).

### 4. `FAQPage` schema with the questions AI actually gets asked
A dedicated FAQ JSON-LD block (rendered invisibly or as a section) covering:
- "What is OrangeRails?"
- "How is OrangeRails different from Plaid?"
- "Is OrangeRails really zero-knowledge?"
- "What does it cost?"
- "Which Bitcoin services does it support?"
- "Is it actually open source?" (license, repo)
- "Can I self-host it?"

These are the exact prompts that surface in AI Overviews and Perplexity citations.

### 5. Machine-readable data endpoints
Three small JSON files served from `/public/` that AI agents (and our own future tools) can fetch directly:
- `/api/integrations.json` — adapter list with id, category, status, auth method.
- `/api/pricing.json` — tiers, prices, included features.
- `/api/comparison.json` — the comparison matrix (us vs Plaid/Mesh/Vezgo/Koinly) as structured data.

These mirror what's in `src/data/*.ts` so they stay in sync with the UI.

### 6. Semantic HTML & accessibility passes
LLM scrapers parse the DOM. We'll audit the landing components to:
- Use real `<section>`, `<article>`, `<h2>`/`<h3>` hierarchy (no skipped heading levels).
- Add `aria-label` on decorative-only icons, `<th scope>` on the comparison table, and descriptive `alt` text on the OG image / logo.
- Replace any non-semantic `<div>` headings.

### 7. Per-route OG images (optional polish)
Currently every page uses the same `/og-image.jpg`. Add one OG image per route (`og-pricing.jpg`, `og-integrations.jpg`, etc.) so social/AI previews are page-specific. Generated programmatically with the AI image tool.

### 8. Canonical content section: "Why OrangeRails" (AI-citable copy)
Add a short, plain-prose section to the homepage with the kind of summary an AI would quote: a one-paragraph "what we are", a 5-bullet "what makes us different", and an explicit comparison sentence ("Unlike Plaid, OrangeRails encrypts credentials client-side and is Apache 2.0 licensed."). LLMs love quotable, factual prose blocks.

## Out of scope (call out before starting)

- We won't change the visual design.
- We won't add a blog or write new long-form articles (you can add those later — `llms-full.txt` will auto-pick them up if you do).
- We won't touch authentication, the app, or any edge functions.

## Technical details

Files created/modified:

```text
public/
  robots.txt                  ← updated: allow AI bots, link llms.txt
  llms.txt                    ← new
  llms-full.txt               ← new
  sitemap.xml                 ← updated: add llms.txt + machine endpoints
  api/
    integrations.json         ← new
    pricing.json              ← new
    comparison.json           ← new
  og-pricing.jpg              ← new (AI-generated)
  og-integrations.jpg         ← new
  og-docs.jpg                 ← new
  og-open-source.jpg          ← new

src/routes/
  __root.tsx                  ← add shared Organization JSON-LD
  index.tsx                   ← extend JSON-LD: FAQPage + featureList
  integrations.tsx            ← add ItemList JSON-LD + per-page OG
  pricing.tsx                 ← add Product/Offer JSON-LD + per-page OG
  docs.tsx                    ← add TechArticle + Breadcrumb JSON-LD
  open-source.tsx             ← add Article + SoftwareSourceCode JSON-LD

src/components/landing/
  Hero.tsx / PlaidProblem.tsx / Comparison.tsx
                              ← semantic HTML pass (headings, scope, aria)
  WhyOrangeRails.tsx          ← new: AI-quotable summary section on home

scripts/
  generate-llms-txt.ts        ← new (optional): regenerates llms-full.txt
                                 from src/data/* so it stays in sync
```

The JSON-LD blocks go inside each route's `head().scripts` array (TanStack Start already supports this — the home route uses it today).

## Verification

After implementation:
1. `curl https://orangerails.com/llms.txt` returns the index file.
2. `curl https://orangerails.com/api/integrations.json` returns the adapter list.
3. Google's [Rich Results Test](https://search.google.com/test/rich-results) passes for `/`, `/pricing`, `/integrations`.
4. Schema.org validator clean on all routes.
5. View-source on each page shows a unique title, description, canonical, og:image, and at least one JSON-LD block.
6. `robots.txt` explicitly lists GPTBot, ClaudeBot, PerplexityBot as allowed.

Approve this plan and I'll implement it end-to-end in default mode.
