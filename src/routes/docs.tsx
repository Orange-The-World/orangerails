import { createFileRoute, Link } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import {
  ArrowRight, Rocket, Code2, Server,
  Wrench, Lock, FileText, Shield, GitCompare, Users,
} from "lucide-react";

export const Route = createFileRoute("/docs")({
  head: () => ({
    meta: [
      { title: "Documentation — OrangeRails" },
      {
        name: "description",
        content:
          "Everything you need to integrate, self-host, or build on OrangeRails.",
      },
      { property: "og:title", content: "Documentation — OrangeRails" },
      {
        property: "og:description",
        content: "Quickstart, API reference, self-hosting guide, and more.",
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
  },
  {
    icon: Code2,
    title: "API reference",
    description: "REST endpoints, webhook events, normalized data shapes.",
    eyebrow: "Reference",
  },
  {
    icon: Server,
    title: "Self-hosting guide",
    description: "Docker Compose, Helm, Supabase-compatible schema.",
    eyebrow: "Operations",
  },
];

const secondary = [
  { icon: Wrench, title: "Adapter SDK guide", body: "Build a typed adapter in a day." },
  { icon: Lock, title: "Zero-knowledge architecture", body: "How split-connector encryption works." },
  { icon: FileText, title: "Open API spec (v0 draft)", body: "OpenAPI 3.1 — published & versioned." },
  { icon: Shield, title: "Security & threat model", body: "What we trust, and what we don't." },
  { icon: GitCompare, title: "Migration from Plaid/Mesh/Vezgo", body: "Endpoint-by-endpoint mapping." },
  { icon: Users, title: "Contributing & community", body: "Discord, RFCs, code of conduct." },
];

function DocsPage() {
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
                  href="#"
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
                  href="#"
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

            <div className="mt-12 rounded-xl border border-border bg-background p-6 text-center">
              <p className="text-sm text-muted-foreground">
                Looking for the full API?{" "}
                <Link to="/integrations" className="font-medium text-primary">
                  Browse the integrations catalog
                </Link>{" "}
                or join the waitlist for hosted access.
              </p>
            </div>
          </div>
        </section>
      </main>

      <Footer />
      <Toaster position="top-center" richColors />
    </div>
  );
}
