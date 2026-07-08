import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex shrink-0 items-center whitespace-nowrap rounded-full font-semibold leading-none transition-colors select-none",
  {
    variants: {
      variant: {
        default: "bg-accent/15 text-accent border border-accent/25",
        secondary: "bg-surface-raised text-text-secondary border border-border",
        success: "bg-success-soft text-success border border-success/25",
        info: "bg-info-soft text-info border border-info/25",
        warning: "bg-warning-soft text-warning border border-warning/25",
        danger: "bg-danger-soft text-danger border border-danger/25",
        outline: "border border-border text-text-secondary",
      },
      size: {
        default: "h-5 px-2 text-[0.6875rem]",
        sm: "h-4 px-1.5 text-[0.625rem]",
        lg: "h-6 px-2.5 text-[0.75rem]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
