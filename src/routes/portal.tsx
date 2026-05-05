import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useRole } from '@/hooks/useRole';

export const Route = createFileRoute('/portal')({
  component: PortalShell,
});

function PortalShell() {
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
        <p className="text-sm text-muted-foreground">Loading your account</p>
      </div>
    );
  }

  if (role.role === 'staff') {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">OrangeRails Portal</h1>
          <Link to="/admin" className="text-sm text-primary hover:underline">
            Back to admin
          </Link>
        </header>
        <main className="px-6 py-8 max-w-3xl mx-auto">
          <p className="text-sm text-muted-foreground">
            You are signed in as a staff member ({role.email}). The client portal is
            for paying customers. Use the admin console to view a customer&apos;s
            picture from the staff side.
          </p>
        </main>
      </div>
    );
  }

  if (role.role !== 'customer-admin' || !role.customerType) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-2xl font-semibold">No customer account yet</h1>
          <p className="text-sm text-muted-foreground">
            You are signed in as {role.email ?? 'an unknown user'}, but no paying
            customer record is linked to this login. Contact OrangeRails support if
            you believe this is wrong.
          </p>
        </div>
      </div>
    );
  }

  const isDeveloper = role.customerType === 'developer';
  const isTeamOrDeveloper = role.customerType === 'team' || isDeveloper;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">OrangeRails Portal</h1>
          <p className="text-xs text-muted-foreground">
            {role.customerName} &middot; {role.customerType}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">{role.email}</p>
      </header>

      <main className="px-6 py-8 max-w-3xl mx-auto space-y-6">
        <Section title="Plan">
          Plan details and billing tier appear here in Phase 3.
        </Section>

        <Section title="Invoices">
          Invoice list and the two pay buttons (card / Bitcoin) appear here in
          Phase 3. Card payment goes live in Phase 4. Bitcoin payment goes live
          when Pay with Flash is ready.
        </Section>

        <Section title="Billing history">
          Past payments appear here in Phase 3.
        </Section>

        {isTeamOrDeveloper && (
          <Section title="Teammates">
            Teammate list and admin rights appear here in Phase 6.
          </Section>
        )}

        {isDeveloper && (
          <Section title="Developer settings">
            Platform connection key, vendor allow list, tier passthrough, and the
            live usage meter all turn on in Phase 6.
          </Section>
        )}
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-2 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}
