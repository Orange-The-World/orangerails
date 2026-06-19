import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/auth";

type UsageRow = {
  ts: string;
  product: string;
  endpoint: string;
  status: number;
  latency_ms: number | null;
  rows_returned: number | null;
};

export default function Usage() {
  const usageQ = useQuery({
    queryKey: ["recent-usage"],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema("client_platform")
        .from("api_usage")
        .select("ts, product, endpoint, status, latency_ms, rows_returned")
        .order("ts", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as UsageRow[];
    },
  });

  if (usageQ.isLoading) return <div className="text-slate-600">Loading...</div>;
  if (usageQ.error) return <div className="text-red-600">Error: {usageQ.error.message}</div>;

  const rows = usageQ.data || [];

  return (
    <div>
      <h1 className="text-2xl font-bold">Usage</h1>
      <p className="mt-1 text-sm text-slate-600">Most recent 100 API calls.</p>

      {rows.length === 0 ? (
        <div className="mt-8 p-6 border border-dashed border-slate-300 rounded-lg text-slate-500 text-sm">
          No usage yet. Make your first API call to see it here.
        </div>
      ) : (
        <table className="mt-8 w-full text-sm">
          <thead className="text-left text-slate-500 border-b border-slate-200">
            <tr>
              <th className="pb-2 font-medium">When</th>
              <th className="pb-2 font-medium">Product</th>
              <th className="pb-2 font-medium">Endpoint</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Latency</th>
              <th className="pb-2 font-medium">Rows</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-slate-100">
                <td className="py-2 text-slate-500 text-xs">{new Date(r.ts).toLocaleString()}</td>
                <td className="py-2">{r.product}</td>
                <td className="py-2 font-mono text-xs">{r.endpoint}</td>
                <td className="py-2">
                  <span className={r.status >= 400 ? "text-red-700" : "text-slate-700"}>
                    {r.status}
                  </span>
                </td>
                <td className="py-2 text-slate-500">{r.latency_ms ? `${r.latency_ms}ms` : ","}</td>
                <td className="py-2 text-slate-500">{r.rows_returned ?? ","}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
