import { memo } from "react";

export const AmbientBackground = memo(function AmbientBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {/* Mesh gradient orbs */}
      <div
        className="absolute -top-[10%] -right-[5%] w-[400px] h-[400px] rounded-full opacity-[0.06] blur-[80px]"
        style={{ background: "var(--color-accent)" }}
      />
      <div
        className="absolute -bottom-[15%] -left-[5%] w-[320px] h-[320px] rounded-full opacity-[0.05] blur-[60px]"
        style={{ background: "var(--color-info)" }}
      />
      <div
        className="absolute top-[20%] left-[10%] w-[240px] h-[240px] rounded-full opacity-[0.03] blur-[50px]"
        style={{ background: "var(--color-success)" }}
      />

      {/* Surface gradient overlay */}
      <div
        className="absolute inset-0 opacity-80"
        style={{
          background:
            "radial-gradient(circle at 50% 50%, transparent 0%, var(--color-background) 80%)",
        }}
      />
    </div>
  );
});
