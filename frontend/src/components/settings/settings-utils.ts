import { saveConfig } from "@/lib/tauri";

export type LoginStatus = "idle" | "starting" | "waiting" | "success" | "error" | "cancelled";

export type SettingsField =
  | "theme"
  | "font_size"
  | "download_path"
  | "download_quality"
  | "download_live_photo_video"
  | "download_live_photo_image"
  | "max_concurrent"
  | "filename_template"
  | "folder_name_template"
  | "auto_create_folder"
  | "ssl_verify";

export type SavingFields = Partial<Record<SettingsField, boolean>>;

export type SettingsPatch = Parameters<typeof saveConfig>[0];

export type SettingStatus = "saving" | "saved" | "error";

export const TEMPLATE_VARIABLES = [
  { token: "{title}", label: "标题" },
  { token: "{aweme_id}", label: "作品ID" },
  { token: "{author}", label: "作者" },
  { token: "{date}", label: "日期" },
  { token: "{time}", label: "时间" },
  { token: "{media_type}", label: "类型" },
];

export const FILENAME_PRESETS = [
  { value: "{title}_{aweme_id}", label: "标题 + 作品ID" },
  { value: "{author}_{title}_{aweme_id}", label: "作者 + 标题 + 作品ID" },
  { value: "{date}_{title}_{aweme_id}", label: "日期 + 标题 + 作品ID" },
  { value: "{title}", label: "只写标题，自动补ID" },
];
