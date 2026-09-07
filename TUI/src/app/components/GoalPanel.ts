// src/app/components/GoalPanel.ts — /goal 迷你面板渲染（纯函数）
//
// 输出恰 height 行（占满固定交互区，与输入/审批/问答/模型选择/历史面板同一区域）。
// 只读展示当前活跃会话的 goal 全量快照 + todo 列表：
//   - 标题行 `Goal <phase>`（蓝）；goal set：objective 正文，blocked 黄 tone message
//   - goal cleared/缺失：面板清空（占位提示）
//   - todo：标题 `Todo 完成数/总数`（蓝）；`·` 待办(默认) / `> ` 进行中(黄) / `✓ ` 完成(灰+删除线)
// 列表超出可视高度时 ↑/↓ 滚动窗口（scroll 由 App 维护，此处 clamp）。
// 无 ANSI 之外的着色；中文字符按显示宽度截断/换行（与 HistoryPanel 同风格）。

import type { RenderLine } from "../../renderer/index.ts";
import type { ThemeId } from "../../renderer/theme.ts";
import { colorFor } from "../../renderer/theme.ts";
import type { GoalState } from "../state.ts";
import type { TodoItemLike } from "../adapter/dsh.ts";
import { truncateToWidth, wrapLine, displayWidth } from "../layout.ts";
import { renderSeg } from "../layout/markdown.ts";

export interface GoalPanelView {
  /** 当前活跃会话的 goal 状态（goal-change reducer 归一化后） */
  goal?: GoalState;
  /** 当前活跃会话的 todo 快照（全量；缺失 = undefined） */
  todos?: TodoItemLike[];
  /** 纵向滚动偏移（行单位；渲染层按可视高度 clamp） */
  scroll: number;
  /** 面板可用行数（footer 高度） */
  height: number;
  /** 面板可用列宽 */
  width: number;
  themeId: ThemeId;
}

/** 视口起点：让偏移恒在 [0, max(0, len-rows)] 内 */
function startFor(len: number, offset: number, rows: number): number {
  if (len <= rows || rows <= 0) return 0;
  return Math.min(Math.max(0, offset), len - rows);
}

const TODO_MARKER: Record<TodoItemLike["status"], string> = {
  pending: "· ",
  in_progress: "> ",
  completed: "✓ ",
};

/** goal set 的纯文本 body 行（未按行数裁剪；供滚动窗口取窗） */
function bodyLines(
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  width: number,
  themeId: ThemeId,
): { text: string; color?: (s: string) => string }[] {
  const out: { text: string; color?: (s: string) => string }[] = [];
  if (!goal || goal.status === "cleared") {
    out.push({ text: "（当前会话无 goal）" });
    return out;
  }
  const g = goal.goal;
  // objective（可长，换行展示；goal 标题 `Goal <phase>` 已由面板首行渲染）
  for (const line of wrapLine(
    "目标: " + (g.objective || "（空目标）"),
    Math.max(1, width),
  ))
    out.push({ text: line });
  // blocked → blockedReason.message 黄 tone（DESIGN:355）
  if (g.phase === "blocked" && g.blockedReason?.message) {
    out.push({
      text: "阻塞: " + g.blockedReason.message,
      color: colorFor(themeId, "yellow"),
    });
  }
  // todo 标题（完成数/总数，蓝）+ 列表：`> ` 进行中(黄)、`· ` 待办(默认)、`✓ ` 完成(灰+删除线)
  const list = todos ?? [];
  if (list.length > 0) {
    const done = list.filter((t) => t.status === "completed").length;
    out.push({
      text: colorFor(themeId, "blue")(`Todo ${done}/${list.length}`),
    });
    for (const t of list) {
      const body = t.content === "" ? "（空项）" : t.content;
      const lines = wrapLine(TODO_MARKER[t.status] + body, Math.max(1, width));
      lines.forEach((line, i) => {
        if (t.status === "completed") {
          out.push({
            text: renderSeg(
              { text: line, style: { fg: "gray", strike: true } },
              themeId,
            ),
          });
        } else if (t.status === "in_progress") {
          out.push({
            text: i === 0 ? colorFor(themeId, "yellow")(line) : line,
          });
        } else {
          out.push({ text: line });
        }
      });
    }
  }
  return out;
}

export function renderGoalPanel(view: GoalPanelView): RenderLine[] {
  const height = Math.max(1, view.height);
  const width = Math.max(1, view.width);
  const bodyRows = Math.max(0, height - 1); // 首行标题 + 正文区
  const rows: RenderLine[] = [];
  // 标题行：`Goal <phase>`（蓝，goal 状态=phase）+ 操作提示（灰）
  const phase = view.goal?.status === "set" ? view.goal.goal.phase : undefined;
  const titleText =
    colorFor(view.themeId, "blue")("Goal" + (phase ? ` ${phase}` : "")) +
    colorFor(view.themeId, "gray")(" · [↑/↓]滚动 · [Esc]关闭");
  const title = truncateToWidth(titleText, width);
  // 按显示宽度补齐（CJK 字符宽 2，padEnd 按字符数会超宽）
  rows.push({
    text: title + " ".repeat(Math.max(0, width - displayWidth(title))),
  });
  const lines = bodyLines(view.goal, view.todos, width, view.themeId);
  const start = startFor(lines.length, view.scroll, bodyRows);
  for (let r = 0; r < bodyRows; r++) {
    const idx = start + r;
    const line = idx < lines.length ? lines[idx] : undefined;
    if (!line || line.text === "") {
      rows.push({ text: "" });
      continue;
    }
    rows.push({
      text: (line.color ?? ((s: string) => s))(
        truncateToWidth(line.text, width),
      ),
    });
  }
  return rows;
}
