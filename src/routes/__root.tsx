import { Outlet, Link, createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";

import appCss from "../styles.css?url";
import { VaultProvider } from "@/context/VaultContext";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#F7931A" },
      { name: "robots", content: "index, follow" },
      { name: "author", content: "OrangeRails" },
      { name: "keywords", content: "Bitcoin, Plaid alternative, open source, zero-knowledge, financial data API, Bitcoin accounting, Lightning Network, self-hostable, Apache 2.0, BTCPay, Blink, mining payouts" },
      { property: "og:type", content: "website" },
      { property: "og:site_name", content: "OrangeRails" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:site", content: "@orangerails" },
      { name: "twitter:creator", content: "@orangerails" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
      },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "OrangeRails",
          url: "https://orangerails.com",
          logo: "https://orangerails.com/favicon.svg",
          description:
            "Open-source, zero-knowledge, Bitcoin-first alternative to Plaid. Apache 2.0.",
          sameAs: ["https://orangerails.com"],
        }),
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
});

function RootShell({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  return (
    <VaultProvider>
      <Outlet />
    </VaultProvider>
  );
}
