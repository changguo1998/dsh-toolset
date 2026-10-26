// TUI/src/app/layout/pipeline/ir.ts — 七段渲染流水线的新 IR（阶段 0 基建类型）
//
// 这是重构后的共享类型层：Section / Block（5 种闭集）/ PaneItem / Node / Leaf /
// Row / FrameRow / NodeBase / PaneId。与旧 `pipeline/types.ts`（节缓存类型：旧
// Section / Item / ToolCall / ToolResult / Delivery / BlockDelivery）**互不占用
// 名字**：旧文件保留给 split（§1）之前的节缓存用，新类型全在本文件。
//
// 类型口径对应追踪文档 T1–T12：
//   - Section = 一次模型交互（思考 + 正文 + 工具声明），纯文本槽位未解析；
//   - Block 树不可变（解析产物），冻结见 freezeBlock；Node / Leaf 可变
//     （§5 measure 原地写宽高），不在冻结范围内；
//   - Node / Leaf 不设 kind 判别字段，靠 direction/children（Node）与 text（Leaf）
//     结构区分，判别助手见 isNode / isLeaf。

import type { FrameSegment, FrameStyle } from "../../../renderer/screen.ts";
import type { ColorName } from "../../../renderer/theme.ts";
import type { NoticeTone } from "../../adapter/types.ts";
import type { ToolCall, ToolResult } from "./types.ts";
import type { ToolUnit } from "./tool-units.ts";

// ================= §1 分节：一次模型交互 =================

/** 一次模型交互（思考 + 正文 + 工具声明）；纯文本槽位未解析（§2 才做 markdown）。
 *  层级：session > turn > step > section（section = 最小事件单元）。 */
export interface Section {
  /** 稳定身份："turn:step:交互序号" */
  id: string;
  turn: number;
  step: number;
  /** 交互开始时间（epoch ms；缺省不显示） */
  time?: number;
  /** 覆盖的宿主事件号（去重 / 遮蔽判定） */
  seqs: readonly number[];
  /** 思考，markdown 纯文本（未解析） */
  reasoning?: string;
  /** 正文 / 本地行，markdown 纯文本（未解析）。
   *  source 含旧节条目来源全集（含 notice / shell / 工具辅助行——它们不是 markdown 槽位，
   *  但经 §2 parse 统一产 Paragraph 块；tone / noCompact 为 notice 与辅助行透传）。 */
  body?: {
    source: BlockSource;
    text: string;
    tone?: NoticeTone;
    /** 紧凑模式豁免（/help） */
    noCompact?: boolean;
    /** 折行续行停靠列（/help 双列表格：续行缩进到描述列） */
    hanging?: number;
  };
  /** 工具调用声明（结构化，非 markdown） */
  calls?: readonly ToolCall[];
  /** 工具结果（与 calls 经 callId / 到达顺序配对；route 组 ToolBatch 显示用） */
  results?: readonly ToolResult[];
  /** 终态：挂起 / 正常 / 失败 / 中断 */
  status?: "running" | "success" | "failure" | "aborted";
  /**
   * 终态标记（旧节 `final` 透传）：turn-end 给回合最后一次交互打标 →
   * §3 route 据此把正文与工具批归会话区（非终态交互的正文进回合区，现状同口径）
   */
  final?: boolean;
  /** 历史节（恢复重放产出）→ 正文与工具批都归会话区（旧 `history` 透传） */
  history?: boolean;
  /** 独立自足节（用户输入 / notice / shell 各自成节）→ §3 不产 step 头 */
  standalone?: boolean;
  /** steer 插队送达的用户输入 → §3 在其前留一个 Gap */
  steer?: boolean;
  /** 用户输入块的运行时态（P1 首行符号解析素材；无 = 无状态） */
  user?: UserRowInfo;
}

/** 用户块首行状态符号所需素材（旧 `userBlockSymbolResolver` 输入的子集） */
export interface UserRowInfo {
  /** 排队中（未发出的 followup / steer 用户消息） */
  queued?: "followup" | "steer";
  /** steer 认领转入历史的续接块 */
  steerContinued?: boolean;
  /** 终态（成功 / 失败 / 中断） */
  status?: "success" | "failure" | "aborted";
  /** 当前正在运行中的用户块 */
  active?: boolean;
}

// ================= §2 解析：行内段与块 =================

/** 行内格式化段（格式控制字符已消费成类；需要更多行内样式时在此补充） */
export interface StyledStr {
  text: string;
  color?: ColorName;
  bold?: boolean;
  italic?: boolean;
  /** 行内代码 */
  code?: boolean;
  /** 链接（目标 URL；显示为蓝色下划线） */
  link?: string;
  /** 删除线（~~…~~ / 勾选任务正文） */
  strike?: boolean;
  /** 下划线（__…__） */
  underline?: boolean;
}

/** 行内内容一律此类型（数组：一段多格式） */
export type StyledText = StyledStr[];

/** 块级来源标记（§3 route 分发用；含本地行来源——notice / shell / 工具辅助行也产块） */
export type BlockSource =
  "reasoning" | "system" | "user" | "assistant" | "notice" | "shell" | "tool";

/** 块级来源标记（§3 route 分发用） */
export interface BlockBase {
  source: BlockSource;
  /** 所属 section id（用户输入一次成节 → 同节块合进同一个用户盒的外壳） */
  section?: string;
  /** 覆盖的宿主事件号（§2 由 section.seqs 透传；接线桥取行身份 posix 锚点用） */
  seqs?: readonly number[];
}

/** 段落块：行内内容（§2 解析产物；原文经 span 回引，不复制原文） */
export interface Paragraph extends BlockBase {
  kind: "paragraph";
  id: string;
  /** 回引源槽位（Section.reasoning / Section.body.text）的原文区间，含控制字符 */
  span: [number, number];
  text: StyledText;
  /** 分隔线（`---` 等）：flatten 据此铺满横向线（不占文本） */
  rule?: boolean;
  /** 用户块的运行时态（§2 由 Section.user 透传；P1 符号与排队竖线颜色用） */
  user?: UserRowInfo;
  /** 折行续行停靠列（notice 双列表格：续行缩进到描述列） */
  hanging?: number;
}

/** 引用块：子块嵌套（多为 Paragraph） */
export interface Quote extends BlockBase {
  kind: "quote";
  id: string;
  span: [number, number];
  children: Block[];
}

/** 列表块：不记 depth（嵌套靠 items 递归）。标记与条目正文分离：
 *  `marker`（所有条目同一个标记）与 `order`（逐条目标记）**二选一**。 */
export interface List extends BlockBase {
  kind: "list";
  id: string;
  span: [number, number];
  /** 条目共用的显示标记（普通无序列表，如 `• `）；与 order 互斥 */
  marker?: string;
  /** 逐条目显示标记（有序编号 `1. ` / `10. `、任务复选框 `[x] ` / `[ ] `）；与 marker 互斥 */
  order?: string[];
  items: Block[];
}

/** 代码块：rows 为原文行，不参与行内格式化 */
export interface Code extends BlockBase {
  kind: "code";
  id: string;
  span: [number, number];
  lang?: string;
  rows: string[];
  /** 围栏是否闭合（未闭合按代码块渲染到段尾） */
  closed: boolean;
}

export type TableAlign = "left" | "center" | "right";

/** 表格块：格 = Paragraph（header 格 / 数据格都是）；列宽在 §5 测量期算 */
export interface Table extends BlockBase {
  kind: "table";
  id: string;
  span: [number, number];
  header: Paragraph[];
  aligns: TableAlign[];
  rows: Paragraph[][];
}

/** 块级闭集（5 种，不新增工具块；不可变，见 freezeBlock） */
export type Block = Paragraph | Quote | List | Code | Table;

/** 块级闭集运行时守卫（T13：Block 新增成员时这里编译报错，保证闭集不破） */
const _blockKindGuard: Record<Block["kind"], true> = {
  paragraph: true,
  quote: true,
  list: true,
  code: true,
  table: true,
};

/**
 * 深度冻结一棵块树（Block 不可变；parse 阶段对每棵块树调用一次）。
 * Node / Leaf 可变（§5 measure 原地写宽高），不在冻结范围内。
 */
export function freezeBlock<T extends Block>(block: T): T {
  if (Object.isFrozen(block)) return block;
  switch (block.kind) {
    case "paragraph":
    case "code":
      return Object.freeze(block) as T;
    case "quote": {
      const copy: Quote = {
        ...block,
        children: block.children.map(freezeBlock),
      };
      return Object.freeze(copy) as T;
    }
    case "list": {
      const copy: List = { ...block, items: block.items.map(freezeBlock) };
      return Object.freeze(copy) as T;
    }
    case "table": {
      const copy: Table = {
        ...block,
        header: block.header.map(freezeBlock),
        rows: block.rows.map((row) => row.map(freezeBlock)),
      };
      return Object.freeze(copy) as T;
    }
  }
}

// ================= §3 分流 =================

/** 每个模型交互（Section）一组：来源元数据 + 该交互解析摊开的 markdown 块 */
export interface EventGroup {
  provenance: Section;
  /** = parse(provenance) 摊开的文本块（思考 + 正文），各块带 source */
  blocks: Block[];
  /** 工具声明（结构化；数据留 Section，显示由 route 组合成批） */
  calls?: readonly ToolCall[];
  /** 工具结果（route 组 ToolBatch 显示用） */
  results?: readonly ToolResult[];
}

// ---- 占位类型（字段沿用旧 pane / box 语义，均带稳定段键 key） ----

/** step 头（route 生成；对应旧 step-head） */
export interface StepHeader {
  kind: "step-header";
  key: string;
  turn: number;
  step: number;
  time?: number;
}

/** 回合分隔（route 生成；对应旧 turn-separator） */
export interface TurnHeader {
  kind: "turn-header";
  key: string;
  turn: number;
  time?: number;
  /** 无标题分隔线（时间未知的纯虚线） */
  untitled?: boolean;
}

/** 空行间隔（route 生成；空行唯一来源） */
export interface Gap {
  kind: "gap";
  key: string;
}

/** 工具调用批（route 由 calls 组合；展示形态组合在后续阶段做，这里只放数据） */
export interface ToolBatch {
  kind: "tool-batch";
  key: string;
  calls: readonly ToolCall[];
  results: readonly { callId?: string; ok: boolean; detail: string }[];
}

/** pane 项：块（成品）或 route 生成的结构项 */
export type PaneItem = Block | StepHeader | TurnHeader | Gap | ToolBatch;

// ================= §4 结构：PaneId / NodeBase / Node / Leaf =================

/** 可寻址 pane（chrome 五 pane 由独立刷新路产出，非 route 产物） */
export type PaneId =
  | "session"
  | "turn"
  | "tool"
  | "statusBar"
  | "statusCol"
  | "titleBar"
  | "input";

/** 宽度类型（与旧 box.ts 同口径） */
export type WidthStyle = "auto" | "fill" | "fixed" | "ratio";

/** 高度类型：auto = 内容折行决定 */

/** 节点公共属性（Node 与 Leaf 共享；自旧 box.ts 字段全集迁入，含 width 族 / height 族） */
export interface NodeBase {
  /** 宽度类型（缺省 auto）；widthLocked 为 true 时不改写 width */
  widthStyle?: WidthStyle;
  /** 宽度下限（auto / fill） */
  widthMin?: number;
  /** 宽度上限（auto / fill） */
  widthMax?: number;
  /** 固定列数（fixed） */
  widthFixed?: number;
  /** 容器分数（ratio） */
  widthRatio?: number;
  /** 实际宽度：measure 写自然宽，allocate 写最终宽；widthLocked 时冻结 */
  width?: number;
  /** true = width 不再被测量 / 分配改写 */
  widthLocked?: boolean;
  /** 高度类型（缺省 auto = 内容折行决定） */
  /** 固定行数（fixed） */
  /** 实际高度：measure / allocate 写入；heightLocked 时冻结 */
  height?: number;
  /** true = height 不再被测量 / 分配改写 */
  heightLocked?: boolean;
  /** 行级对齐（缺省 left）；仅宽度为 fixed/fill 时有效 */
  align?: "left" | "right" | "center";
  /** 默认样式（行内解析可覆盖） */
  style?: FrameStyle;
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
  /** 折行续行停靠列：续行缩进到该列（notice / /help 双列表格） */
  hanging?: number;
  /** 压缩剪枝遮蔽：整块打灰（内容与行数不变；摊平时全部段颜色改 gray） */
  dim?: true;
  /** 行类型标记：透传到 `Row.rowKind`（帧层按它改写工具名相位字形等） */
  rowKind?: string;
  /** 表格网格标记：本容器的各 h 子行按列对齐宽度（列宽在后续步骤算） */
  grid?: true;
  /** 补白字符（带样式）：设置后本节点每行补到自身宽（缺省不补）。空格即普通留白，
   *  `╌` / `─` 等可当分隔线填充；样式随补白段一起下发 */
  fillWith?: StyledStr;
  /** 底色铺满分配宽度（代码块用；行内代码只在文字上着色） */
  fillBg?: boolean;
  /** 默认 true；false = 单行截断不换行 */
  wrap?: boolean;
  /** 平衡折行：保持行数不变，收窄列宽让各行尽量等宽（用户块用） */
  balance?: boolean;
}

/** 兄弟项之间的分隔线（结构性，随子项增删；首尾不画） */
export interface Separator {
  /** 缺省：纵向 `╌` / 横向 `│` */
  char?: string;
  /** 缺省 border（灰）；`"plain"` = 默认前景（不染色，如状态栏圆点分隔） */
  color?: ColorName | "plain";
}

/** 组合节点：可嵌套子 Node / Leaf；不设 kind 判别字段（靠 direction / children）。
 *  特殊内容（代码 / 表格）由 structure 以载荷字段挂在此（measure / flatten 分别消费：
 *  代码按行号+软折行渲染、表格 measure 定列宽后 flatten 排网格 —— 宽相关的细节不进结构层）。 */
export interface Node extends NodeBase {
  direction: "v" | "h";
  children: (Node | Leaf)[];
  separator?: Separator;
  /** 分区身份（可寻址 pane 才挂） */
  id?: PaneId;
  /** 代码节点载荷（structure 由 Code 块产出） */
  code?: { lang: string; rows: readonly string[]; closed: boolean };
  /** 表格节点载荷（structure 由 Table 块产出；measure 按 fitCols 定列宽） */
  table?: {
    aligns: readonly TableAlign[];
    header: readonly Paragraph[];
    rows: readonly Paragraph[][];
  };
  /** box 左缘符号（如用户状态 `?`；仅首行显示，续行补等宽空白）；不传给子级 */
  prefix?: { text: string; style?: FrameStyle; minWidth?: number };
  /** box 右缘后缀（如用户块右侧 `┃`）；flatten 展平子内容后给每行补满到宽 + 挂此符 */
  suffix?: { text: string; style?: FrameStyle; minWidth?: number };
}

/** 叶子节点：不设 kind 判别字段（靠 text）；measure 原地写宽高 */
export interface Leaf extends NodeBase {
  text: StyledText;
}

/** 布局树：根为 Node 或 Leaf */
export type LayoutTree = Node | Leaf;

/** 节点判别（Node / Leaf 无 kind 字段，按结构区分） */
export function isNode(tree: LayoutTree): tree is Node {
  return "direction" in tree;
}

/** 叶子判别（Node / Leaf 无 kind 字段，按结构区分） */
export function isLeaf(tree: LayoutTree): tree is Leaf {
  return "text" in tree;
}

// ================= §6 摊平：Row / Rect；§7 组装：FrameRow =================

/** 摊平行（§6 flatten 输出；pane 归属由 Record<PaneId, Row[]> 承载，行内不重复带） */
export interface Row {
  segments: FrameSegment[];
  /**
   * 行语义标记（接线桥读取，映射 ContentRow.kind）：如工具名 / 参数 / 结果行。
   * 由需要让上层按行归属的摊平分支设置（工具名 / 参数 / 结果行）。
   */
  rowKind?: string;
}

/** 测量 / 摊平阶段的矩形（自旧 box.ts 迁入，供 measure / flatten 用） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** FrameRow 复用 renderer/screen.ts 既有定义（不在本文件重复行内容格式） */
export type FrameRow = import("../../../renderer/screen.ts").FrameRow;
