import { Check } from "lucide-react";

export type Plan = {
  name: string;
  price: string;
  priceSub?: string;
  highlight?: boolean;
  cta: { label: string; href?: string };
  features: { text: string; emphasize?: boolean }[];
};

export function PricingCard({ plan }: { plan: Plan }) {
  return (
    <div
      className={`relative flex h-full flex-col rounded-2xl border p-6 transition-all sm:p-7 ${
        plan.highlight
          ? "border-primary/40 bg-background shadow-xl shadow-primary/10 ring-1 ring-primary/20"
          : "border-border bg-background hover:border-border/80"
      }`}
    >
      {plan.highlight && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-primary-foreground">
          Most popular
        </span>
      )}
      <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground">
        {plan.name}
      </h3>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-semibold tracking-tight sm:text-4xl">{plan.price}</span>
        {plan.priceSub && (
          <span className="text-sm text-muted-foreground">{plan.priceSub}</span>
        )}
      </div>

      <ul className="mt-6 flex-1 space-y-3 text-sm">
        {plan.features.map((f, i) => (
          <li
            key={i}
            className={`flex gap-2.5 ${
              f.emphasize ? "rounded-md bg-primary-soft px-2 py-1.5 -mx-2" : ""
            }`}
          >
            <Check
              className={`mt-0.5 h-4 w-4 shrink-0 ${
                f.emphasize ? "text-primary" : "text-success"
              }`}
              strokeWidth={3}
            />
            <span className={f.emphasize ? "font-medium text-foreground" : "text-foreground/85"}>
              {f.text}
            </span>
          </li>
        ))}
      </ul>

      <a
        href={plan.cta.href ?? "#waitlist"}
        className={`mt-7 inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors ${
          plan.highlight
            ? "bg-primary text-primary-foreground hover:bg-primary/90"
            : "border border-border bg-background hover:bg-muted"
        }`}
      >
        {plan.cta.label}
      </a>
    </div>
  );
}
