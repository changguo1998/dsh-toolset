// src/app/layout/hints.ts — 底部按键提示区文案（按状态取一行；BACKLOG 3.1.2）
//
// 全部按键提示的唯一来源：面板内不再画提示行，提示统一由 layout.buildFrame 放在
// 输入区下方的提示区。空串仍占 1 行（历史加载等「无可用键位」阶段）；**提示区允许
// 2 行折行**（2026-10-14 用户裁定：超宽按「 · 」边界折行，不再截断），占用行数由
// layout.hintRowsFor 按当前文案与终端宽度算出，故「交互区总高」恒定仍成立
// （footerHeight = interaction − hintRows）——面板开关不让活动区上下跳。
//
// 统一格式（2026-10-14 口径，BACKLOG「按键提示信息与实际绑定对齐」）：
//  - 每条提示行一律 `[键]短标签`，条目之间用 ` · `（两侧各一个空格）分隔；
//  - 修饰键用缩写记号：`Ctrl` → `C-`、`Alt` → `A-`、`Shift` → `S-`（例 `C-s`、`A-Enter`）；
//  - 键名拼写统一：`Tab` / `Esc` / `Space` / `Enter` / `↑` / `↓` / `PgUp` / `PgDn`（大小写一致）；
//  - 提示行不放装饰符号（`▶` 只在面板内容里标焦点窗，不进提示行）；
//  - 例外（2026-10-15 用户要求）：普通输入态两态提示行最前加**输入模式提示符图例**
//    `MODE_HINTS`（`[> / ! $ <]`，只列符号不写文字，` · ` 与后续条目分隔）。
//  - 收录口径（2026-10-16 用户裁定，BACKLOG「按键提示信息与实际绑定对齐」）：提示行只放**冷门 /
//    易忘键**（`C-d` / `C-l` / `C-n/p` / `/help` 一类），常用键（`↑/↓` / `Enter` / `Esc` / `←/→`）
//    不因「有绑定」而补齐——完整键表见 `/help` 的「按键：」段（`App.helpLines()`）；面板态不受此
//    口径约束，仍按「只列当前实际用到的键」列出该面板键位。
//
// 分层：只依赖 state 与适配层类型，**不**引用 components/*（否则 layout →
// components 反向依赖成环）；components 侧需要文案时反向 import 本文件。

import type {
  AppState,
  QuestionPanelState,
  StatusPanelState,
} from "../state.ts";
import type { CommandPanelKind } from "../adapter/types.ts";

/**
 * 输入模式提示符图例（2026-10-15 用户要求）：只列模式符号、**不写文字**，常驻普通输入态
 * 提示行最前（`>` steer / `!` interrupt（打断并发送）/ `$` shell / `/` slash / `<` followup）。
 * 仅普通输入态两态（空输入 / 有输入）显示；面板态提示行不加（面板提示本身已较宽）。
 */
export const MODE_HINTS = "[> / ! $ <]";

/**
 * 普通输入态（空输入）：按状态只列当前可用键（2026-10-14 用户裁定）。
 * 区域键 `C-e` / `C-t` / `C-s` 按同一裁定**不在提示行露出**（用户明确要求）。
 * 宽度 59 列（含模式图例 14 列；80 列终端单行放下）。
 */
export const HINT_LINE =
  MODE_HINTS + " · [C-d]退出 · [C-l]重绘 · [C-n/p]历史 · [/help]";

/** 普通输入态（输入非空）：有内容时编辑键优先（含模式图例，宽度 45 列） */
export const HINT_LINE_WITH_INPUT =
  MODE_HINTS + " · [C-c]清空 · [C-j]换行 · [/help]";

/** 补全候选打开（候选面板本身不占活动区行放提示） */
export const COMPLETION_HINT_LINE = "[Tab]补全 · [↑/↓]选择 · [Esc]收起";

/** 文件提及候选打开（`@` 补全；Tab 插入提及——目录续开下一级） */
export const FILE_MENTION_HINT_LINE = "[Tab]插入 · [↑/↓]选择 · [Esc]收起";

/** 历史会话面板各阶段（list=移动/批量标记/范围切换/开关；view=滚动/翻页；
 *  confirm-*=二次确认；加载类阶段为空串=占位空行）。
 *  list 阶段 86 列 ⟹ 80 列终端折成 2 行（row1 移动..范围 / row2 切换..关闭）。 */
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
 * 审批面板（BACKLOG 3.2.4 / 3.2.6 / 3.3.1 / 3.3.4）：`↑/↓` 语义随焦点窗切换
 * （滚草稿 / 移动选项）、`Tab` 切窗。提示行只列键位与标签；**当前焦点窗的显式前缀
 * （`▶草稿` / `▶选项`）自 2026-10-14 起只在面板内容里标**（提示行去装饰符号，统一格式）。
 */
export function approvalHintLine(state: AppState): string {
  const onDesc = state.approvalWindow === "desc";
  const parts: string[] = [
    "[Enter]提交",
    "[Esc]取消",
    onDesc ? "[↑/↓]滚动" : "[↑/↓]选项",
    "[←/→]选项",
    "[Tab]" + (onDesc ? "选项" : "草稿"),
    "[y/n/1/2]直答",
  ];
  return parts.join(" · ");
}

/** 模型选择面板（三列焦点区；输入筛选、空格预选、Enter 提交；Esc 两段：先清词再关） */
export const PICKER_HINT_LINE =
  "[输入]筛选 · [↑/↓]移动 · [Space]预选 · [Tab/←/→]切列 · [Enter]提交 · [Esc]清空/取消";

/** 后台任务面板 */
export const JOBS_HINT_LINE =
  "[↑/↓]选择 · [PgUp/PgDn]翻页 · [Enter]取消 · [Esc]关闭";

/** 通用状态选项面板（/policy /permission）：选项多于 1 个才提示移动键 */
export function statusPanelHintLine(panel: StatusPanelState): string {
  const parts: string[] = ["[Enter]提交", "[Space]预选"];
  if (panel.options.length > 1) parts.push("[↑/↓]选项");
  parts.push("[Esc]取消");
  return parts.join(" · ");
}

/** 问答面板：只列当前实际用到的按键（多题才有切题；无预设选项则不列标记/移动）；
 *  `↑/↓` 与 `Tab` 文案随焦点窗切换（BACKLOG 3.2.1：描述窗滚行 / 选项窗移项、Tab 切窗），
 *  当前焦点窗自 2026-10-14 起只在面板内容里用 `▶` 标出（提示行去装饰符号，统一格式）。 */
export function questionHintLine(panel: QuestionPanelState): string {
  const item = panel.items[panel.itemIndex];
  const total = panel.items.length;
  const hasPreset = (item?.options.length ?? 0) > 0;
  const onDesc = item?.focus === "desc";
  const parts: string[] = [
    "[Enter]" + (total > 1 && panel.itemIndex < total - 1 ? "下一题" : "提交"),
    "[Esc]取消",
    onDesc ? "[↑/↓]滚动" : "[↑/↓]选项",
  ];
  if (hasPreset) {
    parts.push(
      "[Space]标记",
      "[1-9]标记",
      "[Tab]" + (onDesc ? "选项" : "描述"),
    );
  }
  if (total > 1) parts.push("[←/→]切题");
  // 七项全列时 84 列 ⟹ 80 列终端折成 2 行（提示区允许折行后不再需要紧凑分隔符）
  return parts.join(" · ");
}

/** 共享列表面板（/agents 另有刷新键与不同的 Enter 语义；/workflows 只读、Enter 无操作故不列） */
export function commandPanelHint(kind: CommandPanelKind): string {
  const parts = ["[↑/↓]选择", "[PgUp/PgDn]翻页"];
  if (kind === "agents") parts.push("[Enter]中断");
  else if (kind !== "workflows") parts.push("[Enter]详情");
  if (kind === "agents") parts.push("[r]刷新");
  parts.push("[Esc]关闭");
  return parts.join(" · ");
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
  if (state.completion?.kind === "file") return FILE_MENTION_HINT_LINE;
  if (state.completion) return COMPLETION_HINT_LINE;
  return state.inputText === "" ? HINT_LINE : HINT_LINE_WITH_INPUT;
}
