import xpubPlaceholder from "@/assets/xpub-explainer-placeholder.svg";

export function XpubExplainer() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-5xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-primary">
            How it works
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl text-balance">
            How an xpub stays private.
          </h2>
          <p className="mt-4 text-base text-muted-foreground">
            Your wallet's public key never leaves your browser.{" "}
            <span
              aria-disabled="true"
              className="text-primary/70 underline decoration-dotted underline-offset-2"
              title="The 30 second walkthrough is coming soon."
            >
              Watch the 30 second walkthrough
            </span>
          </p>
        </div>

        <div className="mt-12 overflow-hidden rounded-xl border border-border bg-card">
          <img
            src={xpubPlaceholder}
            alt="Diagram showing your wallet's public key staying inside your browser while only scrambled bytes reach the OrangeRails server."
            className="h-auto w-full"
          />
        </div>
      </div>
    </section>
  );
}
