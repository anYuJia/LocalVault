import { useEffect, useState, type CSSProperties, type SVGProps } from "react";
import { useAppStore } from "@/stores/app-store";

type EffectiveTheme = "light" | "dark";

interface ThemeLogoProps extends SVGProps<SVGSVGElement> {
  label?: string;
}

function getSystemTheme(): EffectiveTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function useEffectiveTheme(): EffectiveTheme {
  const theme = useAppStore((s) => s.theme);
  const [systemTheme, setSystemTheme] = useState<EffectiveTheme>(getSystemTheme);

  useEffect(() => {
    if (theme !== "auto" || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const updateSystemTheme = () => {
      setSystemTheme(mediaQuery.matches ? "light" : "dark");
    };

    updateSystemTheme();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updateSystemTheme);
      return () => mediaQuery.removeEventListener("change", updateSystemTheme);
    }

    mediaQuery.addListener(updateSystemTheme);
    return () => mediaQuery.removeListener(updateSystemTheme);
  }, [theme]);

  return theme === "auto" ? systemTheme : theme;
}

export function ThemeLogo({ label, style, ...props }: ThemeLogoProps) {
  const effectiveTheme = useEffectiveTheme();
  const coreColor = effectiveTheme === "light" ? "#1C1C1E" : "#FFFFFF";
  const logoStyle = { "--logo-core": coreColor, ...style } as CSSProperties;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width="200"
      height="200"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={logoStyle}
      {...props}
    >
      <defs>
        <style>
          {`
            .theme-logo-cyan-fill { fill: #25F4EE; }
            .theme-logo-red-fill { fill: #FE2C55; }
            .theme-logo-core-fill { fill: var(--logo-core); }

            .theme-logo-cyan-stroke { stroke: #25F4EE; fill: none; stroke-linecap: round; stroke-linejoin: round; }
            .theme-logo-red-stroke { stroke: #FE2C55; fill: none; stroke-linecap: round; stroke-linejoin: round; }
            .theme-logo-core-stroke { stroke: var(--logo-core); fill: none; stroke-linecap: round; stroke-linejoin: round; }

            .theme-logo-float {
              animation: theme-logo-float 4s ease-in-out infinite;
            }
            @keyframes theme-logo-float {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-3px); }
            }

            .theme-logo-arrow-drop {
              animation: theme-logo-drop 2.5s infinite cubic-bezier(0.4, 0, 0.2, 1);
            }
            @keyframes theme-logo-drop {
              0% { transform: translateY(-4px); opacity: 0; }
              30% { transform: translateY(0); opacity: 1; }
              70% { transform: translateY(4px); opacity: 1; }
              100% { transform: translateY(8px); opacity: 0; }
            }

            .theme-logo-tray-pulse {
              animation: theme-logo-pulse 2.5s infinite ease-in-out;
              transform-origin: 50px 90px;
            }
            @keyframes theme-logo-pulse {
              0%, 60%, 100% { transform: scaleX(1); stroke-width: 3; }
              80% { transform: scaleX(1.06); stroke-width: 3.5; }
            }
          `}
        </style>
      </defs>

      <g className="theme-logo-float">
        <g transform="translate(29.7, 8.5) scale(0.08)">
          <path className="theme-logo-cyan-fill" d="M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z" />
        </g>

        <g transform="translate(32.7, 11.5) scale(0.08)">
          <path className="theme-logo-red-fill" d="M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z" />
        </g>

        <g transform="translate(31.2, 10) scale(0.08)">
          <path className="theme-logo-core-fill" d="M448,209.91a210.06,210.06,0,0,1-122.77-39.25V349.38A162.55,162.55,0,1,1,185,188.31V278.2a74.62,74.62,0,1,0,52.23,71.18V0l88,0a121.18,121.18,0,0,0,1.86,22.17h0A122.18,122.18,0,0,0,381,102.39a121.43,121.43,0,0,0,67,20.14Z" />
        </g>
      </g>

      <g className="theme-logo-arrow-drop">
        <g transform="translate(-1.5, -1.5)">
          <path className="theme-logo-cyan-stroke" strokeWidth="3" d="M 50 60 L 50 74 M 43 67 L 50 74 L 57 67" />
        </g>
        <g transform="translate(1.5, 1.5)">
          <path className="theme-logo-red-stroke" strokeWidth="3" d="M 50 60 L 50 74 M 43 67 L 50 74 L 57 67" />
        </g>
        <path className="theme-logo-core-stroke" strokeWidth="3" d="M 50 60 L 50 74 M 43 67 L 50 74 L 57 67" />
      </g>

      <g className="theme-logo-tray-pulse">
        <g transform="translate(-1.5, -1.5)">
          <path className="theme-logo-cyan-stroke" strokeWidth="3" d="M 34 84 L 34 87 C 34 90 37 92 40 92 L 60 92 C 63 92 66 90 66 87 L 66 84" />
        </g>
        <g transform="translate(1.5, 1.5)">
          <path className="theme-logo-red-stroke" strokeWidth="3" d="M 34 84 L 34 87 C 34 90 37 92 40 92 L 60 92 C 63 92 66 90 66 87 L 66 84" />
        </g>
        <path className="theme-logo-core-stroke" strokeWidth="3" d="M 34 84 L 34 87 C 34 90 37 92 40 92 L 60 92 C 63 92 66 90 66 87 L 66 84" />
      </g>
    </svg>
  );
}
