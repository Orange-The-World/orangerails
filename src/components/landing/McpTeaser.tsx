import { ArrowRight, Sparkles } from "lucide-react";
import { Link } from "@tanstack/react-router";

export function McpTeaser() {
  return (
    <section className="border-t border-border/60 bg-foreground text-background">
      <div className="mx-auto max-w-5xl px-6 py-20">
        <div className="mx-auto max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-xs font-medium uppercase tracking-widest text-primary">
            <Sparkles className="h-3 w-3" />
            New
          </div>
          <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            First aggregator with an MCP layer.
          </h2>
          <p className="mt-5 text-base text-background/80 sm:text-lg">
            Connect any wallet, exchange, or bank to ChatGPT, Claude, or Gemini with explicit per
            tool scopes. Read only by default. Write tools require user confirmation. Full audit
            log.
          </p>
          <div className="mt-7">
            <Link
              to="/mcp"
              className="group inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Learn more
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
