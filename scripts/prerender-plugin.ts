import type { Plugin } from 'vite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALL_PRERENDER_ROUTES, type PublicRouteMeta } from '../src/marketing/routes-meta';

/**
 * Build-time prerender plugin.
 *
 * Lovable's static hosting only runs `vite build` and serves the resulting
 * dist/ folder; it does not run a Node SSR step. Full DOM prerendering
 * (react-snap, vite-plugin-prerender) would need a Chromium binary at
 * build time, which isn't available in this environment.
 *
 * Instead we do a lightweight HTML-only prerender: after the SPA build
 * completes, copy dist/index.html for every public marketing route, then
 * inject route-specific <title>, <meta name="description">, canonical link,
 * page-specific JSON-LD, and a richer <noscript> body. The React bundle
 * still hydrates normally, so end users see no difference — but bots and
 * AI crawlers that don't execute JS now get the right content per route.
 *
 * Output layout (so the static host's directory-index fallback serves the
 * file at the matching URL without redirects):
 *   dist/index.html               (root, replaced)
 *   dist/features/index.html
 *   dist/security/index.html
 *   dist/compare/quickbooks/index.html
 *   ...
 */
export default function prerenderMarketingPlugin(): Plugin {
  return {
    name: 'prerender-marketing-routes',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      // Vite build output is dist/ in this project (default).
      const distDir = path.resolve(process.cwd(), 'dist');
      const shellPath = path.join(distDir, 'index.html');

      let shell: string;
      try {
        shell = await fs.readFile(shellPath, 'utf8');
      } catch (err) {
        // If there's no built shell, the SPA build failed — bail silently
        // so we don't mask the real error.
        return;
      }

      for (const route of ALL_PRERENDER_ROUTES) {
        const html = renderRoute(shell, route);
        const outPath =
          route.path === '/'
            ? path.join(distDir, 'index.html')
            : path.join(distDir, route.path.replace(/^\//, ''), 'index.html');

        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, html, 'utf8');
      }
    },
  };
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a single route by mutating the built shell HTML. */
function renderRoute(shell: string, route: PublicRouteMeta): string {
  const SITE_URL = 'https://orangeway.app';
  const canonical = `${SITE_URL}${route.path === '/' ? '' : route.path}`;

  let html = shell;

  // <title>
  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${escapeHtml(route.title)}</title>`,
  );

  // <meta name="description">
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${escapeHtml(route.description)}" />`,
  );

  // <link rel="canonical">
  if (/<link\s+rel="canonical"/.test(html)) {
    html = html.replace(
      /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/,
      `<link rel="canonical" href="${canonical}" />`,
    );
  } else {
    html = html.replace(
      '</head>',
      `<link rel="canonical" href="${canonical}" />\n</head>`,
    );
  }

  // OG / Twitter title + description (for social embed bots)
  html = html
    .replace(
      /<meta\s+property="og:title"\s+content="[^"]*">/,
      `<meta property="og:title" content="${escapeHtml(route.title)}">`,
    )
    .replace(
      /<meta\s+name="twitter:title"\s+content="[^"]*">/,
      `<meta name="twitter:title" content="${escapeHtml(route.title)}">`,
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*">/,
      `<meta property="og:description" content="${escapeHtml(route.description)}">`,
    )
    .replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*">/,
      `<meta name="twitter:description" content="${escapeHtml(route.description)}">`,
    );

  // Inject page-specific JSON-LD just before </head>. We keep the existing
  // sitewide Organization/WebSite/SoftwareApplication block intact.
  if (route.jsonLd && route.jsonLd.length > 0) {
    const blocks = route.jsonLd
      .map(
        (obj) =>
          `<script type="application/ld+json">\n${JSON.stringify(obj)}\n</script>`,
      )
      .join('\n');
    html = html.replace('</head>', `${blocks}\n</head>`);
  }

  // Replace the <noscript> fallback inside #root with a route-specific one
  // so bots see a real H1 + paragraph for the actual page they fetched.
  const noscriptBody = `      <noscript>\n        <h1>${escapeHtml(route.h1)}</h1>\n        <p>${escapeHtml(
    route.summary,
  )}</p>\n        <p>Visit: <a href="/features">Features</a> · <a href="/security">Security</a> · <a href="/pricing">Pricing</a> · <a href="/faq">FAQ</a> · <a href="/compare">Compare</a> · <a href="/about">About</a></p>\n      </noscript>`;
  html = html.replace(/<noscript>[\s\S]*?<\/noscript>/, noscriptBody);

  return html;
}