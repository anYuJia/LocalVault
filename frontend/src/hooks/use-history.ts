import { useState, useCallback, useEffect } from "react";
import type { HistoryItem } from "@/lib/tauri";
import { getHistory, clearHistory as apiClearHistory, deleteHistory as apiDeleteHistory } from "@/lib/tauri";
import { useLogStore } from "@/stores/app-store";

// ═══════════════════════════════════════════════
// History Hook
// ═══════════════════════════════════════════════

interface HistoryState {
  items: HistoryItem[];
  loading: boolean;
  error: string | null;
}

export function useHistory() {
  const [state, setState] = useState<HistoryState>({
    items: [],
    loading: false,
    error: null,
  });
  const addLog = useLogStore((s) => s.addLog);

  const loadHistory = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      // 默认 limit=1000，避免挂载时全量拉取历史索引
      const items = await getHistory({ limit: 1000 });
      setState((s) => ({ ...s, loading: false, items: items || [] }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "加载历史失败";
      setState((s) => ({ ...s, loading: false, error: msg }));
      addLog(msg, "error");
    }
  }, [addLog]);

  const clearAll = useCallback(async () => {
    try {
      await apiClearHistory();
      setState((s) => ({ ...s, items: [] }));
      addLog("下载历史已清空", "info");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "清空失败";
      addLog(msg, "error");
    }
  }, [addLog]);

  const deleteItem = useCallback(async (id: string) => {
    try {
      await apiDeleteHistory(id);
      setState((s) => ({ ...s, items: s.items.filter((i) => i.id !== id && i.aweme_id !== id) }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "删除失败";
      addLog(msg, "error");
    }
  }, [addLog]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  return { ...state, loadHistory, clearAll, deleteItem };
}
