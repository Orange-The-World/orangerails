import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal/LegalPage";
import { TERMS } from "@/content/legal";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms of Service | OrangeRails" },
      {
        name: "description",
        content:
          "The terms that govern use of Orange Rails Connect, the read-only financial data connector.",
      },
      { rel: "canonical", href: "https://orangerails.com/terms" },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return <LegalPage doc={TERMS} />;
}
