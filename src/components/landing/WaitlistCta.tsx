import { useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Github, BookOpen, MessagesSquare, Loader2, ArrowRight, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const USE_CASES = [
  "Personal Bitcoin accounting",
  "Small business / merchant",
  "Mining operation",
  "Bitcoin bank / exchange",
  "Accounting firm with BTC clients",
  "Developer / integrator",
  "Other",
] as const;

const emailSchema = z
  .string()
  .trim()
  .min(1, "Please enter your email")
  .email("That doesn't look like a valid email")
  .max(255);

export function WaitlistCta() {
  const [email, setEmail] = useState("");
  const [useCase, setUseCase] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid email");
      return;
    }
    setLoading(true);
    const { error } = await supabase.from("waitlist").insert({
      email: parsed.data.toLowerCase(),
      source: "landing",
      use_case: useCase || null,
    });
    setLoading(false);
    if (error) {
      if (error.code === "23505") {
        toast.success("You're already on the list. We'll be in touch.");
        setSubmitted(true);
        return;
      }
      toast.error("Something went wrong. Please try again.");
      return;
    }
    toast.success("You're on the list. We'll email when the OSS repo drops.");
    setSubmitted(true);
  };

  return (
    <section id="waitlist" className="bg-primary text-primary-foreground">
      <div className="mx-auto max-w-4xl px-6 py-20 text-center">
        {!submitted ? (
          <>
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
              Be first to connect.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-base text-primary-foreground/85">
              Join the waitlist for hosted access. Self-host now from GitHub.
            </p>

            <form onSubmit={handleSubmit} className="mx-auto mt-8 flex max-w-md flex-col gap-2">
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="email"
                  required
                  placeholder="you@yourcompany.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  maxLength={255}
                  className="h-11 flex-1 rounded-md border border-white/20 bg-white/10 px-4 text-sm text-primary-foreground placeholder:text-primary-foreground/60 outline-none transition-colors focus:border-white/60 focus:bg-white/15 disabled:opacity-60"
                />
                <Button
                  type="submit"
                  variant="secondary"
                  size="lg"
                  disabled={loading}
                  className="h-11 bg-foreground text-background hover:bg-foreground/90"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Join waitlist"}
                </Button>
              </div>

              <Select value={useCase} onValueChange={setUseCase} disabled={loading}>
                <SelectTrigger className="h-11 border-white/20 bg-white/10 text-sm text-primary-foreground hover:bg-white/15 focus:border-white/60 [&>span]:text-primary-foreground/80 data-[placeholder]:[&>span]:text-primary-foreground/60">
                  <SelectValue placeholder="What are you building? (optional)" />
                </SelectTrigger>
                <SelectContent>
                  {USE_CASES.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </form>

            <p className="mx-auto mt-4 max-w-md text-xs text-primary-foreground/75">
              We'll email you once. No marketing spam. Unsubscribe is a single click.
            </p>
          </>
        ) : (
          <PostSignup />
        )}
      </div>
    </section>
  );
}

function PostSignup() {
  const cards = [
    {
      icon: Github,
      title: "Star us on GitHub",
      body: "Track the build in public. The OSS repo drops at v0.1.",
      href: "#",
    },
    {
      icon: BookOpen,
      title: "Read the docs",
      body: "Quickstart, API reference, and self-hosting guide.",
      href: "/docs",
    },
    {
      icon: MessagesSquare,
      title: "Join the community",
      body: "Discord and Telegram — say hi, ask anything.",
      href: "#",
    },
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-foreground/15">
        <CheckCircle2 className="h-6 w-6" />
      </div>
      <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
        You're on the list.
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-primary-foreground/85">
        We'll email when the OSS repo drops. While you wait — three things worth doing:
      </p>

      <div className="mt-10 grid gap-4 text-left sm:grid-cols-3">
        {cards.map((c) => (
          <a
            key={c.title}
            href={c.href}
            className="group flex h-full flex-col rounded-xl bg-primary-foreground/10 p-5 ring-1 ring-primary-foreground/15 transition-colors hover:bg-primary-foreground/15"
          >
            <c.icon className="h-5 w-5" />
            <h3 className="mt-4 font-semibold">{c.title}</h3>
            <p className="mt-1 flex-1 text-sm text-primary-foreground/85">{c.body}</p>
            <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium">
              Go
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
