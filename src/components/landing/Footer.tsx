import { Zap } from "lucide-react";

const cols = [
  {
    title: "Product",
    links: ["Features", "Integrations", "Pricing", "Docs"],
  },
  {
    title: "Company",
    links: ["About", "Blog", "Security", "Open Source Philosophy"],
  },
  {
    title: "Connect",
    links: ["GitHub", "Twitter", "Nostr"],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-10 md:grid-cols-4">
          <div>
            <a href="#" className="flex items-center gap-2 font-semibold">
              <Zap className="h-5 w-5 fill-primary text-primary" strokeWidth={2.5} />
              <span>OrangeRails</span>
            </a>
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              Open-source, zero-knowledge financial rails for Bitcoin businesses.
            </p>
          </div>

          {cols.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold">{col.title}</h4>
              <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                {col.links.map((l) => (
                  <li key={l}>
                    <a href="#" className="transition-colors hover:text-foreground">
                      {l}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-2 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <p>© 2026 OrangeRails. Apache 2.0 licensed.</p>
          <p>
            Part of the <span className="text-foreground">BitBooks</span> family.
          </p>
        </div>
      </div>
    </footer>
  );
}
