import { ArrowRight } from "lucide-react";
import { Link } from "@tanstack/react-router";

/**
 * Small roadmap-style mention. MCP support is NOT shipped yet — it's a
 * planned feature on the public roadmap. Copy here is intentionally a
 * future-tense teaser, not a current capability claim, so the site
 * stays honest. Headline-level promotion lands the day MCP-α ships.
 */
export function McpTeaser() {
  return (
    <section className="border-t border-border/60 bg-card/40">
      <div className="mx-auto max-w-5xl px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            On the roadmap
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl text-balance">
            MCP for AI assistants
          </h2>
          <p className="mt-4 text-base text-muted-foreground sm:text-lg">
            We are building a Model Context Protocol layer so any wallet, exchange, or payment
            processor you connect through OrangeRails becomes available to ChatGPT, Claude, or
            Gemini with explicit per tool scopes. Read only by default. Write tools require user
            confirmation. Full audit log. Shipping in α.
          </p>
          <div className="mt-6">
            <Link
              to="/mcp"
              className="group inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80"
            >
              Read the design
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
