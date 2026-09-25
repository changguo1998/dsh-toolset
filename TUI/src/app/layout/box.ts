// TUI/src/app/layout/box.ts — Box 排版模型纯类型（规范见 SPEC.md §2）
//
// 接口冻结：类型面在后续 measure/allocate/fill/buildBox 各阶段共享，
// 不含任何行为（纯类型 + 便捷构造器）。字段语义严格对齐 SPEC §2。

import type { FrameSegment, FrameStyle } from "../../renderer/screen.ts";
import type { ColorName } from "../../renderer/theme.ts";

/** 节点公共属性（Box 与 Paragraph 共享；除 children/direction/text 外） */
export interface NodeBase {
  /** 尺寸意图：覆盖父分配（缺省由父容器分配） */
  width?: Width;
  /** 高度意图：分区固定行高 / Spacer 用；普通段落缺省由内容折行决定 */
  height?: Height;
  /** 行级对齐（缺省 left）；仅 width 为 fixed/fill 时有效 */
  align?: "left" | "right" | "center";
  /** 垂直对齐：fill 补白位置（缺省 top）；矮格补行高时上/中/下摆放 */
  valign?: "top" | "center" | "bottom";
  /** 默认样式（行内解析可覆盖） */
  style?: FrameStyle;
  /** 首行左缩进列数（整段基准） */
  indent?: number;
  /** 续行缩进列数；缺省 = indent（工具行的悬挂缩进） */
  hanging?: number;
  /** 段前缀（占列，正文缩进自前缀后起算） */
  prefix?: {
    /** 如思考 ┃ / 引用 │ / 列表 • / 任务 [x] */
    text: string;
    style?: FrameStyle;
    /** 装饰可见度：视口宽低于此列数时不挂（窄列降级，如竖线） */
    minWidth?: number;
  };
  /** 段尾固定后缀（占列，正文补白后挂；每行重复，如用户块右缘竖线） */
  suffix?: {
    text: string;
    style?: FrameStyle;
    /** 装饰可见度：视口宽低于此列数时不挂（窄列降级，如竖线） */
    minWidth?: number;
  };
  /** 行尾铺满字符（不占测量宽；fill 补到分配宽，如 step 虚线 / turn 分隔） */
  tail?: {
    char: string;
    /** 缺省无样式（默认前景；对齐旧 turn 分隔线） */
    style?: FrameStyle;
  };
  /** 底色铺满分配宽度（代码块用；行内代码只在文字上着色） */
  fillBg?: boolean;
  /** 默认 true；false = 单行截断不换行 */
  wrap?: boolean;
}

/** 兄弟项之间的分隔线（结构性，随子项增删；首尾不画）：
 *  纵向 Box = 行间横线（缺省 `╌`，如 turn 分隔/状态列块间虚线）；
 *  横向 Box = 列间竖线框线（缺省 `│`，如状态栏组间分隔，与上/下横线相接成格） */
export interface Separator {
  /** 缺省：纵向 `╌` / 横向 `│` */
  char?: string;
  /** 缺省 border（灰）；`"plain"` = 默认前景（不染色，如状态栏圆点分隔） */
  color?: ColorName | "plain";
}

/** 可寻址分区 id（与 state.focusedPanel 收口一处）；仅可寻址区域挂 */
export type PaneId = "history" | "activity" | "status";

/** spacer 轴：width（h 占列）与 height（v 占行）互斥，且至少一个 */
export type SpacerAxis =
  { width: Width; height?: never } | { height: Height; width?: never };

/** 宽度意图（对齐现状：状态列 1/3、历史区保底 10 列） */
export type Width =
  | { mode: "auto"; min?: number; max?: number } // 按内容宽度（用户块的"收缩块"用）
  | { mode: "fill"; min?: number; max?: number } // 占满剩余
  | { mode: "fixed"; cols: number }
  | { mode: "ratio"; value: number; min?: number; max?: number }; // 按剩余比例（状态列 1/3）

/** 高度意图 */
export type Height =
  | { mode: "fixed"; rows: number } // 交互区/输入区固定行数
  | { mode: "fill" };

/** 1. Box = 组合节点（屏幕分区与内容容器）：可嵌套子 Box，也可嵌套 Paragraph */
export interface Box extends NodeBase {
  kind: "box";
  /** 子项排布：上下（v）/ 左右（h） */
  direction: "v" | "h";
  /** 子节点（Box 或 Paragraph） */
  children: Node[];
  /** v 排布兄弟间分隔线（结构性，随子项增删；首尾不画） */
  separator?: Separator;
  /** 分区身份（Pane = 带 id 的 Box）：仅可寻址区域挂 */
  id?: PaneId;
  // 无 border：边框归 FocusFrame（TUI/docs/DESIGN.md §8）
}

/** 2. Paragraph = 叶子节点（内容最小单位）：不能嵌套子 Box */
export interface Paragraph extends NodeBase {
  kind: "text";
  /** 纯文本；行内 markdown 在摊平阶段解析 */
  text: string;
  // 无 children、无 direction、无 separator
}

/** 预样式叶子：携带未折行的样式段（tool 行/思考/notice 等 plain 直渲染）。
 * fill 阶段折行（wrapFrameSegments），不做 markdown 解析；样式在构建时定。 */
export interface StyledText extends NodeBase {
  kind: "styled";
  /** 未折行样式段（text 纯文本；跨行段每行重声明由折行器负责） */
  segments: FrameSegment[];
  // 无 text（段在 segments）；无 children/direction/separator
}

/** 节点联合：Box（组合）、Paragraph（叶子）、StyledText（预样式叶子） */
export type Node = Box | Paragraph | StyledText;

/** 分配后的矩形（allocate 输出；fill/FocusFrame 消费） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 纵向 Box 便捷构造：v(children, opts?) */
export function v(
  children: Node[],
  opts: Omit<Box, "kind" | "direction" | "children"> = {},
): Box {
  return { kind: "box", direction: "v", children, ...opts };
}

/** 横向 Box 便捷构造：h(children, opts?)  */
export function h(
  children: Node[],
  opts: Omit<Box, "kind" | "direction" | "children" | "id"> = {},
): Box {
  return { kind: "box", direction: "h", children, ...opts };
}

/** Paragraph 便捷构造：text(content, opts?) */
export function text(
  content: string,
  opts: Omit<Paragraph, "kind" | "text"> = {},
): Paragraph {
  return { kind: "text", text: content, ...opts };
}

/**
 * spacer 便捷构造：只声明尺寸意图，不产出内容。轴须显式给出：
 * `spacer({ width })` 在 h 容器中占列；`spacer({ height })` 在 v 容器中占行。
 * auto/ratio 对空内容无意义，不接受（YAGNI，SPEC §2）。
 * 占位字段由调用方按所在容器取向选写（二者至少写一个）。
 */
export function spacer(opts: SpacerAxis): Paragraph {
  if (opts.width !== undefined)
    return { kind: "text", text: "", width: opts.width };
  return { kind: "text", text: "", height: opts.height };
}

/** 预样式叶子便捷构造：styled(segments, opts?) */
export function styled(
  segments: FrameSegment[],
  opts: Omit<StyledText, "kind" | "segments"> = {},
): StyledText {
  return { kind: "styled", segments, ...opts };
}
