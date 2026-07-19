import { createFileRoute, redirect } from '@tanstack/react-router';

// The app has no landing page of its own; the marketing site lives in a
// separate repo. Visiting the bare app domain, or the logo and the 404
// page's "Go home" links (which target "/"), should land on the primary
// connect flow rather than the 404 fallback. Redirect at load so "/" never
// renders a page of its own.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/connect' });
  },
});
