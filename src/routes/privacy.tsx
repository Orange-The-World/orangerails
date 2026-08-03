import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal/LegalPage";
import { PRIVACY } from "@/content/legal";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy | OrangeRails" },
      {
        name: "description",
        content:
          "What Orange Rails collects, what it never collects, and how long data is kept.",
      },
      { rel: "canonical", href: "https://orangerails.com/privacy" },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return <LegalPage doc={PRIVACY} />;
}
