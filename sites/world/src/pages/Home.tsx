import { Link } from "react-router-dom";
import BtcUsdChart from "@/components/BtcUsdChart";
import PurchasingPowerChart from "@/components/PurchasingPowerChart";

export default function Home() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="text-xl font-bold text-orange">Orange the World</div>
          <nav className="flex gap-6 text-sm">
            <Link to="/docs" className="hover:text-orange">Docs</Link>
            <Link to="/signup" className="hover:text-orange">Get API Key</Link>
          </nav>
        </div>
      </header>

      <section className="max-w-4xl mx-auto px-6 py-24 text-center">
        <h1 className="text-5xl font-bold leading-tight">
          Free hard-money truth data.
          <br />
          <span className="text-orange">Open the orange door.</span>
        </h1>
        <p className="mt-6 text-lg text-slate-600 max-w-2xl mx-auto">
          Centuries of inflation, precious metals, monetary aggregates, and Bitcoin network
          metrics — open under CC-BY 4.0. Built on Orange Rails.
        </p>
        <div className="mt-10 flex gap-4 justify-center">
          <Link
            to="/signup"
            className="px-6 py-3 bg-orange text-white rounded-md hover:bg-orange-dark font-medium"
          >
            Get your free API key
          </Link>
          <Link
            to="/docs"
            className="px-6 py-3 border border-slate-300 rounded-md hover:bg-slate-50 font-medium"
          >
            Read the docs
          </Link>
        </div>
      </section>

      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <BtcUsdChart />
        </div>
        <p className="mt-3 text-center text-xs text-slate-400">
          One pair shown. The full open dataset covers 28 BTC/fiat pairs and centuries of inflation,
          metals, and monetary aggregates. See <a href="/data" className="text-orange hover:underline">/data</a>.
        </p>
      </section>

      <section className="max-w-5xl mx-auto px-6 pb-24">
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-slate-900">The reason the chart above matters.</h2>
          <p className="mt-2 text-slate-600 max-w-2xl mx-auto">
            A dollar in 1913 — the year the Federal Reserve opened — has lost most of its
            buying power. Here is what is left, by month, since then.
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <PurchasingPowerChart />
        </div>
      </section>

      <footer className="border-t border-slate-200 mt-24">
        <div className="max-w-6xl mx-auto px-6 py-8 text-sm text-slate-500 flex justify-between">
          <div>Orange the World — a free API on Orange Rails</div>
          <div>CC-BY 4.0 · V4V Lightning tips welcome</div>
        </div>
      </footer>
    </div>
  );
}
