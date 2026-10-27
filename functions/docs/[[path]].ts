// Pages Function for /docs/*: unknown docs paths answer 404, the pages the router serves pass through.
//
// Why this exists: the app is a single-page app, so the static layer answers every path it does not
// recognise with the app shell and status 200. Under /docs/* that is a soft 404: an invented docs URL
// looks healthy to link checkers and search engines. A _redirects rule cannot fix it, because Pages
// only accepts 200 and 3xx statuses there (a "/docs/* /404.html 404" line is rejected at build time).
// A Function can set any status, so this one decides for every request under /docs/*.
//
// KEEP DOCS_PATHS IN STEP WITH THE ROUTER. Every page defined in src/routes/docs.tsx and in the
// src/routes/docs directory must be listed below, otherwise that page answers 404 in production.
//
// Headers: Pages applies public/_headers to static assets, not to a response a Function builds. The
// 404 below is built here, so it sets the same four hardening headers as the catch-all block in
// public/_headers. Pass-through responses keep whatever the static layer set and only get one of the
// four added when it is missing. If you change the hardening headers, change both places.

type PagesContext = {
  request: Request;
  next: () => Promise<Response>;
};

// Exact paths the router serves, lowercase. The router matches case-insensitively, so the request
// path is lowercased before the lookup. One trailing slash is ignored; nothing else is normalised.
const DOCS_PATHS = new Set(["/docs", "/docs/xpub-export", "/docs/strike-csv"]);

const HARDENING_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page not found | OrangeRails</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;padding:2rem;text-align:center}
h1{margin:0 0 .5rem;font-size:1.5rem}
p{margin:0 0 1rem}
a{color:#b45309}
@media (prefers-color-scheme:dark){a{color:#fdba74}}
</style>
</head>
<body>
<main>
<h1>Page not found</h1>
<p>That documentation page does not exist. It may have moved, or the link may be wrong.</p>
<p><a href="/docs">Go to the OrangeRails docs</a></p>
</main>
</body>
</html>
`;

export const onRequest = async (context: PagesContext): Promise<Response> => {
  // The URL comes from the runtime and is always absolute. Nothing is decoded, so no input can
  // make this throw and turn a 404 into a 500.
  const { pathname } = new URL(context.request.url);
  const path = pathname.replace(/\/$/, "").toLowerCase();

  if (DOCS_PATHS.has(path)) {
    const response = await context.next();
    const passed = new Response(response.body, response);
    for (const [name, value] of Object.entries(HARDENING_HEADERS)) {
      if (!passed.headers.has(name)) {
        passed.headers.set(name, value);
      }
    }
    return passed;
  }

  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", ...HARDENING_HEADERS },
  });
};
