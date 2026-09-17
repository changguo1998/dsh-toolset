// TUI/src/app/layout/panel.ts — 面板场景原语（规范见 SPEC.md §7）
//
// 面板组件 = 这些原语的组合函数（DESIGN.md Part II §7），输出整棵
// activity 内容树替换（无 Overlay）。原语均为纯组装糖：返回 Box/Paragraph，
// 无新 kind、不改布局语义，由 measure/allocate/fill 统一摊平。
//
// 渲染字符沿用现状面板：选项行高亮游标 `>`、单选选中 `*`、多选 `+`
// （见 IMPLEMENTATION.md「/model 命令」ModelPicker / StatusPanel / Question）。

import type { Box, Node, Paragraph } from "./box.ts";
import { v, text } from "./box.ts";
import type { FrameStyle } from "../../renderer/screen.ts";

/** 面板单选/列表选项（面板场景原语入参） */
export interface PanelOption {
  /** 显示文本（可含装饰前缀；纯文本由原语包成段） */
  label: string;
  /** 是否选中（单选 `*` / 多选 `+` 标记） */
  selected?: boolean;
  /** 是否焦点行（高亮游标 `>` + 焦点样式） */
  focused?: boolean;
  /** 焦点行样式（缺省黄） */
  focusStyle?: FrameStyle;
  /** 选中行样式（缺省绿） */
  selectedStyle?: FrameStyle;
}

/** 面板标题行：加粗主标题（如审批「等待审批」、StatusPanel 命令名） */
export function panelTitle(content: string, style?: FrameStyle): Paragraph {
  return text(content, { style: { bold: true, ...style } });
}

/** 面板问题正文：主问句/说明（自动换行；宽度由 fill 分配） */
export function panelQuestion(content: string, style?: FrameStyle): Paragraph {
  return text(content, { style });
}

/** 面板说明段：次要解释文字 */
export function panelExplanation(
  content: string,
  style?: FrameStyle,
): Paragraph {
  return text(content, { style });
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
    // 对齐现状 StatusPanel：前导空格 + 游标 + 选中标记 + 空格；
    // 焦点行/选中行整行着色（游标与标记列位恒定，行序稳定）
    const prefixText = ` ${lead}${sel} `;
    const prefix = o.focused
      ? { text: prefixText, style: o.focusStyle ?? { fg: "yellow" } }
      : o.selected
        ? { text: prefixText, style: o.selectedStyle ?? { fg: "green" } }
        : { text: prefixText };
    return text(o.label, { prefix });
  });
  return v(children);
}
