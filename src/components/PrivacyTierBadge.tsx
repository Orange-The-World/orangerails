import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ProviderTier } from "@/lib/providers";
import { cn } from "@/lib/utils";

interface TierMeta {
  label: string;
  tooltip: string;
  className: string;
}

const TIER_META: Record<ProviderTier, TierMeta> = {
  t0: {
    label: "Just you",
    tooltip: "Your secrets stay on your device. Nothing in the middle.",
    className: "bg-tier-t0/15 text-tier-t0 ring-tier-t0/30",
  },
  t1: {
    label: "You and the wallet",
    tooltip: "You and the wallet provider. Nobody else in between.",
    className: "bg-tier-t1/15 text-tier-t1 ring-tier-t1/30",
  },
  t2: {
    label: "Powered by an aggregator",
    tooltip: "A third party helps connect. They see what you connect, not your money.",
    className: "bg-tier-t2/15 text-tier-t2 ring-tier-t2/30",
  },
  t3: {
    label: "Manual upload",
    tooltip: "You drop in a file. Nothing connects automatically.",
    className: "bg-tier-t3/15 text-tier-t3 ring-tier-t3/30",
  },
};

export interface PrivacyTierBadgeProps {
  tier: ProviderTier;
  size?: "sm" | "md";
  showLabel?: boolean;
  className?: string;
}

export function PrivacyTierBadge({
  tier,
  size = "sm",
  showLabel = true,
  className,
}: PrivacyTierBadgeProps) {
  const meta = TIER_META[tier];
  const sizing =
    size === "md"
      ? "px-2.5 py-1 text-xs"
      : "px-2 py-0.5 text-[10px]";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-label={`Privacy tier: ${meta.label}. ${meta.tooltip}`}
            className={cn(
              "inline-flex items-center gap-1 rounded-full font-medium ring-1 ring-inset",
              sizing,
              meta.className,
              className,
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-block h-1.5 w-1.5 rounded-full",
                tier === "t0" && "bg-tier-t0",
                tier === "t1" && "bg-tier-t1",
                tier === "t2" && "bg-tier-t2",
                tier === "t3" && "bg-tier-t3",
              )}
            />
            {showLabel ? meta.label : tier.toUpperCase()}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <span className="font-medium">{tier.toUpperCase()} , {meta.label}.</span>{" "}
          {meta.tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
