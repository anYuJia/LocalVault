import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type SurfaceDensity = "compact" | "default" | "spacious" | "none";
type SurfaceTone = "default" | "muted" | "solid";

const densityClasses: Record<SurfaceDensity, string> = {
  compact: "p-3",
  default: "p-4",
  spacious: "p-5 sm:p-6",
  none: "",
};

const toneClasses: Record<SurfaceTone, string> = {
  default: "bg-surface-solid/70",
  muted: "bg-surface-solid/45",
  solid: "bg-surface-solid/85",
};

type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  density?: SurfaceDensity;
  tone?: SurfaceTone;
  interactive?: boolean;
};

type SectionSurfaceProps = HTMLAttributes<HTMLElement> & {
  density?: SurfaceDensity;
  tone?: SurfaceTone;
  interactive?: boolean;
};

export function surfaceClassName({
  density = "default",
  tone = "default",
  interactive = false,
  className,
}: {
  density?: SurfaceDensity;
  tone?: SurfaceTone;
  interactive?: boolean;
  className?: string;
}) {
  return cn(
    "rounded-[var(--radius-lg)] border border-border shadow-[var(--shadow-sm)]",
    "transition-[background-color,border-color,box-shadow,transform,opacity] duration-[var(--duration-base)] ease-[var(--ease-spring)]",
    densityClasses[density],
    toneClasses[tone],
    interactive && "hover:border-border-strong hover:bg-surface-raised hover:shadow-md active:scale-[0.99]",
    className
  );
}

export function Surface({ density = "default", tone = "default", interactive = false, className, ...props }: SurfaceProps) {
  return <div className={surfaceClassName({ density, tone, interactive, className })} {...props} />;
}

export function SectionSurface({ density = "default", tone = "default", interactive = false, className, ...props }: SectionSurfaceProps) {
  return <section className={surfaceClassName({ density, tone, interactive, className })} {...props} />;
}
