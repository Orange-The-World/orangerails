import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  fetchAdminTopStats,
  fetchCustomers,
  formatCents,
  type AdminTopStats,
  type CustomerRow,
} from '@/lib/admin/queries';
import { formatError } from '@/lib/format-error';

export const Route = createFileRoute('/admin/')({
  component: AdminListPage,
});

function AdminListPage() {
  const [stats, setStats] = useState<AdminTopStats | null>(null);
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'' | CustomerRow['customer_type']>('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, c] = await Promise.all([fetchAdminTopStats(), fetchCustomers()]);
        if (cancelled) return;
        setStats(s);
        setCustomers(c);
      } catch (err) {
        if (!cancelled) setError(formatError(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = filter ? customers.filter((c) => c.customer_type === filter) : customers;

  return (
    <main className="px-6 py-8 max-w-6xl mx-auto">
      <section className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total customers"      value={stats ? stats.totalCustomers.toString() : '—'} />
        <Stat label="Paying customers"     value={stats ? stats.payingCustomers.toString() : '—'} />
        <Stat label="Collected this month" value={stats ? formatCents(stats.collectedThisMonthCents) : '—'} />
        <Stat label="Overdue"              value={stats ? formatCents(stats.overdueCents) : '—'} />
      </section>

      <section className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Customers</h2>
          <div className="flex gap-1 text-xs">
            {(['', 'individual', 'team', 'developer'] as const).map((f) => (
              <button
                key={f || 'all'}
                onClick={() => setFilter(f)}
                className={`px-3 py-1 rounded border ${filter === f ? 'bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'}`}
              >
                {f || 'all'}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-lg border overflow-hidden">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading customers</div>
          ) : error ? (
            <div className="p-6 text-sm text-red-600">Error: {error}</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">
              No customers yet. Run <code className="text-xs">scripts/admin-seed-dev.sql</code> in the
              Supabase SQL editor to populate fake data.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide">
                <tr>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Type</Th>
                  <Th>Plan</Th>
                  <Th>Status</Th>
                  <Th>Joined</Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30">
                    <Td>
                      <Link
                        to="/admin/$customerId"
                        params={{ customerId: c.id }}
                        className="text-primary hover:underline"
                      >
                        {c.name}
                      </Link>
                    </Td>
                    <Td>{c.email}</Td>
                    <Td>{c.customer_type}</Td>
                    <Td>{c.plan}</Td>
                    <Td><StatusPill status={c.status} /></Td>
                    <Td>{new Date(c.created_at).toLocaleDateString()}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left px-4 py-2 font-medium text-muted-foreground">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3">{children}</td>;
}

function StatusPill({ status }: { status: CustomerRow['status'] }) {
  const colors: Record<CustomerRow['status'], string> = {
    active:    'bg-green-100 text-green-800',
    overdue:   'bg-amber-100 text-amber-800',
    suspended: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-800',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colors[status]}`}>
      {status}
    </span>
  );
}
