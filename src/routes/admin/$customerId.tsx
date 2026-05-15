import { createFileRoute, Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  fetchAuditEvents,
  fetchCustomer,
  fetchInvoices,
  fetchPayments,
  fetchSubscriptions,
  formatCents,
  type AuditEventRow,
  type CustomerRow,
  type InvoiceRow,
  type PaymentRow,
  type SubscriptionRow,
} from '@/lib/admin/queries';
import { formatError } from '@/lib/format-error';

export const Route = createFileRoute('/admin/$customerId')({
  component: AdminCustomerDetail,
});

interface DetailBundle {
  customer: CustomerRow;
  subscriptions: SubscriptionRow[];
  invoices: InvoiceRow[];
  payments: PaymentRow[];
  events: AuditEventRow[];
}

function AdminCustomerDetail() {
  const { customerId } = useParams({ from: '/admin/$customerId' });
  const [bundle, setBundle] = useState<DetailBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const customer = await fetchCustomer(customerId);
        if (!customer) {
          if (!cancelled) {
            setError('Customer not found');
            setLoading(false);
          }
          return;
        }
        const [subscriptions, invoices, payments, events] = await Promise.all([
          fetchSubscriptions(customerId),
          fetchInvoices(customerId),
          fetchPayments(customerId),
          fetchAuditEvents(customerId),
        ]);
        if (cancelled) return;
        setBundle({ customer, subscriptions, invoices, payments, events });
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

  if (loading) {
    return <CenteredText>Loading customer</CenteredText>;
  }

  if (error || !bundle) {
    return (
      <main className="px-6 py-8 max-w-4xl mx-auto">
        <Link to="/admin" className="text-sm text-primary hover:underline">
          &larr; Back to customers
        </Link>
        <p className="mt-4 text-sm text-red-600">{error ?? 'Customer not found'}</p>
      </main>
    );
  }

  const { customer, subscriptions, invoices, payments, events } = bundle;
  const balanceOpenCents = invoices
    .filter((i) => i.status === 'open')
    .reduce((sum, i) => sum + Number(i.amount_cents), 0);
  const totalPaidCents = payments
    .filter((p) => p.status === 'succeeded')
    .reduce((sum, p) => sum + Number(p.amount_cents), 0);

  return (
    <main className="px-6 py-8 max-w-4xl mx-auto space-y-6">
      <Link to="/admin" className="text-sm text-primary hover:underline">
        &larr; Back to customers
      </Link>

      <section className="rounded-lg border p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-semibold">{customer.name}</h2>
            <p className="text-sm text-muted-foreground mt-1">{customer.email}</p>
            <p className="text-xs text-muted-foreground mt-2">
              Joined {new Date(customer.created_at).toLocaleDateString()}
            </p>
          </div>
          <div className="text-right text-sm space-y-1">
            <p className="text-muted-foreground">Type: <span className="text-foreground">{customer.customer_type}</span></p>
            <p className="text-muted-foreground">Plan: <span className="text-foreground">{customer.plan}</span></p>
            <p className="text-muted-foreground">Status: <span className="text-foreground">{customer.status}</span></p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
          <SmallStat label="Open balance" value={formatCents(balanceOpenCents)} />
          <SmallStat label="Total paid"   value={formatCents(totalPaidCents)} />
          <SmallStat label="Invoices"     value={invoices.length.toString()} />
        </div>
      </section>

      <Section title="Subscriptions">
        {subscriptions.length === 0 ? (
          <Empty>No subscriptions.</Empty>
        ) : (
          <ul className="text-sm divide-y">
            {subscriptions.map((s) => (
              <li key={s.id} className="py-2 flex justify-between">
                <span>{s.plan}</span>
                <span className="text-muted-foreground">{s.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Invoices">
        {invoices.length === 0 ? (
          <Empty>No invoices.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left py-2">Date</th>
                <th className="text-left py-2">Amount</th>
                <th className="text-left py-2">Status</th>
                <th className="text-left py-2">Paid</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} className="border-t">
                  <td className="py-2">{new Date(i.created_at).toLocaleDateString()}</td>
                  <td className="py-2">{formatCents(Number(i.amount_cents), i.currency)}</td>
                  <td className="py-2">{i.status}</td>
                  <td className="py-2 text-muted-foreground">
                    {i.paid_at ? new Date(i.paid_at).toLocaleDateString() : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Payments">
        {payments.length === 0 ? (
          <Empty>No payments.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground">
              <tr>
                <th className="text-left py-2">Date</th>
                <th className="text-left py-2">Rail</th>
                <th className="text-left py-2">Amount</th>
                <th className="text-left py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="py-2">{new Date(p.created_at).toLocaleDateString()}</td>
                  <td className="py-2">{p.rail}</td>
                  <td className="py-2">{formatCents(Number(p.amount_cents), p.currency)}</td>
                  <td className="py-2">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Audit log">
        {events.length === 0 ? (
          <Empty>No audit events.</Empty>
        ) : (
          <ul className="text-sm divide-y">
            {events.map((e) => (
              <li key={e.id} className="py-2">
                <div className="flex justify-between">
                  <span className="font-medium">{e.event_type}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </span>
                </div>
                {Object.keys(e.payload).length > 0 && (
                  <pre className="mt-1 text-xs text-muted-foreground bg-muted/40 rounded p-2 overflow-x-auto">
                    {JSON.stringify(e.payload, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="text-xs text-muted-foreground italic">
        Phase 2 view is read only. Action buttons (pause, refund, change plan, message) land in Phase 5.
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-6">
      <h3 className="text-base font-semibold mb-3">{title}</h3>
      {children}
    </section>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold mt-1">{value}</p>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function CenteredText({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-6 py-12 text-center text-sm text-muted-foreground">{children}</div>
  );
}
