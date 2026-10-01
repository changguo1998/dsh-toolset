// src/app/layout/hints.ts — 底部按键提示区文案（按状态取一行；BACKLOG 3.1.2）
//
// 全部按键提示的唯一来源：面板内不再画提示行，提示统一由 layout.buildFrame 放在
// 输入区下方的提示区。空串仍占 1 行（历史加载等「无可用键位」阶段），保证
// 「交互区总高 = footer + hint」恒定——面板开关不让活动区上下跳。
//
// 分层：只依赖 state 与适配层类型，**不**引用 components/*（否则 layout →
// components 反向依赖成环）；components 侧需要文案时反向 import 本文件。

import type {
  AppState,
  QuestionPanelState,
  StatusPanelState,
} from "../state.ts";
import type { CommandPanelKind } from "../adapter/types.ts";

/** 普通输入态 */
export const HINT_LINE =
  "[Alt+Enter]打断并发送 · [Ctrl+L]重绘 · [Ctrl+J]输入换行 · [Ctrl+S]切换状态列 · [/help]更多命令";

/** 补全候选打开（候选面板本身不占活动区行放提示） */
export const COMPLETION_HINT_LINE = "[tab]补全 · [↑/↓]选择 · [esc]收起";

/** 历史会话面板各阶段（list=移动/批量标记/范围切换/开关；view=滚动/翻页；
 *  confirm-*=二次确认；加载类阶段为空串=占位空行） */
export const HISTORY_LIST_HINT_LINE =
  "[↑/↓]移动 · [Space]标记 · [a]全选 · [c]清空 · [d]删除 · [Tab]范围 · [Enter]切换 · [x]清理空会话 · [Esc]关闭";
export const HISTORY_VIEW_HINT_LINE =
  "[↑/↓]滚动 · [PgUp/PgDn]翻页 · [Esc]返回列表";
export const HISTORY_ERROR_HINT_LINE = "[Esc]关闭";
export const HISTORY_CONFIRM_HINT_LINE = "[y/Enter]确认 · [n/Esc]取消";
export const HISTORY_LOADING_HINT_LINE = "";

/** 历史面板阶段 → 提示区文案（未列出的阶段按加载类处理：空白占位） */
export const HISTORY_HINTS: Record<string, string> = {
  list: HISTORY_LIST_HINT_LINE,
  view: HISTORY_VIEW_HINT_LINE,
  error: HISTORY_ERROR_HINT_LINE,
  "confirm-delete": HISTORY_CONFIRM_HINT_LINE,
  "confirm-clean": HISTORY_CONFIRM_HINT_LINE,
};

/**
 * 审批面板（BACKLOG 3.2.4 / 3.2.6 / 3.3.1 / 3.3.4）：与问答面板同构——以显式前缀标出当前
 * 焦点窗（`▶草稿` / `▶选项`），`↑/↓` 语义随焦点窗切换（滚草稿 / 移动选项）、`Tab` 切窗；
 * 各项用紧凑分隔符连接（与 questionHintLine 同口径，80 列内可放下）。
 */
export function approvalHintLine(state: AppState): string {
  const onDesc = state.approvalWindow === "desc";
  const parts: string[] = [
    onDesc ? "▶草稿" : "▶选项",
    "[Enter]提交",
    "[Esc]取消",
    onDesc ? "[↑/↓]滚动" : "[↑/↓]选项",
    "[Tab]" + (onDesc ? "选项" : "草稿"),
    "[1/2]直答",
  ];
  return parts.join("·");
}

/** 模型选择面板（三列焦点区；空格预选、Enter 提交） */
export const PICKER_HINT_LINE =
  "[↑/↓]移动 · [空格]预选 · [←/→/Tab]切列 · [Enter]提交 · [Esc]取消";

/** 后台任务面板 */
export const JOBS_HINT_LINE =
  "[↑/↓]选择 · [PgUp/PgDn]翻页 · [Enter]取消 · [Esc]关闭";

/** 通用状态选项面板（/policy /permission）：选项多于 1 个才提示移动键 */
export function statusPanelHintLine(panel: StatusPanelState): string {
  return (
    "[Enter]提交 · [空格]预选" +
    (panel.options.length > 1 ? " · [↑/↓]选项" : "") +
    " · [Esc]取消"
  );
}

/** 问答面板：只列当前实际用到的按键（多题才有切题；无预设选项则不列标记/移动）；
 *  ↑/↓ 与 Tab 文案随焦点窗切换（BACKLOG 3.2.1：描述窗滚行 / 选项窗移项、Tab 切窗），
 *  并以显式前缀标出**当前焦点窗**（BACKLOG 3.2.8：此前只有 ↑/↓ 文案细差，看不出焦点） */
export function questionHintLine(panel: QuestionPanelState): string {
  const item = panel.items[panel.itemIndex];
  const total = panel.items.length;
  const hasPreset = (item?.options.length ?? 0) > 0;
  const onDesc = item?.focus === "desc";
  const parts: string[] = [
    onDesc ? "▶题干" : "▶选项", // 当前焦点窗（`▶` 与面板内题干首行标记同源）
    "[Enter]" + (total > 1 && panel.itemIndex < total - 1 ? "下一题" : "提交"),
    "[Esc]取消",
    onDesc ? "[↑/↓]滚动" : "[↑/↓]选项",
  ];
  if (hasPreset) {
    parts.push("[空格/1-9]标记", "[Tab]" + (onDesc ? "选项" : "描述"));
  }
  if (total > 1) parts.push("[←/→]切题");
  // 紧凑分隔符：七项全列时 80 列终端也要放得下（` · ` 会撑到 82 列、截掉尾部切题提示，
  // 实测；`·` 两侧无空格，每处省 2 列）
  return parts.join("·");
}

/** 共享列表面板（/agents 另有刷新键与不同的 Enter 语义） */
export function commandPanelHint(kind: CommandPanelKind): string {
  const enter = kind === "agents" ? "Enter 中断" : "Enter 详情";
  return kind === "agents"
    ? `↑/↓ 选择 · PgUp/PgDn 翻页 · ${enter} · r 刷新 · Esc 关闭`
    : `↑/↓ 选择 · PgUp/PgDn 翻页 · ${enter} · Esc 关闭`;
}

/**
 * 当前状态 → 提示行文案。优先级固定：面板态（审批 / 问答 / 状态选项 / 模型选择 /
 * 任务 / 列表族）> 历史会话 > 补全 > 普通输入；同一时刻只显示最高优先级的一条。
 * 返回空串表示「有提示区但无可用键位」（占位空行，交互区高度不变）。
 */
export function hintLine(state: AppState): string {
  // 审批态：底部提示区始终显示常规按键（无效键提示自 3.3.6 起画在面板内容区左上）
  if (state.approval) return approvalHintLine(state);
  if (state.question) return questionHintLine(state.question);
  if (state.statusPanel) return statusPanelHintLine(state.statusPanel);
  if (state.picker) return PICKER_HINT_LINE;
  if (state.jobsPanel) return JOBS_HINT_LINE;
  if (state.commandPanel) return commandPanelHint(state.commandPanel.kind);
  if (state.history) {
    return HISTORY_HINTS[state.history.phase] ?? HISTORY_LOADING_HINT_LINE;
  }
  if (state.completion) return COMPLETION_HINT_LINE;
  return HINT_LINE;
}
