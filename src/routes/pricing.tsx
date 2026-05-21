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
      { title: "Pricing — Free self host, $15/yr personal, usage based API | OrangeRails" },
      {
        name: "description",
        content:
          "Free to self host. $15/yr for individuals. $49/mo for teams. Usage based for developers. Zero knowledge architecture by design included on every tier. Privacy is never paywalled.",
      },
      { property: "og:title", content: "Pricing — Priced for who you actually are | OrangeRails" },
      {
        property: "og:description",
        content:
          "Three pricing models for three audiences. Zero knowledge architecture always included. Same code, same guarantees, every tier.",
      },
      { property: "og:image", content: "/og-image.jpg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:title", content: "Pricing — Priced for who you actually are | OrangeRails" },
      {
        name: "twitter:description",
        content:
          "Free self host · $15/yr personal · $49/mo team · usage based API. Zero knowledge architecture on every tier.",
      },
      { name: "twitter:image", content: "/og-image.jpg" },
      { rel: "canonical", href: "https://orangerails.com/pricing" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Product",
          name: "OrangeRails",
          description:
            "Open source data aggregator for fiat and bitcoin accounts. Three pricing models with zero knowledge architecture included on every tier.",
          brand: { "@type": "Brand", name: "OrangeRails" },
          offers: {
            "@type": "AggregateOffer",
            priceCurrency: "USD",
            lowPrice: "0",
            highPrice: "199",
            offerCount: 6,
            offers: [
              { "@type": "Offer", name: "Self-Host", price: "0", priceCurrency: "USD", description: "Free forever. Unlimited connections. You run the server." },
              { "@type": "Offer", name: "Personal", price: "15", priceCurrency: "USD", description: "$15/year. Up to 5 connections. Hosted." },
              { "@type": "Offer", name: "Prosumer", price: "99", priceCurrency: "USD", description: "$99/year. Unlimited connections, hourly sync, real time webhooks." },
              { "@type": "Offer", name: "Team", price: "49", priceCurrency: "USD", description: "$49/month. Up to 25 connections, 5 seats, audit log." },
              { "@type": "Offer", name: "Business", price: "199", priceCurrency: "USD", description: "$199/month. Unlimited connections + seats, SSO, 99.9% SLA." },
              { "@type": "Offer", name: "API", description: "Usage based pricing for developers embedding the API." },
            ],
          },
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://orangerails.com/" },
            { "@type": "ListItem", position: 2, name: "Pricing", item: "https://orangerails.com/pricing" },
          ],
        }),
      },
    ],
  }),
  component: PricingPage,
});

type Segment = "individuals" | "teams" | "developers";

const SEGMENTS: { id: Segment; label: string; intro?: string }[] = [
  {
    id: "individuals",
    label: "For Individuals",
  },
  {
    id: "teams",
    label: "For Teams & Businesses",
  },
  {
    id: "developers",
    label: "For Developers",
    intro:
      "Building a product that needs Bitcoin data ingestion? These tiers are usage based. Pricing scales with your end user load, not with our cost.",
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
              Free to self host. <span className="text-foreground">$15/year for individuals.</span>{" "}
              Usage based for developers. Subscription for teams. Every tier includes{" "}
              <span className="text-foreground">zero knowledge architecture by design</span>. We
              refuse to gate privacy.
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
          </div>
        </section>

        {/* Popular use cases */}
        <section className="border-t border-border/60 bg-card/40 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <div className="max-w-2xl">
              <p className="text-xs font-medium uppercase tracking-widest text-primary">
                Popular use cases
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
                Who picks what.
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
                  b: "No metering anxiety. The same person who runs a Bitcoin Core node does not want a usage meter ticking on their personal sats.",
                },
                {
                  h: "Teams → monthly subscription",
                  b: "SSO, audit log retention, and SLAs are what teams actually buy. They expect to see those on a monthly invoice.",
                },
                {
                  h: "Developers → per use",
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
                  Zero knowledge architecture is not an enterprise feature.
                </h2>
                <p className="mt-3 max-w-3xl text-primary-foreground/90">
                  Your customers hold the key. Our server holds an envelope it cannot open.
                  We cannot read their data even if compelled to. Same code runs on the
                  free self host, the $15/year Personal tier, and the Enterprise contract.{" "}
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
