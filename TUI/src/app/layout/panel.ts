// TUI/src/app/layout/panel.ts — 面板场景原语（规范见 SPEC.md §7）
//
// 面板组件 = 这些原语的组合函数（TUI/docs/DESIGN.md §7），输出整棵
// activity 内容树替换（无 Overlay）。原语均为纯组装糖：返回 Box/Paragraph，
// 无新 kind、不改布局语义，由 measure/allocate/fill 统一摊平。
//
// 面板行语义 = 「一字符串一行」精确行长：原语基于 styled 叶子（fill wait
// wrap:false 不折行、不做 markdown 解析，避免 `[y]`/`*` 等被误解析）。
// **例外**（BACKLOG TUI#6）：描述窗的题干 / detail / 审批草稿走 `panelMarkdownRows`
// ——按历史区同口径渲染 markdown 子集（样式段行）；选项行与按键提示仍不解析。
// 渲染字符：选项行高亮游标 `>`、选中标记 `✓`（见 TUI/docs/DESIGN.md「/model 命令」
// ModelPicker / StatusPanel / Question）。

import type { Box, Node, Paragraph, StyledText } from "./box.ts";
import { v, text, styled } from "./box.ts";
import type { FrameSegment, FrameStyle } from "../../renderer/screen.ts";
import type { ThemeId } from "../../renderer/theme.ts";
import {
  FENCE_RE,
  wrapAssistantLine,
  wrapCodeLine,
  wrapFrameSegments,
} from "./markdown.ts";

/** 面板单选/列表选项（面板场景原语入参） */
export interface PanelOption {
  /** 显示文本 */
  label: string;
  /** 是否选中（单选 `*` / 多选 `+` 标记） */
  selected?: boolean;
  /** 是否焦点行（高亮游标 `>` + 焦点样式） */
  focused?: boolean;
  /** 焦点行样式（缺省黄；该行同时被选中时由选中样式绿覆盖） */
  focusStyle?: FrameStyle;
  /** 选中行样式（缺省绿，优先于焦点样式） */
  selectedStyle?: FrameStyle;
}

/** 面板标题行选项 */
export interface PanelTextOptions {
  style?: FrameStyle;
  /** 标题加粗（缺省 true；现状面板标题多不加粗时传 false） */
  bold?: boolean;
  /** 是否折行（面板行缺省不折行精确行长） */
  wrap?: boolean;
}

/** 面板标题行：加粗主标题（默认不折行）；段直接带样式 */
export function panelTitle(
  content: string,
  opts: PanelTextOptions = {},
): StyledText {
  const segStyle: FrameStyle =
    opts.bold === false
      ? { ...(opts.style ?? {}) }
      : { bold: true, ...(opts.style ?? {}) };
  return styled([mks(content, segStyle)], { wrap: opts.wrap ?? false });
}

/** 构造带样式段（无样式时省略 style 键，deepEqual 友好） */
function mks(text: string, style: FrameStyle): FrameSegment {
  return Object.keys(style).length === 0 ? { text } : { text, style };
}

/** 面板问题正文/说明：默认不加粗、不折行精确行长 */
export function panelQuestion(
  content: string,
  opts: PanelTextOptions = {},
): StyledText {
  const segStyle: FrameStyle = { ...(opts.style ?? {}) };
  return styled([mks(content, segStyle)], { wrap: opts.wrap ?? false });
}

/** 面板说明段：次要解释文字 */
export function panelExplanation(
  content: string,
  opts: PanelTextOptions = {},
): StyledText {
  const segStyle: FrameStyle = { ...(opts.style ?? {}) };
  return styled([mks(content, segStyle)], { wrap: opts.wrap ?? false });
}

/** 面板选项列表：每项一行（标记 + 文本 + 样式）；返回纵向 Box 子树 */
export function panelOptions(
  options: PanelOption[],
  opts: {
    /** 多选模式：选中标记 `+`（缺省单选 `*`） */
    multiSelect?: boolean;
    /** 焦点标记（缺省 `>`；多选面板常无焦点游标时传 "" 关闭） */
    cursor?: string;
  } = {},
): Box {
  const cursor = opts.cursor ?? ">";
  const mark = opts.multiSelect ? "+" : "*";
  const children: Node[] = options.map((o) => {
    const lead = o.focused ? cursor : " ";
    const sel = o.selected ? mark : " ";
    // 对齐现状面板：前导空格 + 游标 + 选中标记 + 空格；焦点行/选中行
    // 整行着色（标记列位恒定、label 同色——对齐 StatusPanel 整行黄/绿），
    // 两者同一行时选中绿优先（选中即绿，与 ModelPicker 一致）
    const prefixText = ` ${lead}${sel} `;
    const rowStyle = o.selected
      ? (o.selectedStyle ?? { fg: "green" as const })
      : o.focused
        ? (o.focusStyle ?? { fg: "yellow" as const })
        : undefined;
    return styled(
      [
        rowStyle === undefined
          ? { text: prefixText }
          : { text: prefixText, style: rowStyle },
        rowStyle === undefined
          ? { text: o.label }
          : { text: o.label, style: rowStyle },
      ],
      { wrap: false },
    );
  });
  return v(children);
}

/** 滚动窗口语义（BACKLOG 3.2.1 统一窗口机制） */
export type WindowMode =
  /** 焦点尽量居中（长列表跟随焦点，原 StatusPanel 语义） */
  | "center"
  /** 锚点行贴窗口末行（原 QuestionPrompt 选项窗口语义：起点不超过锚点） */
  | "tail";

/**
 * 通用滚动窗口起点（纯函数）：让 anchor 行落在窗口内，并 clamp 到
 * [0, count - windowRows]。`count <= windowRows` 时不滚动（返回 0）。
 * 三处面板局部实现（问答选项窗口 / 状态选项面板 / 审批描述窗口）统一用它，
 * 避免「起点算法各写一套」导致长内容下窗口行为不一致（BACKLOG 3.2.1）。
 */
export function windowStart(
  count: number,
  windowRows: number,
  anchor: number,
  mode: WindowMode = "center",
): number {
  if (windowRows <= 0 || count <= windowRows) return 0;
  const max = count - windowRows;
  const raw =
    mode === "tail"
      ? anchor - (windowRows - 1)
      : anchor - Math.floor(windowRows / 2);
  return Math.max(0, Math.min(raw, max));
}

/** 面板 markdown 行输入：一行文本 → 折行后的样式段行（PARAGRAPH 单位） */
export type PanelMarkdownRows = FrameSegment[][];

/**
 * 面板 markdown 行（BACKLOG TUI#6）：把多行文本按**历史区同口径**渲染为样式段行数组，
 * 供面板描述窗（问答题干 / detail、审批草稿）复用 markdown 子集。
 *
 * 分类（逐行，与历史区的行级路径一致）：
 *   - fence（``` / ~~~）标记行与其内部行 → `wrapCodeLine`（灰底、内部不解析）；
 *     fence 状态由本函数自持（面板不经过 build-box 的 fence 注解）；
 *   - 含 `|` 的行 → 普通文本折行（**表格退回纯文本**：BACKLOG TUI#6 裁定——表格列宽是
 *     构建期算死的跨行约束，而面板先折行再按窗口切片，会丢表头与行间横线）；
 *   - 其余 → `wrapAssistantLine`（行内样式 / 标题 / 列表 / 引用 / `---` 分隔线）。
 *
 * 口径：空行不产行（沿用面板现状）；`width` = 内容可用宽（**不含**行首 bar 列，调用方
 * 负责补 bar 列）；返回行数即描述窗行数（滚动上界同源）。
 */
export function panelMarkdownRows(
  text: string,
  width: number,
  themeId: ThemeId,
): PanelMarkdownRows {
  const rows: PanelMarkdownRows = [];
  const w = Math.max(1, width);
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const isFence = FENCE_RE.test(line);
    if (isFence) inFence = !inFence;
    if (isFence || inFence) {
      rows.push(...wrapCodeLine(line, w));
    } else if (line.includes("|")) {
      rows.push(...wrapFrameSegments([{ text: line }], w));
    } else {
      rows.push(...wrapAssistantLine(line, w, themeId));
    }
  }
  return rows;
}
