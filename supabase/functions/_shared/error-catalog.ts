/**
 * Customer-facing copy + recommended action for every error code that
 * or-sync can return per-connection. Keyed by the upstream taxonomy code
 * produced by classifyUpstreamError(). Clients (V2, OWM, OWB) render the
 * title + body + action, and use help_url to deep-link customers into the
 * support knowledge base.
 *
 * Why this lives in OR (not in each client):
 *   Three apps consume the same error codes. Maintaining one catalog here
 *   keeps tone + wording + KB URLs in sync across products.
 *
 * Adding a new error code: add it here AND teach classifyUpstreamError() in
 * _shared/upstream-errors.ts to produce it, either by mapping a provider
 * error class or by adding a regex. Forgetting either side leaves the new
 * code surfacing as bare UPSTREAM_OTHER.
 */

export interface ErrorCatalogEntry {
  /** Plain-English title customers see at the top of the error toast / modal. */
  title: string;
  /** One- or two-sentence explanation in plain English. No jargon, no codes. */
  body: string;
  /**
   * Action label rendered as the primary button or link. Null means there
   * is no customer-facing action -- only "contact support".
   */
  action: string | null;
  /** Deep link to the support knowledge base article for this error. */
  help_url: string;
}

// const KB_BASE = "https://docs.orangerails.com/sync";  // restore when KB articles ship

// Copy is deliberately PROVIDER-NEUTRAL (product decision, DL-0421).
//
// Every entry here used to say "your bank". OR connects to 98 crypto
// exchanges through the CCXT adapter as well as to banks, so a Bitstamp
// customer whose API key was rejected was told "Your bank disconnected this
// account". The alternative considered was a provider dimension on this
// catalog; that was rejected because it eventually means ~100 copy variants
// to keep in tone with each other. Wording that is true for a bank, an
// exchange, and a node is worth more than wording that is vivid for one.
export const ERROR_CATALOG: Record<string, ErrorCatalogEntry> = {
  UPSTREAM_AUTH_FAILED: {
    title: "This account needs to be reconnected",
    body: "We can no longer sign in to this account. This usually happens when a password or API key was changed, expired, or is missing a permission it needs.",
    action: "Reconnect this account",
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  UPSTREAM_RATE_LIMITED: {
    title: "This account is briefly busy",
    body: "We are being asked to slow down. This usually clears in 5 to 10 minutes.",
    action: null,
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  UPSTREAM_UNAVAILABLE: {
    title: "This account is temporarily unreachable",
    body: "The service behind this account is unreachable right now, or is briefly down for maintenance. Try again in a few minutes.",
    action: null,
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  UPSTREAM_BAD_REQUEST: {
    title: "This sync request was rejected",
    body: "The service behind this account didn't accept the sync request. Reconnecting this account usually fixes it.",
    action: "Reconnect this account",
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  UPSTREAM_PARSE_FAILED: {
    title: "We couldn't read the response",
    body: "This account sent data in a shape we did not expect. This is something we need to fix on our side.",
    action: null,
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  ADAPTER_CONFIG_ERROR: {
    title: "Connection setup incomplete",
    body: "This account is missing some configuration. Reconnect it and complete every step of the setup flow.",
    action: "Reconnect this account",
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  UPSTREAM_OTHER: {
    title: "Something went wrong",
    body: "We hit an unexpected error syncing this account. Try again in a few minutes. If it keeps happening, contact support and share the reference code below.",
    action: null,
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
};

/**
 * Lookup helper with a safe fallback so a missing entry never crashes the
 * sync flow. New code seen in the field still gets a reasonable message.
 */
export function lookupErrorCopy(code: string): ErrorCatalogEntry {
  return ERROR_CATALOG[code] ?? ERROR_CATALOG.UPSTREAM_OTHER;
}
