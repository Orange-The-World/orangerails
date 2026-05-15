import { ArrowRight } from "lucide-react";
import { Link } from "@tanstack/react-router";

export function BetaInvite() {
  return (
    <section className="border-y border-border/60 bg-primary-soft">
      <div className="mx-auto max-w-4xl px-6 py-14 text-center">
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">
          In beta. Inviting people to join.
        </p>
        <h2 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl text-balance">
          Value for value.
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-base text-muted-foreground">
          The connector itself is free and open source. Locked backup, recovery, AI access, and
          accountant flow are the paid add ons.
        </p>
        <div className="mt-7">
          <Link
            to="/signup"
            search={{ ref: "beta-landing" } as never}
            className="group inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Join the beta
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
        </div>
      </div>
    </section>
  );
}
