import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full rounded-[var(--radius-sm)] border border-border bg-surface px-3 py-1.5 text-[0.8125rem] text-text placeholder:text-text-muted transition-[background-color,border-color,box-shadow,color,opacity] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
          "focus:border-accent focus:ring-0 focus:bg-surface-raised",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
