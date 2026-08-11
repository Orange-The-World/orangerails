/**
 * Stealth Sync widget , "sync" route.
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
 *
 * This is a widget-mode route: it unseals the wallet envelope and seals the
 * transactions, so it always holds a key. It is typed on
 * StealthInitWidgetMessage rather than the StealthInitMessage union for that
 * reason. An app-mode init carries no key and must never reach this file; the
 * type is what enforces it, not the order the checks happen to run in.
 */

import { useEffect, useState } from "react";

import { parseDescriptor, type ParsedDescriptor } from "@/stealth/lib/derive";
import {
  runSync,
  WindowExhaustedError,
  liveFetchBlock as libLiveFetchBlock,
  liveFetchFilter as libLiveFetchFilter,
  liveFetchTip as libLiveFetchTip,
  liveResolveBirthdayHeight,
  approximateHeightFromDate,
  type SyncProgressEvent,
  type WalletEnvelopePayload,
} from "@/stealth/lib/sync";
import {
  mockFetchBlock,
  mockFetchFilter,
  mockFetchTip,
  mockNeverMatcher,
} from "@/stealth/lib/mock-fixtures";
import { unsealEnvelope } from "@/stealth/lib/seal";
import type {
  SealedEnvelope,
  StealthErrorCode,
  StealthErrorMessage,
  StealthInitWidgetMessage,
  StealthProgressMessage,
  StealthStage,
  StealthSyncCompleteMessage,
} from "@/stealth/lib/postmessage";
import { ProgressModal } from "../components/ProgressModal";
import { useStealthInit } from "../StealthInitContext";
import { proxyFetch } from "../lib/proxyFetch";
import { resolveFunctionUrl } from "../lib/resolveFunctionUrl";

const STEALTH_FILTER_BASE =
  (import.meta.env.VITE_OR_STEALTH_FILTER_BASE_URL as string | undefined) ??
  "https://stealth.orangerails.com";
const BLOCK_SOURCE_BASE =
  (import.meta.env.VITE_OR_BLOCK_SOURCE_BASE_URL as string | undefined) ??
  "https://blocks.orangerails.com";

function isMockMode(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("mock") === "1";
}

// Dev-only escape hatch: ?force_cursor=1 bypasses the !useMock guard so
// Playwright tests can assert the cursor-write path without hitting the live
// block source. import.meta.env.DEV is tree-shaken to false in production
// builds by Vite, so this can never be activated in prod.
function isForceCursor(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("force_cursor") === "1";
}

// ── Live fetchers ──────────────────────────────────────────────────────
// Bound to the production base URLs (overridable via Vite env). The actual
// HTTP work, gzip decompression of the .gcs.gz body, and sidecar JSON read
// happen in @/stealth/lib/sync so they are unit-testable.

const liveFetchTip = () => libLiveFetchTip(BLOCK_SOURCE_BASE);
const liveFetchFilter = (height: number) => libLiveFetchFilter(height, STEALTH_FILTER_BASE);
const liveFetchBlock = (hash: string) => libLiveFetchBlock(hash, BLOCK_SOURCE_BASE);

// ── Component ──────────────────────────────────────────────────────────

export function SyncRoute({ init: _initProp }: { init: StealthInitWidgetMessage }) {
  const { init, parent } = useStealthInit();

  const [progress, setProgress] = useState<SyncProgressEvent>({
    stage: "unlocking",
    percent: 0,
    message: "Vault unlocked",
    detail: "Your password never left this browser.",
  });
  const [done, setDone] = useState<{ txCount: number; bytes: number; windowExhausted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isFirstSync, setIsFirstSync] = useState<boolean | null>(null);

  function postWidgetError(code: StealthErrorCode, message: string, retryable: boolean) {
    if (!parent) return;
    const msg: StealthErrorMessage = {
      type: "OR_STEALTH_ERROR",
      code,
      message,
      retryable,
    };
    try {
      parent.postMessage(msg, init.return_callback_origin);
    } catch (e) {
      console.error("[stealth/sync] failed to post error:", e);
    }
  }

  function postWidgetProgress(ev: SyncProgressEvent) {
    if (!parent) return;
    const msg: StealthProgressMessage = {
      type: "OR_STEALTH_PROGRESS",
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
          throw new Error("connection_id is required for mode=sync");
        }

        // 1. Fetch sealed envelope. Routes through parent postMessage proxy
        //    when proxy_base_url is set in INIT (V2 pattern, keeps platform
        //    key off the browser); falls back to direct fetch otherwise.
        const envFetchBody = {
          connection_id: init.connection_id,
          app_user_id: init.app_user_id,
          app_slug: init.app_slug,
        };
        let envOk = false;
        let envStatus = 0;
        let envText = "";
        let envBody: unknown = null;
        if (init.proxy_base_url && parent) {
          const r = await proxyFetch({
            parent,
            parentOrigin: init.return_callback_origin,
            fn: "or-stealth-envelope-fetch",
            body: envFetchBody,
          });
          envOk = r.ok;
          envStatus = r.status;
          envText = r.bodyText;
          envBody = r.parsed;
        } else {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (init.access_token) {
            headers["Authorization"] = `Bearer ${init.access_token}`;
          }
          const envResp = await fetch(
            resolveFunctionUrl("or-stealth-envelope-fetch", init.proxy_base_url),
            {
              method: "POST",
              headers,
              body: JSON.stringify(envFetchBody),
            },
          );
          envOk = envResp.ok;
          envStatus = envResp.status;
          envText = await envResp.text().catch(() => "");
          envBody = envText ? JSON.parse(envText) : null;
        }
        if (!envOk) {
          throw new Error(`Envelope fetch failed: ${envStatus} ${envText}`);
        }
        const envJson = envBody as {
          sealed_envelope: SealedEnvelope;
          last_block_scanned: number | null;
          wallet_birthday_plaintext: string | null;
        };
        setIsFirstSync(envJson.last_block_scanned === null);

        // We need a birthday-height. In live mode we ask the block source
        // for the first block at-or-after the birthday date; in mock mode
        // we keep the date-based approximation so the test fixtures do not
        // need to mock a network endpoint.
        const envelopePayload = await unsealEnvelope<WalletEnvelopePayload>(
          envJson.sealed_envelope,
          init.or_stealth_key_b64,
        );
        const useMock = isMockMode();
        const birthdayHeight = useMock
          ? approximateHeightFromDate(envelopePayload.wallet_birthday)
          : await liveResolveBirthdayHeight(envelopePayload.wallet_birthday, BLOCK_SOURCE_BASE);

        let descriptor: ParsedDescriptor | undefined;
        if (envelopePayload.kind === "descriptor_stealth") {
          descriptor = parseDescriptor(envelopePayload.descriptor);
        }

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

        // 3. Upload sealed transactions to OR , UNLESS the consumer app
        //    has set skip_transaction_upload (V2 does this; V2's own DB
        //    is the source of truth and OR-side encrypted backup is
        //    not needed). Cuts the slow upload step entirely for those
        //    apps. SYNC_COMPLETE still fires below so the consumer
        //    persists locally.
        if (!init.skip_transaction_upload && result.sealedTransactions.length > 0) {
          const uploadBody = {
            connection_id: init.connection_id,
            app_user_id: init.app_user_id,
            sealed_transactions: result.sealedTransactions,
            last_block_scanned: result.lastBlockScanned,
          };
          let uploadOk = false;
          let uploadStatus = 0;
          let uploadText = "";
          if (init.proxy_base_url && parent) {
            const r = await proxyFetch({
              parent,
              parentOrigin: init.return_callback_origin,
              fn: "or-stealth-transactions-store",
              body: uploadBody,
            });
            uploadOk = r.ok;
            uploadStatus = r.status;
            uploadText = r.bodyText;
          } else {
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (init.access_token) {
              headers["Authorization"] = `Bearer ${init.access_token}`;
            }
            const uploadResp = await fetch(
              resolveFunctionUrl("or-stealth-transactions-store", init.proxy_base_url),
              {
                method: "POST",
                headers,
                body: JSON.stringify(uploadBody),
              },
            );
            uploadOk = uploadResp.ok;
            uploadStatus = uploadResp.status;
            uploadText = await uploadResp.text().catch(() => "");
          }
          if (!uploadOk) {
            throw new Error(`Upload failed: ${uploadStatus} ${uploadText}`);
          }
        }

        // 4. Persist the sync cursor, independent of transaction upload.
        //    Consumer apps that set skip_transaction_upload (and any sync
        //    that found zero new transactions) never reach
        //    or-stealth-transactions-store, so without this call their
        //    cursor never advanced and every sync rescanned the whole
        //    birthday-to-tip window. A failure here must surface loudly:
        //    a NULL cursor silently restarts every future sync from scratch.
        //
        //    Guard: only write if the cursor actually advanced. runSync
        //    returns the previous cursor unchanged when fromHeight > tip
        //    (short-circuit path). Persisting that value would falsely mark
        //    the wallet as synced to a height it never scanned.
        let cursorFailed = false;
        if ((!useMock || isForceCursor()) && result.lastBlockScanned > (envJson.last_block_scanned ?? -1)) {
          try {
          const cursorBody = {
            connection_id: init.connection_id,
            app_user_id: init.app_user_id,
            last_block_scanned: result.lastBlockScanned,
          };
          let cursorWritten = false;
          if (init.proxy_base_url && parent) {
            // Proxy path. Use a short timeout: the cursor write is a single-row
            // lightweight update, not a large sealed-tx upload. Consumer proxy
            // handlers set up before or-stealth-envelope-update was added will
            // silently drop the OR_STEALTH_PROXY_REQUEST message and never
            // respond. Fail fast (15s) so we can try the direct fallback below
            // rather than blocking the user for two minutes.
            let proxyErr = "";
            try {
              const r = await proxyFetch({
                parent,
                parentOrigin: init.return_callback_origin,
                fn: "or-stealth-envelope-update",
                body: cursorBody,
                timeoutMs: 15000,
              });
              if (r.ok) {
                cursorWritten = true;
              } else {
                proxyErr = `proxy ${r.status}: ${r.bodyText}`;
              }
            } catch (err) {
              proxyErr = err instanceof Error ? err.message : String(err);
            }
            // Direct fallback: if the proxy path failed and we have a user JWT,
            // call the OR function directly. The edge function accepts user-JWT
            // auth in addition to platform-key auth, so this succeeds even when
            // the consumer proxy does not handle this function.
            if (!cursorWritten && init.access_token) {
              console.warn(
                `[stealth/sync] proxy cursor write failed (${proxyErr}); falling back to a ` +
                `direct user-JWT call to or-stealth-envelope-update. This bypasses your ` +
                `OR_STEALTH_PROXY_REQUEST handler. Add or-stealth-envelope-update to that ` +
                `handler to restore the proxy path.`,
              );
              const fbHeaders: Record<string, string> = {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${init.access_token}`,
              };
              let fbResp: Response;
              try {
                fbResp = await fetch(
                  resolveFunctionUrl("or-stealth-envelope-update", undefined),
                  { method: "POST", headers: fbHeaders, body: JSON.stringify(cursorBody) },
                );
              } catch (err) {
                // A network-layer rejection (DNS, CORS, offline) would otherwise
                // escape as a bare TypeError and drop proxyErr, hiding why we were
                // in the fallback at all. Fold both causes into one error.
                const fbErr = err instanceof Error ? err.message : String(err);
                throw new Error(
                  `[stealth/sync] cursor update failed (proxy: ${proxyErr}; direct fallback: ${fbErr}). ` +
                  `Add or-stealth-envelope-update to your OR_STEALTH_PROXY_REQUEST handler to fix the proxy path.`,
                );
              }
              if (fbResp.ok) {
                cursorWritten = true;
              } else {
                const fbText = await fbResp.text().catch(() => "");
                throw new Error(
                  `[stealth/sync] cursor update failed (proxy: ${proxyErr}; direct fallback: ${fbResp.status} ${fbText}). ` +
                  `Add or-stealth-envelope-update to your OR_STEALTH_PROXY_REQUEST handler to fix the proxy path.`,
                );
              }
            }
            if (!cursorWritten) {
              throw new Error(
                `[stealth/sync] cursor update failed: ${proxyErr}. ` +
                `Add or-stealth-envelope-update to your OR_STEALTH_PROXY_REQUEST handler.`,
              );
            }
          } else {
            const headers: Record<string, string> = {
              "Content-Type": "application/json",
            };
            if (init.access_token) {
              headers["Authorization"] = `Bearer ${init.access_token}`;
            }
            const cursorResp = await fetch(
              resolveFunctionUrl("or-stealth-envelope-update", init.proxy_base_url),
              {
                method: "POST",
                headers,
                body: JSON.stringify(cursorBody),
              },
            );
            if (!cursorResp.ok) {
              const errText = await cursorResp.text().catch(() => "");
              throw new Error(`[stealth/sync] cursor update failed: ${cursorResp.status} ${errText}`);
            }
            cursorWritten = true;
          }
          // Satisfy the TypeScript exhaustiveness check: every branch above
          // either sets cursorWritten = true, throws, or was guarded such that
          // reaching here with cursorWritten = false is impossible. The variable
          // exists so the compiler can verify that guarantee.
          void cursorWritten;
          } catch (e) {
            console.error('[stealth/sync] cursor update failed: next sync will rescan from stored cursor:', e);
            cursorFailed = true;
          }
        }

        // 5. SYNC_COMPLETE.
        if (parent) {
          const msg: StealthSyncCompleteMessage = {
            type: "OR_STEALTH_SYNC_COMPLETE",
            connection_id: init.connection_id,
            sealed_transactions: result.sealedTransactions,
            last_block_scanned: result.lastBlockScanned,
            tx_count: result.txCount,
            bytes_downloaded: result.bytesDownloaded,
            duration_seconds: (Date.now() - startedAt) / 1000,
            address_window_exhausted: result.windowExhausted || undefined,
            cursor_update_failed: cursorFailed ? true : undefined,
          };
          try {
            parent.postMessage(msg, init.return_callback_origin);
          } catch (e) {
            console.error("[stealth/sync] failed to post complete:", e);
          }
        }

        if (cancelled) return;
        setDone({ txCount: result.txCount, bytes: result.bytesDownloaded, windowExhausted: result.windowExhausted });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        if (e instanceof WindowExhaustedError) {
          // Address window exhausted: wallet history beyond the scanned window
          // may be missing. Not retryable as is; the embedder must prompt a
          // re-sync with a wider gap_limit. Its own code so this is
          // distinguishable from an unexpected INTERNAL failure. DL-0584.
          postWidgetError("WINDOW_EXHAUSTED", msg, false);
        } else {
          postWidgetError("INTERNAL", msg, true);
        }
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
              ? "Nothing new on chain since the last sync."
              : `Sealed and stored ${done.txCount} transaction${done.txCount === 1 ? "" : "s"}.`}
          </p>
          {done.windowExhausted && (
            <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-left text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-semibold">Your history may be incomplete.</p>
              <p className="mt-1">
                Transactions were found near the edge of the address window. Some older
                transactions may not have been found. Re-connect this wallet with a
                wider address window to recover the full history.
              </p>
            </div>
          )}
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
      isFirstSync={isFirstSync ?? undefined}
    />
  );
}

export default SyncRoute;
