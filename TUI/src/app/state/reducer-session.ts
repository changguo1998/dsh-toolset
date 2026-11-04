// TUI/src/app/state/reducer-session.ts — 纯 reducer 分组：历史会话恢复、删除与切换

import { createSections } from "../layout/pipeline/sections.ts";
import { DIALOGUE_KEEP_REPLIES } from "../layout.ts";
import {
  cleanableSessionIds,
  currentProjectCwd,
  deletableSession,
  historyVisibleRecords,
  dropHistoryRecords,
} from "./types.ts";
import type { AppState } from "./types.ts";
import type { StateAction } from "./actions.ts";

export function reduceSession(
  state: AppState,
  action: StateAction,
): AppState | undefined {
  switch (action.type) {
    case "history-resume":
      return state.history
        ? {
            ...state,
            history: {
              ...state.history,
              phase: "resuming",
              pendingResume: action.id,
              error: undefined,
            },
          }
        : state;
    case "history-resume-error":
      // 会话陈旧则丢弃（面板已关闭/已切换目标）
      if (
        !state.history ||
        state.history.phase !== "resuming" ||
        state.history.pendingResume !== action.id
      ) {
        return state;
      }
      return {
        ...state,
        history: {
          ...state.history,
          phase: "error",
          error: action.error,
          pendingResume: undefined,
        },
      };
    case "history-resume-ok":
      // 会话陈旧则丢弃（面板已关闭/已切换目标）
      if (
        !state.history ||
        state.history.phase !== "resuming" ||
        state.history.pendingResume !== action.id
      ) {
        return state;
      }
      return {
        ...state,
        activeSessionId: action.id,
        sessionTitle: action.title,
        history: null,
        local: [],
        followBottom: true,
        // 会话切换：清掉上一会话的阅读位置，回到跟随底部（段键跨会话无意义）
        dialogueTop: null,
        activityTop: null,
        scrollOffset: 0,
        activityScroll: 0,
        // TUI#9：会话恢复/切换 → 本会话累计清零（与 buffer 同步换会话）
        usageTotals: { input: 0, output: 0, cacheRead: 0 },
        // TUI#12：最近一次调用属上一会话 → 丢弃（不可知，显示占位）
        usage: undefined,
      };
    case "history-restore": {
      // TUI#40：CLI 启动即恢复（--resume / -c）——把既有消息折叠成历史行。
      // 与 history-resume-ok 的区别：**不依赖 /session 面板状态机**（启动路径没有面板），
      // 但仍守「会话已切走」的陈旧守卫（activeSessionId 必须为空或同 id）
      if (
        state.activeSessionId !== null &&
        state.activeSessionId !== action.id
      ) {
        return state;
      }
      return {
        ...state,
        activeSessionId: action.id,
        sessionTitle: action.title,
        local: [],
        followBottom: true,
        dialogueTop: null,
        activityTop: null,
        scrollOffset: 0,
        activityScroll: 0,
      };
    }
    case "session-switch":
      // /new：全新会话 → 缓冲、滚动、窗口、焦点与排队登记全部归零。
      // 按会话隔离的 mode/goal/todo/model 与 TUI 本地开关由 App 随后的
      // restoreSessionState 回填（新会话无记录 → 各回默认值）。
      return {
        ...state,
        activeSessionId: action.id,
        sessionTitle: action.title,
        history: null,
        local: [],
        // 六步流水线的节缓存同源归零（否则切换后首帧仍渲染旧会话内容）
        ...(state.pipeline === undefined ? {} : { pipeline: createSections() }),
        followBottom: true,
        scrollOffset: 0,
        dialogueTop: null,
        activityTop: null,
        activityScroll: 0,
        windowGroups: DIALOGUE_KEEP_REPLIES,
        focusedPanel: null,
        queued: [],
        stepGroup: null,
        // TUI#9：/new 全新会话 → 本会话累计清零
        usageTotals: { input: 0, output: 0, cacheRead: 0 },
        // TUI#12：/new 换会话 → 最近一次调用不再适用，清空（显示占位）
        usage: undefined,
      };
    case "history-confirm-delete": {
      const hcd = state.history;
      if (!hcd || hcd.phase !== "list") return state;
      // 有标记 → 批量删除标记集（跨范围保留的标记也计入；已不可删的项自动剔除）
      const batch = (hcd.marked ?? []).filter((id) => {
        const target = hcd.records.find((r) => r.id === id);
        return target !== undefined && deletableSession(target);
      });
      if (batch.length > 0) {
        return {
          ...state,
          history: {
            ...hcd,
            phase: "confirm-delete",
            pendingDelete: undefined,
            pendingDeleteIds: batch,
            result: undefined,
          },
        };
      }
      const rec = historyVisibleRecords(state)[hcd.index];
      // 当前活跃 / live / 未持久化 → 不进入确认（调用方以 notice 说明原因）
      if (!rec || !deletableSession(rec)) {
        return state;
      }
      return {
        ...state,
        history: {
          ...hcd,
          phase: "confirm-delete",
          pendingDelete: rec.id,
          pendingDeleteIds: undefined,
          result: undefined,
        },
      };
    }
    case "history-confirm-clean": {
      const hcc = state.history;
      if (!hcc || hcc.phase !== "list") return state;
      const ids = cleanableSessionIds(state);
      if (ids.length === 0) return state;
      return {
        ...state,
        history: {
          ...hcc,
          phase: "confirm-clean",
          pendingClean: ids,
          cleanCwd: currentProjectCwd(state),
          result: undefined,
        },
      };
    }
    case "history-confirm-cancel": {
      const hcx = state.history;
      if (
        !hcx ||
        (hcx.phase !== "confirm-delete" && hcx.phase !== "confirm-clean")
      ) {
        return state;
      }
      return {
        ...state,
        history: {
          ...hcx,
          phase: "list",
          pendingDelete: undefined,
          pendingDeleteIds: undefined,
          pendingClean: undefined,
          cleanCwd: undefined,
        },
      };
    }
    case "history-delete":
      return state.history?.phase === "confirm-delete"
        ? { ...state, history: { ...state.history, phase: "deleting" } }
        : state;
    case "history-delete-done": {
      // 单条与批量共用：ids = 成功删除的集合（空集 = 全部失败 → 记录与标记原样保留，仍回列表）
      const hdd = state.history;
      if (!hdd || hdd.phase !== "deleting") return state;
      return {
        ...state,
        history: dropHistoryRecords(
          hdd,
          action.ids,
          historyVisibleRecords(state).map((r) => r.id),
        ),
      };
    }
    case "history-clean":
      return state.history?.phase === "confirm-clean"
        ? { ...state, history: { ...state.history, phase: "cleaning" } }
        : state;
    case "history-clean-done": {
      const hcd2 = state.history;
      if (!hcd2 || hcd2.phase !== "cleaning") return state;
      return {
        ...state,
        history: dropHistoryRecords(
          hcd2,
          action.ids,
          historyVisibleRecords(state).map((r) => r.id),
        ),
      };
    }
    case "session-identify":
      return {
        ...state,
        activeSessionId: action.id,
        sessionTitle: action.title,
      };
    default:
      return undefined;
  }
}
