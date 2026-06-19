import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/auth";

type Key = {
  id: string;
  name: string;
  prefix: string;
  scopes: Record<string, unknown>;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  applications: { name: string; org_id: string } | null;
};

export default function Keys() {
  const keysQ = useQuery({
    queryKey: ["my-keys"],
    queryFn: async () => {
      const { data, error } = await supabase
        .schema("client_platform")
        .from("api_keys")
        .select("id, name, prefix, scopes, created_at, last_used_at, revoked_at, applications(name, org_id)")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as unknown as Key[];
    },
  });

  if (keysQ.isLoading) return <div className="text-slate-600">Loading...</div>;
  if (keysQ.error) return <div className="text-red-600">Error: {keysQ.error.message}</div>;

  const keys = keysQ.data || [];

  return (
    <div>
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">API keys</h1>
          <p className="mt-1 text-sm text-slate-600">
            Each key is shown once at creation. We only store its hash.
          </p>
        </div>
      </div>

      {keys.length === 0 ? (
        <div className="mt-8 p-6 border border-dashed border-slate-300 rounded-lg text-slate-500 text-sm">
          You don't have any keys yet. Sign up at{" "}
          <a href="https://orangetheworld.orangerails.com/signup" className="text-orange underline">
            orangetheworld.orangerails.com
          </a>{" "}
          to get your first one.
        </div>
      ) : (
        <table className="mt-8 w-full text-sm">
          <thead className="text-left text-slate-500 border-b border-slate-200">
            <tr>
              <th className="pb-2 font-medium">Key prefix</th>
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">App</th>
              <th className="pb-2 font-medium">Scopes</th>
              <th className="pb-2 font-medium">Last used</th>
              <th className="pb-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-slate-100">
                <td className="py-3 font-mono text-xs">{k.prefix}...</td>
                <td className="py-3">{k.name}</td>
                <td className="py-3">{k.applications?.name ?? ","}</td>
                <td className="py-3">{scopeBadges(k.scopes)}</td>
                <td className="py-3 text-slate-500">
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                </td>
                <td className="py-3">
                  {k.revoked_at ? (
                    <span className="text-red-700">revoked</span>
                  ) : (
                    <span className="text-green-700">active</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function scopeBadges(scopes: Record<string, unknown>): React.ReactNode {
  const enabled = Object.entries(scopes || {})
    .filter(([, v]) => v === true || (typeof v === "string" && v.length > 0))
    .map(([k]) => k);
  if (enabled.length === 0) return <span className="text-slate-400">none</span>;
  return (
    <span className="space-x-1">
      {enabled.map((s) => (
        <span key={s} className="inline-block px-2 py-0.5 text-xs bg-orange/10 text-orange rounded">
          {s}
        </span>
      ))}
    </span>
  );
}
