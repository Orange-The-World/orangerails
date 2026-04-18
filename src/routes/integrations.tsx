import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { CodeBlock } from "@/components/landing/CodeBlock";
import { AdapterCard } from "@/components/integrations/AdapterCard";
import { RequestAdapterDialog } from "@/components/integrations/RequestAdapterDialog";
import { ADAPTERS, CATEGORIES, type FilterCategory } from "@/data/integrations";
import { ArrowRight } from "lucide-react";

export const Route = createFileRoute("/integrations")({
  head: () => ({
    meta: [
      { title: "Integrations — OrangeRails" },
      {
        name: "description",
        content:
          "Banking, exchanges, wallets, mining pools, Lightning, and files. All normalized into a single API shape.",
      },
      { property: "og:title", content: "Integrations — OrangeRails" },
      {
        property: "og:description",
        content:
          "Every Bitcoin integration, in one place. 22+ adapters and counting.",
      },
    ],
  }),
  component: IntegrationsPage,
});

const SDK_CODE = `import { defineAdapter } from '@orangerails/sdk'

export default defineAdapter({
  id: 'my-bitcoin-provider',
  displayName: 'My Bitcoin Provider',

  async authenticate(credentials) { /* ... */ },

  async listAccounts() { /* ... */ },

  async *syncTransactions(cursor) { /* ... */ },

  normalize(raw) { /* ... */ },
})`;

function IntegrationsPage() {
  const [filter, setFilter] = useState<FilterCategory>("All");

  const filtered = useMemo(() => {
    if (filter === "All") return ADAPTERS;
    return ADAPTERS.filter((a) => a.category === filter);
  }, [filter]);

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        {/* Compact hero */}
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="pointer-events-none absolute inset-0 grid-bg opacity-50 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
          <div className="relative mx-auto max-w-6xl px-6 py-20 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-primary">
              Integrations
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Every Bitcoin integration, in one place.
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
              Banking, exchanges, wallets, mining pools, Lightning, and files. All normalized
              into a single API shape.
            </p>
          </div>
        </section>

        {/* Filters + grid */}
        <section className="py-16">
          <div className="mx-auto max-w-6xl px-6">
            <Tabs
              value={filter}
              onValueChange={(v) => setFilter(v as FilterCategory)}
              className="w-full"
            >
              <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
                {CATEGORIES.map((cat) => (
                  <TabsTrigger
                    key={cat}
                    value={cat}
                    className="rounded-full border border-border bg-background px-4 py-1.5 text-sm data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-none"
                  >
                    {cat}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="mt-4 text-sm text-muted-foreground">
              Showing <span className="font-mono text-foreground">{filtered.length}</span> of{" "}
              <span className="font-mono text-foreground">{ADAPTERS.length}</span> adapters
            </div>

            <div className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filtered.map((adapter) => (
                <AdapterCard key={adapter.id} adapter={adapter} />
              ))}

              {/* Footer card */}
              <div className="flex flex-col items-start justify-between rounded-xl border-2 border-dashed border-border bg-card/40 p-6">
                <div>
                  <h3 className="font-semibold">Don't see your provider?</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Tell us which Bitcoin or banking provider you want to connect — we ship
                    based on demand.
                  </p>
                </div>
                <div className="mt-5">
                  <RequestAdapterDialog />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Build an adapter */}
        <section className="border-t border-border/60 bg-card/40 py-24">
          <div className="mx-auto max-w-6xl px-6">
            <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
              <div>
                <p className="text-xs font-medium uppercase tracking-widest text-primary">
                  Build your own
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
                  Adapter SDK — build one in a day.
                </h2>
                <p className="mt-4 max-w-xl text-muted-foreground">
                  Implement four async methods, ship a typed adapter. The SDK handles auth
                  refresh, pagination, retries, normalization, and zero-knowledge encryption.
                </p>
                <a
                  href="/docs"
                  className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary"
                >
                  Read the SDK docs
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </a>
              </div>
              <div className="lg:pl-4">
                <CodeBlock code={SDK_CODE} />
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
      <Toaster richColors position="top-center" />
    </div>
  );
}
