/**
 * Profile rule engine — interprets the rules section of an AppProfile.
 *
 * This is a deliberately small interpreter. It handles two responsibilities:
 *
 *   1. findMatchingRule(profile, tx, ctx)
 *      Walks profile.account_mapping_rules in order. The first rule whose
 *      `when` clause matches the transaction wins. If no `when` matches and
 *      a `default: true` rule exists, it wins. Returns resolved CoA hints
 *      for the debit and credit legs of the journal entry.
 *
 *   2. mapStatus(profile, providerStatus)
 *      Looks up the provider's status string in profile.status_to_v2. Falls
 *      back to status_to_v2.default if no exact match. Returns the V2
 *      TransactionStatus enum value.
 *
 * The engine resolves `from: <path>` references inside CoA hints. Supported
 * path roots:
 *   canonical.<field>   — read from NormalizedTransaction
 *   derived.<field>     — read from a per-transaction context the sink prepares
 *   input.<field>       — read from SinkInput (org_id, or_connection_id, etc.)
 *
 * Anything else passes through as a literal. This keeps YAML authoring
 * minimal: write the value you want, or write `{ from: <path> }` when you
 * want a substitution.
 */

import type { AccountMappingRule, AppProfile, ProfileCoaHint } from './profile-loader.ts';
import type { NormalizedTransaction } from './types.ts';

// ─── Resolved CoA hint shape ─────────────────────────────────────────────

/**
 * The runtime form of a CoA hint after `from:` references are resolved.
 * Sink adapters embed this in __resolveCoa fields on emitted rows; the
 * consumer's sync handler resolves it to a real ChartOfAccount.id.
 */
export interface ResolvedCoaHint {
  accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  accountSubType: string;
  isWallet?: boolean;
  targetSourceWalletId?: string;
  currency?: string;
  name?: string;
}

/**
 * Per-transaction context the sink prepares before invoking the engine. The
 * engine reads `derived.<key>` from this object. Sinks can put anything in
 * here — the engine just does property lookups.
 */
export type DerivedContext = Record<string, string | number | boolean | null | undefined>;

/**
 * Input context the engine reads `input.<key>` from. Mirrors the SinkInput
 * fields plus any sink-specific extras.
 */
export type InputContext = Record<string, string | number | boolean | null | undefined>;

// ─── Account-mapping evaluation ──────────────────────────────────────────

/**
 * Evaluate `rule.when` against the transaction.
 *
 * The when clause is an exact-match dictionary. Each key is the field name
 * on NormalizedTransaction; the value must equal the transaction's field
 * value. Missing fields don't match.
 *
 * Today this only supports equality. If/when YAML needs `in: [...]` or
 * comparison operators, extend here.
 */
function matchesWhen(
  when: Record<string, string | number | boolean>,
  tx: NormalizedTransaction,
): boolean {
  for (const [key, expected] of Object.entries(when)) {
    // deno-lint-ignore no-explicit-any
    const actual = (tx as any)[key];
    if (actual !== expected) return false;
  }
  return true;
}

/**
 * Find the matching rule and return its resolved debit/credit hints.
 *
 * Walks rules in declaration order. First non-default `when` match wins.
 * Falls back to the rule marked `default: true` if no match. Throws if
 * no rule matches and no default exists — that surfaces a YAML coverage
 * gap loudly rather than silently routing money to nowhere.
 */
export function findMatchingRule(
  profile: AppProfile,
  tx: NormalizedTransaction,
  derived: DerivedContext,
  input: InputContext,
): { debit: ResolvedCoaHint; credit: ResolvedCoaHint } {
  let defaultRule: AccountMappingRule | null = null;

  for (const rule of profile.account_mapping_rules) {
    if (rule.default) {
      defaultRule = rule;
      continue;
    }
    if (rule.when && matchesWhen(rule.when, tx)) {
      return {
        debit: resolveCoaHint(rule.debit, tx, derived, input),
        credit: resolveCoaHint(rule.credit, tx, derived, input),
      };
    }
  }

  if (defaultRule) {
    return {
      debit: resolveCoaHint(defaultRule.debit, tx, derived, input),
      credit: resolveCoaHint(defaultRule.credit, tx, derived, input),
    };
  }

  throw new Error(
    `[profile-engine] No account_mapping_rule matched (type=${tx.type}, direction=${tx.direction}) and no default rule defined in profile ${profile.app}@${profile.version}`,
  );
}

/**
 * Resolve any `from: <path>` references inside a CoA hint. Returns a fully
 * concrete ResolvedCoaHint suitable for emission.
 */
function resolveCoaHint(
  hint: ProfileCoaHint,
  tx: NormalizedTransaction,
  derived: DerivedContext,
  input: InputContext,
): ResolvedCoaHint {
  return {
    accountType: hint.accountType,
    accountSubType: hint.accountSubType,
    isWallet: hint.isWallet,
    targetSourceWalletId: resolveRef(hint.targetSourceWalletId, tx, derived, input) as string | undefined,
    currency: resolveRef(hint.currency, tx, derived, input) as string | undefined,
    name: hint.name,
  };
}

/**
 * Resolve a single FieldRef. Returns the literal value if no `from`/`const`
 * wrapper, the const value if `{ const }`, or a property lookup along the
 * dotted path if `{ from }`.
 *
 * Unsupported path roots (anything other than canonical / derived / input)
 * return undefined. Unknown leaf paths also return undefined. Sinks decide
 * whether to treat undefined as an error or skip the field.
 */
function resolveRef(
  ref: unknown,
  tx: NormalizedTransaction,
  derived: DerivedContext,
  input: InputContext,
): unknown {
  if (ref == null) return ref;
  if (typeof ref === 'string' || typeof ref === 'number' || typeof ref === 'boolean') return ref;
  if (typeof ref !== 'object') return ref;

  const obj = ref as Record<string, unknown>;
  if ('const' in obj) return obj.const;
  if ('from' in obj && typeof obj.from === 'string') {
    return readDottedPath(obj.from, tx, derived, input);
  }
  // Unknown wrapper — pass through literally so the consumer surface sees
  // exactly what the YAML said.
  return ref;
}

function readDottedPath(
  path: string,
  tx: NormalizedTransaction,
  derived: DerivedContext,
  input: InputContext,
): unknown {
  const dot = path.indexOf('.');
  if (dot < 0) return undefined;
  const root = path.slice(0, dot);
  const rest = path.slice(dot + 1);

  let source: Record<string, unknown> | undefined;
  if (root === 'canonical') source = tx as unknown as Record<string, unknown>;
  else if (root === 'derived') source = derived as unknown as Record<string, unknown>;
  else if (root === 'input') source = input as unknown as Record<string, unknown>;
  else return undefined;

  // Walk dotted segments. Returns undefined on any missing intermediate.
  let cursor: unknown = source;
  for (const segment of rest.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

// ─── Status mapping ──────────────────────────────────────────────────────

/**
 * Resolve a provider-side status string against profile.status_to_v2.
 *
 * Lookup order:
 *   1. Exact match (case-sensitive against the YAML keys)
 *   2. Upper-case match (most providers UPPERCASE their statuses, but
 *      profiles can be authored either way)
 *   3. The `default` key in status_to_v2
 *   4. Hard fallback to 'INCOMPLETE' so unmapped statuses surface in V2's
 *      review UI instead of silently coercing to COMPLETE
 *
 * Returns the V2 TransactionStatus enum string.
 */
export function mapStatus(profile: AppProfile, providerStatus: string | undefined): string {
  const map = profile.status_to_v2 ?? {};
  const fallback = map.default ?? 'INCOMPLETE';
  if (!providerStatus) return fallback;

  if (map[providerStatus]) return map[providerStatus];

  const upper = providerStatus.toUpperCase();
  if (map[upper]) return map[upper];

  return fallback;
}
