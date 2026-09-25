// src/app/components/HistoryPanel.ts — /history 历史会话面板渲染（纯函数）
//
// 输出恰 height 行（占满活动区可视行，与审批/问答/模型选择/任务面板同一渲染链，
// 显示于流输出窗口；底部输入区以空白占位）。
// 十阶段：loading-list（加载中）、list（会话列表）、loading-view（内容加载）、
// view（只读消息浏览，↑/↓ 滚动窗口）、resuming（切换中）、confirm-delete
// （删除二次确认，单条或批量）、deleting（删除中）、confirm-clean（清理空会话二次确认）、
// cleaning（清理中）、error（错误消息）。
// 列表行格式：`[>| ]* MM-DD HH:mm  <8位短id>  <标题>  .../cwd  [当前]|[不可续]|[空]`
// （第 2 列 * = 批量删除标记，Space 切换；可删项标红不涉及，见 index.ts 键位）。
// 按键提示不放面板内（位于输入区下方提示区，见 layout.ts HISTORY_*_HINT_LINE）；
// 标题按显示宽补齐，避免 CJK 顶开活动区右缘框线。
// 无 ANSI 着色（与模型选择面板同风格），中文界面文本按显示宽度截断。

import type { FrameRow } from "../../renderer/index.ts";
import type { HistoryPanelState } from "../state.ts";
import type { SessionInfo } from "../adapter/dsh.ts";
import { truncateToWidth, wrapLine, displayWidth } from "../layout.ts";
import type { Box } from "../layout/box.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";
import { fillBoxTree } from "../layout/fill.ts";

export interface HistoryPanelView {
  history: HistoryPanelState;
  /** 当前范围（project/all）下的可见会话（由 layout 注入 historyVisibleRecords） */
  records: SessionInfo[];
  /** 全量会话数：当前目录范围用于「可见/全量」计数与空态提示 */
  totalCount: number;
  /** 当前目录路径（undefined=无法识别：空态文案据此区分） */
  projectCwd: string | undefined;
  /** 面板可用行数（footer 高度） */
  height: number;
  /** 面板可用列宽 */
  width: number;
}

/** 时间戳（Unix 毫秒）→ `MM-DD HH:mm`（本地时区） */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** cwd 尾段截取：按显示宽度从尾部保留 w 列，超长前缀补 … */
function tailCwd(cwd: string, w: number): string {
  if (w <= 1) return "";
  if (displayWidth(cwd) <= w) return cwd;
  let out = "";
  let used = 0;
  for (let i = cwd.length - 1; i >= 0 && used + 1 < w; i--) {
    const c = cwd[i]!;
    used += c === "\t" ? 1 : displayWidth(c);
    out = c + out;
  }
  return `...${out}`;
}

/**
 * 列表行：`[>| ]* MM-DD HH:mm  <短id>  <标题>  .../cwd  [当前]|[不可续]|[空]`。
 * 第 1 列为焦点（>）、第 2 列为批量标记（*），无则空格（列宽恒 2，行宽稳定）。
 * 标题优先官方 session/title 事件，缺失本地兜底；两者皆无显示（新会话）。
 * live 会话：当前活跃标 [当前]，其余 live 标 [不可续]（不可选中/标记）；
 * 空会话（persisted 且无用户消息）标 [空]（可被 /session clean 清理）。
 * 批量可删项（persisted 非 live 非当前）可被 Space 标记，d 批量删除。
 */
function listLine(
  rec: SessionInfo,
  isFocus: boolean,
  marked: boolean,
  width: number,
): string {
  const marker = `${isFocus ? ">" : " "}${marked ? "*" : " "}`;
  const time = fmtTime(rec.createdAt);
  const id = rec.id.slice(0, 8);
  // 当前活跃 live 行双标（[当前] 活跃 + [不可续] 不可选中）；其余 live 仅 [不可续]；空会话 [空]
  let tag = "";
  if (rec.live) tag = rec.current === true ? " [当前] [不可续]" : " [不可续]";
  else if (rec.isEmpty === true) tag = " [空]";
  const fixed =
    displayWidth(marker) + displayWidth(time) + 2 + 8 + 2 + displayWidth(tag);
  const avail = Math.max(0, width - fixed);
  const titleText = rec.title?.trim() ? rec.title : "（新会话）";
  const title = truncateToWidth(titleText, avail);
  const left = Math.max(0, avail - displayWidth(title));
  const cwd = rec.cwd && left > 1 ? tailCwd(rec.cwd, left) : "";
  return truncateToWidth(
    `${marker}${time}  ${id}  ${title}${cwd ? `  ${cwd}` : ""}${tag}`,
    width,
  );
}

/** 确认/进行中文案 → 逐行按宽度折行截断，取前 max 行（面板正文区填充用） */
function wrapBody(lines: string[], width: number, max: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const l of wrapLine(line, width)) out.push(truncateToWidth(l, width));
  }
  return out.slice(0, Math.max(0, max));
}

/** 当前目录范围的空态文案：区分「目录识别失败」与「该目录暂无会话」，均提示可切到全部 */
function emptyScopeText(view: HistoryPanelView, allScope: boolean): string {
  if (allScope) return "（无历史会话）";
  const tail = `[Tab] 查看全部 ${view.totalCount} 条`;
  return view.projectCwd === undefined
    ? `（无法识别当前目录；${tail}）`
    : `（当前目录暂无会话；${tail}）`;
}

/** 视口起点：让偏移恒在 [0, max(0, len-rows)] 内 */
function startFor(len: number, offset: number, rows: number): number {
  if (len <= rows || rows <= 0) return 0;
  return Math.min(Math.max(0, offset), len - rows);
}

/** 消息列表 → 显示行（问/答 前缀 + 换行缩进；消息间空行分隔；空文本占位） */
function messageLines(
  messages: { role: string; text: string }[],
  width: number,
): string[] {
  const out: string[] = [];
  for (const m of messages) {
    const label = m.role === "user" ? "问: " : "答: ";
    const text = m.text === "" ? "（无文本内容）" : m.text;
    const wrapped = wrapLine(text, Math.max(1, width - displayWidth(label)));
    wrapped.forEach((line, i) => {
      out.push(truncateToWidth((i === 0 ? label : "    ") + line, width));
    });
    out.push(""); // 消息间空行
  }
  // 去掉末尾空行（末行由调用方补空行填满）
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * 历史会话面板 Box 生成器（TUI/docs/design/DESIGN.md §7 / SPEC.md §7）：复用 renderHistoryPanel
 * 的标题/正文算法（多 phase switch + 列表滚动 + 消息视图），产 styled 叶子
 * （wrap:false 精确行长；title 行 pad 保留、body 行原样）。
 */
export function buildHistoryPanelBox(view: HistoryPanelView): Box {
  const h = view.history;
  const height = Math.max(1, view.height);
  const width = Math.max(1, view.width);
  const bodyRows = Math.max(0, height - 1);

  let title = "";
  let body: string[] = [];
  switch (h.phase) {
    case "loading-list":
      title = "历史会话";
      body = ["加载中..."];
      break;
    case "list": {
      const allScope = h.scope === "all";
      const scopeLabel = allScope ? "全部" : "当前目录";
      const count = allScope
        ? `${view.records.length}`
        : `${view.records.length}/${view.totalCount}`;
      const markedCount = h.marked?.length ?? 0;
      const markLabel = markedCount > 0 ? ` · 标记 ${markedCount}` : "";
      title = truncateToWidth(
        `历史会话 [${scopeLabel}]（${count}）${markLabel}`,
        width,
      );
      const head =
        h.result === undefined ? null : truncateToWidth(h.result, width);
      const listRows = Math.max(0, bodyRows - (head === null ? 0 : 1));
      if (view.records.length === 0) {
        body = [
          view.totalCount === 0
            ? "（无历史会话）"
            : emptyScopeText(view, allScope),
        ];
      } else {
        const start = startFor(view.records.length, h.index, listRows);
        for (let r = 0; r < listRows; r++) {
          const idx = start + r;
          const rec = view.records[idx];
          body.push(
            rec
              ? listLine(
                  rec,
                  idx === h.index,
                  h.marked?.includes(rec.id) === true,
                  width,
                )
              : "",
          );
        }
      }
      if (head !== null) body = [head, ...body];
      break;
    }
    case "loading-view":
      title = `历史会话 · ${(h.currentId ?? "").slice(0, 8)}`;
      body = ["加载内容..."];
      break;
    case "resuming":
      title = `历史会话 · ${(h.pendingResume ?? "").slice(0, 8)}`;
      body = ["切换到该会话..."];
      break;
    case "confirm-delete": {
      // 批量（标记 ≥1 条；标记驱动即为批量）：标题含数量、正文逐条预览（超出行数截断 + 省略计数）
      const batch = h.pendingDeleteIds;
      if (batch && batch.length > 0) {
        const label = (id: string): string => {
          const r = h.records.find((x) => x.id === id);
          const t = r?.title?.trim();
          return t ? t : "（新会话）";
        };
        const previewRows = Math.max(0, bodyRows - 4);
        const preview = batch.slice(0, previewRows);
        const lines = [
          `删除标记的 ${batch.length} 个会话？`,
          ...preview.map((id) => `- ${label(id)}（${id.slice(0, 8)}）`),
        ];
        if (preview.length < batch.length) {
          lines.push(`…（其余 ${batch.length - preview.length} 个）`);
        }
        lines.push("不可恢复：这些会话的持久化文件将被永久删除。");
        lines.push("[y/Enter] 确认删除    [n/Esc] 取消");
        title = "历史会话 · 批量删除确认";
        body = wrapBody(lines, width, bodyRows);
        break;
      }
      const singleId = h.pendingDelete ?? batch?.[0];
      const rec = h.records.find((r) => r.id === singleId);
      const label = rec?.title?.trim() ? rec.title : "（新会话）";
      title = "历史会话 · 删除确认";
      body = wrapBody(
        [
          `删除会话「${label}」（${(singleId ?? "").slice(0, 8)}）？`,
          "不可恢复：该会话的持久化文件将被永久删除。",
          "[y/Enter] 确认删除    [n/Esc] 取消",
        ],
        width,
        bodyRows,
      );
      break;
    }
    case "deleting":
      title = "历史会话 · 删除中";
      body = ["删除中..."];
      break;
    case "confirm-clean": {
      const n = h.pendingClean?.length ?? 0;
      title = "历史会话 · 清理空会话";
      body = wrapBody(
        [
          h.scope === "all"
            ? `清理全部目录的空会话 ${n} 个？`
            : `清理当前目录（${h.cleanCwd ?? "未知路径"}）的空会话 ${n} 个？`,
          "不可恢复：仅删除已持久化且从未有用户消息的会话；当前与 live 会话不受影响。",
          "[y/Enter] 确认清理    [n/Esc] 取消",
        ],
        width,
        bodyRows,
      );
      break;
    }
    case "cleaning":
      title = "历史会话 · 清理中";
      body = ["清理中..."];
      break;
    case "view": {
      title = truncateToWidth(`会话 ${h.currentId ?? ""}`, width);
      const lines =
        h.messages.length === 0
          ? [
              "（该会话暂无文本消息：会话为空，或 live 会话的模型回复尚未持久化）",
            ]
          : messageLines(h.messages, width);
      const start = startFor(lines.length, h.scroll, bodyRows);
      for (let r = 0; r < bodyRows; r++) {
        const idx = start + r;
        body.push(idx < lines.length ? lines[idx]! : "");
      }
      break;
    }
    case "error":
      title = "加载失败";
      body = wrapLine(h.error ?? "未知错误", width).slice(0, bodyRows);
      break;
  }

  const titleRow = styled(
    [seg(title + " ".repeat(Math.max(0, width - displayWidth(title))))],
    { wrap: false },
  );
  const bodyLeaves = Array.from({ length: bodyRows }, (_, r) =>
    styled([seg(body[r] ?? "")], { wrap: false }),
  );
  return v([titleRow, ...bodyLeaves]);
}

export function renderHistoryPanel(view: HistoryPanelView): FrameRow[] {
  // 薄包装：单一数据源 buildHistoryPanelBox → fillBoxTree
  return fillBoxTree(
    buildHistoryPanelBox(view),
    view.height,
    view.width,
    "dark" as never,
  );
}
