// Marketing routes that get prerendered to per-route HTML at build time
// for SEO and AI crawler indexing. The plugin reads ALL_PRERENDER_ROUTES
// and emits one index.html per route under dist/<route>/.

export interface PublicRouteMeta {
  path: string;
  title: string;
  description: string;
  h1: string;
  summary: string;
}

export const ALL_PRERENDER_ROUTES: PublicRouteMeta[] = [
  {
    path: "/",
    title: "OrangeRails — Open-source Bitcoin financial data API",
    description: "Open-source, zero-knowledge, Bitcoin-first alternative to Plaid. Apache 2.0 licensed.",
    h1: "Open-source Bitcoin financial data",
    summary: "Connect wallets, exchanges, mining pools, and Lightning nodes through one open-source API.",
  },
  {
    path: "/docs",
    title: "Docs — OrangeRails",
    description: "Documentation for OrangeRails: connectors, APIs, integration guides.",
    h1: "Documentation",
    summary: "Everything you need to integrate OrangeRails with your application.",
  },
  {
    path: "/integrations",
    title: "Integrations — OrangeRails",
    description: "Bitcoin wallets, exchanges, Lightning nodes, mining pools. One API.",
    h1: "Integrations",
    summary: "Every Bitcoin financial data source we support.",
  },
  {
    path: "/open-source",
    title: "Open Source — OrangeRails",
    description: "OrangeRails is Apache 2.0. Self-host or use the hosted version.",
    h1: "Open source by design",
    summary: "The full source code is on GitHub. Use it, fork it, audit it.",
  },
  {
    path: "/pricing",
    title: "Pricing — OrangeRails",
    description: "Free self-hosted forever. Hosted version with pay-as-you-grow pricing.",
    h1: "Pricing",
    summary: "Self-host for free, or use our hosted version for convenience.",
  },
];
