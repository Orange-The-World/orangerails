import { useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

const emailSchema = z
  .string()
  .trim()
  .min(1, "Please enter your email")
  .email("That doesn't look like a valid email")
  .max(255, "Email is too long");

export function WaitlistCta() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

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
    });
    setLoading(false);

    if (error) {
      if (error.code === "23505") {
        toast.success("You're already on the list. We'll be in touch.");
        setEmail("");
        return;
      }
      toast.error("Something went wrong. Please try again.");
      return;
    }

    toast.success("You're on the list. We'll email when the OSS repo drops.");
    setEmail("");
  };

  return (
    <section id="waitlist" className="bg-primary text-primary-foreground">
      <div className="mx-auto max-w-4xl px-6 py-20 text-center">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
          Be first to connect.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-base text-primary-foreground/85">
          Join the waitlist for hosted access. Self-host now from GitHub.
        </p>

        <form
          onSubmit={handleSubmit}
          className="mx-auto mt-8 flex max-w-md flex-col gap-2 sm:flex-row"
        >
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
        </form>

        <p className="mx-auto mt-4 max-w-md text-xs text-primary-foreground/75">
          We'll email you once. No marketing spam. Unsubscribe is a single click.
        </p>
      </div>
    </section>
  );
}
