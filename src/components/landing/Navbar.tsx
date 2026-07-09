import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Github } from "lucide-react";
import { Button } from "@/components/ui/button";

type NavLink =
  | { kind: "internal"; to: string; label: string }
  | { kind: "external"; href: string; label: string };

// Marketing site lives in a separate repo at https://orangerails.com.
// Pages here are served from there, so the links are external. A
// click from inside the integrator app cleanly leaves to marketing.
const navLinks: NavLink[] = [
  { kind: "external", href: "https://orangerails.com/integrations", label: "Integrations" },
  { kind: "external", href: "https://orangerails.com/pricing", label: "Pricing" },
  { kind: "internal", to: "/docs", label: "Docs" },
  { kind: "external", href: "https://orangerails.com/open-source", label: "Open Source" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToWaitlist = () => {
    const el = document.getElementById("waitlist");
    if (el) {
      el.scrollIntoView({ behavior: "smooth" });
    } else {
      window.location.href = "/#waitlist";
    }
  };

  return (
    <header
      className={`sticky top-0 z-50 w-full transition-all duration-200 ${
        scrolled
          ? "border-b border-border bg-background/80 backdrop-blur-md"
          : "border-b border-transparent bg-background/40 backdrop-blur-sm"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <img
            src="/favicon.svg"
            alt=""
            aria-hidden
            className="h-6 w-6"
            width={24}
            height={24}
          />
          <span className="text-lg">OrangeRails</span>
        </Link>

        <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
          {navLinks.map((link) =>
            link.kind === "internal" ? (
              <Link
                key={link.to}
                to={link.to}
                className="transition-colors hover:text-foreground"
                activeProps={{ className: "text-foreground" }}
              >
                {link.label}
              </Link>
            ) : (
              <a
                key={link.href}
                href={link.href}
                className="transition-colors hover:text-foreground"
              >
                {link.label}
              </a>
            ),
          )}
        </nav>

        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
            <a href="https://github.com/Orange-The-World/orangerails" target="_blank" rel="noreferrer">
              <Github className="h-4 w-4" />
              GitHub
            </a>
          </Button>
          <Button size="sm" onClick={scrollToWaitlist}>
            Join Beta
          </Button>
        </div>
      </div>
    </header>
  );
}
