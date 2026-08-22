import { createFileRoute, Link, Outlet, redirect } from '@tanstack/react-router';
import { supabase } from '@/integrations/supabase/client';
import { useRole } from '@/hooks/useRole';

export const Route = createFileRoute('/admin')({
  beforeLoad: async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw redirect({ to: '/login' });
    }
  },
  component: AdminLayout,
});

function AdminLayout() {
  // Server-side enforcement: admin tables (customers, subscriptions,
  // invoices, payments) are gated by RLS policies that key off
  // auth.jwt() ->> 'app_metadata' -> 'role' == 'staff'. This
  // client-side check is defense-in-depth, not the primary lock.
  const role = useRole();

  if (role.loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Loading admin</p>
      </div>
    );
  }

  if (role.role !== 'staff') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-2xl font-semibold">Staff only</h1>
          <p className="text-sm text-muted-foreground">
            This page is for OrangeRails staff. You are signed in as {role.email ?? 'an unknown user'},
            which does not have staff access.
          </p>
          <Link
            to="/portal"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Go to your client portal
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-4 flex items-center justify-between">
        <div>
          <Link to="/admin" className="text-xl font-semibold hover:underline">
            OrangeRails Admin
          </Link>
          <p className="text-xs text-muted-foreground">Staff console</p>
        </div>
        <p className="text-sm text-muted-foreground">{role.email}</p>
      </header>
      <Outlet />
    </div>
  );
}
