import { createFileRoute } from "@tanstack/react-router";
import { Toaster } from "@/components/ui/sonner";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { CodeBlock } from "@/components/landing/CodeBlock";
import { ArrowRight, Scale, Network, HandCoins, Lock, GitPullRequest } from "lucide-react";

export const Route = createFileRoute("/open-source")({
  head: () => ({
    meta: [
      { title: "Open Source — Apache 2.0, zero-knowledge by architecture | OrangeRails" },
      {
        name: "description",
        content:
          "Open source is not a marketing strategy — it's the architecture. Why Apache 2.0, why the moat is not the code, and why our zero-knowledge guarantee is mechanical, not promissory.",
      },
      { property: "og:title", content: "Open source is not a marketing strategy. It's the architecture." },
      {
        property: "og:description",
        content:
          "Apache 2.0. Split-connector zero-knowledge. Audit the code yourself. The OrangeRails philosophy.",
      },
      { property: "og:image", content: "/og-image.jpg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:title", content: "Open source is not a marketing strategy. It's the architecture." },
      { name: "twitter:description", content: "Apache 2.0. Zero-knowledge by design. Audit the code yourself." },
      { name: "twitter:image", content: "/og-image.jpg" },
      { rel: "canonical", href: "https://orangerails.com/open-source" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareSourceCode",
          name: "OrangeRails",
          description:
            "Open-source, zero-knowledge, Bitcoin-first alternative to Plaid. Apache 2.0 licensed.",
          codeRepository: "https://github.com/orangerails",
          programmingLanguage: ["TypeScript", "Rust"],
          license: "https://www.apache.org/licenses/LICENSE-2.0",
          author: { "@type": "Organization", name: "OrangeRails" },
        }),
      },
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            { "@type": "ListItem", position: 1, name: "Home", item: "https://orangerails.com/" },
            { "@type": "ListItem", position: 2, name: "Open Source", item: "https://orangerails.com/open-source" },
          ],
        }),
      },
    ],
  }),
  component: OpenSourcePage,
});

const SECTIONS = [
  {
    icon: Scale,
    title: "The license: Apache 2.0",
    paragraphs: [
      "Apache 2.0 over MIT because of the explicit patent grant. If a contributor holds a patent that reads on the code they contributed, they grant you a license to it. MIT doesn't.",
      "Not AGPL because AGPL would block the QuickBooks and Xero plugin Trojan horse — the whole point is shipping Bitcoin data into legacy accounting stacks that won't touch copyleft code.",
      "Not Business Source License (BSL) because it undermines community trust. \"Open source eventually\" is not open source. We chose the license that the audience we want actually respects.",
    ],
  },
  {
    icon: Network,
    title: "The moat is not the code",
    paragraphs: [
      "If the code were the moat, open-sourcing it would be self-defeating. It isn't, so it isn't.",
      "What's actually defensible: signed partnership agreements with banks and wallets, verified-adapter quality, SOC 2 Type II and HIPAA paperwork that takes years to build, and the network effects of being the open spec the rest of the ecosystem builds against.",
      "A fork can copy the code in an hour. It cannot copy two years of compliance audits and dozens of partnership contracts.",
    ],
  },
  {
    icon: HandCoins,
    title: "Our revenue model is honest",
    paragraphs: [
      "We sell operational leverage: managed hosting, SSO, audit log retention, SLAs, signed partner adapters, compliance attestations.",
      "We do not sell crippled features. The free self-host has the same adapters, the same zero-knowledge mode, the same API. Paid tiers add ops — not capability.",
      "If we ever feel tempted to hold a feature back to push you onto a paid plan, you have our git history to call us out with.",
    ],
  },
  {
    icon: Lock,
    title: "The zero-knowledge guarantee",
    paragraphs: [
      "ZKA is enforced by a split-connector pattern: the connector runs on your machine (or your server), holds the credentials, decrypts the data, and only sends back encrypted blobs we cannot read.",
      "The guarantee is mechanical, not promissory. We're not asking you to trust our intentions — we're inviting you to read the code and verify that the architecture makes data theft impossible by us, even under subpoena.",
      "If you find a way for our infrastructure to read plaintext transaction data in ZKA mode, that's a bug. Report it to security@orangerails.com — GPG key on the docs site.",
    ],
  },
  {
    icon: GitPullRequest,
    title: "Contributing",
    paragraphs: [
      "Code contributions and adapter contributions both welcome. Adapters get a co-maintainer on the core team for the first 90 days after merge.",
      "Security disclosures: security@orangerails.com with our GPG key. We commit to a 24-hour acknowledgement and a public CVE timeline.",
      "Hall of fame for responsible disclosure. We list the people who made this safer — by name, on the website, with a permanent link.",
    ],
  },
];

const AUDIT_CODE = `git clone https://github.com/orangerails/core
cd core

# read the engine that talks to your data
less src/connectors/sync-engine.ts

# verify that ZKA mode never sees plaintext
npm run audit:zka`;

function OpenSourcePage() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="pointer-events-none absolute inset-0 grid-bg opacity-50 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
          <div className="relative mx-auto max-w-4xl px-6 py-20 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-primary">
              Open source
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Open source is not a marketing strategy. It's the architecture.
            </h1>
          </div>
        </section>

        {/* Sections */}
        <section className="py-20">
          <div className="mx-auto max-w-3xl px-6">
            <div className="space-y-10">
              {SECTIONS.map((s) => (
                <article
                  key={s.title}
                  className="rounded-2xl border border-border bg-background p-7 sm:p-9"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-soft text-primary ring-1 ring-primary/15">
                    <s.icon className="h-5 w-5" />
                  </div>
                  <h2 className="mt-5 text-2xl font-semibold tracking-tight">{s.title}</h2>
                  <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-muted-foreground sm:text-base">
                    {s.paragraphs.map((p, i) => (
                      <p key={i}>{p}</p>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Audit yourself */}
        <section className="border-t border-border/60 bg-card/40 py-20">
          <div className="mx-auto max-w-3xl px-6">
            <p className="text-xs font-medium uppercase tracking-widest text-primary">
              Audit yourself
            </p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance">
              Don't take our word for it.
            </h2>
            <p className="mt-3 text-muted-foreground">
              Read the engine. Verify the encryption boundary. Run the audit script.
            </p>

            <div className="mt-8">
              <CodeBlock code={AUDIT_CODE} language="sh" />
            </div>

            <a
              href="#"
              className="group mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-primary"
            >
              Read the full threat model
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </a>
          </div>
        </section>
      </main>

      <Footer />
      <Toaster richColors position="top-center" />
    </div>
  );
}
