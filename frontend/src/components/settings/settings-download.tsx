import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { FileImage, FileText, FolderOpen, FolderTree, Gauge, Loader2, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { TEMPLATE_VARIABLES, type SavingFields, type SettingsField, type SettingStatus } from "./settings-utils";
import { SettingGroup } from "./settings-components";

interface SettingsDownloadTabProps {
  downloadPath: string;
  setDownloadPath: (value: string) => void;
  downloadQuality: string;
  downloadLivePhotoVideo: boolean;
  downloadLivePhotoImage: boolean;
  maxConcurrent: string;
  filenameTemplate: string;
  setFilenameTemplate: (value: string) => void;
  folderNameTemplate: string;
  setFolderNameTemplate: (value: string) => void;
  autoCreateFolder: boolean;
  choosingDirectory: boolean;
  savingFields: SavingFields;
  fieldStatus: (field: SettingsField) => SettingStatus | undefined;
  handleChooseDirectory: () => void;
  handleQualityChange: (value: string) => void;
  handleLivePhotoContentChange: (kind: "video" | "image", value: boolean) => void;
  handleMaxConcurrentChange: (value: string) => void;
  handleAutoCreateFolderChange: (value: boolean) => void;
  saveFilenameTemplate: (value: string) => void;
  saveFolderNameTemplate: (value: string) => void;
  appendFilenameToken: (token: string) => void;
  appendFolderToken: (token: string) => void;
}

export function SettingsDownloadTab({ downloadPath, setDownloadPath, downloadQuality, downloadLivePhotoVideo, downloadLivePhotoImage, maxConcurrent, filenameTemplate, setFilenameTemplate, folderNameTemplate, setFolderNameTemplate, autoCreateFolder, choosingDirectory, savingFields, fieldStatus, handleChooseDirectory, handleQualityChange, handleLivePhotoContentChange, handleMaxConcurrentChange, handleAutoCreateFolderChange, saveFilenameTemplate, saveFolderNameTemplate, appendFilenameToken, appendFolderToken }: SettingsDownloadTabProps) {
  const renderLivePhotoToggle = (kind: "video" | "image", label: string, checked: boolean) => (
    <button
      type="button"
      onClick={() => void handleLivePhotoContentChange(kind, !checked)}
      disabled={savingFields.download_live_photo_video || savingFields.download_live_photo_image}
      className={cn("flex h-8 items-center justify-between rounded-[8px] border px-2.5 transition-[background-color,border-color,opacity]", checked ? "border-accent/25 bg-accent/5" : "border-border bg-white/[0.01]", (savingFields.download_live_photo_video || savingFields.download_live_photo_image) && "opacity-70")}
    >
      <span className="text-[0.76rem] font-semibold text-text">{label}</span>
      <span className={cn("relative h-4.5 w-8.5 rounded-full transition-colors", checked ? "bg-accent" : "bg-white/[0.12]")}>
        <span className={cn("absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")} />
      </span>
    </button>
  );

  return (
    <div className="space-y-4">
      <SettingGroup icon={FolderOpen} label="下载目录" status={fieldStatus("download_path")}>
        <div className="flex gap-2">
          <Input value={downloadPath} onChange={(event) => setDownloadPath(event.target.value)} placeholder="选择或输入下载路径" className="h-9 text-[0.78rem]" />
          <Button variant="secondary" onClick={handleChooseDirectory} disabled={choosingDirectory} className="h-9 rounded-[8px] text-[0.76rem] px-3 shrink-0 cursor-pointer">{choosingDirectory ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "选择"}</Button>
        </div>
      </SettingGroup>

      <SettingGroup icon={FolderTree} label="作者目录规则" status={fieldStatus("folder_name_template") || fieldStatus("auto_create_folder")}>
        <div className="space-y-2">
          <button type="button" onClick={() => void handleAutoCreateFolderChange(!autoCreateFolder)} disabled={savingFields.auto_create_folder} className={cn("flex h-8 w-full items-center justify-between rounded-[8px] border px-2.5 transition-[background-color,border-color,opacity]", autoCreateFolder ? "border-accent/25 bg-accent/5" : "border-border bg-white/[0.01]", savingFields.auto_create_folder && "opacity-70")}>
            <span className="text-[0.76rem] font-semibold text-text">按目录归档</span>
            <span className={cn("relative h-4.5 w-8.5 rounded-full transition-colors", autoCreateFolder ? "bg-accent" : "bg-white/[0.12]")}>
              <span className={cn("absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform", autoCreateFolder ? "translate-x-4.5" : "translate-x-0.5")} />
            </span>
          </button>
          <Input value={folderNameTemplate} onChange={(event) => setFolderNameTemplate(event.target.value)} onBlur={() => void saveFolderNameTemplate(folderNameTemplate)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} disabled={!autoCreateFolder || savingFields.folder_name_template} placeholder="{author}" className="h-9 font-mono text-[0.78rem]" />
          <div className="flex flex-wrap gap-1">
            {TEMPLATE_VARIABLES.filter((item) => item.token !== "{title}").map((item) => (<button key={item.token} type="button" onClick={() => appendFolderToken(item.token)} disabled={!autoCreateFolder || savingFields.folder_name_template} className="inline-flex h-6 items-center rounded-[6px] border border-border bg-white/[0.01] px-1.5 font-mono text-[0.65rem] text-text-secondary transition-all hover:border-accent/30 hover:bg-accent/10 hover:text-accent disabled:opacity-50" title={item.label}>{item.token}</button>))}
          </div>
        </div>
      </SettingGroup>

      <SettingGroup icon={FileText} label="文件命名规则" status={fieldStatus("filename_template")}>
        <div className="space-y-2">
          <Input value={filenameTemplate} onChange={(event) => setFilenameTemplate(event.target.value)} onBlur={() => void saveFilenameTemplate(filenameTemplate)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} disabled={savingFields.filename_template} placeholder="{title}_{aweme_id}" className="h-9 font-mono text-[0.78rem]" />
          <div className="flex flex-wrap gap-1">
            {TEMPLATE_VARIABLES.map((item) => (<button key={item.token} type="button" onClick={() => appendFilenameToken(item.token)} disabled={savingFields.filename_template} className="inline-flex h-6 items-center rounded-[6px] border border-border bg-white/[0.01] px-1.5 font-mono text-[0.65rem] text-text-secondary transition-all hover:border-accent/30 hover:bg-accent/10 hover:text-accent" title={item.label}>{item.token}</button>))}
          </div>
        </div>
      </SettingGroup>

      <div className="grid grid-cols-2 gap-3">
        <SettingGroup icon={Gauge} label="下载质量" status={fieldStatus("download_quality")}>
          <Select value={downloadQuality} onValueChange={(value) => void handleQualityChange(value)}>
            <SelectTrigger className="h-9 text-[0.76rem] rounded-[8px]" disabled={savingFields.download_quality}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="auto">自动</SelectItem><SelectItem value="highest">最高质量</SelectItem><SelectItem value="h264">兼容优先 (H.264)</SelectItem><SelectItem value="4k">4K</SelectItem><SelectItem value="2k">2K</SelectItem><SelectItem value="1080p">1080P</SelectItem><SelectItem value="720p">720P</SelectItem><SelectItem value="480p">480P</SelectItem><SelectItem value="smallest">最小体积</SelectItem></SelectContent>
          </Select>
        </SettingGroup>
        <SettingGroup icon={Zap} label="并发数" status={fieldStatus("max_concurrent")}>
          <Select value={maxConcurrent} onValueChange={(value) => void handleMaxConcurrentChange(value)}>
            <SelectTrigger className="h-9 text-[0.76rem] rounded-[8px]" disabled={savingFields.max_concurrent}><SelectValue /></SelectTrigger>
            <SelectContent>{[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (<SelectItem key={n} value={String(n)}>{n} 个{n === 3 ? " (推荐)" : ""}</SelectItem>))}</SelectContent>
          </Select>
        </SettingGroup>
      </div>

      <SettingGroup icon={FileImage} label="实况图内容" status={fieldStatus("download_live_photo_video") || fieldStatus("download_live_photo_image")}>
        <div className="grid grid-cols-2 gap-2">
          {renderLivePhotoToggle("video", "视频", downloadLivePhotoVideo)}
          {renderLivePhotoToggle("image", "图片", downloadLivePhotoImage)}
        </div>
      </SettingGroup>
    </div>
  );
}
