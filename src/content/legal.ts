/**
 * Legal copy for /terms and /privacy.
 *
 * Source of truth for the prose is the Lawyer's draft; this file is the
 * wired version of it. Two rules for anyone editing:
 *
 *  1. The five values in LEGAL_VALUES are owned by legal and governance.
 *     Fill them here and nowhere else. Every appearance in the prose is a
 *     bracket tag that is substituted at render time.
 *
 *  2. The build refuses to run while any bracket tag survives anywhere in
 *     this file (scripts/check-legal-placeholders.mjs). That is deliberate:
 *     a legal page that ships reading "[JURISDICTION]" is worse than no
 *     page at all, so the guard fails the build rather than the reader.
 *
 * Do not soften the "as is" disclaimer in Terms section 6 or the liability
 * limit in section 7 without the Lawyer's sign off. Both are the floor for
 * a financial data connector.
 */

export interface LegalValues {
  /** Legal entity name. Terms header and section 5, Privacy section 10. */
  companyLegalName: string;
  /** Governing law state or country. Terms section 9. */
  jurisdiction: string;
  /** Legal and privacy contact address. Both pages. */
  contactEmail: string;
  /** Date these pages go live. Both page headers. */
  effectiveDate: string;
  /**
   * Days until connection data is deleted after a connection closes.
   * Privacy section 5. This number must match the retention window stated
   * in the connector disclosure. If the two ever disagree, the policy is
   * a promise we are breaking, so change both or neither.
   */
  retentionDays: string;
}

export const LEGAL_VALUES: LegalValues = {
  companyLegalName: "[COMPANY LEGAL NAME]",
  jurisdiction: "[JURISDICTION]",
  contactEmail: "[CONTACT EMAIL]",
  effectiveDate: "[EFFECTIVE DATE]",
  retentionDays: "[N]",
};

/** Maps a bracket tag as written in the prose to its LegalValues key. */
const TAG_TO_KEY: Record<string, keyof LegalValues> = {
  "[COMPANY LEGAL NAME]": "companyLegalName",
  "[JURISDICTION]": "jurisdiction",
  "[CONTACT EMAIL]": "contactEmail",
  "[EFFECTIVE DATE]": "effectiveDate",
  "[N]": "retentionDays",
};

/**
 * Substitutes every known bracket tag in a line of prose.
 *
 * Unknown tags are left alone on purpose: they will still be visible, and
 * the build guard will have already refused the build, so an unknown tag
 * can only appear in a local dev session where seeing it is the point.
 */
export function fillLegalCopy(text: string, values: LegalValues = LEGAL_VALUES): string {
  let out = text;
  for (const [tag, key] of Object.entries(TAG_TO_KEY)) {
    out = out.split(tag).join(values[key]);
  }
  return out;
}

export interface LegalSection {
  heading: string;
  /** Paragraphs. Rendered in order, one <p> each. */
  body: string[];
}

export interface LegalDocument {
  title: string;
  intro: string[];
  sections: LegalSection[];
}

export const TERMS: LegalDocument = {
  title: "Orange Rails Connect, Terms of Service",
  intro: [
    "These terms govern your use of Orange Rails Connect (the \"Service\"), provided by [COMPANY LEGAL NAME] (\"Orange Rails,\" \"we,\" or \"us\"). By using the Service you agree to these terms.",
  ],
  sections: [
    {
      heading: "1. What the Service Does",
      body: [
        "Orange Rails Connect is a financial data connector. It retrieves transaction and account data from financial providers you choose (each, a \"Provider\") and delivers that data to the application you authorize. Orange Rails acts as a read-only data bridge; it does not hold, invest, or transmit your funds.",
      ],
    },
    {
      heading: "2. Your Credentials",
      body: [
        "Your Provider passwords, private keys, and seed phrases are never transmitted to or stored on Orange Rails servers. Connection tokens issued by Providers for ongoing access are encrypted and scoped to data retrieval only.",
      ],
    },
    {
      heading: "3. Acceptable Use",
      body: [
        "You may use the Service for personal or business financial data aggregation. You may not: (a) access accounts you are not authorized to use; (b) scrape, reverse-engineer, or resell the Service; (c) violate any applicable law; or (d) interfere with the integrity or performance of the Service.",
      ],
    },
    {
      heading: "4. Third-Party Providers",
      body: [
        "Your relationship with each Provider is governed by that Provider's own terms. Orange Rails is not responsible for Provider outages, data errors, or changes to Provider APIs.",
      ],
    },
    {
      heading: "5. Open Source",
      body: [
        "The core Orange Rails connector engine is released under the Apache 2.0 License (github.com/Orange-The-World/orangerails). These Terms govern use of the hosted Service, not the open-source software itself.",
      ],
    },
    {
      heading: "6. No Warranty",
      body: [
        "THE SERVICE IS PROVIDED \"AS IS\" WITHOUT WARRANTY OF ANY KIND. ORANGE RAILS DOES NOT GUARANTEE THE ACCURACY, COMPLETENESS, OR TIMELINESS OF FINANCIAL DATA RETRIEVED THROUGH THE SERVICE. DO NOT RELY ON THIS DATA AS YOUR SOLE BASIS FOR FINANCIAL DECISIONS.",
      ],
    },
    {
      heading: "7. Limitation of Liability",
      body: [
        "TO THE MAXIMUM EXTENT PERMITTED BY LAW, ORANGE RAILS IS NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES ARISING FROM YOUR USE OF THE SERVICE, INCLUDING ANY FINANCIAL LOSSES.",
      ],
    },
    {
      heading: "8. Changes and Termination",
      body: [
        "We may update these Terms or discontinue the Service with reasonable notice. We may suspend or terminate access if you violate these Terms.",
      ],
    },
    {
      heading: "9. Governing Law",
      body: [
        "These Terms are governed by the laws of [JURISDICTION]. Disputes shall be resolved in the courts of [JURISDICTION].",
      ],
    },
    {
      heading: "10. Contact",
      body: ["[CONTACT EMAIL]"],
    },
  ],
};

export const PRIVACY: LegalDocument = {
  title: "Orange Rails Connect, Privacy Policy",
  intro: [
    "This policy describes what data Orange Rails collects, why we collect it, and how long we keep it.",
  ],
  sections: [
    {
      heading: "1. What We Collect",
      body: [
        "Connection data: Provider name, account identifiers, and scoped access tokens needed to retrieve your data.",
        "Transaction and balance data: The financial records your Provider returns when we fetch on your behalf.",
        "Usage logs: Request timestamps and Provider endpoints called, sufficient to operate and debug the Service. We do not log transaction amounts or counterparty identifiers in our infrastructure logs.",
        "Session data: IP address, browser type, and session tokens.",
      ],
    },
    {
      heading: "2. What We Do Not Collect",
      body: [
        "We do not collect or store your Provider passwords, private keys, or seed phrases. Our architecture ensures these credentials are never transmitted to or stored on our servers.",
      ],
    },
    {
      heading: "3. How We Use Your Data",
      body: [
        "To connect to your Provider and retrieve your requested data. To deliver that data to the application you authorized. To operate, maintain, and improve the Service.",
        "We do not sell your financial data to third parties.",
      ],
    },
    {
      heading: "4. Data Sharing",
      body: [
        "We share your data only: (a) with the application you expressly authorized to receive it; (b) with Providers to establish and maintain your connection; or (c) as required by law.",
      ],
    },
    {
      heading: "5. Data Retention",
      body: [
        "We retain connection tokens and retrieved financial data while your connection is active. After you close a connection, associated data is deleted within [N] days. Usage logs are retained for up to 90 days for operational purposes, then deleted.",
      ],
    },
    {
      heading: "6. Security",
      body: [
        "Connection tokens are encrypted at rest. Data in transit uses TLS. We scope tokens to the minimum permissions required by each Provider.",
      ],
    },
    {
      heading: "7. Your Rights",
      body: [
        "You may disconnect any Provider at any time through the connect interface, which revokes our access token. To request deletion of your data, contact us at [CONTACT EMAIL].",
      ],
    },
    {
      heading: "8. Open Source",
      body: [
        "The Orange Rails connector engine is open source (Apache 2.0). You can inspect the code at github.com/Orange-The-World/orangerails.",
      ],
    },
    {
      heading: "9. Changes to This Policy",
      body: [
        "We will update the effective date when this policy changes materially. Continued use of the Service after a material change constitutes acceptance of the updated policy.",
      ],
    },
    {
      heading: "10. Contact",
      body: ["[CONTACT EMAIL]", "[COMPANY LEGAL NAME]"],
    },
  ],
};
