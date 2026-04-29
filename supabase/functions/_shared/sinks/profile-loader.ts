/**
 * Profile loader — read App Profile YAMLs, validate them, cache the parsed
 * result for the lifetime of an edge-function instance.
 *
 * Why this exists: the protocol promises that consumer apps publish their
 * profile as YAML and OR follows it. Today the V2 profile lives at
 * `_shared/sinks/profiles/bitbooks-v2.yaml`. This loader makes that file
 * load-bearing config — when the YAML changes, the runtime behavior
 * changes, no TypeScript edit needed for rule edits.
 *
 * What's load-bearing today:
 *   - account_mapping_rules     (canonical type → debit/credit CoA hints)
 *   - status_to_v2              (provider status → V2's TransactionStatus enum)
 *
 * What is NOT load-bearing yet:
 *   - output_tables              (row field generation still lives in TS)
 *   - identity / accepts_modules (advisory only at this stage)
 *
 * The remaining TS-side work is the per-consumer field-generation engine.
 * When a third consumer joins the protocol we lift output_tables to YAML
 * and the runtime sink becomes a generic interpreter. For now, with one
 * consumer, the asymmetry is fine.
 */

import { parse } from 'https://deno.land/std@0.208.0/yaml/parse.ts';

// ─── Types — what a valid profile looks like ─────────────────────────────

/**
 * A field-value reference inside a CoA hint or rule expression. Either a
 * literal value or a `from: <path>` reference into the canonical
 * transaction or a per-transaction derived context.
 *
 * Path syntax:
 *   canonical.<field>      — read from NormalizedTransaction
 *   derived.<field>        — read from a context computed by the sink
 *   input.<field>          — read from SinkInput (org_id, or_connection_id, etc.)
 */
export type FieldRef =
  | string
  | number
  | boolean
  | null
  | { from: string }
  | { const: unknown };

/**
 * Account-role hint as written in the YAML. The engine resolves any `from`
 * references against the transaction + derived context to produce a
 * ResolvedCoaHint suitable for emission in the sink output.
 */
export interface ProfileCoaHint {
  accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  accountSubType: string;
  isWallet?: boolean;
  /** When set, V2 looks up the CoA tied to a specific source wallet. */
  targetSourceWalletId?: FieldRef;
  /** Currency hint (e.g. 'BTC'). Defaults to derived.asset on the consumer side. */
  currency?: FieldRef;
  /** Override the auto-generated CoA name on find-or-create. */
  name?: string;
}

/**
 * One account-mapping rule. Either a `default` rule (catch-all, evaluated
 * last) or a conditional rule that matches specific transaction shapes.
 *
 * `when` is an exact-match dictionary against transaction fields. Today
 * we support: type, direction. (Add operators like `in: [...]` if YAML
 * needs grow before consumer #3.)
 */
export interface AccountMappingRule {
  when?: Record<string, string | number | boolean>;
  default?: boolean;
  debit: ProfileCoaHint;
  credit: ProfileCoaHint;
}

export interface AppProfile {
  app: string;
  version: string;
  canonical_version: string;
  accepts_modules?: string[];
  identity?: { external_user_id_source?: string };
  account_mapping_rules: AccountMappingRule[];
  /** Provider-specific status string → V2 enum. `default` key = fallback. */
  status_to_v2?: Record<string, string>;
  override_path?: string;
  encryption?: unknown;
  /**
   * Captured for completeness; not interpreted at runtime today. The TS sink
   * still owns row construction. When this YAML lands as a consumer profile
   * for a second app, lift output_tables to YAML and have the engine drive
   * row construction too.
   */
  output_tables?: Record<string, unknown>;
}

// ─── Parser + validator ───────────────────────────────────────────────────

class ProfileLoadError extends Error {
  constructor(format: string, reason: string) {
    super(`[profile-loader] ${format}: ${reason}`);
    this.name = 'ProfileLoadError';
  }
}

/**
 * Validate that a parsed YAML object satisfies the AppProfile contract.
 * Throws ProfileLoadError on the first violation. Fail-closed: any structural
 * problem stops the runtime from using the profile, surfacing as a 500 from
 * or-sync rather than running with bad rules.
 */
function validateProfile(format: string, raw: unknown): AppProfile {
  if (!raw || typeof raw !== 'object') {
    throw new ProfileLoadError(format, 'YAML root must be a mapping (got non-object)');
  }
  const p = raw as Record<string, unknown>;

  if (typeof p.app !== 'string' || !p.app) {
    throw new ProfileLoadError(format, '`app` (string) is required');
  }
  if (typeof p.version !== 'string' || !p.version) {
    throw new ProfileLoadError(format, '`version` (string) is required');
  }
  if (typeof p.canonical_version !== 'string' || !p.canonical_version) {
    throw new ProfileLoadError(format, '`canonical_version` (string) is required');
  }
  if (!Array.isArray(p.account_mapping_rules) || p.account_mapping_rules.length === 0) {
    throw new ProfileLoadError(format, '`account_mapping_rules` (non-empty array) is required');
  }

  // Validate every rule. Each rule needs (when XOR default) plus debit + credit
  // CoA hints.
  let sawDefault = false;
  for (let i = 0; i < p.account_mapping_rules.length; i++) {
    const rule = p.account_mapping_rules[i] as Record<string, unknown>;
    if (!rule || typeof rule !== 'object') {
      throw new ProfileLoadError(format, `account_mapping_rules[${i}] must be an object`);
    }
    const hasWhen = rule.when && typeof rule.when === 'object';
    const hasDefault = rule.default === true;
    if (!hasWhen && !hasDefault) {
      throw new ProfileLoadError(format, `account_mapping_rules[${i}] needs either \`when\` or \`default: true\``);
    }
    if (hasWhen && hasDefault) {
      throw new ProfileLoadError(format, `account_mapping_rules[${i}] cannot have both \`when\` and \`default\``);
    }
    if (hasDefault) sawDefault = true;
    validateCoaHint(format, `account_mapping_rules[${i}].debit`, rule.debit);
    validateCoaHint(format, `account_mapping_rules[${i}].credit`, rule.credit);
  }
  if (!sawDefault) {
    // Default rule isn't strictly required, but its absence is a footgun: an
    // unmapped transaction throws at runtime. Warn loudly via the load path
    // so YAML authors notice during development. We don't fail closed here
    // because a profile that intentionally only handles a known set is
    // legitimate (just not robust).
    console.warn(`[profile-loader] ${format}: no default account_mapping_rule — unmapped transactions will throw at runtime`);
  }

  if (p.status_to_v2 !== undefined) {
    if (!p.status_to_v2 || typeof p.status_to_v2 !== 'object' || Array.isArray(p.status_to_v2)) {
      throw new ProfileLoadError(format, '`status_to_v2` must be an object map');
    }
    for (const [k, v] of Object.entries(p.status_to_v2 as Record<string, unknown>)) {
      if (typeof v !== 'string') {
        throw new ProfileLoadError(format, `status_to_v2.${k} must be a string`);
      }
    }
  }

  return p as unknown as AppProfile;
}

function validateCoaHint(format: string, path: string, raw: unknown): void {
  if (!raw || typeof raw !== 'object') {
    throw new ProfileLoadError(format, `${path} must be an object (CoA hint)`);
  }
  const h = raw as Record<string, unknown>;
  const validAccountTypes = new Set(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']);
  if (typeof h.accountType !== 'string' || !validAccountTypes.has(h.accountType)) {
    throw new ProfileLoadError(format, `${path}.accountType must be one of ${Array.from(validAccountTypes).join('|')}`);
  }
  if (typeof h.accountSubType !== 'string' || !h.accountSubType) {
    throw new ProfileLoadError(format, `${path}.accountSubType (string) is required`);
  }
  // Optional fields aren't strictly type-checked here — the runtime resolver
  // tolerates unknown shapes by passing them through unchanged. Bad refs
  // surface as runtime errors, which is acceptable for a YAML that an
  // engineer authored.
}

// ─── Load + cache ─────────────────────────────────────────────────────────

const PROFILE_CACHE = new Map<string, AppProfile>();

/**
 * Load a profile by format slug, returning the validated AppProfile.
 *
 * The YAML file lives at `_shared/sinks/profiles/<format>.yaml`, relative
 * to this loader. Resolved via `import.meta.url` so Supabase Edge Function
 * bundles work without hardcoded paths.
 *
 * Cached for the lifetime of the edge-function instance. Cold-start incurs
 * one parse + validate; subsequent requests hit the cache.
 */
export async function loadProfile(format: string): Promise<AppProfile> {
  const cached = PROFILE_CACHE.get(format);
  if (cached) return cached;

  const url = new URL(`./profiles/${format}.yaml`, import.meta.url);
  let yamlContent: string;
  try {
    yamlContent = await Deno.readTextFile(url);
  } catch (err) {
    throw new ProfileLoadError(format, `Cannot read profile file ${url.pathname}: ${err instanceof Error ? err.message : String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(yamlContent);
  } catch (err) {
    throw new ProfileLoadError(format, `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const validated = validateProfile(format, parsed);
  PROFILE_CACHE.set(format, validated);
  return validated;
}

/**
 * For tests / dev tools — drop the cache so the next load re-reads the YAML.
 * Not used by edge functions in production; they let the cache live for the
 * lifetime of the instance.
 */
export function clearProfileCache(format?: string): void {
  if (format) PROFILE_CACHE.delete(format);
  else PROFILE_CACHE.clear();
}
