import { motion } from "framer-motion";
import { Monitor, Moon, Palette, Sun, Type } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThemeMode, FontSizeMode } from "@/types";
import type { SavingFields, SettingsField, SettingStatus } from "./settings-utils";
import { SettingGroup } from "./settings-components";

interface SettingsAppearanceTabProps {
  theme: ThemeMode;
  fontSize: FontSizeMode;
  savingFields: SavingFields;
  fieldStatus: (field: SettingsField) => SettingStatus | undefined;
  handleThemeChange: (value: ThemeMode) => void;
  handleFontSizeChange: (value: FontSizeMode) => void;
}

export function SettingsAppearanceTab({
  theme,
  fontSize = "medium",
  savingFields,
  fieldStatus,
  handleThemeChange,
  handleFontSizeChange,
}: SettingsAppearanceTabProps) {
  return (
    <div className="space-y-4">
      <SettingGroup icon={Palette} label="外观主题" status={fieldStatus("theme")}>
        <div className="flex gap-1 p-1 rounded-[10px] bg-white/[0.02] border border-white/[0.04]">
          {(
            [
              { value: "light", icon: Sun, label: "亮色" },
              { value: "dark", icon: Moon, label: "暗色" },
              { value: "auto", icon: Monitor, label: "系统" },
            ] as const
          ).map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              onClick={() => void handleThemeChange(value as ThemeMode)}
              disabled={savingFields.theme}
              className={cn(
                "relative flex-1 flex items-center justify-center gap-1.5 h-8.5 rounded-[8px] text-[0.78rem] font-semibold transition-all duration-200 cursor-pointer",
                savingFields.theme && "cursor-wait opacity-75",
                theme === value
                  ? "text-text"
                  : "text-text-muted hover:text-text-secondary"
              )}
            >
              {theme === value && (
                <motion.div
                  layoutId="theme-tab-bg"
                  className="absolute inset-0 rounded-[8px] bg-accent/[0.1] shadow-[0_0_12px_rgba(254,44,85,0.04)]"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
              <Icon className="relative w-3.5 h-3.5" />
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>
      </SettingGroup>

      <SettingGroup icon={Type} label="字体大小" status={fieldStatus("font_size" as SettingsField)}>
        <div className="flex gap-1 p-1 rounded-[10px] bg-white/[0.02] border border-white/[0.04]">
          {(
            [
              { value: "small", label: "较小" },
              { value: "medium", label: "默认" },
              { value: "large", label: "较大" },
              { value: "xlarge", label: "超大" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={value}
              onClick={() => void handleFontSizeChange(value as FontSizeMode)}
              className={cn(
                "relative flex-1 flex items-center justify-center h-8.5 rounded-[8px] text-[0.78rem] font-semibold transition-all duration-200 cursor-pointer",
                fontSize === value
                  ? "text-text"
                  : "text-text-muted hover:text-text-secondary"
              )}
            >
              {fontSize === value && (
                <motion.div
                  layoutId="font-tab-bg"
                  className="absolute inset-0 rounded-[8px] bg-accent/[0.1] shadow-[0_0_12px_rgba(254,44,85,0.04)]"
                  transition={{ type: "spring", stiffness: 400, damping: 30 }}
                />
              )}
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>
      </SettingGroup>
    </div>
  );
}
