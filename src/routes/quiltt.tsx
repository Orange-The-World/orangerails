/**
 * Top-level /quiltt redirect.
 *
 * Same reason as /sparrow: Quiltt is the other provider with a dedicated
 * connect route, so a bare `orangerails.com/quiltt` deep-link must land on
 * the connect screen, not the marketing fallback. Query string preserved
 * so integration params survive the bounce.
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/quiltt")({
  beforeLoad: () => {
    throw redirect({ to: "/connect/quiltt", search: true });
  },
});
