// src/app/components/HistoryPanel.ts — /history 历史会话面板渲染（纯函数）
//
// 输出恰 height 行（占满固定交互区，与输入/审批/问答/模型选择面板同一区域）。
// 五阶段：loading-list（加载中）、list（会话列表）、loading-view（内容加载）、
// view（只读消息浏览，↑/↓ 滚动窗口）、error（错误消息）。
// 列表行格式：`> MM-DD HH:mm  <8位短id>  .../cwd  [当前]`（live 会话标记 [当前]）。
// 无 ANSI 着色（与模型选择面板同风格），中文界面文本按显示宽度截断。

import type { RenderLine } from "../../renderer/index.ts";
import type { HistoryPanelState } from "../state.ts";
import type { SessionInfo } from "../adapter/dsh.ts";
import { truncateToWidth, wrapLine, displayWidth } from "../layout.ts";

export interface HistoryPanelView {
  history: HistoryPanelState;
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
  return "…" + out;
}

/**
 * 列表行：`> MM-DD HH:mm  <短id>  <标题>  .../cwd  [当前]|[不可续]`。
 * 标题优先官方 session/title 事件，缺失本地兜底；两者皆无显示（新会话）。
 * live 会话：当前活跃标 [当前]，其余 live 标 [不可续]（不可选中）。
 */
function listLine(rec: SessionInfo, isFocus: boolean, width: number): string {
  const marker = isFocus ? "> " : "  ";
  const time = fmtTime(rec.createdAt);
  const id = rec.id.slice(0, 8);
  // 当前活跃 live 行双标（[当前] 活跃 + [不可续] 不可选中）；其余 live 仅 [不可续]
  const tag = rec.live
    ? rec.current === true
      ? " [当前] [不可续]"
      : " [不可续]"
    : "";
  const fixed =
    displayWidth(marker) + displayWidth(time) + 2 + 8 + 2 + displayWidth(tag);
  const avail = Math.max(0, width - fixed);
  const titleText = rec.title?.trim() ? rec.title : "（新会话）";
  const title = truncateToWidth(titleText, avail);
  const left = Math.max(0, avail - displayWidth(title));
  const cwd = rec.cwd && left > 1 ? tailCwd(rec.cwd, left) : "";
  return truncateToWidth(
    marker + time + "  " + id + "  " + title + (cwd ? "  " + cwd : "") + tag,
    width,
  );
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

export function renderHistoryPanel(view: HistoryPanelView): RenderLine[] {
  const h = view.history;
  const height = Math.max(1, view.height);
  const width = Math.max(1, view.width);
  const bodyRows = Math.max(0, height - 1); // 首行标题 + 正文区
  const rows: RenderLine[] = [];

  let title = "";
  let body: string[] = [];
  switch (h.phase) {
    case "loading-list":
      title = "历史会话";
      body = ["加载中…"];
      break;
    case "list":
      title = truncateToWidth(
        `历史会话（${h.records.length}） [↑/↓]移动 · [Enter]切换 · [Esc]关闭`,
        width,
      );
      if (h.records.length === 0) body = ["（无历史会话）"];
      else {
        const start = startFor(h.records.length, h.index, bodyRows);
        for (let r = 0; r < bodyRows; r++) {
          const idx = start + r;
          const rec = h.records[idx];
          body.push(rec ? listLine(rec, idx === h.index, width) : "");
        }
      }
      break;
    case "loading-view":
      title = "历史会话 · " + (h.currentId ?? "").slice(0, 8);
      body = ["加载内容…"];
      break;
    case "resuming":
      title = "历史会话 · " + (h.pendingResume ?? "").slice(0, 8);
      body = ["切换到该会话…"];
      break;
    case "view": {
      title = truncateToWidth(
        `会话 ${h.currentId ?? ""}  [↑/↓]滚动 · [PgUp/PgDn]翻页 · [Esc]返回列表`,
        width,
      );
      // 无文本消息（空会话 / live 会话 store 暂未落 assistant 事件）→ 占位提示
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
      title = "加载失败 [Esc]关闭";
      body = wrapLine(h.error ?? "未知错误", width).slice(0, bodyRows);
      break;
  }

  rows.push({ text: title.padEnd(width) });
  for (let r = 0; r < bodyRows; r++) rows.push({ text: body[r] ?? "" });
  return rows;
}
