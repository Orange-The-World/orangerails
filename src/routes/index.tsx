import { createFileRoute } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { PlaidProblem } from "@/components/landing/PlaidProblem";
import { Features } from "@/components/landing/Features";
import { Comparison } from "@/components/landing/Comparison";
import { Integrations } from "@/components/landing/Integrations";
import { WhyOrangeRails } from "@/components/landing/WhyOrangeRails";
import { BetaInvite } from "@/components/landing/BetaInvite";
import { XpubExplainer } from "@/components/landing/XpubExplainer";
import { McpTeaser } from "@/components/landing/McpTeaser";
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
      { property: "og:title", content: "OrangeRails, Bitcoin financial rails without the surveillance" },
      {
        property: "og:description",
        content:
          "The aggregator that cannot read your data. 100+ connections. Open source. Value for value. Built for Bitcoin.",
      },
      { property: "og:image", content: "/og-image.jpg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "OrangeRails — open-source, zero-knowledge alternative to Plaid built for Bitcoin" },
      { name: "twitter:title", content: "OrangeRails — Bitcoin financial rails, without the surveillance" },
      { name: "twitter:description", content: "Open-source, zero-knowledge alternative to Plaid. 100+ connections. Apache 2.0." },
      { name: "twitter:image", content: "/og-image.jpg" },
      { rel: "canonical", href: "https://orangerails.com/" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "OrangeRails",
          applicationCategory: "FinanceApplication",
          operatingSystem: "Web, Linux, macOS, Docker",
          description:
            "Open-source, zero-knowledge alternative to Plaid built for Bitcoin. Connect banks, exchanges, wallets, mining pools, and Lightning nodes through one normalized API.",
          url: "https://orangerails.com/",
          license: "https://www.apache.org/licenses/LICENSE-2.0",
          featureList: [
            "Open source (Apache 2.0)",
            "Zero-knowledge architecture (AES-256-GCM, client-side key derivation)",
            "Bitcoin-first: 100+ connections",
            "Self-hostable (Docker, Helm)",
            "Normalized REST API across all adapters",
            "Post-quantum ready (X25519 + ML-KEM-768, ML-DSA-65)",
            "Published open spec",
          ],
          offers: [
            { "@type": "Offer", name: "Self-host", price: "0", priceCurrency: "USD" },
            { "@type": "Offer", name: "Personal", price: "15", priceCurrency: "USD" },
            { "@type": "Offer", name: "Prosumer", price: "99", priceCurrency: "USD" },
            { "@type": "Offer", name: "Team", price: "49", priceCurrency: "USD" },
            { "@type": "Offer", name: "Business", price: "199", priceCurrency: "USD" },
          ],
          publisher: { "@type": "Organization", name: "OrangeRails", url: "https://orangerails.com" },
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: "What is OrangeRails?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "OrangeRails is an open-source, zero-knowledge, Bitcoin-first alternative to Plaid. It connects bank accounts, exchanges, wallets, mining pools, and Lightning nodes through one normalized API, and is designed so the company itself cannot read user data.",
              },
            },
            {
              "@type": "Question",
              name: "How is OrangeRails different from Plaid?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Plaid stores credentials and reads transactions in plaintext on its own servers. OrangeRails encrypts credentials client-side with AES-256-GCM (key derived from the user via Argon2id) and uses a split-connector architecture so transaction details never leave the user's device unencrypted. It is also Apache 2.0 licensed and self-hostable.",
              },
            },
            {
              "@type": "Question",
              name: "How does OrangeRails compare to Mesh Connect, Vezgo, and Koinly?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "OrangeRails is the only option in the category that is simultaneously open source, Bitcoin-first, zero-knowledge, self-hostable, and built around a published open spec. Mesh Connect and Vezgo are closed source aggregators. Koinly is tax only and does not produce real bookkeeping output.",
              },
            },
            {
              "@type": "Question",
              name: "Is OrangeRails really zero-knowledge?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Yes — and the guarantee is mechanical, not promissory. The code is public, encryption keys are derived from user-controlled secrets via Argon2id, and the server only ever sees ciphertext.",
              },
            },
            {
              "@type": "Question",
              name: "What does OrangeRails cost?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Free to self-host. $15/year for individuals (Personal), $99/year (Prosumer), $49/month for teams, $199/month for Business, and usage-based for developers embedding the API. Zero-knowledge mode is included on every tier.",
              },
            },
            {
              "@type": "Question",
              name: "Which Bitcoin services does OrangeRails support?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "100+ connections, including native adapters for Bitcoin Core, BTCPay Server, Blink, xpub, Strike, plus 98 exchanges via the CCXT layer (Coinbase, Kraken, Binance, Bybit, OKX, KuCoin, Gemini, Bitstamp, Bitfinex, Crypto.com, NDAX, Bitbuy, and more). Lightning, mining pools, and banking aggregators are on the roadmap.",
              },
            },
            {
              "@type": "Question",
              name: "Can I self-host OrangeRails?",
              acceptedAnswer: {
                "@type": "Answer",
                text: "Yes. Docker and Helm. Self-hosted instances are fully supported and feature-equivalent to the hosted tier.",
              },
            },
          ],
        }),
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
        <BetaInvite />
        <PlaidProblem />
        <Features />
        <Comparison />
        <WhyOrangeRails />
        <Integrations />
        <XpubExplainer />
        <McpTeaser />
      </main>
      <Footer />
      <Toaster richColors position="top-center" />
    </div>
  );
}
