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
      { title: "OrangeRails — Open-source, zero-knowledge alternative to Plaid for Bitcoin" },
      {
        name: "description",
        content:
          "Connect bank accounts, exchanges, wallets, mining pools, and Lightning nodes through one normalized API. Open source, zero-knowledge, self-hostable. Apache 2.0.",
      },
      { property: "og:title", content: "OrangeRails — Bitcoin financial rails, without the surveillance" },
      {
        property: "og:description",
        content:
          "The alternative to Plaid that can't read your data — because it can't. 22+ adapters. Open source. Zero knowledge. Built for Bitcoin.",
      },
      { property: "og:image", content: "/og-image.jpg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "OrangeRails — open-source, zero-knowledge alternative to Plaid built for Bitcoin" },
      { name: "twitter:title", content: "OrangeRails — Bitcoin financial rails, without the surveillance" },
      { name: "twitter:description", content: "Open-source, zero-knowledge alternative to Plaid. 22+ adapters. Apache 2.0." },
      { name: "twitter:image", content: "/og-image.jpg" },
      { rel: "canonical", href: "https://orangerails.com/" },
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
