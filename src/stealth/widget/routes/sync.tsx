/**
 * Stealth Sync widget — "sync" route.
 *
 * Master plan: STEALTH-SYNC-MASTER-PLAN.md §4.6 + §5.
 *
 * Flow:
 *   1. On mount, fetch the sealed envelope from `or-stealth-envelope-fetch`.
 *   2. Hand it to `runSync` along with fetchTip / fetchFilter / fetchBlock
 *      callbacks. Progress events drive the transparency modal.
 *   3. POST sealed transactions to `or-stealth-transactions-store`.
 *   4. postMessage OR_STEALTH_SYNC_COMPLETE back to the consuming app.
 *   5. On error, postMessage OR_STEALTH_ERROR.
 *
 * The route accepts `?mock=1` on the popup URL to use fixture fetchers
 * instead of live ones; this lets us exercise the full path before
 * Milestone 4 ships the filter producer + block source services.
 */

import { useEffect, useState } from 'react';

import {
  parseDescriptor,
  type ParsedDescriptor,
} from '@/stealth/lib/derive';
import {
  runSync,
  type BlockRecord,
  type FilterRecord,
  type SyncProgressEvent,
  type WalletEnvelopePayload,
} from '@/stealth/lib/sync';
import {
  mockFetchBlock,
  mockFetchFilter,
  mockFetchTip,
  mockNeverMatcher,
} from '@/stealth/lib/mock-fixtures';
import { unsealEnvelope } from '@/stealth/lib/seal';
import type {
  SealedEnvelope,
  StealthErrorCode,
  StealthErrorMessage,
  StealthInitMessage,
  StealthProgressMessage,
  StealthStage,
  StealthSyncCompleteMessage,
} from '@/stealth/lib/postmessage';
import { ProgressModal } from '../components/ProgressModal';
import { useStealthInit } from '../StealthInitContext';

interface AccessTokenInit extends StealthInitMessage {
  access_token?: string;
}

const STEALTH_FILTER_BASE =
  (import.meta.env.VITE_OR_STEALTH_FILTER_BASE_URL as string | undefined) ??
  'https://stealth.orangerails.com';
const BLOCK_SOURCE_BASE =
  (import.meta.env.VITE_OR_BLOCK_SOURCE_BASE_URL as string | undefined) ??
  'https://blocks.orangerails.com';

function resolveFunctionUrl(name: string): string {
  const base = (
    (import.meta.env.VITE_OR_FUNCTIONS_BASE_URL as string | undefined) ?? ''
  ).replace(/\/$/, '');
  if (base) return `${base}/${name}`;
  return `/functions/v1/${name}`;
}

function isMockMode(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('mock') === '1';
}

// ── Live fetchers ──────────────────────────────────────────────────────

async function liveFetchTip(): Promise<number> {
  const resp = await fetch(`${BLOCK_SOURCE_BASE}/tip`);
  if (!resp.ok) throw new Error(`fetchTip failed: ${resp.status}`);
  const j = (await resp.json()) as { height: number };
  return j.height;
}

async function liveFetchFilter(height: number): Promise<FilterRecord | null> {
  const resp = await fetch(`${STEALTH_FILTER_BASE}/${height}.gcs.gz`);
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`fetchFilter ${height} failed: ${resp.status}`);
  // The CDN serves gzipped GCS bytes. Browsers transparently un-gzip
  // when Content-Encoding is set; otherwise we'd need DecompressionStream.
  const buf = new Uint8Array(await resp.arrayBuffer());
  // The block hash for this height is encoded in a sibling manifest entry.
  // For Milestone 3 we read it from a header the producer attaches:
  //   X-Block-Hash: <hex display order>
  const blockHashHex = resp.headers.get('X-Block-Hash') ?? '';
  return { height, blockHashHex, filter: buf };
}

async function liveFetchBlock(blockHashHex: string): Promise<BlockRecord> {
  const resp = await fetch(`${BLOCK_SOURCE_BASE}/block/${blockHashHex}`);
  if (!resp.ok) throw new Error(`fetchBlock ${blockHashHex} failed: ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  // Height is returned via a response header from the source service.
  const height = Number(resp.headers.get('X-Block-Height') ?? '0');
  return { height, blockHashHex, raw: buf };
}

// ── Component ──────────────────────────────────────────────────────────

export function SyncRoute({ init: _initProp }: { init: StealthInitMessage }) {
  const { init, parent } = useStealthInit();
  const initWithToken = init as AccessTokenInit;

  const [progress, setProgress] = useState<SyncProgressEvent>({
    stage: 'unlocking',
    percent: 0,
    message: 'Vault unlocked',
    detail: 'Your password never left this browser.',
  });
  const [done, setDone] = useState<{ txCount: number; bytes: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function postWidgetError(code: StealthErrorCode, message: string, retryable: boolean) {
    if (!parent) return;
    const msg: StealthErrorMessage = {
      type: 'OR_STEALTH_ERROR',
      code,
      message,
      retryable,
    };
    try {
      parent.postMessage(msg, init.return_callback_origin);
    } catch (e) {
      console.error('[stealth/sync] failed to post error:', e);
    }
  }

  function postWidgetProgress(ev: SyncProgressEvent) {
    if (!parent) return;
    const msg: StealthProgressMessage = {
      type: 'OR_STEALTH_PROGRESS',
      stage: ev.stage,
      percent: ev.percent,
      message: ev.message,
      detail: ev.detail,
    };
    try {
      parent.postMessage(msg, init.return_callback_origin);
    } catch {
      // Progress messages are best-effort; do not abort the sync.
    }
  }

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    (async () => {
      try {
        if (!init.connection_id) {
          throw new Error('connection_id is required for mode=sync');
        }

        // 1. Fetch sealed envelope.
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (initWithToken.access_token) {
          headers['Authorization'] = `Bearer ${initWithToken.access_token}`;
        }

        const envResp = await fetch(resolveFunctionUrl('or-stealth-envelope-fetch'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            connection_id: init.connection_id,
            app_user_id: init.app_user_id,
            app_slug: init.app_slug,
          }),
        });
        if (!envResp.ok) {
          const text = await envResp.text().catch(() => '');
          throw new Error(`Envelope fetch failed: ${envResp.status} ${text}`);
        }
        const envJson = (await envResp.json()) as {
          sealed_envelope: SealedEnvelope;
          last_block_scanned: number | null;
          wallet_birthday_plaintext: string | null;
        };

        // We need a birthday-height. Resolution from date → height belongs
        // server-side in Milestone 4; for now we approximate from the date.
        // ~144 blocks per day from genesis (2009-01-03).
        const envelopePayload = await unsealEnvelope<WalletEnvelopePayload>(
          envJson.sealed_envelope,
          init.or_stealth_key_b64,
        );
        const birthdayHeight = approximateHeightFromDate(envelopePayload.wallet_birthday);

        let descriptor: ParsedDescriptor | undefined;
        if (envelopePayload.kind === 'descriptor_stealth') {
          descriptor = parseDescriptor(envelopePayload.descriptor);
        }

        const useMock = isMockMode();

        // 2. Run the orchestrator.
        const result = await runSync({
          envelope: envJson.sealed_envelope,
          orStealthKey: init.or_stealth_key_b64,
          lastBlockScanned: envJson.last_block_scanned,
          birthdayHeight,
          descriptor,
          fetchTip: useMock ? mockFetchTip : liveFetchTip,
          fetchFilter: useMock ? mockFetchFilter : liveFetchFilter,
          fetchBlock: useMock ? mockFetchBlock : liveFetchBlock,
          matcher: useMock ? mockNeverMatcher : undefined,
          onProgress: (ev) => {
            if (cancelled) return;
            setProgress(ev);
            postWidgetProgress(ev);
          },
        });
        if (cancelled) return;

        // 3. Upload sealed transactions.
        if (result.sealedTransactions.length > 0) {
          const uploadResp = await fetch(
            resolveFunctionUrl('or-stealth-transactions-store'),
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                connection_id: init.connection_id,
                app_user_id: init.app_user_id,
                sealed_transactions: result.sealedTransactions,
                last_block_scanned: result.lastBlockScanned,
              }),
            },
          );
          if (!uploadResp.ok) {
            const text = await uploadResp.text().catch(() => '');
            throw new Error(`Upload failed: ${uploadResp.status} ${text}`);
          }
        }

        // 4. SYNC_COMPLETE.
        if (parent) {
          const msg: StealthSyncCompleteMessage = {
            type: 'OR_STEALTH_SYNC_COMPLETE',
            connection_id: init.connection_id,
            sealed_transactions: result.sealedTransactions,
            last_block_scanned: result.lastBlockScanned,
            tx_count: result.txCount,
            bytes_downloaded: result.bytesDownloaded,
            duration_seconds: (Date.now() - startedAt) / 1000,
          };
          try {
            parent.postMessage(msg, init.return_callback_origin);
          } catch (e) {
            console.error('[stealth/sync] failed to post complete:', e);
          }
        }

        if (cancelled) return;
        setDone({ txCount: result.txCount, bytes: result.bytesDownloaded });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        postWidgetError('INTERNAL', msg, true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // We deliberately run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <h1 className="text-lg font-semibold text-destructive">Sync failed</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={() => window.close()}
            className="mt-4 inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Close this window
          </button>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">Sync complete</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {done.txCount === 0
              ? 'Nothing new on chain since the last sync.'
              : `Sealed and stored ${done.txCount} transaction${done.txCount === 1 ? '' : 's'}.`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Downloaded {(done.bytes / 1024).toFixed(1)} KB.
          </p>
          <button
            type="button"
            onClick={() => window.close()}
            className="mt-4 inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Close this window
          </button>
        </div>
      </div>
    );
  }

  return (
    <ProgressModal
      stage={progress.stage as StealthStage}
      percent={progress.percent}
      detailOverride={progress.detail}
    />
  );
}

export default SyncRoute;

// Genesis at 2009-01-03; ~10 minutes per block. Crude lower bound for the
// birthday-height window. The Milestone 4 filter producer service will
// expose a date-to-height endpoint that replaces this approximation.
function approximateHeightFromDate(isoDate: string): number {
  const GENESIS = Date.UTC(2009, 0, 3) / 1000;
  const SECONDS_PER_BLOCK = 600;
  const ts = Date.parse(isoDate + 'T00:00:00Z') / 1000;
  if (!Number.isFinite(ts) || ts < GENESIS) return 0;
  return Math.max(0, Math.floor((ts - GENESIS) / SECONDS_PER_BLOCK));
}
