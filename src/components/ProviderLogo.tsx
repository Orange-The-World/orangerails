import { useState } from "react";
import { cn } from "@/lib/utils";

const FALLBACK_PALETTE = [
  "bg-orange-500",
  "bg-blue-500",
  "bg-emerald-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-amber-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-teal-500",
  "bg-fuchsia-500",
];

function hashSlug(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i += 1) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return h;
}

function initials(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 ]/g, "").trim();
  if (!cleaned) return "??";
  const parts = cleaned.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase();
}

export interface ProviderLogoProps {
  slug: string;
  displayName: string;
  src?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function ProviderLogo({
  slug,
  displayName,
  src,
  size = "md",
  className,
}: ProviderLogoProps) {
  const [errored, setErrored] = useState(false);
  const dim =
    size === "lg" ? "h-12 w-12 text-base" : size === "sm" ? "h-7 w-7 text-[10px]" : "h-9 w-9 text-xs";

  if (src && !errored) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        onError={() => setErrored(true)}
        className={cn("rounded-md object-contain bg-card", dim, className)}
      />
    );
  }

  const colour = FALLBACK_PALETTE[hashSlug(slug) % FALLBACK_PALETTE.length];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex items-center justify-center rounded-md font-semibold text-white",
        colour,
        dim,
        className,
      )}
    >
      {initials(displayName)}
    </span>
  );
}
