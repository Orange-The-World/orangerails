import { Check, X } from "lucide-react";

type Cell = boolean | string;

const competitors = ["Plaid", "Mesh Connect", "Vezgo", "Koinly", "OrangeRails"] as const;

const rows: { label: string; cells: Cell[] }[] = [
  { label: "Open source", cells: [false, false, false, false, true] },
  { label: "Bitcoin-first", cells: [false, false, false, false, true] },
  { label: "Books ready", cells: [false, false, false, "Tax only", true] },
  { label: "Zero-knowledge", cells: [false, false, false, false, true] },
  { label: "Self-hostable", cells: [false, false, false, false, true] },
  { label: "Published open spec", cells: [false, false, false, false, true] },
];

function CellRender({ value }: { value: Cell }) {
  if (value === true) {
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-success/10 text-success">
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
    );
  }
  if (value === false) {
    return (
      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <X className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span className="font-mono text-xs text-muted-foreground">{value}</span>
  );
}

export function Comparison() {
  return (
    <section className="border-y border-border/60 bg-card/40 py-24">
      <div className="mx-auto max-w-6xl px-6">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">Compared</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            How OrangeRails stacks up.
          </h2>
          <p className="mt-3 text-muted-foreground">
            Every other option asks you to trust a closed black box. We publish the spec and the source.
          </p>
        </div>

        <div className="mt-10 overflow-x-auto rounded-xl border border-border bg-background">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="w-1/4 px-5 py-4 text-left font-medium text-muted-foreground">
                  Capability
                </th>
                {competitors.map((c) => {
                  const isUs = c === "OrangeRails";
                  return (
                    <th
                      key={c}
                      className={`px-4 py-4 text-center text-sm font-semibold ${
                        isUs
                          ? "border-x border-primary/30 bg-primary-soft text-primary"
                          : "text-foreground"
                      }`}
                    >
                      {c}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.label}
                  className={`border-b border-border last:border-0 ${
                    i % 2 === 1 ? "bg-muted/40" : ""
                  }`}
                >
                  <td className="px-5 py-4 font-medium">{row.label}</td>
                  {row.cells.map((cell, idx) => {
                    const isUs = idx === competitors.length - 1;
                    return (
                      <td
                        key={idx}
                        className={`px-4 py-4 text-center ${
                          isUs ? "border-x border-primary/30 bg-primary-soft" : ""
                        }`}
                      >
                        <CellRender value={cell} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
