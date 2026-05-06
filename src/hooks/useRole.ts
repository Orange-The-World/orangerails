import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type Role = 'staff' | 'customer-admin' | 'end-user' | 'anonymous';

export interface RoleState {
  loading: boolean;
  role: Role;
  userId: string | null;
  email: string | null;
  customerId: string | null;
  customerName: string | null;
  customerType: 'individual' | 'team' | 'developer' | null;
}

const initialState: RoleState = {
  loading: true,
  role: 'anonymous',
  userId: null,
  email: null,
  customerId: null,
  customerName: null,
  customerType: null,
};

export function useRole(): RoleState {
  const [state, setState] = useState<RoleState>(initialState);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled) return;

      if (!user) {
        setState({ ...initialState, loading: false });
        return;
      }

      // The auto-generated Database type doesn't yet include staff_users
      // and customers (added by 20260505010000_admin_pages_schema.sql).
      // Narrow at the boundary instead of leaking 'any' through the hook.
      const db = supabase as unknown as {
        from: (table: string) => ReturnType<typeof supabase.from>;
      };
      const [staffResp, customerResp] = await Promise.all([
        db.from('staff_users').select('user_id').eq('user_id', user.id).maybeSingle(),
        db
          .from('customers')
          .select('id, name, customer_type')
          .eq('auth_user_id', user.id)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      const staffRow = staffResp.data as { user_id: string } | null;
      const customer = customerResp.data as
        | { id: string; name: string; customer_type: RoleState['customerType'] }
        | null;

      let role: Role = 'end-user';
      if (staffRow) role = 'staff';
      else if (customer) role = 'customer-admin';

      setState({
        loading: false,
        role,
        userId: user.id,
        email: user.email ?? null,
        customerId: customer?.id ?? null,
        customerName: customer?.name ?? null,
        customerType: customer?.customer_type ?? null,
      });
    }

    resolve();

    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      if (!cancelled) resolve();
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}
