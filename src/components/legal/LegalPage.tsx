import { Navbar } from "@/components/landing/Navbar";
import { Footer } from "@/components/landing/Footer";
import { fillLegalCopy, LEGAL_VALUES, type LegalDocument } from "@/content/legal";

interface LegalPageProps {
  doc: LegalDocument;
}

/**
 * Renders a legal document from src/content/legal.ts.
 *
 * Every string passes through fillLegalCopy, so the five governance-owned
 * values are substituted in exactly one place. Nothing here decides what
 * the copy says; edit the content file for that.
 */
export function LegalPage({ doc }: LegalPageProps) {
  return (
    <div className="min-h-screen bg-background text-foreground antialiased">
      <Navbar />

      <main>
        <section className="border-b border-border/60">
          <div className="mx-auto max-w-3xl px-6 pt-14 pb-10">
            <p className="text-xs font-medium uppercase tracking-widest text-primary">
              Legal
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
              {fillLegalCopy(doc.title)}
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Effective {fillLegalCopy(LEGAL_VALUES.effectiveDate)}
            </p>
            {doc.intro.map((p) => (
              <p key={p} className="mt-4 text-base text-muted-foreground">
                {fillLegalCopy(p)}
              </p>
            ))}
          </div>
        </section>

        <section className="py-12">
          <div className="mx-auto max-w-3xl px-6 space-y-10">
            {doc.sections.map((s) => (
              <section key={s.heading}>
                <h2 className="text-lg font-semibold tracking-tight">
                  {fillLegalCopy(s.heading)}
                </h2>
                {s.body.map((p) => (
                  <p key={p} className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {fillLegalCopy(p)}
                  </p>
                ))}
              </section>
            ))}

            <p className="border-t border-border/60 pt-6 text-xs text-muted-foreground">
              Questions about this page: {fillLegalCopy(LEGAL_VALUES.contactEmail)}
            </p>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
