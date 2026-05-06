import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useRole } from '@/hooks/useRole';

export const Route = createFileRoute('/admin')({
  component: AdminShell,
});

function AdminShell() {
  const role = useRole();
  const navigate = useNavigate();

  useEffect(() => {
    if (!role.loading && role.role === 'anonymous') {
      navigate({ to: '/login' });
    }
  }, [role.loading, role.role, navigate]);

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
          <h1 className="text-xl font-semibold">OrangeRails Admin</h1>
          <p className="text-xs text-muted-foreground">Staff console</p>
        </div>
        <p className="text-sm text-muted-foreground">{role.email}</p>
      </header>

      <main className="px-6 py-8 max-w-6xl mx-auto">
        <p className="text-sm text-muted-foreground">
          Phase 1 shell. Customer list, the four top-of-page numbers, per-customer
          detail, and action buttons land in Phases 2 and 5.
        </p>

        <section className="mt-8 grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Total customers', value: '—' },
            { label: 'Paying customers', value: '—' },
            { label: 'Collected this month', value: '—' },
            { label: 'Overdue', value: '—' },
          ].map((s) => (
            <div key={s.label} className="rounded-lg border p-4">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="mt-2 text-2xl font-semibold">{s.value}</p>
            </div>
          ))}
        </section>

        <section className="mt-8 rounded-lg border p-6 text-sm text-muted-foreground">
          Customer list goes here in Phase 2.
        </section>
      </main>
    </div>
  );
}
