import { ArrowRight, Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Terminal } from "./Terminal";

export function Hero() {
  const scrollToWaitlist = () => {
    document.getElementById("waitlist")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <section className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 grid-bg opacity-60 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-16 lg:grid-cols-2 lg:gap-16 lg:pt-24">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary-soft px-3 py-1 text-xs font-medium uppercase tracking-widest text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            OrangeRails
          </div>

          <h1 className="mt-5 text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.5rem] lg:leading-[1.05]">
            The rails every Bitcoin business <span className="text-primary">runs on</span>.
          </h1>

          <p className="mt-5 max-w-xl text-balance text-base text-muted-foreground sm:text-lg">
            Open source. Zero knowledge. Built for Bitcoin. The alternative to Plaid that
            <span className="text-foreground"> can't read your data</span> — because it can't.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="lg" onClick={scrollToWaitlist} className="group">
              Join the Waitlist
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="#" target="_blank" rel="noreferrer">
                <Github className="h-4 w-4" />
                View on GitHub
              </a>
            </Button>
          </div>

          <ul className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
            <Badge>Apache 2.0</Badge>
            <Badge>Self-hostable</Badge>
            <Badge>Zero-knowledge by design</Badge>
          </ul>
        </div>

        <div className="lg:pl-4">
          <Terminal />
        </div>
      </div>
    </section>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="h-1 w-1 rounded-full bg-primary" />
      <span>{children}</span>
    </li>
  );
}
