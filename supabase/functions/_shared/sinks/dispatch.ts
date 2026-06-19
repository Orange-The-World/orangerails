/**
 * Sink dispatch table.
 *
 * or-sync calls `getSinkAdapter(format)` to look up the registered adapter
 * for a `format` value the caller passed in the body. Each adapter is
 * registered here at import time.
 *
 * Adding a new consumer (V3 protocol-driven, OW, Personal, GreenBooks-future):
 *   1. Implement the SinkAdapter in _shared/sinks/<app-slug>.ts
 *   2. Import it here
 *   3. Add to the SINK_ADAPTERS map below
 *   4. The consumer can now call or-sync with `format: '<app-slug>'`
 *
 * The framework is intentionally minimal , slug → adapter map. No YAML loader
 * yet (today's adapters are TypeScript). When more than three consumers ship,
 * extract the account-mapping rules to YAML and load at startup.
 */

import type { SinkAdapter } from './types.ts';
import { bitbooksV2Sink, ensureProfileLoaded as ensureV2ProfileLoaded } from './bitbooks-v2.ts';
import { orangewayMeSink } from './orangeway-me.ts';

const SINK_ADAPTERS: ReadonlyMap<string, SinkAdapter> = new Map<string, SinkAdapter>([
  [bitbooksV2Sink.format, bitbooksV2Sink],
  [orangewayMeSink.format, orangewayMeSink],
  // Future:
  // [bitbooksV3Sink.format, bitbooksV3Sink],
  // [orangewayBooksSink.format, orangewayBooksSink],
]);

/**
 * Per-format profile bootstrap. Each YAML-driven sink registers an async
 * loader here so or-sync can ensure the profile is parsed and validated
 * before the synchronous toAppShape call. Cached after first load.
 */
const PROFILE_LOADERS: ReadonlyMap<string, () => Promise<void>> = new Map<string, () => Promise<void>>([
  [bitbooksV2Sink.format, ensureV2ProfileLoaded],
]);

/**
 * Make sure the YAML profile for the given format is loaded and cached.
 * Call before invoking the sink's toAppShape. Cheap on cache hit.
 */
export async function ensureProfileForFormat(format: string): Promise<void> {
  const loader = PROFILE_LOADERS.get(format);
  if (loader) await loader();
}

/**
 * Look up the sink adapter for a given `format` value.
 *
 * Returns null when no adapter is registered for the format. or-sync should
 * surface this as a 400 with a list of valid formats so consumers know what
 * the framework supports.
 */
export function getSinkAdapter(format: string): SinkAdapter | null {
  return SINK_ADAPTERS.get(format) ?? null;
}

/** List of registered sink format slugs. Used in 400 errors for unknown formats. */
export function listSinkFormats(): string[] {
  return Array.from(SINK_ADAPTERS.keys());
}

// Re-export the types so or-sync can import everything from one place.
export type { SinkAdapter, SinkInput, SinkOutput, NormalizedTransaction } from './types.ts';
export { mergeSinkOutputs } from './types.ts';
