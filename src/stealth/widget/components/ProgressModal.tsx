/**
 * Stealth Sync , transparency progress modal.
 *
 * Renders the eight stages from postmessage.ts with the locked copy from
 * STEALTH-SYNC-MASTER-PLAN.md §5.2. The active stage shows the percent
 * bar; completed stages show a check; upcoming stages are listed under
 * "Next steps (your browser will do these)" so the user always sees the
 * full pipeline.
 *
 * Copy is locked in the master plan §5.2; do not paraphrase here without
 * updating the plan.
 */

import type { StealthStage } from '@/stealth/lib/postmessage';

interface StageCopy {
  message: string;
  detail: string;
  /** Short-form label for the upcoming-steps list. Plain English; matches
   *  the modal mock in master plan §5.1. */
  shortLabel: string;
  /** Optional muted sub-line shown below shortLabel in the upcoming-steps
   *  list. Rendered inside the same li (inside the touch target). */
  shortSubtext?: string;
}

const STAGE_ORDER: StealthStage[] = [
  'unlocking',
  'deriving',
  'fetching_filters',
  'matching',
  'fetching_blocks',
  'building_txs',
  'sealing',
  'uploading',
];

const STAGE_COPY: Record<StealthStage, StageCopy> = {
  unlocking: {
    message: 'Vault unlocked',
    detail: 'Your password never left this browser.',
    shortLabel: 'Unlock your vault',
  },
  deriving: {
    message: 'Computing your addresses',
    detail: 'Sparrow and Wasabi do this the same way.',
    shortLabel: 'Compute your addresses',
  },
  fetching_filters: {
    message: 'Downloading public filter files',
    detail: 'These files are the same for everyone. Block range {from}-{to}.',
    shortLabel: 'Download public filter files',
  },
  matching: {
    message: 'Matching filters against your addresses',
    detail: 'The match runs locally; no addresses are sent anywhere.',
    shortLabel: 'Match filters against your addresses',
  },
  fetching_blocks: {
    message: 'Fetching blocks where your wallet appears',
    detail: '{n} blocks need to be downloaded.',
    shortLabel: 'Fetch the blocks that match',
  },
  building_txs: {
    message: 'Building your transaction history',
    detail: 'Your browser is parsing each block.',
    shortLabel: 'Build your transaction history',
  },
  sealing: {
    message: 'Sealing your transactions',
    detail: 'Encrypted with your vault key, only you can open them.',
    shortLabel: 'Encrypt your history in your browser',
    shortSubtext: 'Your key never leaves your device',
  },
  uploading: {
    message: 'Saving encrypted records to Orange Rails',
    detail:
      'Orange Rails stores only the encrypted bytes as a backup. They cannot read your transactions; only your browser holds the key.',
    shortLabel: 'Ship it to your app',
  },
};

export interface ProgressModalProps {
  stage: StealthStage;
  /** 0-100. */
  percent?: number;
  /** Optional override for the active stage's detail line. */
  detailOverride?: string;
  /** True = first sync (last_block_scanned was null). False = repeat sync.
   *  Omit to suppress the timing footer entirely. */
  isFirstSync?: boolean;
}

export function ProgressModal({ stage, percent, detailOverride, isFirstSync }: ProgressModalProps) {
  const activeIdx = STAGE_ORDER.indexOf(stage);
  const copy = STAGE_COPY[stage];
  const pct = Math.max(0, Math.min(100, Math.round(percent ?? 0)));

  return (
    <div
      role="dialog"
      aria-live="polite"
      aria-label="Stealth Sync progress"
      className="flex min-h-screen items-center justify-center bg-background p-6"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-lg">🔒</span>
          <h2 className="text-base font-semibold text-foreground">
            Stealth Sync
          </h2>
        </div>

        <p className="mt-3 text-sm text-muted-foreground">
          Your xpub stays on your device. We are taking a few seconds longer
          than a regular bank connection because the math runs in your
          browser, not on our servers. This is what zero-knowledge looks like.
        </p>

        {/* Completed + active stages */}
        <ul className="mt-4 space-y-1.5 text-sm">
          {STAGE_ORDER.slice(0, activeIdx).map((s) => (
            <li key={s} className="flex items-start gap-2 text-muted-foreground">
              <span aria-hidden className="mt-0.5 text-emerald-600">✓</span>
              <span>{STAGE_COPY[s].message}</span>
            </li>
          ))}
          <li className="flex items-start gap-2 text-foreground">
            <span aria-hidden className="mt-0.5">⏳</span>
            <div className="flex-1">
              <p className="font-medium">{copy.message}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {detailOverride ?? copy.detail}
              </p>
              {percent !== undefined && (
                <div className="mt-2" aria-label={`Progress ${pct}%`}>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-[width] duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="mt-1 text-right text-[10px] text-muted-foreground">
                    {pct}%
                  </p>
                </div>
              )}
            </div>
          </li>
        </ul>

        {/* Upcoming stages */}
        {activeIdx < STAGE_ORDER.length - 1 && (
          <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground">
              Next steps (your browser will do these):
            </p>
            <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
              {STAGE_ORDER.slice(activeIdx + 1).map((s) => (
                <li key={s}>
                  <span>· {STAGE_COPY[s].shortLabel}</span>
                  {STAGE_COPY[s].shortSubtext && (
                    <p className="mt-0.5 pl-3 leading-snug">
                      {STAGE_COPY[s].shortSubtext}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {isFirstSync !== undefined && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {isFirstSync
              ? 'Sync time depends on how far back your wallet scans and your connection speed. The bar shows blocks remaining.'
              : 'After the first sync, later syncs take seconds.'}
          </p>
        )}
        <p className="mt-4 text-[10px] text-muted-foreground">
          Why is this slower than a regular bank connection? Stealth Sync
          runs the math in your browser so your xpub never reaches our
          servers. See{' '}
          <a
            href="https://orangerails.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            orangerails.com
          </a>{' '}
          for more.
        </p>
      </div>
    </div>
  );
}

export default ProgressModal;
