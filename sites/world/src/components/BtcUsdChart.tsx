import { useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type DailyRow = { day: string; rate: number };
type Range = "1Y" | "5Y" | "ALL";
type Quote = "USD" | "EUR" | "GBP" | "JPY";

const RANGE_DAYS: Record<Range, number | null> = {
  "1Y": 365,
  "5Y": 365 * 5,
  ALL: null,
};

const QUOTE_SYMBOL: Record<Quote, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
};

function formatPrice(n: number, q: Quote): string {
  const sym = QUOTE_SYMBOL[q];
  if (n >= 1000) return sym + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return sym + n.toFixed(2);
  return sym + n.toFixed(4);
}

export default function BtcUsdChart() {
  const [rows, setRows] = useState<DailyRow[] | null>(null);
  const [range, setRange] = useState<Range>("ALL");
  const [quote, setQuote] = useState<Quote>("USD");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    fetch(`/data/btc-${quote.toLowerCase()}-daily.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j) => {
        if (cancelled) return;
        const arr: DailyRow[] = (j.data as [string, number][]).map(([day, rate]) => ({
          day,
          rate,
        }));
        setRows(arr);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "failed"));
    return () => {
      cancelled = true;
    };
  }, [quote]);

  const view = useMemo(() => {
    if (!rows) return [];
    const days = RANGE_DAYS[range];
    if (days === null) return rows;
    return rows.slice(-days);
  }, [rows, range]);

  const latest = rows && rows.length > 0 ? rows[rows.length - 1] : null;

  if (error) {
    return (
      <div className="text-sm text-slate-500">Chart unavailable ({error}).</div>
    );
  }

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
        <div>
          <div className="text-sm text-slate-500">BTC / {quote}</div>
          {latest && (
            <div className="text-3xl font-bold text-slate-900">
              {formatPrice(latest.rate, quote)}
              <span className="ml-2 text-sm font-normal text-slate-500">
                as of {latest.day}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1 items-end">
          <div className="flex gap-1 text-xs">
            {(Object.keys(QUOTE_SYMBOL) as Quote[]).map((q) => (
              <button
                key={q}
                onClick={() => setQuote(q)}
                className={
                  "px-3 py-1 rounded-md border " +
                  (quote === q
                    ? "bg-orange text-white border-orange"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50")
                }
              >
                {q}
              </button>
            ))}
          </div>
          <div className="flex gap-1 text-xs">
            {(Object.keys(RANGE_DAYS) as Range[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={
                  "px-3 py-1 rounded-md border " +
                  (range === r
                    ? "bg-orange text-white border-orange"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50")
                }
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={view} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
            <defs>
              <linearGradient id="btcFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#f97316" stopOpacity={0.4} />
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
              tickFormatter={(v: number) => {
                const sym = QUOTE_SYMBOL[quote];
                return v >= 1000 ? `${sym}${(v / 1000).toFixed(0)}k` : `${sym}${v.toFixed(0)}`;
              }}
              width={60}
              scale={range === "ALL" ? "log" : "auto"}
              domain={range === "ALL" ? [0.01, "auto"] : ["auto", "auto"]}
            />
            <Tooltip
              formatter={(v: number) => formatPrice(v, quote)}
              labelFormatter={(d: string) => d}
              contentStyle={{ fontSize: 12, borderRadius: 6 }}
            />
            <Area
              type="monotone"
              dataKey="rate"
              stroke="#f97316"
              strokeWidth={2}
              fill="url(#btcFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 text-xs text-slate-400">
        Source: ORBI daily close (open data, CC-BY 4.0). {rows?.length ?? 0} days
        of history.
      </div>
    </div>
  );
}
