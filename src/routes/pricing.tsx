import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Github, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: "Pricing — request beta access | OrangeRails" },
      {
        name: "description",
        content:
          "OrangeRails is in private beta. Self host is free under Apache 2.0. Hosted access opens later this year. Request beta access or email us.",
      },
      { property: "og:title", content: "Pricing — request beta access | OrangeRails" },
      {
        property: "og:description",
        content:
          "OrangeRails is in private beta. Self host is free. Request beta access for hosted.",
      },
      { property: "og:image", content: "/og-image.jpg" },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:title", content: "Pricing — request beta access | OrangeRails" },
      {
        name: "twitter:description",
        content: "OrangeRails is in private beta. Self host free. Request beta for hosted.",
      },
      { name: "twitter:image", content: "/og-image.jpg" },
      { rel: "canonical", href: "https://orangerails.com/pricing" },
    ],
  }),
  component: PricingPage,
});

function PricingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 grid-bg opacity-60 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />

          <div className="relative mx-auto max-w-3xl px-6 py-24 text-center">
            <p className="text-xs font-medium uppercase tracking-widest text-primary">
              Pricing
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              Public pricing is on the way.
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
              OrangeRails is in private beta. The source opens in Q3, and the hosted
              tiers go public alongside it. Self hosting is free, forever, under Apache 2.0.
              For everything else, send us an email and let&apos;s have a conversation.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button asChild size="lg" className="group">
                <Link to="/#waitlist">
                  Request beta access
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="mailto:hello@orangerails.com">
                  <Mail className="h-4 w-4" />
                  Email us
                </a>
              </Button>
            </div>

            <div className="mt-12 grid gap-4 text-left sm:grid-cols-2">
              <a
                href="https://github.com/MorningRevolution/orangerails"
                target="_blank"
                rel="noreferrer"
                className="group rounded-xl border border-border bg-card p-5 transition-colors hover:bg-card/80"
              >
                <Github className="h-5 w-5 text-primary" />
                <h3 className="mt-4 font-semibold">Self host, free forever</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Same code we run. Docker and Helm. Apache 2.0. Audit it, fork it,
                  host it on your own metal.
                </p>
              </a>
              <Link
                to="/#waitlist"
                className="group rounded-xl border border-border bg-card p-5 transition-colors hover:bg-card/80"
              >
                <Mail className="h-5 w-5 text-primary" />
                <h3 className="mt-4 font-semibold">Hosted, in private beta</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Public pricing arrives with the Q3 source drop. In the meantime,
                  join the waitlist and we&apos;ll set you up.
                </p>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
