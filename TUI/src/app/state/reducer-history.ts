// src/app/state/reducer-history.ts — 纯 reducer 分组：历史会话浏览

import {
  deletableSession,
  historyVisibleRecords,
  markableSessionIds,
} from "./types.ts";
import type { AppState, HistoryPanelState } from "./types.ts";
import type { StateAction } from "./actions.ts";

export function reduceHistory(
  state: AppState,
  action: StateAction,
): AppState | undefined {
  switch (action.type) {
    case "history-refresh": {
      // 删除/清理后重拉列表：保留面板结果提示与高亮位置（按**可见**长度 clamp）；
      // 标记集按新列表裁剪（已消失的 id 不再计入，避免幽灵标记）
      const hrf = state.history;
      if (!hrf || hrf.phase !== "list") return state;
      const alive = new Set(action.records.map((r) => r.id));
      const refreshed: HistoryPanelState = {
        ...hrf,
        records: action.records,
        error: undefined,
        marked: hrf.marked?.filter((id) => alive.has(id)),
      };
      const visible = historyVisibleRecords({ ...state, history: refreshed });
      return {
        ...state,
        history: {
          ...refreshed,
          index: Math.max(0, Math.min(visible.length - 1, hrf.index)),
        },
      };
    }
    case "history-result": {
      // 面板内结果提示：面板已关则忽略（调用方另有 buffer notice 留痕）
      const hrs = state.history;
      if (!hrs) return state;
      return { ...state, history: { ...hrs, result: action.text } };
    }
    case "history-scope-toggle": {
      // 切换列表范围（当前目录 ⇄ 全部）：尽量按 id 保留选中项，不可见则回首项
      const hst = state.history;
      if (!hst || hst.phase !== "list") return state;
      const scope: "project" | "all" = hst.scope === "all" ? "project" : "all";
      const prevId = historyVisibleRecords(state)[hst.index]?.id;
      const next: HistoryPanelState = { ...hst, scope };
      const visible = historyVisibleRecords({ ...state, history: next });
      const found =
        prevId === undefined ? -1 : visible.findIndex((r) => r.id === prevId);
      return {
        ...state,
        history: { ...next, index: found < 0 ? 0 : found },
      };
    }
    case "history-open":
      return {
        ...state,
        history: {
          phase: "loading-list",
          scope: "project",
          records: [],
          index: 0,
          messages: [],
          scroll: 0,
        },
      };
    case "history-list":
      // 面板已关闭则丢弃过期结果（异步竞态守卫）
      if (!state.history) return state;
      return {
        ...state,
        history: {
          ...state.history,
          phase: "list",
          records: action.records,
          index: 0,
          error: undefined,
        },
      };
    case "history-list-error":
      if (!state.history) return state;
      return {
        ...state,
        history: { ...state.history, phase: "error", error: action.error },
      };
    case "history-move": {
      if (!state.history || state.history.phase !== "list") return state;
      const hmv = state.history;
      const next = Math.max(
        0,
        Math.min(
          historyVisibleRecords(state).length - 1,
          hmv.index + action.delta,
        ),
      );
      return { ...state, history: { ...hmv, index: next } };
    }
    case "history-mark-toggle": {
      // Space：切换高亮行标记并下移一行（连续标记不必反复按 ↓）；
      // 不可删项（当前活跃 / live / 未持久化）不标记也不移动，由调用方 notice 说明
      const hmt = state.history;
      if (!hmt || hmt.phase !== "list") return state;
      const marked = hmt.marked ?? [];
      const rec = historyVisibleRecords(state)[hmt.index];
      if (!rec || !deletableSession(rec)) return state;
      const next = marked.includes(rec.id)
        ? marked.filter((id) => id !== rec.id)
        : [...marked, rec.id];
      const rows = historyVisibleRecords(state).length;
      return {
        ...state,
        history: {
          ...hmt,
          marked: next,
          index: Math.min(Math.max(0, rows - 1), hmt.index + 1),
        },
      };
    }
    case "history-mark-all": {
      // a：全选当前列表范围的可删项（**替换**标记集：删除集恒等于当前范围可删项，再按 Space 微调）
      const hma = state.history;
      if (!hma || hma.phase !== "list") return state;
      const ids = markableSessionIds(state);
      if (ids.length === 0) return state;
      return { ...state, history: { ...hma, marked: ids } };
    }
    case "history-mark-clear": {
      // c：清空标记集（无标记时不动状态，调用方据此提示）
      const hmc = state.history;
      if (!hmc || hmc.phase !== "list" || (hmc.marked?.length ?? 0) === 0) {
        return state;
      }
      return { ...state, history: { ...hmc, marked: [] } };
    }
    case "history-open-view": {
      if (!state.history || state.history.phase !== "list") return state;
      const hov = state.history;
      const rec = historyVisibleRecords(state)[hov.index];
      if (!rec) return state;
      return {
        ...state,
        history: { ...hov, phase: "loading-view", currentId: rec.id },
      };
    }
    case "history-view":
      if (!state.history || state.history.phase !== "loading-view")
        return state;
      return {
        ...state,
        history: {
          ...state.history,
          phase: "view",
          currentId: action.id,
          messages: action.messages,
          scroll: 0,
          error: undefined,
        },
      };
    case "history-view-error":
      if (!state.history || state.history.phase !== "loading-view")
        return state;
      return {
        ...state,
        history: { ...state.history, phase: "error", error: action.error },
      };
    case "history-scroll": {
      if (!state.history || state.history.phase !== "view") return state;
      const hsc = state.history;
      return {
        ...state,
        history: { ...hsc, scroll: Math.max(0, hsc.scroll + action.delta) },
      };
    }
    case "history-back": {
      if (!state.history || state.history.phase !== "view") return state;
      const hbk = state.history;
      return {
        ...state,
        history: {
          ...hbk,
          phase: "list",
          currentId: undefined,
          messages: [],
          scroll: 0,
        },
      };
    }
    case "history-close":
      return { ...state, history: null };
    default:
      return undefined;
  }
}
