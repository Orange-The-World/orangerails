import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceLine,
} from "recharts";

type Row = { period: string; index: number };
type Series = "PPI" | "CPI" | "CPI-core";

const SERIES_META: Record<Series, { file: string; label: string; tooltip: string }> = {
  PPI: {
    file: "/data/us-ppi-monthly.json",
    label: "Producer prices (back to 1913)",
    tooltip: "FRED PPIACO — All Commodities. Starts the year the Federal Reserve opened.",
  },
  CPI: {
    file: "/data/us-cpi-monthly.json",
    label: "Consumer prices (back to 1947)",
    tooltip: "FRED CPIAUCSL — CPI for All Urban Consumers, all items.",
  },
  "CPI-core": {
    file: "/data/us-cpi-core-monthly.json",
    label: "Core CPI (back to 1957)",
    tooltip: "FRED CPILFESL — CPI ex food and energy. The number the Fed actually watches.",
  },
};

export default function PurchasingPowerChart() {
  const [series, setSeries] = useState<Series>("PPI");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    fetch(SERIES_META[series].file)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        const arr: Row[] = (j.data as [string, number][]).map(([period, index]) => ({
          period,
          index,
        }));
        setRows(arr);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [series]);

  const view = useMemo(() => {
    if (!rows || rows.length === 0) return [];
    const baseIndex = rows[0].index;
    return rows.map((r) => ({
      period: r.period,
      power: baseIndex / r.index,
    }));
  }, [rows]);

  const startYear = rows && rows.length > 0 ? rows[0].period.slice(0, 4) : "";
  const latestPower = view.length > 0 ? view[view.length - 1].power : null;
  const latestYear = rows && rows.length > 0 ? rows[rows.length - 1].period.slice(0, 4) : "";

  if (error) {
    return (
      <div className="text-sm text-slate-500">Chart unavailable ({error}).</div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <div>
          <div className="text-sm text-slate-500">
            Purchasing power of $1 since {startYear}
          </div>
          {latestPower !== null && (
            <div className="text-3xl font-bold text-slate-900">
              ${latestPower.toFixed(3)}
              <span className="ml-2 text-sm font-normal text-slate-500">
                {startYear} dollars left in {latestYear}
              </span>
            </div>
          )}
        </div>
        <div className="flex gap-1 text-xs">
          {(Object.keys(SERIES_META) as Series[]).map((s) => (
            <button
              key={s}
              onClick={() => setSeries(s)}
              title={SERIES_META[s].tooltip}
              className={
                "px-3 py-1 rounded-md border " +
                (series === s
                  ? "bg-orange text-white border-orange"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50")
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={view} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <defs>
              <linearGradient id="powerFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f97316" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#f97316" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="period"
              tick={{ fontSize: 11, fill: "#64748b" }}
              tickFormatter={(d: string) => d.slice(0, 4)}
              minTickGap={50}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "#64748b" }}
              tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              width={60}
              domain={[0, 1]}
            />
            <ReferenceLine y={1} stroke="#cbd5e1" strokeDasharray="3 3" />
            <Tooltip
              formatter={(v: number) => `$${v.toFixed(3)}`}
              labelFormatter={(d: string) => d}
              contentStyle={{ fontSize: 12, borderRadius: 6 }}
            />
            <Area
              type="monotone"
              dataKey="power"
              stroke="#f97316"
              strokeWidth={2}
              fill="url(#powerFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 text-xs text-slate-400">
        {SERIES_META[series].label}. Power = base / latest. Source: FRED (St Louis Fed). CC-BY 4.0.
      </div>
    </div>
  );
}
