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

/** 审批面板（3.3.1 落地白名单后文案随之更新） */
export const APPROVAL_HINT_LINE = "[y]批准 · [n]拒绝 · [Esc]退出";

/** 模型选择面板（三列焦点区；空格预选、Enter 提交） */
export const PICKER_HINT_LINE =
  "[↑/↓]移动 · [空格]预选 · [←/→/Tab]切列 · [Enter]提交 · [Esc]取消";

/** 后台任务面板 */
export const JOBS_HINT_LINE =
  "[↑/↓]选择 · [PgUp/PgDn]翻页 · [Enter]取消 · [Esc]关闭";

/** 通用状态选项面板（/policy /permission /preset）：选项多于 1 个才提示移动键 */
export function statusPanelHintLine(panel: StatusPanelState): string {
  return (
    "[Enter]提交 · [空格]预选" +
    (panel.options.length > 1 ? " · [↑/↓]选项" : "") +
    " · [Esc]取消"
  );
}

/** 问答面板：只列当前实际用到的按键（多题才有切题；无预设选项则不列标记/移动） */
export function questionHintLine(panel: QuestionPanelState): string {
  const item = panel.items[panel.itemIndex];
  const total = panel.items.length;
  const hasPreset = (item?.options.length ?? 0) > 0;
  const parts: string[] = [
    "[Enter]" + (total > 1 && panel.itemIndex < total - 1 ? "下一题" : "提交"),
    "[Esc]取消",
  ];
  if (hasPreset) parts.push("[空格]标记", "[↑/↓]选项");
  if (total > 1) parts.push("[←/→]切题");
  return parts.join(" · ");
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
  if (state.approval) return APPROVAL_HINT_LINE;
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
