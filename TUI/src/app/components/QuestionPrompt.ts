// src/app/components/QuestionPrompt.ts — 问答面板渲染（纯函数）
//
// 以文本面板呈现 DSH 提问（与 ApprovalPrompt 同风格）：标题行 + 单题视图
// （header/question/detail/选项）+ 底部操作提示 + 第 n/m 题导航。
// plan-review intent 以“计划卡片”突出显示 detail（决策卡片，approve 选项按
// intent.approve 标签识别，渲染上与普通选项一致、由用户在选项中选取）。
// “自定义回答”是固定在选项列表末尾的兜底项（无预设选项时列表仅此一项），
// 与普通选项一样用 ↑/↓ 高亮；高亮在其上时键入字符即输入自定义文本。
// 操作提示只列出当前实际用到的按键（Enter 文案区分“下一题/提交”，多题才显示
// “切题”，有预设选项才显示“空格 标记”与“↑/↓ 选项”）。
// 输出恰好 height 行；题干/detail/选项超出面板可用宽均按行 soft-wrap（题干/选项
// 续行按正文起点缩进、选项续行无光标/标记且缩进 6 列更深（选项文字起点第 4 列 + 2），
// 便于辨认新选项起点；见 OPTION_CONT_INDENT）、高度超出时滚动，高亮在
// 自定义项时优先保证该行可见（输入文字即时回显）。

import type { FrameRow } from "../../renderer/index.ts";
import type { FrameStyle } from "../../renderer/screen.ts";
import type { QuestionPanelState } from "../state.ts";
import type { Box } from "../layout/box.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";
import { fillBoxTree } from "../layout/fill.ts";

/**
 * 选项续行缩进（6 列 = 选项首行前缀 ` >* ` 4 列 + 2 列阶梯差）。选项行未选中
 * 且光标不在其上时前缀全为空格、与 4 列续行缩进同形，长文本折行后无法辨认
 * 新选项从哪一行开始；加深到 6 列后续行缩进于选项文字起点（第 4 列）。
 * 面板可用宽不足 6 列时退回 4 列（见 buildQuestionPanelBox 的 contIndent）。
 */
const OPTION_CONT_INDENT = "      ";

/**
 * 问答面板 Box 生成器（TUI/docs/DESIGN.md §7 / SPEC.md §7）：整棵 activity 内容树
 * 替换。文本池（题干/detail/选项/自定义兜底 + 滚动窗口）在 build 内按现状
 * 算法计算，逐行产 styled 叶子（选项行选中绿 / 未选中的光标行黄、无 markdown
 * 解析）。操作提示仅列实际用到的按键（Enter 文案区分下一题/提交等）。
 */
export function buildQuestionPanelBox(
  panel: QuestionPanelState,
  height: number,
  width: number,
): Box {
  const avail = Math.max(4, width - 4);
  // 续行缩进：常规 6 列；面板极窄（avail ≤ 6）时退回 4 列，避免缩进自身被折行
  const contIndent =
    avail > OPTION_CONT_INDENT.length ? OPTION_CONT_INDENT : "    ";
  const maxBody = Math.max(0, height - 2);
  const item = panel.items[panel.itemIndex];
  let hl = -1;
  const total = panel.items.length;
  const isPlan = item?.intent?.kind === "plan-review";
  const multi = item?.multiSelect ?? false;
  const hasPreset = (item?.options.length ?? 0) > 0;

  const pool: string[] = [];
  // 与 pool 逐行平行的着色表：选项行（含其所有折行续行）整块同色，题干/detail
  // 为 undefined（默认前景色）。按行记录归属，避免用固定列猜测标记位置。
  const poolColor: (FrameStyle | undefined)[] = [];
  const pushRows = (rows: string[], color?: FrameStyle): void => {
    for (const r of rows) {
      pool.push(r);
      poolColor.push(color);
    }
  };
  if (item) {
    pushRows(
      wrapPrefixed(
        ` ${item.header ? item.header + "：" : ""}${item.question}`,
        avail,
        " ",
      ),
    );
    if (item.detail) {
      if (isPlan) pushRows([" -- 待审计划 --"]);
      for (const part of item.detail.split("\n")) {
        if (part === "") continue;
        pushRows(wrapByWidth(` ${part}`, avail));
      }
      if (isPlan) pushRows([" --------------"]);
    }
    const optRows: number[] = [];
    for (let i = 0; i < item.options.length; i++) {
      const opt = item.options[i]!;
      if (opt === undefined) break;
      const selected = item.selected.includes(opt.label);
      const cursor = item.optionIndex === i ? ">" : " ";
      const mark = selected ? markFor(multi) : " ";
      const desc = opt.description ? ` ${opt.description}` : "";
      optRows[i] = pool.length;
      pushRows(
        wrapPrefixed(
          ` ${cursor}${mark} ${opt.label}${desc}`,
          avail,
          contIndent,
        ),
        // 已标记选中绿优先，未标记的光标行黄（对齐 ModelPicker）
        selected
          ? { fg: "green" }
          : item.optionIndex === i
            ? { fg: "yellow" }
            : undefined,
      );
    }
    const ci = item.options.length;
    const cursor = item.optionIndex === ci ? ">" : " ";
    const mark = item.custom === "" ? " " : multi ? "+" : "*";
    optRows[ci] = pool.length;
    pushRows(
      wrapPrefixed(
        ` ${cursor}${mark} 自定义回答${item.custom === "" ? "" : "：" + item.custom}`,
        avail,
        contIndent,
      ),
      item.custom !== ""
        ? { fg: "green" }
        : item.optionIndex === ci
          ? { fg: "yellow" }
          : undefined,
    );
    hl = optRows[item.optionIndex] ?? -1;
  }

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
  const bodyColors = poolColor.slice(start, start + maxBody);

  // 标题行
  const title = styled(
    [
      seg(
        isPlan
          ? ` ⚠ 计划审批（第 ${panel.itemIndex + 1}/${total} 题）`
          : ` ⚠ 请回答（第 ${panel.itemIndex + 1}/${total} 题）`,
      ),
    ],
    { wrap: false },
  );
  // body 行（着色取自 poolColor：选项行含折行续行整块同色）
  const bodyLeaves = Array.from({ length: maxBody }, (_, i) => {
    const line = body[i] ?? "";
    const color = bodyColors[i];
    return color === undefined
      ? styled([seg(line)], { wrap: false })
      : styled([seg(line, color)], { wrap: false });
  });
  // 操作提示：仅列实际用到的按键
  const parts: string[] = [];
  parts.push(
    "[Enter]" + (total > 1 && panel.itemIndex < total - 1 ? "下一题" : "提交"),
  );
  parts.push("[Esc]取消");
  if (hasPreset) parts.push("[空格]标记");
  if (hasPreset) parts.push("[↑/↓]选项");
  if (total > 1) parts.push("[←/→]切题");
  const hint = styled([seg(` ${parts.join(" · ")} `)], {
    wrap: false,
  });
  return v([title, ...bodyLeaves, hint]);
}

export function renderQuestionPanel(
  panel: QuestionPanelState,
  height: number,
  width: number,
): FrameRow[] {
  // 薄包装：单一数据源 buildQuestionPanelBox → fillBoxTree
  return fillBoxTree(
    buildQuestionPanelBox(panel, height, width),
    height,
    width,
    "dark" as never,
  );
}

/** 选项标记：多选 `+`，单选 `*`（嵌套已收敛为单一布尔） */
function markFor(multi: boolean): string {
  return multi ? "+" : "*";
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

/**
 * 首行保留原前缀（按全宽折行），其余文本按「可用宽 − 缩进」折行且**每行**都补
 * 上 indent——悬挂缩进语义（选项/题干等带前缀行通用）。不可先把续行文本整体
 * 按全宽折再补缩进：那样每段溢出的余行会丢掉缩进。
 */
function wrapPrefixed(text: string, width: number, indent: string): string[] {
  const rows = wrapByWidth(text, width);
  if (rows.length <= 1) return rows;
  const head = rows[0]!;
  const contWidth = Math.max(1, width - indent.length);
  return [
    head,
    ...wrapByWidth(text.slice(head.length), contWidth).map((r) => indent + r),
  ];
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
