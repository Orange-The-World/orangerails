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
 * Adding a new error code: add it here AND add a regex in
 * classifyUpstreamError(). Forgetting either side leaves the new code
 * surfacing as bare UPSTREAM_OTHER.
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

export const ERROR_CATALOG: Record<string, ErrorCatalogEntry> = {
  UPSTREAM_AUTH_FAILED: {
    title: "Your bank disconnected this account",
    body: "This usually happens when your bank password changed or the connection expired.",
    action: "Reconnect this account",
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  UPSTREAM_RATE_LIMITED: {
    title: "Your bank is briefly busy",
    body: "Your bank is asking us to slow down. This usually clears in 5 to 10 minutes.",
    action: null,
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  UPSTREAM_UNAVAILABLE: {
    title: "Your bank is temporarily unreachable",
    body: "Your bank's service is unreachable right now. Try again in a few minutes.",
    action: null,
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  UPSTREAM_BAD_REQUEST: {
    title: "Your bank rejected the request",
    body: "Your bank didn't accept the sync request. Reconnecting this account usually fixes it.",
    action: "Reconnect this account",
    help_url: "",  // TODO: re-enable once articles published to docs.orangerails.com
  },
  UPSTREAM_PARSE_FAILED: {
    title: "We couldn't read your bank's response",
    body: "Your bank sent data in a shape we did not expect. This is something we need to fix on our side.",
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
  // Strike webhook subscription could not be registered. Platform-side
  // failure: the copy is locked by the support catalog and must surface as a
  // platform error with no customer recovery action (no key rotation, no
  // scope change instruction). Ship verbatim.
  "STRIKE_SCOPE_MISSING_partner.webhooks.manage": {
    title: "We could not connect to Strike",
    body: "We could not connect to Strike. This is a platform issue on our end, not your account settings. Please try reconnecting once the fix is live.",
    action: null,
    help_url: "",
  },
};

/**
 * Lookup helper with a safe fallback so a missing entry never crashes the
 * sync flow. New code seen in the field still gets a reasonable message.
 */
export function lookupErrorCopy(code: string): ErrorCatalogEntry {
  return ERROR_CATALOG[code] ?? ERROR_CATALOG.UPSTREAM_OTHER;
}
