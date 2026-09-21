// TUI/src/app/layout/panel.ts — 面板场景原语（规范见 SPEC.md §7）
//
// 面板组件 = 这些原语的组合函数（DESIGN.md §7），输出整棵
// activity 内容树替换（无 Overlay）。原语均为纯组装糖：返回 Box/Paragraph，
// 无新 kind、不改布局语义，由 measure/allocate/fill 统一摊平。
//
// 面板行语义 = 「一字符串一行」精确行长：原语基于 styled 叶子（fill wait
// wrap:false 不折行、不做 markdown 解析，避免 `[y]`/`*` 等被误解析）。
// 渲染字符沿用现状面板：选项行高亮游标 `>`、单选选中 `*`、多选 `+`
// （见 IMPLEMENTATION.md「/model 命令」ModelPicker / StatusPanel / Question）。

import type { Box, Node, Paragraph, StyledText } from "./box.ts";
import { v, text, styled } from "./box.ts";
import type { FrameSegment, FrameStyle } from "../../renderer/screen.ts";

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

/** 兼容便捷：纯文本 Paragraph（首行缩进/续行悬挂语义；非面板精确行长场景用） */
export function panelPlainParagraph(
  content: string,
  style?: FrameStyle,
): Paragraph {
  return text(content, { style });
}
