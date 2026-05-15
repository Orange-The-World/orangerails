import { Link } from "@tanstack/react-router";
import { Zap } from "lucide-react";

type FooterLink = { label: string; to?: string; href?: string };

const cols: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Connections", to: "/providers" },
      { label: "Connect a wallet", to: "/connect" },
      { label: "Pricing", to: "/pricing" },
      { label: "Docs", to: "/docs" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Blog", href: "#" },
      { label: "Security", href: "#" },
      { label: "Open Source Philosophy", to: "/open-source" },
    ],
  },
  {
    title: "Connect",
    links: [
      { label: "GitHub", href: "#" },
      { label: "Twitter", href: "#" },
      { label: "Nostr", href: "#" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-10 md:grid-cols-4">
          <div>
            <Link to="/" className="flex items-center gap-2 font-semibold">
              <Zap className="h-5 w-5 fill-primary text-primary" strokeWidth={2.5} />
              <span>OrangeRails</span>
            </Link>
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              Open-source, zero-knowledge financial rails for Bitcoin businesses.
            </p>
          </div>

          {cols.map((col) => (
            <div key={col.title}>
              <h4 className="text-sm font-semibold">{col.title}</h4>
              <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
                {col.links.map((l) => (
                  <li key={l.label}>
                    {l.to ? (
                      <Link to={l.to} className="transition-colors hover:text-foreground">
                        {l.label}
                      </Link>
                    ) : (
                      <a
                        href={l.href}
                        className="transition-colors hover:text-foreground"
                      >
                        {l.label}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-2 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <p>© 2026 OrangeRails. Apache 2.0 licensed.</p>
        </div>
      </div>
    </footer>
  );
}
