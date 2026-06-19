import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/auth";

type Org = { id: string; name: string; billing_email: string; status: string; created_at: string };
type Ent = { product: string; enabled_at: string };
type Usage24h = { product: string; calls: number };

export default function Overview() {
  const orgsQ = useQuery({
    queryKey: ["my-orgs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema("client_platform")
        .from("organizations")
        .select("id, name, billing_email, status, created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as Org[];
    },
  });

  const entQ = useQuery({
    queryKey: ["my-entitlements"],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema("client_platform")
        .from("organization_entitlements")
        .select("product, enabled_at");
      if (error) throw error;
      return data as Ent[];
    },
    enabled: !!orgsQ.data?.length,
  });

  const usageQ = useQuery({
    queryKey: ["usage-24h"],
    queryFn: async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .schema("client_platform")
        .from("api_usage")
        .select("product")
        .gte("ts", yesterday);
      if (error) throw error;
      const counts: Record<string, number> = {};
      (data as { product: string }[]).forEach((r) => {
        counts[r.product] = (counts[r.product] || 0) + 1;
      });
      return Object.entries(counts).map(([product, calls]) => ({ product, calls })) as Usage24h[];
    },
    enabled: !!orgsQ.data?.length,
  });

  if (orgsQ.isLoading) return <div className="text-slate-600">Loading...</div>;
  if (orgsQ.error) return <div className="text-red-600">Error: {orgsQ.error.message}</div>;

  const orgs = orgsQ.data || [];
  if (orgs.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold">Welcome to Orange Rails</h1>
        <p className="mt-2 text-slate-600">
          You're signed in but not linked to an organization yet. Sign up at{" "}
          <a href="https://orangetheworld.orangerails.com/signup" className="text-orange underline">
            orangetheworld.orangerails.com
          </a>{" "}
          to activate the Truth API on this account.
        </p>
      </div>
    );
  }

  const org = orgs[0];
  const entitlements = entQ.data || [];
  const usage = usageQ.data || [];

  return (
    <div>
      <h1 className="text-2xl font-bold">{org.name}</h1>
      <p className="text-sm text-slate-500">{org.billing_email}</p>

      <div className="mt-8 grid grid-cols-3 gap-4">
        <Card label="Status">
          <span className={org.status === "active" ? "text-green-700" : "text-amber-700"}>
            {org.status}
          </span>
        </Card>
        <Card label="Products enabled">
          {entitlements.length === 0 ? (
            <span className="text-slate-400">none</span>
          ) : (
            <ul className="space-y-1">
              {entitlements.map((e) => (
                <li key={e.product} className="text-sm">
                  <span className="font-medium">{labelForProduct(e.product)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card label="API calls (last 24h)">
          {usage.length === 0 ? (
            <span className="text-slate-400">0</span>
          ) : (
            <ul className="space-y-1">
              {usage.map((u) => (
                <li key={u.product} className="text-sm">
                  <span className="font-medium">{labelForProduct(u.product)}:</span>{" "}
                  {u.calls.toLocaleString()}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-12">
        <h2 className="text-lg font-semibold">Quick start</h2>
        <div className="mt-3 p-4 bg-slate-50 border border-slate-200 rounded-md">
          <p className="text-sm text-slate-700">
            Your API keys live in the <strong>API keys</strong> tab. Once you have one, call:
          </p>
          <pre className="mt-3 text-xs overflow-x-auto">{`curl -H "Authorization: Bearer YOUR_KEY" \\
  "${import.meta.env.VITE_ORANGERAILS_SUPABASE_URL}/functions/v1/world-gateway/bitcoin-network?limit=5"`}</pre>
        </div>
      </div>
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="p-4 border border-slate-200 rounded-lg">
      <div className="text-xs text-slate-500 uppercase tracking-wide">{label}</div>
      <div className="mt-2 text-base">{children}</div>
    </div>
  );
}

function labelForProduct(p: string): string {
  return p === "truth" ? "Orange the World" : p === "orbi" ? "ORBI" : p === "or" ? "Orange Rails" : p;
}
