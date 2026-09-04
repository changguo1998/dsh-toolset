// src/app/components/QuestionPrompt.ts — 问答面板渲染（纯函数）
//
// 以文本面板呈现 DSH 提问（与 ApprovalPrompt 同风格）：标题行 + 单题视图
// （header/question/detail/选项）+ 底部操作提示 + 第 n/m 题导航。
// plan-review intent 以“计划卡片”突出显示 detail（决策卡片，approve 选项按
// intent.approve 标签识别，渲染上与普通选项一致、由用户在选项中选取）。
// “自定义回答”是固定在选项列表末尾的兜底项（无预设选项时列表仅此一项），
// 与普通选项一样用 ↑/↓ 高亮；高亮在其上时键入字符即输入自定义文本。
// 操作提示只列出当前实际用到的按键（Enter 文案区分“下一题/提交”，多题才显示
// “切题”，有预设选项才显示“空格 选择”与“↑/↓ 选项”）。
// 输出恰好 height 行；题干/detail/选项超出时截断，但高亮在自定义项时
// 优先保证该行可见（输入文字即时回显）。

import type { RenderLine } from "../../renderer/index.ts";
import type { QuestionPanelState } from "../state.ts";

export function renderQuestionPanel(
  panel: QuestionPanelState,
  height: number,
  width: number,
): RenderLine[] {
  const avail = Math.max(4, width - 4);
  const maxBody = Math.max(0, height - 2); // 去掉标题行和操作提示行后的可装行数（高度 <3 时可为 0）
  const item = panel.items[panel.itemIndex];
  // 高亮行号（pool 内）：当前选项/自定义兜底项，供滚动窗口定位
  let hl = -1;
  const total = panel.items.length;
  const isPlan = item?.intent?.kind === "plan-review";
  const multi = item?.multiSelect ?? false;
  const hasPreset = (item?.options.length ?? 0) > 0;

  // 可截断区：题干/detail/选项（含“自定义回答”兜底项）
  const pool: string[] = [];
  if (item) {
    // 题干（header 前缀）
    pool.push(" " + (item.header ? item.header + "：" : "") + item.question);
    // detail：plan-review 以计划卡片呈现，普通题作为说明正文
    if (item.detail) {
      if (isPlan) pool.push(" ── 待审计划 ──");
      for (const seg of item.detail.split("\n")) {
        if (seg === "") continue;
        pool.push(...wrapByWidth(" " + seg, avail));
      }
      if (isPlan) pool.push(" ──────────────");
    }
    // 预设选项（记录选项区起点，供高亮行滚动窗口定位）
    const optStart = pool.length;
    for (let i = 0; i < item.options.length; i++) {
      const opt = item.options[i]!;
      const selected = item.selected.includes(opt.label);
      const cursor = item.optionIndex === i ? ">" : " ";
      const mark = selected ? (multi ? "+" : "*") : " ";
      const desc = opt.description ? " " + opt.description : "";
      pool.push(" " + cursor + mark + " " + opt.label + desc);
    }
    // 自定义回答兜底项（列表末位，含已输入文本）
    const ci = item.options.length;
    const cursor = item.optionIndex === ci ? ">" : " ";
    const mark = item.custom === "" ? " " : multi ? "+" : "*";
    pool.push(
      " " +
        cursor +
        mark +
        " 自定义回答" +
        (item.custom === "" ? "" : "：" + item.custom),
    );
    // 自定义项下标 = optStart + options.length，与 optionIndex 取值域一致
    hl = optStart + item.optionIndex;
  }

  // 高亮行（当前选项/自定义兜底项）恒在可视窗口内：可截断区超出时按
  // 高亮行整体滚动（取代旧的「自定义行强制放底部」特例）。
  // 未导航（optionIndex==0）时窗口锚定内容顶部——默认展示题干/计划卡片头
  // （如 plan-review 的长 detail），用户下移导航后才跟随高亮行滚动。
  const following = (item?.optionIndex ?? 0) > 0;
  const start =
    hl < 0 || pool.length <= maxBody
      ? 0
      : following
        ? Math.min(
            Math.max(0, hl - (maxBody - 1)),
            Math.max(0, pool.length - maxBody),
          )
        : 0;
  const body = pool.slice(start, start + maxBody);

  const out: RenderLine[] = [];
  out.push({
    text: isPlan
      ? " ⚠ 计划审批（第 " + (panel.itemIndex + 1) + "/" + total + " 题）"
      : " ⚠ 请回答（第 " + (panel.itemIndex + 1) + "/" + total + " 题）",
  });
  for (let i = 0; i < maxBody; i++) out.push({ text: body[i] ?? "" });
  // 操作提示：只显示当前实际用到的按键
  const parts: string[] = [];
  parts.push(
    "[Enter]" + (total > 1 && panel.itemIndex < total - 1 ? "下一题" : "提交"),
  );
  parts.push("[Esc]取消");
  if (hasPreset) parts.push("[空格]选择");
  if (hasPreset) parts.push("[↑/↓]选项");
  if (total > 1) parts.push("[←/→]切题");
  out.push({ text: " " + parts.join(" · ") + " " });
  return out;
}

/** 按列适配宽度做简单换行（与 layout.wrapLine 语义一致，避免循环依赖） */
function wrapByWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = chrW(ch);
    if (curW > 0 && curW + w > width) {
      rows.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  rows.push(cur);
  return rows;
}

function chrW(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x2fffd)
  ) {
    return 2;
  }
  return 1;
}
