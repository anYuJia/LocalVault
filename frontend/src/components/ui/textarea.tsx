import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-[var(--radius-sm)] border border-border bg-surface px-3 py-2 text-[0.8125rem] text-text placeholder:text-text-muted outline-none focus-visible:outline-none transition-[background-color,border-color,box-shadow,color,opacity] duration-[var(--duration-fast)] ease-[var(--ease-spring)] resize-y",
          "focus:border-accent focus:ring-0 focus:bg-surface-raised",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "font-mono text-[0.75rem] leading-relaxed",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export { Textarea };
