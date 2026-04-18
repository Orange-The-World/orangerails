import { createFileRoute } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { PlaidProblem } from "@/components/landing/PlaidProblem";
import { Features } from "@/components/landing/Features";
import { Comparison } from "@/components/landing/Comparison";
import { Integrations } from "@/components/landing/Integrations";
import { WaitlistCta } from "@/components/landing/WaitlistCta";
import { Footer } from "@/components/landing/Footer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "OrangeRails — Open-source Bitcoin financial rails" },
      {
        name: "description",
        content:
          "The open-source, zero-knowledge alternative to Plaid, built for Bitcoin. Self-hostable. Apache 2.0.",
      },
      { property: "og:title", content: "OrangeRails — Open-source Bitcoin financial rails" },
      {
        property: "og:description",
        content:
          "The alternative to Plaid that can't read your data — because it can't. Open source. Zero knowledge. Built for Bitcoin.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />
      <main>
        <Hero />
        <PlaidProblem />
        <Features />
        <Comparison />
        <Integrations />
        <WaitlistCta />
      </main>
      <Footer />
      <Toaster richColors position="top-center" />
    </div>
  );
}
