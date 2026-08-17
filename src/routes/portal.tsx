import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useRole, type RoleState } from '@/hooks/useRole';
import {
  fetchCustomer,
  fetchInvoices,
  fetchPayments,
  fetchSubscriptions,
  formatCents,
  type CustomerRow,
  type InvoiceRow,
  type PaymentRow,
  type SubscriptionRow,
} from '@/lib/admin/queries';
import { formatError } from '@/lib/format-error';

export const Route = createFileRoute('/portal')({
  beforeLoad: async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      throw redirect({ to: '/login' });
    }
  },
  component: PortalPage,
});

interface PortalBundle {
  customer: CustomerRow;
  subscription: SubscriptionRow | null;
  invoices: InvoiceRow[];
  payments: PaymentRow[];
}

function PortalPage() {
  const role = useRole();

  if (role.loading) {
    return <Centered>Loading your account</Centered>;
  }

  if (role.role === 'staff') {
    return (
      <PortalShell role={role}>
        <p className="text-sm text-muted-foreground">
          You are signed in as a staff member ({role.email}). The client portal is for paying
          customers. Use the admin console to view a customer&apos;s picture from the staff side.
        </p>
        <div className="mt-4">
          <Link
            to="/admin"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Back to admin
          </Link>
        </div>
      </PortalShell>
    );
  }

  if (role.role !== 'customer-admin' || !role.customerId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-4">
        <div className="max-w-md text-center space-y-4">
          <h1 className="text-2xl font-semibold">No customer account yet</h1>
          <p className="text-sm text-muted-foreground">
            You are signed in as {role.email ?? 'an unknown user'}, but no paying customer record
            is linked to this login. Contact OrangeRails support if you believe this is wrong.
          </p>
        </div>
      </div>
    );
  }

  return <PortalContent role={role} customerId={role.customerId} />;
}

function PortalContent({ role, customerId }: { role: RoleState; customerId: string }) {
  const [bundle, setBundle] = useState<PortalBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const customer = await fetchCustomer(customerId);
        if (!customer) {
          if (!cancelled) {
            setError('Customer record not found');
            setLoading(false);
          }
          return;
        }
        const [subs, invoices, payments] = await Promise.all([
          fetchSubscriptions(customerId),
          fetchInvoices(customerId),
          fetchPayments(customerId),
        ]);
        if (cancelled) return;
        setBundle({
          customer,
          subscription: subs[0] ?? null,
          invoices,
          payments,
        });
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  if (loading) return <Centered>Loading your account</Centered>;
  if (error || !bundle) {
    return (
      <PortalShell role={role}>
        <p className="text-sm text-red-600">{error ?? 'Could not load account'}</p>
      </PortalShell>
    );
  }

  const { customer, subscription, invoices, payments } = bundle;
  const openInvoice = invoices.find((i) => i.status === 'open');
  const isDeveloper = customer.customer_type === 'developer';
  const isTeamOrDeveloper = customer.customer_type === 'team' || isDeveloper;

  return (
    <PortalShell role={{ ...role, customerName: customer.name, customerType: customer.customer_type }}>
      <PlanSection customer={customer} subscription={subscription} />

      <InvoicesSection invoices={invoices} openInvoice={openInvoice ?? null} />

      <BillingHistorySection payments={payments} />

      {isTeamOrDeveloper && (
        <Section title="Teammates">
          <p className="text-sm text-muted-foreground">
            Teammate list and admin rights appear here in Phase 6.
          </p>
        </Section>
      )}

      {isDeveloper && (
        <Section title="Developer settings">
          <p className="text-sm text-muted-foreground">
            Platform connection key, vendor allow list, tier passthrough, and the live usage meter
            all turn on in Phase 6.
          </p>
        </Section>
      )}
    </PortalShell>
  );
}

function PortalShell({ role, children }: { role: RoleState; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">OrangeRails Portal</h1>
          {role.customerName && (
            <p className="text-xs text-muted-foreground">
              {role.customerName} &middot; {role.customerType}
            </p>
          )}
        </div>
        <p className="text-sm text-muted-foreground">{role.email}</p>
      </header>
      <main className="px-6 py-8 max-w-3xl mx-auto space-y-6">{children}</main>
    </div>
  );
}

function PlanSection({
  customer,
  subscription,
}: {
  customer: CustomerRow;
  subscription: SubscriptionRow | null;
}) {
  return (
    <Section title="Plan">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
        <Field label="Plan" value={customer.plan} />
        <Field label="Account status" value={customer.status} />
        <Field
          label="Subscription"
          value={subscription ? subscription.status : 'none'}
        />
        {subscription?.current_period_end && (
          <Field
            label="Renews"
            value={new Date(subscription.current_period_end).toLocaleDateString()}
          />
        )}
        {subscription?.cancel_at_period_end && (
          <Field label="Cancels at period end" value="yes" />
        )}
      </div>
    </Section>
  );
}

function InvoicesSection({
  invoices,
  openInvoice,
}: {
  invoices: InvoiceRow[];
  openInvoice: InvoiceRow | null;
}) {
  return (
    <Section title="Invoices">
      {openInvoice && (
        <div className="rounded-md border-2 border-amber-300 bg-amber-50 p-4 mb-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-amber-900">Open invoice</p>
              <p className="text-xs text-amber-800">
                Due {openInvoice.due_date ? new Date(openInvoice.due_date).toLocaleDateString() : 'soon'} ·{' '}
                {formatCents(Number(openInvoice.amount_cents), openInvoice.currency)}
              </p>
            </div>
            <div className="flex gap-2">
              <PayButton rail="stripe" disabled label="Pay with card" reason="Card payments turn on in Phase 4." />
              <PayButton rail="flash" disabled label="Pay with Bitcoin" reason="Bitcoin payments turn on when Pay with Flash is wired." />
            </div>
          </div>
        </div>
      )}

      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invoices yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left py-2">Date</th>
              <th className="text-left py-2">Amount</th>
              <th className="text-left py-2">Status</th>
              <th className="text-left py-2">Receipt</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((i) => (
              <tr key={i.id} className="border-t">
                <td className="py-2">{new Date(i.created_at).toLocaleDateString()}</td>
                <td className="py-2">{formatCents(Number(i.amount_cents), i.currency)}</td>
                <td className="py-2">{i.status}</td>
                <td className="py-2">
                  {i.hosted_invoice_url ? (
                    <a
                      href={i.hosted_invoice_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      view
                    </a>
                  ) : (
                    <span className="text-muted-foreground">,</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function BillingHistorySection({ payments }: { payments: PaymentRow[] }) {
  return (
    <Section title="Billing history">
      {payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No payments yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left py-2">Date</th>
              <th className="text-left py-2">Method</th>
              <th className="text-left py-2">Amount</th>
              <th className="text-left py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} className="border-t">
                <td className="py-2">{new Date(p.created_at).toLocaleDateString()}</td>
                <td className="py-2">{p.rail === 'stripe' ? 'Card' : 'Bitcoin'}</td>
                <td className="py-2">{formatCents(Number(p.amount_cents), p.currency)}</td>
                <td className="py-2">{p.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-6">
      <h2 className="text-base font-semibold mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium capitalize">{value}</p>
    </div>
  );
}

function PayButton({
  rail,
  disabled,
  label,
  reason,
}: {
  rail: 'stripe' | 'flash';
  disabled: boolean;
  label: string;
  reason: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={reason}
      onClick={() => {
        // Phase 4 (stripe) / future (flash) wires this to payment-provider.charge(invoice).
      }}
      className="rounded-md px-3 py-1.5 text-xs font-medium border bg-background text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {label}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
