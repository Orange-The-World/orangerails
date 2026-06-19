import { Link } from "@tanstack/react-router";

type FooterLink = { label: string; to?: string; href?: string };

const cols: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Connections", to: "/providers" },
      { label: "Connect a wallet", href: "https://app.orangerails.com/connect" },
      { label: "Pricing", to: "/pricing" },
      { label: "Docs", href: "https://docs.orangerails.com" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "#" },
      { label: "Blog", href: "#" },
      { label: "Security", href: "#" },
      { label: "Open source philosophy", to: "/open-source" },
    ],
  },
  {
    title: "Help",
    links: [
      { label: "Support", href: "https://support.orangerails.com" },
      { label: "Feedback", href: "https://feedback.bitbooks.com" },
      { label: "Docs", href: "https://docs.orangerails.com" },
    ],
  },
  {
    title: "Connect",
    links: [
      { label: "GitHub", href: "https://github.com/Orange-The-World/orangerails" },
      { label: "Twitter", href: "https://x.com/orangerails" },
      { label: "Nostr", href: "https://primal.net/p/orangerails" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-10 md:grid-cols-5">
          <div>
            <Link to="/" className="flex items-center gap-2 font-semibold">
              <img
                src="/favicon.svg"
                alt=""
                aria-hidden
                className="h-6 w-6"
                width={24}
                height={24}
              />
              <span>OrangeRails</span>
            </Link>
            <p className="mt-3 max-w-xs text-sm text-muted-foreground">
              Open source, zero knowledge financial rails for Bitcoin businesses.
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
