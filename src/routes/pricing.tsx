import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { PricingCard } from "@/components/pricing/PricingCard";
import { INDIVIDUALS, TEAMS, DEVELOPERS, FAQ, PERSONAS } from "@/data/pricing";
import { Lock } from "lucide-react";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — Free self-host, $15/yr personal, usage-based API | OrangeRails" },
      {
        name: "description",
        content:
          "Free to self-host. $15/yr for individuals. $49/mo for teams. Usage-based for developers. Zero-knowledge mode included on every tier — privacy is never paywalled.",
      },
      { property: "og:title", content: "Pricing — Priced for who you actually are | OrangeRails" },
      {
        property: "og:description",
        content: "Three pricing models for three audiences. Zero-knowledge always included. Same code, same guarantees, every tier.",
      },
      { property: "og:image", content: "/og-image.jpg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:title", content: "Pricing — Priced for who you actually are | OrangeRails" },
      { name: "twitter:description", content: "Free self-host · $15/yr personal · $49/mo team · usage-based API. Zero-knowledge on every tier." },
      { name: "twitter:image", content: "/og-image.jpg" },
      { rel: "canonical", href: "https://orangerails.com/pricing" },
    ],
  }),
  component: PricingPage,
});

type Segment = "individuals" | "teams" | "developers";

const SEGMENTS: { id: Segment; label: string; caption: string; intro?: string }[] = [
  {
    id: "individuals",
    label: "For Individuals",
    caption:
      "Pricing benchmarked against SimpleFIN ($15/yr) and Koinly ($99/yr) — both proven willingness-to-pay anchors for self-sovereign users.",
  },
  {
    id: "teams",
    label: "For Teams & Businesses",
    caption:
      "Team anchors near Xero Growing ($47/mo). Business anchors near QuickBooks Online Advanced ($200/mo). Enterprise is custom because SOC 2/HIPAA paperwork is custom.",
  },
  {
    id: "developers",
    label: "For Developers",
    intro:
      "Building a product that needs Bitcoin data ingestion? These tiers are usage-based, like Plaid. Benchmark: Plaid charges $0.30–$1.00 per connection per month + per-API-call fees. We match the shape — but Bitcoin-first, open-source, and zero-knowledge.",
    caption:
      "BitBooks itself is our first developer-API customer. Clean intra-company pricing — our own product pays us per connected user.",
  },
];

function PricingPage() {
  const [segment, setSegment] = useState<Segment>("individuals");
  const plans = segment === "individuals" ? INDIVIDUALS : segment === "teams" ? TEAMS : DEVELOPERS;
  const meta = SEGMENTS.find((s) => s.id === segment)!;

  return (
    <div id="pricing" className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="pointer-events-none absolute inset-0 grid-bg opacity-50 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
          <div className="relative mx-auto max-w-4xl px-6 py-20 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-primary">Pricing</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Priced for who you actually are.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
              Free to self-host. <span className="text-foreground">$15/year for individuals.</span>{" "}
              Usage-based for developers. Subscription for teams. Every tier includes
              zero-knowledge mode — <span className="text-foreground">we refuse to gate privacy.</span>
            </p>
          </div>
        </section>

        {/* Segmented control + grid */}
        <section className="py-16">
          <div className="mx-auto max-w-6xl px-6">
            <Tabs value={segment} onValueChange={(v) => setSegment(v as Segment)} className="w-full">
              <TabsList className="mx-auto flex h-auto w-full max-w-2xl flex-col gap-1 rounded-xl border border-border bg-card p-1 sm:flex-row">
                {SEGMENTS.map((s) => (
                  <TabsTrigger
                    key={s.id}
                    value={s.id}
                    className="flex-1 rounded-lg px-4 py-2.5 text-sm font-medium data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
                  >
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            {meta.intro && (
              <p className="mx-auto mt-8 max-w-3xl text-center text-sm text-muted-foreground sm:text-base">
                {meta.intro}
              </p>
            )}

            <div className="mt-10 grid gap-5 lg:grid-cols-3">
              {plans.map((p) => (
                <PricingCard key={p.name} plan={p} />
              ))}
            </div>

            <p className="mx-auto mt-8 max-w-3xl text-center text-xs text-muted-foreground sm:text-sm">
              {meta.caption}
            </p>
          </div>
        </section>

        {/* Personas */}
        <section className="border-t border-border/60 bg-card/40 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="max-w-2xl">
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                Who picks what
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
                Still not sure? Here's who picks what.
              </h2>
            </div>
            <div className="mt-10 grid gap-4 md:grid-cols-2">
              {PERSONAS.map((p) => (
                <div
                  key={p.who}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-background p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
                >
                  <p className="font-medium">{p.who}</p>
                  <span className="font-mono text-xs text-primary">{p.plan}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Why three models */}
        <section className="py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="max-w-2xl">
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                Reasoning
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
                Why three pricing models?
              </h2>
            </div>
            <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3">
              {[
                {
                  h: "Individuals → flat annual fee",
                  b: "SimpleFIN and Koinly anchored. No metering anxiety. The same person who runs a Bitcoin Core node doesn't want a usage meter ticking on their personal sats.",
                },
                {
                  h: "Teams → monthly subscription",
                  b: "QuickBooks and Xero anchored. SSO, audit log retention, and SLAs are what teams actually buy — and what they expect to see on a monthly invoice.",
                },
                {
                  h: "Developers → per-use, like Plaid",
                  b: "Pricing scales with their revenue, not ours. A fintech with 10k end users pays in line with the load they create. A weekend project stays free.",
                },
              ].map((c) => (
                <div key={c.h} className="bg-background p-6">
                  <h3 className="font-semibold">{c.h}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{c.b}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Orange callout */}
        <section className="px-6 py-12">
          <div className="mx-auto max-w-5xl rounded-2xl bg-primary p-8 text-primary-foreground sm:p-12">
            <div className="flex items-start gap-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/15">
                <Lock className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl text-balance">
                  Zero-knowledge is not an enterprise feature.
                </h2>
                <p className="mt-3 max-w-3xl text-primary-foreground/90">
                  We refuse to gate privacy behind a paywall. The audience that values open source
                  the most is the same audience that values zero-knowledge the most — splitting
                  them alienates both. ZKA mode runs on the free self-host, the $15/year Personal
                  tier, and the Enterprise contract.{" "}
                  <span className="font-semibold text-primary-foreground">
                    Same code. Same guarantees. Same architecture.
                  </span>
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="py-20">
          <div className="mx-auto max-w-3xl px-6">
            <div className="text-center">
              <p className="text-xs font-medium uppercase tracking-widest text-primary">FAQ</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
                Common questions.
              </h2>
            </div>
            <Accordion type="single" collapsible className="mt-10">
              {FAQ.map((item, i) => (
                <AccordionItem key={i} value={`item-${i}`}>
                  <AccordionTrigger className="text-left text-base font-medium">
                    {item.q}
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground sm:text-base">
                    {item.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>
      </main>

      <Footer />
      <Toaster richColors position="top-center" />
    </div>
  );
}
