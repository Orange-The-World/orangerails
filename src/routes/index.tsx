import { createFileRoute, redirect } from '@tanstack/react-router';

// The app has no landing page of its own; the marketing site lives in a
// separate repo. Visiting the bare app domain, or the logo and the 404
// page's "Go home" links (which target "/"), should land on the public
// docs index. /connect is deliberately not the target: it is the embedded
// link widget and it requires platform, app_user_id and return_to search
// params, so a visitor arriving with no params would see it in its
// missing-params state. Redirect at load so "/" never renders a page of
// its own.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/docs' });
  },
});
