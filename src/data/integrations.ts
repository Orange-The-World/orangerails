export type AdapterCategory =
  | "Banking"
  | "Exchange"
  | "Wallet"
  | "Mining"
  | "Lightning"
  | "Files"
  | "Payments"
  | "Explorer";

export type AdapterStatus = "Available" | "Beta" | "Planned";

export type Adapter = {
  id: string;
  name: string;
  category: AdapterCategory;
  status: AdapterStatus;
  description: string;
  /** When set, the adapter card links to this in-app route. Used for
   *  adapters with a dedicated landing page (e.g. Sparrow's Stealth Sync
   *  flow). Adapters without a connectUrl render the generic "Docs" text. */
  connectUrl?: string;
};

export const ADAPTERS: Adapter[] = [
  { id: "bitcoin-core", name: "Bitcoin Core", category: "Wallet", status: "Available", description: "Connect to your own node via RPC. Full sovereignty." },
  { id: "btcpay", name: "BTCPay Server", category: "Payments", status: "Available", description: "Merchant invoices via webhook. HMAC-signed." },
  { id: "blink", name: "Blink / Galoy", category: "Banking", status: "Available", description: "Lightning + USD stablecoin. GraphQL API." },
  { id: "bwt", name: "bwt / xpub", category: "Wallet", status: "Available", description: "Watch-only on-chain wallet. Rust descriptor tracker." },
  { id: "lunar", name: "Lunar Rails", category: "Banking", status: "Beta", description: "Exchange rates now. Banking Phase 2." },
  { id: "kraken", name: "Kraken", category: "Exchange", status: "Planned", description: "Spot trading, deposits, withdrawals, fee history." },
  { id: "river", name: "River", category: "Exchange", status: "Planned", description: "DCA and treasury management." },
  { id: "ocean", name: "Ocean Pool", category: "Mining", status: "Planned", description: "Non-custodial mining payouts (BOLT12 Lightning)." },
  { id: "braiins", name: "Braiins Pool", category: "Mining", status: "Planned", description: "API + CSV/JSON payout export." },
  { id: "viabtc", name: "ViaBTC Pool", category: "Mining", status: "Planned", description: "Mining rewards and payouts." },
  { id: "lnd", name: "LND", category: "Lightning", status: "Planned", description: "gRPC + Faraday accounting." },
  { id: "cln", name: "Core Lightning (CLN)", category: "Lightning", status: "Planned", description: "Self-hosted Lightning node." },
  { id: "ldk", name: "LDK", category: "Lightning", status: "Planned", description: "Library adapter. WASM-capable." },
  { id: "sparrow", name: "Sparrow Wallet", category: "Wallet", status: "Available", description: "Descriptor watch only via Stealth Sync. Browser scans BIP 158 filters; the server never sees your addresses.", connectUrl: "/connect/sparrow" },
  { id: "phoenix", name: "Phoenix", category: "Lightning", status: "Planned", description: "LDK-based mobile Lightning." },
  { id: "mempool", name: "Mempool.space / Esplora", category: "Explorer", status: "Available", description: "Blockchain query adapter." },
  { id: "coinbase", name: "Coinbase", category: "Exchange", status: "Planned", description: "OAuth read-only." },
  { id: "swan", name: "Swan", category: "Exchange", status: "Planned", description: "DCA + treasury." },
  { id: "strike", name: "Strike", category: "Banking", status: "Planned", description: "Lightning + USD banking." },
  { id: "bitcredit", name: "BitCredit", category: "Banking", status: "Planned", description: "Bitcoin-backed lending." },
  { id: "fedi", name: "Fedi", category: "Wallet", status: "Planned", description: "Ecash mini-app ecosystem." },
  { id: "files", name: "CSV / OFX / QIF", category: "Files", status: "Available", description: "Universal fallback import." },
];

export const CATEGORIES = [
  "All",
  "Banking",
  "Exchange",
  "Wallet",
  "Mining",
  "Lightning",
  "Files",
] as const;

export type FilterCategory = (typeof CATEGORIES)[number];
