import { Check, X } from "lucide-react";

const problems = [
  {
    title: "Aggregators store credentials",
    body: "Your bank logins live on their servers, indefinitely.",
  },
  {
    title: "Aggregators see every transaction",
    body: "Every line item, every counterparty, visible in plaintext on their infrastructure.",
  },
  {
    title: "Plaid: $58M settlement",
    body: "In 2020 the largest consumer aggregator paid out for unauthorized data use. The business model is the industry default, not the exception.",
  },
];

const solutions = [
  {
    title: "Credentials encrypted",
    body: "AES-256-GCM, derived from your key. Never ours.",
    code: "AES-256-GCM",
  },
  {
    title: "Transactions stay encrypted",
    body: "Split connector architecture: descriptions never leave your device unencrypted.",
    code: "split connector",
  },
  {
    title: "No data moat",
    body: "Just infrastructure. Apache 2.0. Fork it, audit it, run it.",
    code: "Apache 2.0",
  },
];

export function PlaidProblem() {
  return (
    <section className="border-y border-border/60 bg-card/40 py-24">
      <div className="mx-auto max-w-6xl px-6">
        {/* Problem */}
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-widest text-destructive">The problem</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            Traditional aggregators monetize your data.
          </h2>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {problems.map((p) => (
            <div
              key={p.title}
              className="rounded-xl border border-border bg-background p-6 transition-colors hover:border-destructive/40"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-destructive/10 text-destructive">
                <X className="h-4 w-4" strokeWidth={3} />
              </div>
              <h3 className="mt-4 font-semibold">{p.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{p.body}</p>
            </div>
          ))}
        </div>

        {/* Divider */}
        <div className="my-16 flex items-center gap-4">
          <div className="h-px flex-1 bg-border" />
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            our approach
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>

        {/* Solution */}
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">The opposite</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            We took the opposite approach.
          </h2>
        </div>

        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {solutions.map((s) => (
            <div
              key={s.title}
              className="group relative rounded-xl border border-border bg-background p-6 transition-all hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-md bg-success/10 text-success">
                <Check className="h-4 w-4" strokeWidth={3} />
              </div>
              <h3 className="mt-4 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
              <code className="mt-4 inline-block rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground/80">
                {s.code}
              </code>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
