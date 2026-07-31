/**
 * Pure response construction for or-quiltt-accounts.
 *
 * This lives in its own module rather than in index.ts on purpose. index.ts
 * calls Deno.serve at import time, so anything that imports it binds a port
 * as a side effect of being tested. Keeping the transform here means the
 * response contract can be asserted against fixtures with no server, no
 * network, and no credential.
 *
 * Everything in here is the part of DL-0326 that was previously unprovable:
 * the CLOSED denylist, the null-state warn-and-include, the per-account
 * connection passthrough, and the three counters.
 */

export interface QuilttAccount {
  id: string;
  name: string;
  mask: string | null;
  kind: string | null;
  state: string | null;
  currencyCode: string | null;
  institution: { name: string } | null;
  balance: { current: number | null; available: number | null } | null;
  connection?: { id: string; status: string } | null;
}

export interface MappedAccount {
  id: string;
  name: string;
  institution_name: string | null;
  kind: string | null;
  mask: string | null;
  currency: string | null;
  state: string | null;
  balance_current: number | null;
  balance_available: number | null;
  connection: { id: string; status: string } | null;
}

export interface AccountsResponse {
  accounts: MappedAccount[];
  total_returned: number;
  excluded_closed: number;
  distinct_states: (string | null)[];
  source_disagreement: number;
}

export interface MergedAccountSet {
  accounts: QuilttAccount[];
  only_in_root: string[];
  only_in_connections: string[];
}

/**
 * Union the two account sources the profile-wide query asks for.
 *
 * The profile-wide branch of this endpoint means "every account under this
 * profile". Quiltt exposes that directly as the root `accounts` field. The
 * original implementation instead flattened `connections { accounts }`, which
 * makes the answer depend on whatever the `connections` list returns by
 * default, and Quiltt's public schema reference documents `ConnectionFilter`
 * without documenting the no-filter default. Neither source can be shown from
 * outside to be the complete one.
 *
 * So this asks for both in a single document and returns the union, keyed by
 * account id. A union can never return fewer accounts than either source
 * alone, which is the same fail-open direction the CLOSED denylist takes and
 * for the same reason: undercounting accounts is the defect this ticket exists
 * for.
 *
 * The two id lists are the measurement. If they are ever non-empty in
 * production, that is the undocumented default becoming visible, and it
 * answers the question without a call to Quiltt.
 */
export function mergeAccountSets(
  fromRoot: QuilttAccount[],
  fromConnections: QuilttAccount[],
): MergedAccountSet {
  const rootIds = new Set(fromRoot.map((a) => a.id));
  const connIds = new Set(fromConnections.map((a) => a.id));

  const accounts = [...fromRoot];
  for (const a of fromConnections) {
    if (!rootIds.has(a.id)) accounts.push(a);
  }

  const onlyInRoot = fromRoot.filter((a) => !connIds.has(a.id)).map((a) => a.id);
  const onlyInConnections = fromConnections.filter((a) => !rootIds.has(a.id)).map((a) => a.id);

  if (onlyInRoot.length > 0 || onlyInConnections.length > 0) {
    console.warn(
      `[or-quiltt-accounts] account sources disagree: ${onlyInRoot.length} account(s) only in ` +
        `root accounts (ids: ${onlyInRoot.join(', ') || 'none'}), ${onlyInConnections.length} ` +
        `only in flattened connections (ids: ${onlyInConnections.join(', ') || 'none'}): ` +
        `returning the union`,
    );
  }

  return { accounts, only_in_root: onlyInRoot, only_in_connections: onlyInConnections };
}

/**
 * Build the 200 body from whatever Quiltt returned.
 *
 * Contract, in the order the checks apply:
 *   1. Accounts with a missing state are logged by id and INCLUDED. Dropping
 *      rows on uncertainty is the original DL-0326 bug class, so the only
 *      acceptable direction to be wrong in is failing open.
 *   2. Only CLOSED is excluded. This is a denylist over an enum we do not
 *      own; a state Quiltt adds later must appear in the response rather
 *      than vanish from it.
 *   3. The counters describe the set BEFORE filtering, so a caller can tell
 *      "Quiltt returned few" apart from "OR dropped many" without our logs.
 *   4. `source_disagreement` counts accounts that only one of the two profile
 *      wide sources listed. It is 0 for the single-connection path, which has
 *      one source. Non-zero means the two Quiltt roots do not agree and the
 *      union saved an account from being dropped.
 */
export function buildAccountsResponse(
  rawAccounts: QuilttAccount[],
  sourceDisagreement = 0,
): AccountsResponse {
  const nullStateAccounts = rawAccounts.filter((a) => !a.state);
  if (nullStateAccounts.length > 0) {
    console.warn(
      `[or-quiltt-accounts] ${nullStateAccounts.length} account(s) returned a null or empty state ` +
        `(ids: ${nullStateAccounts.map((a) => a.id).join(', ')}): including them in the response`,
    );
  }

  const totalReturned = rawAccounts.length;
  const excludedClosed = rawAccounts.filter((a) => a.state === 'CLOSED').length;
  const distinctStates = [...new Set(rawAccounts.map((a) => a.state))];

  const accounts: MappedAccount[] = rawAccounts
    .filter((a) => a.state !== 'CLOSED')
    .map((a) => ({
      id: a.id,
      name: a.name,
      institution_name: a.institution?.name ?? null,
      kind: a.kind ?? null,
      mask: a.mask ?? null,
      currency: a.currencyCode ?? null,
      state: a.state,
      balance_current: a.balance?.current ?? null,
      balance_available: a.balance?.available ?? null,
      connection: a.connection ? { id: a.connection.id, status: a.connection.status } : null,
    }));

  return {
    accounts,
    total_returned: totalReturned,
    excluded_closed: excludedClosed,
    distinct_states: distinctStates,
    source_disagreement: sourceDisagreement,
  };
}
