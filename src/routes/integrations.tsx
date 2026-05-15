import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * /integrations is the legacy URL for the catalog. The canonical URL is
 * /providers — this route exists only to preserve inbound links and the
 * search-engine breadcrumb that already points here.
 */
export const Route = createFileRoute("/integrations")({
  beforeLoad: () => {
    throw redirect({ to: "/providers" });
  },
  component: () => null,
});
