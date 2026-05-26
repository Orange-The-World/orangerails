import { ArrowRight } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { Adapter } from "@/data/integrations";

const statusStyles: Record<Adapter["status"], string> = {
  Available: "bg-success/10 text-success ring-success/20",
  Beta: "bg-primary/10 text-primary ring-primary/20",
  Planned: "bg-muted text-muted-foreground ring-border",
};

export function AdapterCard({ adapter }: { adapter: Adapter }) {
  const initials = adapter.name
    .replace(/[^a-zA-Z]/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="group flex h-full flex-col rounded-xl border border-border bg-background p-6 transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5">
      <div className="flex items-start justify-between">
        <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-soft font-mono text-sm font-semibold text-primary ring-1 ring-primary/15">
          {initials}
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${statusStyles[adapter.status]}`}
        >
          {adapter.status}
        </span>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <h3 className="font-semibold leading-tight">{adapter.name}</h3>
      </div>
      <span className="mt-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
        {adapter.category}
      </span>

      <p className="mt-3 text-sm text-muted-foreground">{adapter.description}</p>

      {adapter.connectUrl ? (
        <Link
          to={adapter.connectUrl}
          className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-primary transition-opacity hover:opacity-90"
        >
          Connect
          <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </Link>
      ) : (
        <span className="mt-5 inline-flex items-center gap-1 text-sm font-medium text-muted-foreground">
          {adapter.status === "Planned" ? "Coming soon" : "Docs"}
        </span>
      )}
    </div>
  );
}
