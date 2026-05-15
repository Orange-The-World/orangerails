import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { ProviderPicker } from "@/components/ProviderPicker";
import {
  fetchProviderCatalog,
  type ProviderCatalog,
} from "@/lib/providers";
import { ArrowRight } from "lucide-react";

export const Route = createFileRoute("/providers")({
  head: () => ({
    meta: [
      { title: "All connections supported by OrangeRails" },
      {
        name: "description",
        content:
          "Browse every wallet, exchange, payment processor, mining pool, and bank that connects through OrangeRails. Open source, zero knowledge, value for value.",
      },
      {
        property: "og:title",
        content: "Every Bitcoin connection in one catalog — OrangeRails",
      },
      {
        property: "og:description",
        content:
          "Wallets, exchanges, payment processors, mining pools, and banks. One open catalog you can self host.",
      },
      {
        name: "twitter:title",
        content: "Every Bitcoin connection in one catalog — OrangeRails",
      },
      {
        name: "twitter:description",
        content:
          "Wallets, exchanges, payment processors, mining pools, and banks. One open catalog you can self host.",
      },
      { rel: "canonical", href: "https://orangerails.com/providers" },
    ],
  }),
  component: ProvidersPage,
  errorComponent: ProvidersError,
  notFoundComponent: () => (
    <div className="p-12 text-center text-muted-foreground">Page not found.</div>
  ),
});

function ProvidersPage() {
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchProviderCatalog()
      .then((c) => {
        if (active) setCatalog(c);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Could not load connections.");
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="pointer-events-none absolute inset-0 grid-bg opacity-50 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
          <div className="relative mx-auto max-w-6xl px-6 py-16 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-primary">
              Connections
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Every connection, in one catalog.
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
              Wallets, exchanges, payment processors, mining pools, and banks. Sourced live from
              the open catalog. Self host or use ours.
            </p>
            <div className="mt-6">
              <Link
                to="/connect"
                className="group inline-flex items-center gap-1.5 text-sm font-medium text-primary"
              >
                Open the connect widget
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </div>
          </div>
        </section>

        <section className="py-12">
          <div className="mx-auto max-w-6xl px-6">
            {error && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                {error}
              </div>
            )}
            {!catalog && !error && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 9 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-24 animate-pulse rounded-lg border border-border bg-card/40"
                  />
                ))}
              </div>
            )}
            {catalog && <ProviderPicker catalog={catalog} mode="browse" />}
          </div>
        </section>
      </main>

      <Footer />
      <Toaster richColors position="top-center" />
    </div>
  );
}

function ProvidersError({ error }: { error: Error }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold">Could not load connections</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
      </div>
    </div>
  );
}
