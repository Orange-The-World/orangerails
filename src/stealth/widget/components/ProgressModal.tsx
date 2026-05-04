/**
 * Stealth Sync — transparency progress modal (stub).
 *
 * Milestone 1 placeholder: renders the §5.2 stage copy table for the
 * provided stage, with no actual progress logic. Subsequent milestones
 * wire it to the scan orchestrator and emit OR_STEALTH_PROGRESS messages
 * to the consuming app.
 *
 * Copy is locked in the master plan §5.2; do not paraphrase here without
 * updating the plan.
 */

import type { StealthStage } from "@/stealth/lib/postmessage";

interface StageCopy {
  message: string;
  detail: string;
}

const STAGE_COPY: Record<StealthStage, StageCopy> = {
  unlocking: {
    message: "Vault unlocked",
    detail: "Your password never left this browser.",
  },
  deriving: {
    message: "Computing your addresses",
    detail: "Sparrow and Wasabi do this the same way.",
  },
  fetching_filters: {
    message: "Downloading public filter files",
    detail:
      "These files are the same for everyone. Block range {from}-{to}.",
  },
  matching: {
    message: "Matching filters against your addresses",
    detail: "The match runs locally; no addresses are sent anywhere.",
  },
  fetching_blocks: {
    message: "Fetching blocks where your wallet appears",
    detail: "{n} blocks need to be downloaded.",
  },
  building_txs: {
    message: "Building your transaction history",
    detail: "Your browser is parsing each block.",
  },
  sealing: {
    message: "Sealing your transactions",
    detail:
      "Encrypted with your vault key, only you can open them.",
  },
  uploading: {
    message: "Saving sealed records",
    detail: "Our server stores the sealed bytes only.",
  },
};

export interface ProgressModalProps {
  stage: StealthStage;
  /** 0-100. Optional in the stub. */
  percent?: number;
  /** Optional override for the copy detail line (e.g. with substituted block range). */
  detailOverride?: string;
}

export function ProgressModal({ stage, percent, detailOverride }: ProgressModalProps) {
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

        <div className="mt-5 rounded-md border border-border bg-muted/30 p-4">
          <p className="text-sm font-medium text-foreground">{copy.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {detailOverride ?? copy.detail}
          </p>

          {percent !== undefined && (
            <div className="mt-3" aria-label={`Progress ${pct}%`}>
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
      </div>
    </div>
  );
}

export default ProgressModal;
