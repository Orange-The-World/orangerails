import { supabase } from '@/integrations/supabase/client';

// Local types for the admin tables. The auto-generated Database types
// won't include these until the migration has been applied and types
// regenerated. Once that's done these can be replaced with imports
// from '@/integrations/supabase/types'.

export type CustomerType = 'individual' | 'team' | 'developer';
export type CustomerStatus = 'active' | 'overdue' | 'suspended' | 'cancelled';

export interface CustomerRow {
  id: string;
  auth_user_id: string | null;
  name: string;
  email: string;
  customer_type: CustomerType;
  plan: string;
  status: CustomerStatus;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionRow {
  id: string;
  customer_id: string;
  plan: string;
  status: 'trialing' | 'active' | 'past_due' | 'cancelled';
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
  updated_at: string;
}

export interface InvoiceRow {
  id: string;
  customer_id: string;
  subscription_id: string | null;
  amount_cents: number;
  currency: string;
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  due_date: string | null;
  paid_at: string | null;
  stripe_invoice_id: string | null;
  hosted_invoice_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRow {
  id: string;
  invoice_id: string;
  customer_id: string;
  rail: 'stripe' | 'flash';
  amount_cents: number;
  currency: string;
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  provider_payment_id: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEventRow {
  id: string;
  actor_user_id: string | null;
  customer_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface AdminTopStats {
  totalCustomers: number;
  payingCustomers: number;
  collectedThisMonthCents: number;
  overdueCents: number;
}

// Cast helper. The generated Database type doesn't know about the new
// admin tables yet, so we narrow at the boundary instead of sprinkling
// `any` through the components.
const db = supabase as unknown as {
  from: (table: string) => ReturnType<typeof supabase.from>;
};

export async function fetchCustomers(): Promise<CustomerRow[]> {
  const { data, error } = await db
    .from('customers')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as CustomerRow[];
}

export async function fetchCustomer(customerId: string): Promise<CustomerRow | null> {
  const { data, error } = await db
    .from('customers')
    .select('*')
    .eq('id', customerId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as CustomerRow) ?? null;
}

export async function fetchSubscriptions(customerId: string): Promise<SubscriptionRow[]> {
  const { data, error } = await db
    .from('subscriptions')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as SubscriptionRow[];
}

export async function fetchInvoices(customerId: string): Promise<InvoiceRow[]> {
  const { data, error } = await db
    .from('invoices')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as InvoiceRow[];
}

export async function fetchPayments(customerId: string): Promise<PaymentRow[]> {
  const { data, error } = await db
    .from('payments')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as PaymentRow[];
}

export async function fetchAuditEvents(customerId: string): Promise<AuditEventRow[]> {
  const { data, error } = await db
    .from('audit_events')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as unknown as AuditEventRow[];
}

export async function fetchAdminTopStats(): Promise<AdminTopStats> {
  const customers = await fetchCustomers();

  const totalCustomers = customers.length;
  const payingCustomers = customers.filter(
    (c) => c.status === 'active' || c.status === 'overdue',
  ).length;

  const startOfMonth = new Date();
  startOfMonth.setUTCDate(1);
  startOfMonth.setUTCHours(0, 0, 0, 0);

  const { data: paid, error: paidErr } = await db
    .from('payments')
    .select('amount_cents,status,created_at')
    .eq('status', 'succeeded')
    .gte('created_at', startOfMonth.toISOString());
  if (paidErr) throw paidErr;

  const collectedThisMonthCents = ((paid ?? []) as unknown as PaymentRow[]).reduce(
    (sum, p) => sum + Number(p.amount_cents),
    0,
  );

  const { data: overdue, error: overdueErr } = await db
    .from('invoices')
    .select('amount_cents,status')
    .eq('status', 'open');
  if (overdueErr) throw overdueErr;

  const overdueCents = ((overdue ?? []) as unknown as InvoiceRow[]).reduce(
    (sum, i) => sum + Number(i.amount_cents),
    0,
  );

  return {
    totalCustomers,
    payingCustomers,
    collectedThisMonthCents,
    overdueCents,
  };
}

export function formatCents(cents: number, currency = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}
