import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Row = { day: string; oz: number };

export default function BtcVsGoldChart() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logScale, setLogScale] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/data/btc-xau-daily.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        const arr: Row[] = (j.data as [string, number][]).map(([day, oz]) => ({
          day,
          oz,
        }));
        setRows(arr);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, []);

  const view = useMemo(() => rows ?? [], [rows]);
  const latest = view.length > 0 ? view[view.length - 1] : null;
  const start = view.length > 0 ? view[0] : null;
  const multiple =
    latest && start && start.oz > 0 ? latest.oz / start.oz : null;

  if (error) {
    return (
      <div className="text-sm text-slate-500">Chart unavailable ({error}).</div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <div>
          <div className="text-sm text-slate-500">Ounces of gold per Bitcoin</div>
          {latest && (
            <div className="text-3xl font-bold text-slate-900">
              {latest.oz.toFixed(2)} oz
              <span className="ml-2 text-sm font-normal text-slate-500">
                as of {latest.day}
              </span>
            </div>
          )}
          {multiple !== null && start && (
            <div className="mt-1 text-sm text-slate-500">
              {multiple >= 100
                ? `${multiple.toLocaleString(undefined, { maximumFractionDigits: 0 })}×`
                : `${multiple.toFixed(1)}×`}{" "}
              the gold one Bitcoin bought on {start.day}.
            </div>
          )}
        </div>
        <div className="flex gap-1 text-xs">
          <button
            onClick={() => setLogScale(false)}
            className={
              "px-3 py-1 rounded-md border " +
              (!logScale
                ? "bg-orange text-white border-orange"
                : "border-slate-300 text-slate-600 hover:bg-slate-50")
            }
          >
            Linear
          </button>
          <button
            onClick={() => setLogScale(true)}
            className={
              "px-3 py-1 rounded-md border " +
              (logScale
                ? "bg-orange text-white border-orange"
                : "border-slate-300 text-slate-600 hover:bg-slate-50")
            }
          >
            Log
          </button>
        </div>
      </div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={view} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <defs>
              <linearGradient id="goldFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f97316" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="day"
              tick={{ fontSize: 11, fill: "#64748b" }}
              tickFormatter={(d: string) => d.slice(0, 7)}
              minTickGap={40}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#64748b" }}
              tickFormatter={(v: number) =>
                v >= 1 ? `${v.toFixed(0)}` : v.toFixed(3)
              }
              width={55}
              scale={logScale ? "log" : "auto"}
              domain={logScale ? [0.0001, "auto"] : ["auto", "auto"]}
            />
            <Tooltip
              formatter={(v: number) => `${v.toFixed(3)} oz`}
              labelFormatter={(d: string) => d}
              contentStyle={{ fontSize: 12, borderRadius: 6 }}
            />
            <Area
              type="monotone"
              dataKey="oz"
              stroke="#f97316"
              strokeWidth={2}
              fill="url(#goldFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 text-xs text-slate-400">
        BTC/USD ÷ LBMA gold fix. Source: ORBI + LBMA. CC-BY 4.0. {view.length} fix days.
      </div>
    </div>
  );
}
