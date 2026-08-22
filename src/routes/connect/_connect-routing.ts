/**
 * Pure routing helper for the /connect widget provider step decision (DL-1007).
 *
 * The slug check MUST run before the connectUrl check. Stealth-inline providers
 * (sparrow, xpub) do not carry a connectUrl in their manifests: routing on
 * connectUrl alone made the stealth-inline branch unreachable, causing sparrow
 * to render an empty credential form and xpub to lose the or-link-success post
 * path that notifies the host app of a completed connection.
 */

import { isStealthInlineSlug } from "./_stealth-inline-init";

/**
 * Determine the next step for a provider resolved from the /connect widget.
 *
 * Priority:
 *   1. Stealth-inline slug (sparrow, xpub) -> "stealth-inline" regardless of connectUrl.
 *   2. Any other provider with a connectUrl -> "navigate" to that URL.
 *   3. Everything else -> "credential-form" (generic field entry).
 */
export function resolveConnectStep(
  slug: string | undefined | null,
  connectUrl: string | undefined | null,
): "stealth-inline" | "navigate" | "credential-form" {
  if (isStealthInlineSlug(slug)) return "stealth-inline";
  if (connectUrl) return "navigate";
  return "credential-form";
}
