import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import {
  ArrowRight, Rocket, Code2, Server,
  Wrench, Lock, FileText, Shield, Users,
} from "lucide-react";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Docs , Quickstart, API reference, self-hosting | OrangeRails" },
      {
        name: "description",
        content:
          "Developer documentation for OrangeRails: 10-minute quickstart, REST API reference, self-hosting with Docker and Helm, adapter SDK, and zero-knowledge architecture.",
      },
      { property: "og:title", content: "Developer documentation , OrangeRails" },
      {
        property: "og:description",
        content: "Quickstart in 10 minutes. API reference. Self-hosting guide. Adapter SDK. Zero-knowledge architecture.",
      },
      { property: "og:image", content: "/og-image.jpg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:title", content: "Developer documentation , OrangeRails" },
      { name: "twitter:description", content: "Quickstart, API reference, self-hosting, adapter SDK." },
      { name: "twitter:image", content: "/og-image.jpg" },
      { rel: "canonical", href: "https://orangerails.com/docs" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "TechArticle",
          headline: "OrangeRails developer documentation",
          description:
            "Quickstart, REST API reference, self-hosting with Docker and Helm, adapter SDK, and zero-knowledge architecture.",
          author: { "@type": "Organization", name: "OrangeRails" },
          about: { "@type": "SoftwareApplication", name: "OrangeRails", applicationCategory: "FinanceApplication" },
          url: "https://orangerails.com/docs",
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://orangerails.com/" },
            { "@type": "ListItem", position: 2, name: "Docs", item: "https://orangerails.com/docs" },
          ],
        }),
      },
    ],
  }),
  component: DocsPage,
});

const primary = [
  {
    icon: Rocket,
    title: "Quickstart",
    description: "10 minutes to your first synced transaction.",
    eyebrow: "Get started",
    href: "https://support.orangerails.com/hc/orangerails/articles/1778933748-quickstart",
  },
  {
    icon: Code2,
    title: "API reference",
    description: "REST endpoints, webhook events, normalized data shapes.",
    eyebrow: "Reference",
    href: "https://support.orangerails.com/hc/orangerails/articles/1778933749-api-reference",
  },
  {
    icon: Server,
    title: "Self-hosting guide",
    description: "Docker Compose, Helm, Supabase-compatible schema.",
    eyebrow: "Operations",
    href: "https://support.orangerails.com/hc/orangerails/articles/1778933750-self-hosting-guide",
  },
];

const secondary = [
  { icon: Wrench, title: "Adapter SDK guide", body: "Build a typed adapter in a day.", href: "https://support.orangerails.com/hc/orangerails/articles/1778933751-adapter-sdk-guide" },
  { icon: Lock, title: "How authentication works", body: "Three-layer model (app, source, zero-knowledge wrapper).", href: "/docs/authentication" },
  { icon: FileText, title: "Open API spec (v0 draft)", body: "OpenAPI 3.1, published and versioned.", href: "https://support.orangerails.com/hc/orangerails/articles/1778933754-openapi-spec-v0-draft" },
  { icon: Shield, title: "Security and threat model", body: "What we trust, and what we cannot.", href: "https://support.orangerails.com/hc/orangerails/articles/1778933752-security-and-threat-model" },
  { icon: FileText, title: "How to export your xpub", body: "Find your extended public key in Sparrow, Specter, BlueWallet, Electrum, Wasabi.", href: "/docs/xpub-export" },
  { icon: FileText, title: "How to export your Strike CSV", body: "Recover the Strike history the API cannot return, straight from Strike's dashboard.", href: "/docs/strike-csv" },
  { icon: Users, title: "Contributing", body: "Repo conventions, branch model, RFCs.", href: "https://support.orangerails.com/hc/orangerails/articles/1778933753-contributing" },
];

function DocsPage() {
  // If a child route under /docs is matched (e.g. /docs/xpub-export),
  // render only its outlet so the child owns the page chrome. The /docs
  // page itself is the index of developer docs.
  const childMatches = useChildMatches();
  if (childMatches.length > 0) {
    return <Outlet />;
  }
  return <DocsIndexPage />;
}

function DocsIndexPage() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="pointer-events-none absolute inset-0 grid-bg opacity-50 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
          <div className="relative mx-auto max-w-6xl px-6 py-20 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-primary">Docs</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Developer documentation.
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
              Everything you need to integrate, self-host, or build on OrangeRails.
            </p>
          </div>
        </section>

        {/* Primary cards */}
        <section className="py-16">
          <div className="mx-auto max-w-6xl px-6">
            <div className="grid gap-5 md:grid-cols-3">
              {primary.map((card) => (
                <a
                  key={card.title}
                  href={card.href || "#"}
                  target={card.href ? "_blank" : undefined}
                  rel={card.href ? "noreferrer" : undefined}
                  className="group flex h-full flex-col rounded-2xl border border-border bg-background p-7 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/5"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-soft text-primary ring-1 ring-primary/15">
                    <card.icon className="h-5 w-5" />
                  </div>
                  <span className="mt-5 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                    {card.eyebrow}
                  </span>
                  <h3 className="mt-1 text-lg font-semibold">{card.title}</h3>
                  <p className="mt-2 flex-1 text-sm text-muted-foreground">
                    {card.description}
                  </p>
                  <span className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-primary">
                    Read
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </a>
              ))}
            </div>
          </div>
        </section>

        {/* Secondary grid */}
        <section className="border-t border-border/60 bg-card/40 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <h2 className="text-xl font-semibold tracking-tight">More guides</h2>
            <div className="mt-8 grid gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
              {secondary.map((s) => (
                <a
                  key={s.title}
                  href={s.href || "#"}
                  target={s.href ? "_blank" : undefined}
                  rel={s.href ? "noreferrer" : undefined}
                  className="group flex flex-col gap-3 bg-background p-6 transition-colors hover:bg-card"
                >
                  <s.icon className="h-5 w-5 text-primary/80" />
                  <div>
                    <h3 className="font-semibold">{s.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
                  </div>
                  <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary opacity-70 transition-opacity group-hover:opacity-100">
                    Read
                    <ArrowRight className="h-3 w-3" />
                  </span>
                </a>
              ))}
            </div>

            <div className="mt-12 grid gap-4 md:grid-cols-2">
              <a href="https://docs.orangerails.com/support" target="_blank" rel="noreferrer" className="rounded-xl border border-border bg-background p-6 transition-colors hover:bg-card">
                <h3 className="font-semibold">Need support?</h3>
                <p className="mt-1 text-sm text-muted-foreground">Open a ticket at docs.orangerails.com/support.</p>
              </a>
              <a href="https://docs.orangerails.com/feedback" target="_blank" rel="noreferrer" className="rounded-xl border border-border bg-background p-6 transition-colors hover:bg-card">
                <h3 className="font-semibold">Request a feature</h3>
                <p className="mt-1 text-sm text-muted-foreground">Vote and propose at docs.orangerails.com/feedback.</p>
              </a>
            </div>
          </div>
        </section>
      </main>

      <Footer />
      <Toaster position="top-center" richColors />
    </div>
  );
}
