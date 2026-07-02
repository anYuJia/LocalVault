import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-[0.85rem] font-bold transition-[background-color,color,border-color,box-shadow,transform,opacity] duration-200 ease-[var(--ease-spring)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:pointer-events-none disabled:opacity-40 cursor-pointer select-none active:scale-[0.96]",
  {
    variants: {
      variant: {
        default:
          "bg-accent text-white shadow-lg shadow-accent/20 hover:bg-accent-hover hover:shadow-accent/30",
        secondary:
          "bg-surface-raised text-text shadow-[inset_0_0_0_1px_var(--color-border)] hover:bg-surface-solid hover:shadow-[inset_0_0_0_1px_var(--color-border-strong),0_10px_24px_rgba(0,0,0,0.08)]",
        outline:
          "bg-transparent text-text-secondary shadow-[inset_0_0_0_1px_var(--color-border)] hover:text-text hover:bg-surface-raised hover:shadow-[inset_0_0_0_1px_var(--color-border-strong)]",
        ghost:
          "text-text-secondary hover:text-text hover:bg-surface-raised",
        danger:
          "bg-danger text-white shadow-lg shadow-danger/20 hover:brightness-110",
        "danger-outline":
          "border border-danger/25 bg-danger-soft text-danger hover:bg-danger hover:text-white",
        "success-outline":
          "border border-success/25 bg-success-soft text-success hover:bg-success hover:text-white",
        "info-outline":
          "border border-info/25 bg-info-soft text-info hover:bg-info hover:text-white",
        link:
          "text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-5 rounded-[12px]",
        sm: "h-9 px-4 text-[0.78rem] rounded-[10px]",
        lg: "h-12 px-8 text-[0.95rem] rounded-[14px]",
        icon: "h-10 w-10 rounded-[12px]",
        "icon-sm": "h-9 w-9 rounded-[10px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
