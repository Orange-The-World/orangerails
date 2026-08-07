/**
 * Top-level /sparrow redirect.
 *
 * Provider deep-links get shared bare, as `orangerails.com/sparrow`, from
 * docs, marketing, and word of mouth, not as `.../connect/sparrow`. Without
 * a route at the top level the SPA falls back to index.html and the visitor
 * lands on the marketing home instead of the Sparrow connect screen. That
 * fallback is what DL-0439 saw.
 *
 * We carry the visitor to /connect/sparrow and preserve the query string
 * (search: true) so app_url and the other params the Stealth Sync handoff
 * reads survive the bounce.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/sparrow")({
  beforeLoad: () => {
    throw redirect({ to: "/connect/sparrow", search: true });
  },
});
