/**
 * Public interactive demo for orangerails.app.
 *
 * Shows a visitor what connecting and syncing a Bitcoin wallet through
 * Stealth Sync looks like, without needing their own wallet or any real
 * network calls. Drives the real, unmodified `ProgressModal` component
 * (src/stealth/widget/components/ProgressModal.tsx, the same one real
 * users see mid-sync) with a scripted sequence instead of a live sync, so
 * this demo can never silently drift from what the real progress UI
 * looks like: any copy change to that component shows up here too.
 *
 * No real xpub, no real network calls to the real block-source or
 * filter-CDN services, no Supabase calls. See
 * src/stealth/lib/demo-fixtures.ts for the canned data.
 */

import { useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { ProgressModal } from "@/stealth/widget/components/ProgressModal";
import type { StealthStage } from "@/stealth/lib/postmessage";
import {
  DEMO_XPUB,
  DEMO_TRANSACTIONS,
  formatSats,
  type DemoTransaction,
} from "@/stealth/lib/demo-fixtures";

export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title: "See it work | OrangeRails" },
      {
        name: "description",
        content:
          "Watch a Bitcoin wallet connect and sync through Stealth Sync, OrangeRails' connector that gives you self-custody of your data. This is a simulated demo with sample data, no wallet needed.",
      },
      { property: "og:title", content: "See Orange Rails work, no wallet needed" },
      {
        property: "og:description",
        content:
          "A real look at the Stealth Sync flow, with sample data. Nothing here touches a real wallet.",
      },
      { rel: "canonical", href: "https://orangerails.app/demo" },
    ],
  }),
  component: DemoPage,
});

type DemoState = "landing" | "progress" | "complete";

// One scripted step per stage: [stage, duration_ms, percent-at-end].
// Timings are compressed from the real performance budget documented in
// docs/Stealth-Sync.md (recent-activity sync: 1-3s) into something that
// reads well as a demo, several seconds total, not real-time-accurate,
// clearly a demo, not a claim about real sync speed.
const SCRIPT: Array<{ stage: StealthStage; ms: number; detail?: string }> = [
  { stage: "unlocking", ms: 500 },
  { stage: "deriving", ms: 700, detail: "40 addresses ready" },
  {
    stage: "fetching_filters",
    ms: 1800,
    detail:
      "About 4 MB across 13,011 small files. We do not upload anything, these files are public.",
  },
  { stage: "matching", ms: 600 },
  { stage: "fetching_blocks", ms: 900, detail: "6 blocks need to be downloaded." },
  { stage: "building_txs", ms: 700 },
  { stage: "sealing", ms: 500 },
  { stage: "uploading", ms: 500 },
];

function useDemoScript(running: boolean, onDone: () => void) {
  const [stage, setStage] = useState<StealthStage>("unlocking");
  const [percent, setPercent] = useState(0);
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (!running) return;
    let stepIndex = 0;
    let cancelled = false;

    function runStep() {
      if (cancelled) return;
      if (stepIndex >= SCRIPT.length) {
        onDone();
        return;
      }
      const step = SCRIPT[stepIndex];
      setStage(step.stage);
      setDetail(step.detail);
      setPercent(0);

      const tickMs = 60;
      const ticks = Math.max(1, Math.round(step.ms / tickMs));
      let tick = 0;
      const interval = window.setInterval(() => {
        tick += 1;
        setPercent(Math.min(100, Math.round((tick / ticks) * 100)));
        if (tick >= ticks) {
          window.clearInterval(interval);
          stepIndex += 1;
          runStep();
        }
      }, tickMs);
      timeoutRef.current = interval;
    }

    runStep();
    return () => {
      cancelled = true;
      if (timeoutRef.current !== null) window.clearInterval(timeoutRef.current);
    };
    // onDone is intentionally omitted below: it is a stable setState
    // wrapper from the parent, including it would restart the whole
    // scripted sequence on every parent re-render, which is not the
    // intended behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  return { stage, percent, detail };
}

function TransactionRow({ tx }: { tx: DemoTransaction }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2 pr-4 text-sm text-muted-foreground">{tx.occurredAt}</td>
      <td className="py-2 pr-4 text-sm">
        <span
          className={
            tx.direction === "in" ? "text-emerald-600 dark:text-emerald-400" : "text-foreground"
          }
        >
          {tx.direction === "in" ? "Received" : "Sent"}
        </span>
      </td>
      <td className="py-2 pr-4 text-sm font-mono">{formatSats(tx.amountSats)}</td>
      <td className="py-2 text-xs text-muted-foreground font-mono truncate max-w-[160px]">
        {tx.address}
      </td>
    </tr>
  );
}

// Plain-English walkthrough. Consolidates the 8 SCRIPT stages into 6
// reader-facing steps (building_txs folds into the fetch/parse step,
// uploading folds into seal-and-store). If SCRIPT changes, revisit this list.
const STEPS: Array<{ title: string; body: string }> = [
  {
    title: "Unlock",
    body: "Your encrypted vault, the sealed store that holds your wallet details, opens in your browser with your password. The key is never sent to our servers.",
  },
  {
    title: "Derive addresses",
    body: "The wallet's public key is expanded into its receiving addresses, locally. Nothing is sent anywhere.",
  },
  {
    title: "Download public filter files",
    body: "Your browser fetches small summary files of recent Bitcoin blocks. They are the same public files for every user and every wallet, so the files themselves reveal nothing about your addresses. (See the caveat below on what traffic patterns can show.)",
  },
  {
    title: "Match in your browser",
    body: "The addresses are checked against those summaries on your own machine. This is the step other tools outsource to someone else's server. We never see it.",
  },
  {
    title: "Fetch only matching blocks",
    body: "Full blocks are downloaded only where a summary showed a possible match, then parsed locally to pull out the wallet's real transactions.",
  },
  {
    title: "Seal and store",
    body: "The results are encrypted in your browser before upload. What our server stores is sealed bytes it cannot open. Only your apps, with your key, can read them.",
  },
];

const COMPARISONS: Array<{ title: string; how: string; cost: string }> = [
  {
    title: "Paste your xpub into a block explorer",
    how: "The explorer's server expands your wallet and looks up every address for you.",
    cost: "That one paste hands over your full balance, your entire history, and every future transaction, tied to your IP address. You are trusting them to never log it, forever.",
  },
  {
    title: "Let a sync service hold your xpub",
    how: "A server stores your wallet's public key and scans the chain on your behalf.",
    cost: "Their database becomes a map of your finances. One breach, subpoena, or bad employee exposes everything, and you may never know it happened.",
  },
  {
    title: "Stealth Sync",
    how: "Your browser does the scan itself, using the same public files everyone downloads, and seals the results before they leave your machine.",
    cost: "Our server stores sealed bytes it cannot open. Your addresses, balances, and history stay yours. Self-custody for your data, the same way your keys work.",
  },
];

function ExplainerSection() {
  return (
    <div className="mx-auto max-w-2xl px-6 pb-20">
      <h2 className="text-xl font-semibold text-foreground">What is actually happening</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        The simulated sync, step by step, in plain English. For a real wallet this all runs in the
        user's own browser.
      </p>
      <ol className="mt-4 space-y-3">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {i + 1}
            </span>
            <div>
              <p className="text-sm font-medium text-foreground">{s.title}</p>
              <p className="text-sm text-muted-foreground">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <h2 className="mt-12 text-xl font-semibold text-foreground">
        Why not just look the wallet up somewhere?
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Unless you run your own Bitcoin node, syncing a wallet usually means showing it to someone.
        Here is the honest comparison.
      </p>
      <div className="mt-4 space-y-4">
        {COMPARISONS.map((c, i) => (
          <div
            key={c.title}
            className={
              i === COMPARISONS.length - 1
                ? "rounded-lg border-2 border-primary/40 bg-primary/5 p-4"
                : "rounded-lg border border-border p-4"
            }
          >
            <p className="text-sm font-semibold text-foreground">{c.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{c.how}</p>
            <p className="mt-2 text-sm text-muted-foreground">{c.cost}</p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        One honest caveat: like any website, our server could observe traffic patterns such as which
        block ranges a browser fetches. It cannot see your addresses or your keys, and it does not
        learn which transactions in those blocks are yours. The stored results stay sealed.
      </p>
    </div>
  );
}

function DemoPage() {
  const [state, setState] = useState<DemoState>("landing");
  const { stage, percent, detail } = useDemoScript(state === "progress", () =>
    setState("complete"),
  );

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <div className="sticky top-0 z-50 bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100">
        Demo mode: this is a simulated sync using sample data. No real wallet is connected.
      </div>
      <Navbar />
      <main className="flex-1">
        {state === "landing" && (
          <div className="mx-auto max-w-2xl px-6 py-20 text-center">
            <h1 className="text-3xl font-semibold text-foreground sm:text-4xl">
              Watch a Bitcoin wallet connect, without connecting your own.
            </h1>
            <p className="mt-4 text-base text-muted-foreground">
              This is the exact screen a real user sees when they add a wallet through Stealth Sync,
              OrangeRails' connector that gives you self-custody of your data. Below is a simulated
              run with sample data, no wallet needed, so you can see the real screen end to end.
            </p>
            <button
              type="button"
              onClick={() => setState("progress")}
              className="mt-8 inline-flex items-center rounded-md bg-primary px-6 py-3 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Watch it work
            </button>
            <p className="mt-3 text-xs text-muted-foreground">
              Sample xpub shown below is a demo fixture, not a real key.
            </p>
            <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground/70">
              {DEMO_XPUB}
            </p>
          </div>
        )}

        {state === "progress" && (
          <ProgressModal stage={stage} percent={percent} detailOverride={detail} />
        )}

        {state === "complete" && (
          <div className="mx-auto max-w-2xl px-6 py-16">
            <h2 className="text-2xl font-semibold text-foreground">That's the whole flow.</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Six sample transactions, matched and decrypted entirely in the browser above.
            </p>
            <div className="mt-6 overflow-x-auto rounded-lg border border-border">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
                    <th className="py-2 pr-4">Date</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Amount</th>
                    <th className="py-2">Address</th>
                  </tr>
                </thead>
                <tbody>
                  {DEMO_TRANSACTIONS.map((tx) => (
                    <TransactionRow key={tx.txid} tx={tx} />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-8 rounded-lg border border-border bg-muted/30 p-5">
              <h3 className="text-sm font-semibold text-foreground">
                What this demonstrates for a real wallet
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                The screen above is simulated, no real wallet was involved. For a real wallet, this
                same screen means OrangeRails' server never sees which addresses match it. The
                server only ever sees sealed bytes it cannot open. The matching, the block parsing,
                and the encryption all run in the user's own browser.
              </p>
              <a
                href="/docs"
                className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
              >
                Read how to connect your own app to Orange Rails to see the technical docs.
              </a>
            </div>

            <button
              type="button"
              onClick={() => setState("landing")}
              className="mt-6 text-sm text-muted-foreground hover:text-foreground underline"
            >
              Watch it again
            </button>
          </div>
        )}
        {state !== "progress" && <ExplainerSection />}
      </main>
      <Footer />
    </div>
  );
}
