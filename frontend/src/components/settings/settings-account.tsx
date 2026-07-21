import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SyntheticEvent } from "react";
import { CheckCircle2, ExternalLink, Globe, Key, Loader2, UserRound, X, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { mediaProxyUrl, refreshAccountProfile, type AccountInfo } from "@/lib/tauri";
import type { AlertConfig } from "@/stores/app-store";
import type { LoginStatus } from "./settings-utils";
import { SettingGroup } from "./settings-components";

interface AccountListSectionProps {
  accounts: AccountInfo[];
  currentSecUid: string;
  startLogin: (cookie?: string) => void;
  switchAccount: (secUid: string) => Promise<void>;
  deleteAccount: (secUid: string) => Promise<void>;
  onAccountsChanged?: () => Promise<void> | void;
  showAlert: (config: AlertConfig) => void;
}

const avatarRefreshAttempts = new Set<string>();

function AccountAvatar({ account, className, onRefreshed }: { account: AccountInfo; className: string; onRefreshed?: () => Promise<void> | void }) {
  const avatarSrc = account.avatar_thumb ? mediaProxyUrl(account.avatar_thumb, "image") : "";
  const initial = (account.nickname || account.sec_uid || "?").slice(0, 1).toUpperCase();
  const handleAvatarError = (event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    image.style.display = "none";
    const refreshKey = `${account.sec_uid}:${account.avatar_thumb || ""}`;
    if (!account.sec_uid || avatarRefreshAttempts.has(refreshKey)) return;
    avatarRefreshAttempts.add(refreshKey);
    void refreshAccountProfile(account.sec_uid)
      .then((result) => {
        if (result.success) return onRefreshed?.();
        return undefined;
      })
      .catch(() => undefined);
  };
  return (
    <div className={cn("relative overflow-hidden rounded-full border border-white/10 bg-white/[0.04] text-text-muted", className)}>
      {avatarSrc ? (
        <img
          key={avatarSrc}
          src={avatarSrc}
          alt={account.nickname}
          className="absolute inset-0 h-full w-full object-cover"
          onError={handleAvatarError}
        />
      ) : null}
      <div className="flex h-full w-full items-center justify-center text-[0.62rem] font-bold">
        {initial ? initial : <UserRound className="h-3.5 w-3.5" />}
      </div>
    </div>
  );
}

export function AccountListSection({ accounts, currentSecUid, startLogin, switchAccount, deleteAccount, onAccountsChanged, showAlert }: AccountListSectionProps) {
  return (
    <SettingGroup icon={Key} label="当前账号">
      {accounts.length > 0 ? (
        <div className="grid gap-2">
          {accounts.map((acc) => {
            const isActive = acc.sec_uid === currentSecUid;
            const isExpired = acc.is_valid === false;
            return (
              <div key={acc.sec_uid} className={cn("flex items-center gap-3 p-3 rounded-[10px] transition-all duration-200 border", isActive ? "bg-accent/[0.04] border-accent/20 shadow-[0_0_12px_rgba(254,44,85,0.02)]" : "bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.04]")}>
                <AccountAvatar account={acc} className="h-8 w-8 shrink-0" onRefreshed={onAccountsChanged} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[0.78rem] font-semibold text-text truncate">{acc.nickname}</span>
                    {isActive && (<span className="px-1.5 py-0.5 rounded-[4px] bg-accent/15 text-accent text-[0.58rem] font-bold">当前激活</span>)}
                    {isExpired && (<span className="px-1.5 py-0.5 rounded-[4px] bg-danger/15 text-danger text-[0.58rem] font-bold">已失效</span>)}
                  </div>
                  <span className="text-[0.62rem] text-text-muted truncate block font-mono">ID: {acc.sec_uid.substring(0, 15)}...</span>
                </div>
                <div className="flex items-center gap-1">
                  {isExpired ? (
                    <Button variant="ghost" size="sm" onClick={() => startLogin(acc.cookie)} className="h-7 rounded-[6px] text-[0.72rem] font-semibold px-2 hover:bg-danger/10 hover:text-danger text-danger cursor-pointer animate-pulse">重新登录</Button>
                  ) : (!isActive && (
                    <Button variant="ghost" size="sm" onClick={() => void switchAccount(acc.sec_uid)} className="h-7 rounded-[6px] text-[0.72rem] font-semibold px-2 hover:bg-accent/10 hover:text-accent cursor-pointer">切换</Button>
                  ))}
                  <Button variant="ghost" size="icon" onClick={() => { showAlert({ title: "注销账号", variant: "danger", description: `确定要注销账号「${acc.nickname}」并清空当前 Cookie 吗？`, actionLabel: "确定注销", cancelLabel: "取消", onAction: () => deleteAccount(acc.sec_uid) }); }} className="w-7 h-7 rounded-[6px] text-text-muted hover:text-danger hover:bg-danger/10 cursor-pointer"><X className="w-3.5 h-3.5" /></Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[0.75rem] text-text-muted text-center py-4 bg-white/[0.01] rounded-[10px] border border-dashed border-white/[0.04]">暂无已登录账号，请在下方登录或粘贴 Cookie</p>
      )}
    </SettingGroup>
  );
}

interface LoginSectionProps {
  loginStatus: LoginStatus;
  loginMessage: string;
  countdown: number;
  browserType: string;
  setBrowserType: (value: string) => void;
  startLogin: () => void;
  handleCancel: () => void;
  resetLogin: () => void;
}

export function LoginSection({ loginStatus, loginMessage, countdown, browserType, setBrowserType, startLogin, handleCancel, resetLogin }: LoginSectionProps) {
  const formatCountdown = (s: number) => { const m = Math.floor(s / 60); const sec = s % 60; return `${m}:${sec.toString().padStart(2, "0")}`; };
  return (
    <SettingGroup icon={Globe} label="登录账号">
      {loginStatus === "idle" ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <p className="text-[0.72rem] font-semibold uppercase tracking-wider text-text-muted">扫码/网页登录浏览器类型</p>
            <Select value={browserType} onValueChange={setBrowserType}>
              <SelectTrigger className="h-8 rounded-[8px] text-[0.74rem] w-[140px] ml-auto"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="chrome">Chrome</SelectItem><SelectItem value="edge">Edge</SelectItem><SelectItem value="chromium">Chromium</SelectItem></SelectContent>
            </Select>
          </div>
          <Button onClick={startLogin} className="w-full h-9 rounded-[8px] text-[0.78rem] font-bold gap-1.5 cursor-pointer"><ExternalLink className="w-3.5 h-3.5" />打开内置窗口登录</Button>
        </div>
      ) : (
        <div className="rounded-[10px] bg-white/[0.02] border border-white/[0.04] p-3">
          <div className="flex items-center gap-3">
            <div className={cn("w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0", (loginStatus === "starting" || loginStatus === "waiting") && "bg-info/10", loginStatus === "success" && "bg-success/10", loginStatus === "error" && "bg-danger/10", loginStatus === "cancelled" && "bg-white/[0.06]")}>
              {(loginStatus === "starting" || loginStatus === "waiting") && <Loader2 className="w-4 h-4 text-info animate-spin" />}
              {loginStatus === "success" && <CheckCircle2 className="w-4 h-4 text-success" />}
              {loginStatus === "error" && <XCircle className="w-4 h-4 text-danger" />}
              {loginStatus === "cancelled" && <X className="w-4 h-4 text-text-muted" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[0.78rem] font-semibold text-text">
                {loginStatus === "starting" && "正在启动..."}{loginStatus === "waiting" && "等待登录"}{loginStatus === "success" && "登录成功"}{loginStatus === "error" && "登录失败"}{loginStatus === "cancelled" && "已取消"}
              </p>
              <p className="text-[0.7rem] text-text-muted truncate mt-0.5">{loginMessage}</p>
            </div>
          </div>
          {loginStatus === "waiting" && countdown > 0 && (
            <div className="flex items-center justify-between px-2.5 py-1.5 rounded-[8px] bg-white/[0.04] my-2 text-[0.7rem]"><span className="text-text-muted">剩余时间</span><span className="font-mono font-semibold text-text tabular-nums">{formatCountdown(countdown)}</span></div>
          )}
          <div className="flex gap-2 mt-3">
            {(loginStatus === "starting" || loginStatus === "waiting") && (<Button variant="outline" onClick={handleCancel} className="flex-1 h-8 rounded-[8px] text-[0.74rem] text-danger hover:text-danger cursor-pointer">取消</Button>)}
            {(loginStatus === "success" || loginStatus === "error" || loginStatus === "cancelled") && (<Button variant="outline" onClick={resetLogin} className="flex-1 h-8 rounded-[8px] text-[0.74rem] cursor-pointer">{loginStatus === "success" ? "完成" : "重试"}</Button>)}
          </div>
        </div>
      )}
    </SettingGroup>
  );
}

interface CookieInputSectionProps {
  cookieValue: string;
  setCookieValue: (value: string) => void;
  cookieInputStatus: "idle" | "valid" | "invalid";
  savingCookie: boolean;
  loginMessage: string;
  handleValidateCookie: () => void;
  handleSaveCookie: (value: string) => void;
}

export function CookieInputSection({ cookieValue, setCookieValue, cookieInputStatus, savingCookie, loginMessage, handleValidateCookie, handleSaveCookie }: CookieInputSectionProps) {
  return (
    <SettingGroup icon={Key} label="手动录入 Cookie">
      <div className="space-y-3">
        <Textarea value={cookieValue} onChange={(e) => setCookieValue(e.target.value)} onBlur={handleValidateCookie} placeholder="从浏览器开发者工具复制抖音 Cookie并在此粘贴..." rows={2.5} className="text-[0.76rem] font-mono leading-relaxed placeholder:text-[0.74rem]" />
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {savingCookie ? (<p className="text-[0.68rem] text-info flex items-center gap-1"><Loader2 className="w-3.5 h-3.5 animate-spin" /> 正在校验并登录...</p>) : cookieInputStatus === "valid" ? (<p className="text-[0.68rem] text-success flex items-center gap-1 font-semibold"><CheckCircle2 className="w-3.5 h-3.5" /> 格式校验通过</p>) : cookieInputStatus === "invalid" ? (<p className="text-[0.68rem] text-danger flex items-center gap-1"><XCircle className="w-3.5 h-3.5" /> 需包含必要参数 sessionid</p>) : null}
          </div>
          <Button onClick={() => void handleSaveCookie(cookieValue)} disabled={savingCookie || !cookieValue.trim() || cookieInputStatus === "invalid"} className="h-8.5 rounded-[8px] text-[0.76rem] font-bold px-4 cursor-pointer shrink-0">确认添加</Button>
        </div>
        {loginMessage && (<p className="text-[0.68rem] text-text-muted mt-1 leading-relaxed bg-white/[0.02] p-2 rounded-[6px] border border-white/[0.04]">{loginMessage}</p>)}
      </div>
    </SettingGroup>
  );
}
