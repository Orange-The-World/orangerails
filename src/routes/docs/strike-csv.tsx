/**
 * /docs/strike-csv , How to export your Strike transaction CSV.
 *
 * Linked from the Strike history panel in the connect widget. Strike's
 * public API has no bulk transaction history endpoint, so activity from
 * before a customer connects can only be recovered from Strike's own CSV
 * export. The export menu is not obvious, hence this page.
 *
 * Deliberately does NOT tell the reader to upload the file in-app: that
 * control does not exist yet. Add the upload step here in the same PR
 * that ships it, not before.
 */

import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Clock, Download, RefreshCw } from "lucide-react";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";

export const Route = createFileRoute("/docs/strike-csv")({
  head: () => ({
    meta: [
      { title: "How to export your Strike CSV | OrangeRails docs" },
      {
        name: "description",
        content:
          "Step-by-step instructions for exporting your full Strike transaction history as CSV, and why Strike's API cannot provide it automatically.",
      },
      { property: "og:title", content: "How to export your Strike CSV | OrangeRails docs" },
      {
        property: "og:description",
        content:
          "Export your Strike transaction history as CSV from the Strike dashboard.",
      },
      { rel: "canonical", href: "https://orangerails.com/docs/strike-csv" },
    ],
  }),
  component: StrikeCsvPage,
});

interface ExportStep {
  title: string;
  body: string;
  detail?: string;
}

const steps: ExportStep[] = [
  {
    title: "Sign in on a desktop browser",
    body: "Go to dashboard.strike.me and sign in.",
    detail:
      "The CSV export is web only. It is not in the Strike mobile app today, so this step needs a computer.",
  },
  {
    title: "Open Activity",
    body: "In the left sidebar pick Activity. You land on a chronological feed of your transactions.",
  },
  {
    title: "Open the report panel",
    body: "In the top right of the Activity page, click Generate report. A side panel opens with two report types.",
    detail:
      "Account statement covers one calendar month. Annual transactions covers a whole calendar year. Both produce the same columns, the only difference is the date window.",
  },
  {
    title: "Pick the range, and check the format",
    body: "Choose the year or the month, confirm the format is CSV, then click Generate.",
    detail:
      "Strike may default statements to PDF. Switch it to CSV or the file will not import. Strike emails the file when it is ready and it is also downloadable from the panel.",
  },
  {
    title: "Save the files somewhere you can find them",
    body: "Keep every file you generate. You will need them in one place when you bring them across.",
    detail:
      "Bringing these files into your OrangeRails account is being built right now. This page gets the upload step the moment it ships.",
  },
];

const columns: Array<{ name: string; note: string }> = [
  { name: "Reference", note: "A unique id. This is what we match on so nothing is ever counted twice." },
  { name: "Date & Time (UTC)", note: "Strike's own date format, for example Nov 23 2023 15:12:48." },
  { name: "Transaction Type", note: "Deposit, Withdrawal, Receive, Send, Purchase or Sale." },
  { name: "Amount USD, Fee USD", note: "Signed. Negative when money left your account." },
  { name: "Amount BTC, Fee BTC", note: "Signed. Negative when bitcoin left your account." },
  { name: "BTC Price", note: "The USD price at the time of the trade. Only on Purchase and Sale." },
  { name: "Cost Basis (USD)", note: "Strike's reported cost basis. Only on Purchase." },
  { name: "Destination", note: "A Lightning invoice or an on-chain Bitcoin address. Not a person." },
  { name: "Description", note: "Strike's own memo, for example a bill payment name." },
  { name: "Transaction Hash", note: "The on-chain or Lightning hash." },
  { name: "Note", note: "Your own note, if you added one. Rarely populated." },
];

function StrikeCsvPage() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        <section className="border-b border-border/60">
          <div className="mx-auto max-w-3xl px-6 pt-14 pb-10">
            <Link
              to="/docs"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to docs
            </Link>
            <p className="mt-6 text-xs font-medium uppercase tracking-widest text-primary">
              Docs
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
              How to export your Strike CSV.
            </h1>
            <p className="mt-3 text-base text-muted-foreground sm:text-lg">
              Strike does not hand over your past transactions, so anything that
              happened before you connected has to come from Strike's own export.
              The menu is well hidden. Here is the exact path.
            </p>
          </div>
        </section>

        <section className="py-12">
          <div className="mx-auto max-w-3xl px-6 space-y-5">
            <div className="rounded-2xl border border-border bg-card/40 p-6">
              <div className="flex items-start gap-3">
                <Clock className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h2 className="text-base font-semibold">
                    Why this step exists at all.
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    This is a limit on Strike's side, not ours. Strike's public
                    API has no endpoint that lists your transaction history, and
                    there is no replay window for activity that landed before you
                    connected. Lightning Address tips are especially unreachable,
                    because Strike creates and deletes the receive request the tip
                    arrived against. Every accounting tool that integrates Strike
                    (Koinly, CoinLedger, CoinTracker) hits the same wall and uses
                    the same CSV workaround.
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-border bg-card/40 p-6">
              <div className="flex items-start gap-3">
                <RefreshCw className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h2 className="text-base font-semibold">
                    This is a one time job, not a routine.
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Everything from the moment you connect onwards arrives on its
                    own. Strike notifies us of each receive, send, deposit, payout
                    and exchange as it happens. The CSV is only ever about the
                    past.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-border/60 bg-card/20 py-16">
          <div className="mx-auto max-w-3xl px-6">
            <h2 className="text-2xl font-semibold tracking-tight">
              Exporting from Strike.
            </h2>
            <ol className="mt-8 space-y-8">
              {steps.map((s, i) => (
                <li key={s.title} className="flex items-start gap-4">
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-background text-sm font-semibold">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="text-base font-semibold">{s.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{s.body}</p>
                    {s.detail && (
                      <p className="mt-2 rounded-md border border-border/60 bg-background/60 p-3 text-xs text-muted-foreground">
                        {s.detail}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="py-16">
          <div className="mx-auto max-w-3xl px-6">
            <div className="rounded-2xl border border-border bg-card/40 p-6">
              <div className="flex items-start gap-3">
                <Download className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                <div>
                  <h2 className="text-base font-semibold">
                    Which files to grab, so you do not miss a year.
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Strike will not let you pick a range that spans several years,
                    so you have to take them one at a time. Export one Annual
                    transactions file for every full calendar year you were active,
                    then one Account statement for each month of the current year
                    so far. If you only export this year, every earlier year is
                    missing.
                  </p>
                </div>
              </div>
            </div>

            <h2 className="mt-12 text-xl font-semibold tracking-tight">
              What is actually in the file.
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Strike's export has thirteen columns. You do not need to edit any of
              them, and you should not: changing the header row is the quickest way
              to make a file unreadable.
            </p>
            <dl className="mt-6 space-y-3">
              {columns.map((c) => (
                <div
                  key={c.name}
                  className="rounded-md border border-border/60 bg-card/30 p-3"
                >
                  <dt className="font-mono text-xs font-semibold">{c.name}</dt>
                  <dd className="mt-1 text-sm text-muted-foreground">{c.note}</dd>
                </div>
              ))}
            </dl>

            <div className="mt-10 rounded-2xl border border-border bg-card/40 p-6">
              <h3 className="text-base font-semibold">Still stuck?</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Open a ticket at{" "}
                <a
                  href="https://docs.orangerails.com/support"
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                >
                  docs.orangerails.com/support
                </a>{" "}
                and tell us which year you are trying to export.
              </p>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
