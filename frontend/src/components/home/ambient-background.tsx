import { memo } from "react";

export const AmbientBackground = memo(function AmbientBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div
        className="absolute inset-0 opacity-80"
        style={{
          background:
            "radial-gradient(circle at 50% 6%, rgba(254,44,85,0.11), transparent 30%), radial-gradient(circle at 18% 72%, rgba(124,92,252,0.10), transparent 34%), radial-gradient(circle at 84% 68%, rgba(0,214,143,0.07), transparent 30%)",
        }}
      />
      <div
        className="absolute inset-x-[8%] top-[12%] h-px opacity-60"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--color-border-strong), transparent)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.18]"
        style={{
          backgroundImage:
            "linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)",
          backgroundSize: "56px 56px",
          maskImage: "radial-gradient(circle at center, black, transparent 68%)",
          WebkitMaskImage: "radial-gradient(circle at center, black, transparent 68%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-95"
        style={{
          background:
            "radial-gradient(circle at 50% 48%, transparent 0%, var(--color-background) 78%)",
        }}
      />
    </div>
  );
});
