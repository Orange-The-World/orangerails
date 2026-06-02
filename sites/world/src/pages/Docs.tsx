export default function Docs() {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <h1 className="text-3xl font-bold">Truth Data API — Docs</h1>
      <p className="mt-2 text-slate-600">
        Docs land in Phase 1. Endpoints, examples, rate limits.
      </p>
      <div className="mt-8 p-4 bg-slate-50 border border-slate-200 rounded-md">
        <p className="text-sm text-slate-700">
          Available API surface (preview):
        </p>
        <ul className="mt-2 text-sm text-slate-600 list-disc pl-5 space-y-1">
          <li>GET /v1/truth/precious-metals</li>
          <li>GET /v1/truth/inflation</li>
          <li>GET /v1/truth/historical-money-prices</li>
          <li>GET /v1/truth/bitcoin-network</li>
          <li>GET /v1/truth/wages</li>
          <li>GET /v1/truth/monetary-aggregates</li>
          <li>GET /v1/truth/commodity-prices</li>
        </ul>
      </div>
    </div>
  );
}
