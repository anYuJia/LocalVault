import { useCallback, useEffect, useRef } from "react";
import { getNotices, publishComment, suggestAiInteraction } from "@/lib/tauri";
import type { NoticeItem } from "@/lib/contracts";
import { useAppStore, useLogStore } from "@/stores/app-store";
import {
  getAiAutoSendDelayMs,
  normalizeAiSuggestions,
  readAiAutomationConfig,
  rememberAutomationKey,
  shouldAutomateText,
  waitForAiAutoSend,
} from "@/lib/ai-automation";

export const NOTICE_REFRESH_OPTIONS = [
  { label: "不自动刷新", value: 0 },
  { label: "15 秒", value: 15 },
  { label: "30 秒", value: 30 },
  { label: "60 秒", value: 60 },
  { label: "120 秒", value: 120 },
];

const autoRepliedNoticeIds = new Set<string>();

export async function runNoticeAutomation(items: NoticeItem[], accountSecUid = useAppStore.getState().currentSecUid) {
  if (!accountSecUid) return;
  const config = await readAiAutomationConfig();
  if (!config?.auto_monitor_notices || !config.auto_send_comments) return;
  const addLog = useLogStore.getState().addLog;
  let handled = 0;

  for (const notice of items) {
    if (useAppStore.getState().currentSecUid !== accountSecUid) break;
    const comment = notice.comment;
    const awemeId = notice.aweme?.aweme_id;
    const key = comment?.cid || notice.id;
    const scopedKey = key ? `${accountSecUid}:${key}` : "";
    if (!scopedKey || autoRepliedNoticeIds.has(scopedKey)) continue;
    if (handled >= config.auto_max_actions_per_run) break;
    if (notice.type !== 31 || !comment || !awemeId) continue;

    const matchText = [
      notice.content,
      notice.comment_text,
      comment.text,
      comment.user?.nickname,
      notice.aweme?.desc,
    ].filter(Boolean).join(" ");
    if (!shouldAutomateText(matchText, config, "comment")) continue;
    if (!rememberAutomationKey(autoRepliedNoticeIds, scopedKey)) continue;

    handled += 1;
    try {
      const result = await suggestAiInteraction({
        target: "comment",
        context: [
          notice.aweme?.desc ? `视频文案：${notice.aweme.desc}` : "",
          notice.content ? `通知：${notice.content}` : "",
          comment.reply_to_text ? `上文：${comment.reply_to_text}` : "",
          comment.text ? `${comment.user?.nickname || "用户"}：${comment.text}` : "",
        ].filter(Boolean).join("\n").slice(-900),
        incoming_text: comment.text.slice(0, 360),
        author_name: comment.user?.nickname || "",
        tone: "friendly",
        language: "zh-CN",
        max_suggestions: 3,
      });
      const suggestions = normalizeAiSuggestions(result);
      if (!result.actions?.send_comment || suggestions.length === 0) continue;
      await waitForAiAutoSend(getAiAutoSendDelayMs(result.auto_send_delay_ms));
      if (useAppStore.getState().currentSecUid !== accountSecUid) break;
      const publish = await publishComment(
        awemeId,
        suggestions[0],
        comment.root_cid,
        comment.is_sub ? comment.cid : "0"
      );
      if (publish.success) {
        addLog(`通知自动回复成功：${comment.user?.nickname || "用户"}`, "success");
      } else {
        addLog(publish.message || "通知自动回复失败", "warning");
      }
    } catch (error) {
      addLog(error instanceof Error ? error.message : "通知自动回复失败", "warning");
    }
  }
}

export function useGlobalNoticeMonitor() {
  const cookieLoggedIn = useAppStore((state) => state.cookieLoggedIn);
  const currentSecUid = useAppStore((state) => state.currentSecUid);
  const refreshIntervalSeconds = useAppStore((state) => state.noticeRefreshIntervalSeconds);
  const setNoticeUnreadCount = useAppStore((state) => state.setNoticeUnreadCount);
  const setNoticeItems = useAppStore((state) => state.setNoticeItems);
  const setNoticeAutoRefreshing = useAppStore((state) => state.setNoticeAutoRefreshing);
  const setNoticeLastUpdatedAt = useAppStore((state) => state.setNoticeLastUpdatedAt);
  const inFlightRef = useRef(false);

  const poll = useCallback(async () => {
    if (!cookieLoggedIn || !currentSecUid || refreshIntervalSeconds <= 0 || inFlightRef.current) return;
    const accountAtStart = currentSecUid;
    inFlightRef.current = true;
    setNoticeAutoRefreshing(true);
    try {
      const resp = await getNotices({ count: 20 });
      if (useAppStore.getState().currentSecUid !== accountAtStart) return;
      if (resp.success) {
        const items = resp.notices || [];
        setNoticeItems(items);
        setNoticeUnreadCount(Number(resp.unread_count || 0));
        setNoticeLastUpdatedAt(Date.now());
        void runNoticeAutomation(items, accountAtStart);
      }
    } catch {
      // 后台刷新失败不打断当前界面，下一轮继续尝试。
    } finally {
      inFlightRef.current = false;
      setNoticeAutoRefreshing(false);
    }
  }, [cookieLoggedIn, currentSecUid, refreshIntervalSeconds, setNoticeAutoRefreshing, setNoticeItems, setNoticeLastUpdatedAt, setNoticeUnreadCount]);

  useEffect(() => {
    autoRepliedNoticeIds.clear();
    inFlightRef.current = false;
    setNoticeItems([]);
    setNoticeUnreadCount(0);
    setNoticeLastUpdatedAt(0);
    setNoticeAutoRefreshing(false);
  }, [currentSecUid, setNoticeAutoRefreshing, setNoticeItems, setNoticeLastUpdatedAt, setNoticeUnreadCount]);

  useEffect(() => {
    if (!cookieLoggedIn || !currentSecUid || refreshIntervalSeconds <= 0) return;
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, refreshIntervalSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [cookieLoggedIn, currentSecUid, poll, refreshIntervalSeconds]);
}
