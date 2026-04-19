import type { Plan } from "@/components/pricing/PricingCard";

const ZK = "Zero-knowledge mode";

export const INDIVIDUALS: Plan[] = [
  {
    name: "Self-Host",
    price: "Free",
    priceSub: "forever",
    cta: { label: "Get on GitHub", href: "#" },
    features: [
      { text: "Unlimited connections" },
      { text: ZK, emphasize: true },
      { text: "You run the server" },
      { text: "Daily sync (your schedule)" },
      { text: "Community support" },
      { text: "Apache 2.0 licensed" },
    ],
  },
  {
    name: "Personal",
    price: "$15",
    priceSub: "/yr · or $2/mo",
    highlight: true,
    cta: { label: "Start 14-day trial" },
    features: [
      { text: "Up to 5 connections" },
      { text: ZK, emphasize: true },
      { text: "We run the server" },
      { text: "Daily sync" },
      { text: "Community forum" },
    ],
  },
  {
    name: "Prosumer",
    price: "$99",
    priceSub: "/yr · or $10/mo",
    cta: { label: "Start 14-day trial" },
    features: [
      { text: "Unlimited connections" },
      { text: ZK, emphasize: true },
      { text: "We run the server" },
      { text: "Hourly sync + real-time webhooks" },
      { text: "Email support (72hr)" },
    ],
  },
];

export const TEAMS: Plan[] = [
  {
    name: "Team",
    price: "$49",
    priceSub: "/mo",
    cta: { label: "Start 14-day trial" },
    features: [
      { text: "Up to 25 connections" },
      { text: "5 seats" },
      { text: ZK, emphasize: true },
      { text: "Audit log" },
      { text: "Daily backups" },
      { text: "Email support (24hr)" },
    ],
  },
  {
    name: "Business",
    price: "$199",
    priceSub: "/mo",
    highlight: true,
    cta: { label: "Start 14-day trial" },
    features: [
      { text: "Unlimited connections" },
      { text: "Unlimited seats" },
      { text: ZK, emphasize: true },
      { text: "SAML / OIDC SSO" },
      { text: "Audit log + retention" },
      { text: "Priority support (4hr)" },
      { text: "99.9% SLA" },
      { text: "Verified partner-signed adapters" },
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    cta: { label: "Book a call" },
    features: [
      { text: "Unlimited + private deployment" },
      { text: "Unlimited + SSO + SCIM" },
      { text: ZK, emphasize: true },
      { text: "Audit log + SIEM export" },
      { text: "Named CSM + 1hr SLA" },
      { text: "99.95% SLA" },
      { text: "SOC 2 Type II, HIPAA BAA" },
      { text: "HSM / KMS integration" },
    ],
  },
];

export const DEVELOPERS: Plan[] = [
  {
    name: "Sandbox",
    price: "Free",
    cta: { label: "Start building" },
    features: [
      { text: "Rate-limited" },
      { text: "5 test connections" },
      { text: "No production traffic" },
      { text: "Sandbox data only" },
      { text: "Community support" },
    ],
  },
  {
    name: "Production",
    price: "$500",
    priceSub: "/mo base",
    highlight: true,
    cta: { label: "Go live" },
    features: [
      { text: "+ $0.50 / connection / month" },
      { text: "+ $0.001 / API call" },
      { text: "Unlimited test connections" },
      { text: "Real bank/wallet data" },
      { text: ZK, emphasize: true },
      { text: "Email support (24hr)" },
    ],
  },
  {
    name: "Enterprise API",
    price: "Custom",
    priceSub: "contract",
    cta: { label: "Book a call" },
    features: [
      { text: "Volume discounts > 10k connections" },
      { text: "Dedicated infrastructure" },
      { text: "White-label option" },
      { text: ZK, emphasize: true },
      { text: "Custom SLA" },
      { text: "Named CSM" },
    ],
  },
];

export const FAQ = [
  {
    q: "Why three different pricing models?",
    a: "One size never fits all. Individuals, teams, and developers each get the pricing shape that matches how they actually use the product — not the shape that's easiest for us to bill.",
  },
  {
    q: "Why is zero-knowledge on every tier including free?",
    a: "Gating privacy contradicts why we built this. The OSS audience is the same audience that values zero-knowledge — splitting them would alienate both.",
  },
  {
    q: "Can I move between tiers or segments?",
    a: "Yes. Data persists, billing recalculates. You can upgrade, downgrade, or jump segments without losing connections or history.",
  },
  {
    q: "What happens if I stop paying?",
    a: "Hosted accounts are paused for 90 days with data retained. After that you can self-host from GitHub with full feature parity and import your data back at any time.",
  },
  {
    q: "Do you resell my data?",
    a: "We can't. Zero-knowledge mode means we literally cannot read transaction details — the math doesn't allow it. See the threat model on /open-source.",
  },
  {
    q: "Is the OSS self-host crippled?",
    a: "No. Same adapters, same zero-knowledge guarantees, same API. Paid tiers add operational features (SSO, audit log retention, SLA, SOC 2 attestation) — not core capability.",
  },
  {
    q: "Why not charge everyone usage-based like Plaid?",
    a: "Per-connection metering is hostile to individuals. A miner with 400 rigs shouldn't pay Plaid-style fees to look at their own payouts.",
  },
  {
    q: "Why not charge developers a flat fee?",
    a: "$99/yr can't cover the infrastructure a fintech with 10,000 end users generates. Usage-based pricing aligns our cost with their scale.",
  },
];

export const PERSONAS = [
  {
    who: "Bitcoiner tracking own stack",
    plan: "Personal ($15/yr) or Self-Host (free)",
  },
  {
    who: "Miner with <50 rigs or BTC merchant",
    plan: "Prosumer ($99/yr)",
  },
  {
    who: "Accounting firm with BTC clients or multi-entity Bitcoin business",
    plan: "Team ($49/mo) or Business ($199/mo)",
  },
  {
    who: "Building a product needing Bitcoin ingestion",
    plan: "Production API ($500/mo + usage)",
  },
];
