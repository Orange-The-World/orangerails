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

/**
 * Which Quiltt roots actually produced the account set in this response.
 *
 *   union             both roots were asked and the answer is their union.
 *                     This is the only value under which the two sources were
 *                     compared, so it is the only value under which
 *                     `source_disagreement` is a number.
 *   connections_only  the union document was rejected and the connections-only
 *                     retry answered instead. NOT a comparison.
 *   single_connection the caller named one connection. One source by
 *                     construction, so there is nothing to compare.
 */
export type AccountSource = 'union' | 'connections_only' | 'single_connection';

export interface AccountsResponse {
  accounts: MappedAccount[];
  total_returned: number;
  excluded_closed: number;
  distinct_states: (string | null)[];
  account_source: AccountSource;
  source_disagreement: number | null;
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
 *   4. `account_source` names which roots produced the set, and
 *      `source_disagreement` is a number ONLY when they were compared.
 *
 * Rule 4 is the whole encoding, so it is stated as a contract rather than left
 * to call sites:
 *
 *   account_source      source_disagreement   means
 *   ----------------    -------------------   ----------------------------
 *   union               0                     compared, and they agreed
 *   union               n > 0                 compared, n accounts appeared
 *                                             in only one root, and the union
 *                                             saved them from being dropped
 *   union               null                  a caller said "union" and passed
 *                                             no count, so nothing was counted.
 *                                             None of this endpoint's three
 *                                             exits can produce it and
 *                                             `deno check` refuses it besides.
 *                                             A defect, and reported as one.
 *   connections_only    null                  NEVER COMPARED: the union query
 *                                             was rejected and the retry
 *                                             answered. Investigate.
 *   single_connection   null                  never compared, and correctly
 *                                             so: one source by construction
 *
 * The invariant that falls out of the table, and the one to hold on to:
 * `source_disagreement` is a number IF AND ONLY IF two sources were actually
 * compared. There is no path by which this field carries a number nobody
 * counted. Callers keying off it must treat null as "unknown", never as "fine".
 *
 * `null` and `0` are different answers and the difference is the point. A 0 on
 * a path that never compared anything reports the healthy value in exactly the
 * condition this field exists to detect, so a source that did not compare is
 * forced to null here rather than trusted to pass it.
 *
 * The overloads below carry that rule into the type system, so it is checkable
 * rather than conventional. `union` REQUIRES a count and the two non-comparing
 * sources accept none. An optional count with a default would leave the same
 * reporting failure alive one level in: a union call site that omitted the
 * argument would publish "compared, and they agreed" having compared nothing,
 * which is the exact defect the encoding exists to remove.
 *
 * Both illegal calls are covered twice, and that symmetry was bought rather
 * than free:
 *
 *   a non-comparing source passing a count   `deno check` refuses the call, and
 *                                            the coercion below forces null if
 *                                            it is ever reached anyway.
 *   `union` with no count                    `deno check` refuses the call, and
 *                                            the coercion below answers null,
 *                                            which reads as "not compared"
 *                                            rather than as "compared, and
 *                                            they agreed".
 *
 * The second row used to read "covered by `deno check` alone", because the
 * coercion sent a missing union count to `?? 0`. That made the compiler the
 * only thing standing between an omitted argument and a false all-clear, on the
 * one field whose whole purpose is to not report health during the failure.
 * **Do not reintroduce a numeric default here.** A number in this field must
 * always mean somebody counted.
 */
export function buildAccountsResponse(
  rawAccounts: QuilttAccount[],
  source: 'union',
  sourceDisagreement: number,
): AccountsResponse;
export function buildAccountsResponse(
  rawAccounts: QuilttAccount[],
  source: 'connections_only' | 'single_connection',
): AccountsResponse;
export function buildAccountsResponse(
  rawAccounts: QuilttAccount[],
  source: AccountSource,
  sourceDisagreement?: number,
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

  // The encoding is enforced here, not asked of the caller. A source that did
  // not compare cannot report a comparison result whatever it passed, and a
  // caller that counted nothing cannot report a count.
  //
  // This runs behind the overloads rather than instead of them, because the
  // type gate is erased at runtime: `deno test` runs with --no-check and a
  // JavaScript caller sees no overloads at all.
  //
  // Null on both illegal calls, deliberately. The two non-comparing sources are
  // forced to null so a count they had no right to pass cannot escape. `union`
  // with no count also lands on null, because null reads as "not compared"
  // while 0 reads as "compared, and they agreed". Defaulting it to 0 would
  // publish the healthy value in the one condition this field exists to detect.
  const disagreement = source === 'union' ? sourceDisagreement ?? null : null;

  return {
    accounts,
    total_returned: totalReturned,
    excluded_closed: excludedClosed,
    distinct_states: distinctStates,
    account_source: source,
    source_disagreement: disagreement,
  };
}
