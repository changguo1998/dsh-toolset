// src/app/layout.ts — 视口切分 + 帧组装（纯函数，可单测）
//
// 语义（DESIGN scrollback 行为）：
//  - 长行按列宽软换行（wrapping）
//  - 视口 = 换行后行数组上裁剪出的可见窗口
//  - followBottom=true 跟随底部；用户上滚后 followBottom=false，
//    scrollOffset 表示距底部多少行，up/down/PageUp/PageDown 移动它
//  - buffer 超 2000 行裁剪由 state.ts 负责（MAX_BUFFER_LINES）
//
// markdown 子集渲染（行内/块级）与宽度原语见 ./layout/markdown.ts；本文件保留
// 换行/视口/帧组装，并重导 charWidth/displayWidth/parseInlineMarkdown/wrapInlineMarkdown。

import type { RenderLine } from "../renderer/index.ts";
import type { Size } from "../renderer/index.ts";
import type {
  AppState,
  InputMode,
  InputStatus,
  GoalState,
  ModeState,
} from "./state.ts";

import type { Buffer, BufferKind, BufferLine } from "./state.ts";
import type { JobInfo, NoticeTone, TodoItemLike } from "./adapter/dsh.ts";
import { renderTextInput } from "./components/TextInput.ts";
import { renderModelPicker } from "./components/ModelPicker.ts";
import { renderHistoryPanel } from "./components/HistoryPanel.ts";
import { renderQuestionPanel } from "./components/QuestionPrompt.ts";
import { renderJobsPanel, statusMark } from "./components/JobsPanel.ts";
import { renderStatusPanel } from "./components/StatusPanel.ts";
import type { ColorName, ThemeId } from "../renderer/theme.ts";
import { colorFor } from "../renderer/theme.ts";
import { renderApprovalPrompt } from "./components/ApprovalPrompt.ts";
import {
  charWidth,
  displayWidth,
  FENCE_RE,
  renderSeg,
  wrapAssistantLine,
  wrapCodeLine,
} from "./layout/markdown.ts";
export {
  charWidth,
  displayWidth,
  parseInlineMarkdown,
  wrapInlineMarkdown,
} from "./layout/markdown.ts";

// ---------- 换行（wrapping）纯函数 ----------

/**
 * 按显示宽度截断：超出 cols 的尾部丢弃（不切半个 CJK 字符）。
 * ANSI 转义不计宽并原样透传（不切断转义序列，避免破坏着色）。
 */
export function truncateToWidth(text: string, cols: number): string {
  if (cols <= 0) return "";
  let w = 0;
  let out = "";
  for (const m of text.matchAll(/\x1b\[[0-9;]*m|[\s\S]/gu)) {
    const t = m[0]!;
    if (t.startsWith("\x1b")) {
      out += t;
      continue;
    }
    const cw = charWidth(t);
    if (w + cw > cols) continue; // 丢弃超宽字符，后续转义仍透传(样式不泄漏)
    out += t;
    w += cw;
  }
  return out;
}

/**
 * 按列宽软换行：返回不超过 width 列的各行（width<=0 视为无穷）。
 * 行首字符比宽度还宽时强制放下（不丢字符）；空行不产出多余的空白行。
 */
export function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return text === "" ? [""] : [text];
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = charWidth(ch);
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

/** buffer 各原始行 → 全部 wrapped 行（保留空行语义） */
export function wrapLines(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line === "") {
      out.push("");
      continue;
    }
    out.push(...wrapLine(line, width));
  }
  return out;
}

// ---------- 视口纯函数 ----------

export interface ViewportInput {
  totalRows: number;
  height: number; // 视口区域行数
  followBottom: boolean;
  scrollOffset: number; // 距底部行数
}

export interface Viewport {
  start: number; // wrapped 行数组内可见起始下标
  end: number; // 结束下标（不含）
  followBottom: boolean;
  scrollOffset: number;
}

/** 由 followBottom + scrollOffset 计算可见窗口；offset 超界自动收敛 */
export function computeViewport(vp: ViewportInput): Viewport {
  if (vp.totalRows <= vp.height) {
    return { start: 0, end: vp.totalRows, followBottom: true, scrollOffset: 0 };
  }
  if (vp.followBottom) {
    return {
      start: vp.totalRows - vp.height,
      end: vp.totalRows,
      followBottom: true,
      scrollOffset: 0,
    };
  }
  const offset = Math.min(vp.scrollOffset, vp.totalRows - vp.height);
  const start = vp.totalRows - vp.height - offset;
  const end = start + vp.height;
  const followBottom = offset <= 0;
  return { start: Math.max(0, start), end, followBottom, scrollOffset: offset };
}

// ---------- 帧组装 ----------

/** 水平分隔线字符（顶边 / 状态区下方横线等窗口间分隔；box-drawing 可与竖线连成连续线） */
export const SEPARATOR = "─";

/** 对话 turn 之间的分隔线字形：用点更少的虚线（double dash），与窗口间实线区分（2026-09-07） */
export const TURN_SEPARATOR_CHAR = "╌";

/** 状态区上方分隔线字符（与其余横线一致的单线 `─`；box-drawing 可与竖线连成连续线） */
export const STATUS_TOP_SEPARATOR = "─";

/** 上/中/下三区之间的横线分隔行数 */
export const SEPARATOR_ROWS = 2;

/** 按键提示区内容（独立区域，位于输入区下方、之间不画横线；窄终端按显示宽度截断；审批/问答/选择面板自带按键提示，不显示该区） */
export const HINT_LINE =
  "[Alt+Enter]打断并发送 · [Ctrl+L]重绘 · [Ctrl+J]输入换行 · [/help]更多命令";

export interface FrameMetrics {
  /** 顶部区域行数 = rows - 状态区 - 输入区 - 按键提示区 - 分隔行（剩余高度全给上方两个） */
  topHeight: number;
  /** 系统状态区行数（可 >1：状态内容溢出到多行时按实际行数） */
  statusHeight: number;
  /** 输入区行数（审批弹窗时更高） */
  footerHeight: number;
  /** 按键提示区行数（独立区域，位于输入区下方、之间不画横线；输入态 1，面板打开 0） */
  hintHeight: number;
  /** 顶部状态列宽（详细 goal/todo；窄列约 25%，含左缘分隔竖线，状态列位于右侧列） */
  statusColWidth: number;
  /** 历史区宽 = cols - statusColWidth */
  historyWidth: number;
}

export function metricsFor(
  size: Size,
  /** 是否有交互面板打开（审批/问答/模型选择） */
  hasPanel = false,
  /** 状态区行数（默认 1；可多行溢出时按实际行数压缩顶部区域） */
  statusHeight = 1,
  /** 按键提示区行数（独立区域，与输入区共同构成交互区；输入态 1） */
  hintRows = 0,
  /** 布局配置（tui.config.json；缺省某字段 → 原默认公式） */
  layout?: { footerHeight?: number; statusDivisor?: number },
): FrameMetrics {
  // 「交互区」（输入框 3 行 + 按键提示区 1 行）固定为 4 行；
  // 不足时至少 2 行（输入 1 + 提示 1）。面板态（审批/问答/选择）整体占据
  // 交互区（面板自带最底行按键提示、无独立提示区），与输入态同高——
  // 面板开关不改变交互区高度，避免顶部区域上下跳动
  // 输入框固定 3 行(+按键提示 1 行 → 交互区 4 行)；矮终端按 1/5 比例收缩保底每区 ≥1 行
  // 交互区：tui.config.json footerHeight 绝对行数优先；缺省自动 1/5 上限 4
  const interaction =
    layout?.footerHeight ?? Math.min(4, Math.max(2, Math.floor(size.rows / 5)));
  const footerHeight = hasPanel ? interaction : interaction - 1;
  // 状态列：窄列约 1/3（含右侧竖线，2026-09-07 由 25% 改 1/3），但历史区保底 10 列
  const statusColWidth = Math.min(
    Math.max(1, Math.floor(size.cols / (layout?.statusDivisor ?? 3))),
    Math.max(1, size.cols - 10),
  );
  const historyWidth = Math.max(1, size.cols - statusColWidth);
  const topHeight = Math.max(
    0,
    size.rows - statusHeight - footerHeight - hintRows - SEPARATOR_ROWS,
  );
  return {
    topHeight,
    statusHeight,
    footerHeight,
    hintHeight: hintRows,
    statusColWidth,
    historyWidth,
  };
}

/** 对话区仅保留最近 DIALOGUE_KEEP_REPLIES 条回复，更早以灰占位折叠 */
export const DIALOGUE_KEEP_REPLIES = 3;
export const DIALOGUE_MORE = "...(更早回复已折叠)";
/** 活动区行数 = 右上区（对话历史+活动区）高度的一半（固定比例，不随内容变化） */
/** @deprecated 由 activityHeight(contentTopH, divisor) 的 divisor=2 取代（配置 tui.config.json layout.activityHeightDivisor） */
export const ACTIVITY_HEIGHT_RATIO = 1 / 2;
/** 活动区分隔线字形（对话历史 ↔ 流输出边界：box-drawing 虚线，保留点感；不参与 barRowCount 统计） */
export const ACTIVITY_SEPARATOR = "─"; // 对话历史 ↔ 流输出（活动区）边界：实线（2026-09-07 窗口间统一实线）

/** 状态列内 goal/todo/jobs 块间分隔：点更少的虚线（double dash，窗口内部板块分隔保留虚线） */
export const STATUS_BLOCK_SEPARATOR = "╌";

/** 权限/沙箱等级缩写（状态列 Mode 块与旧状态栏徽标共用） */
const MODE_SHORT: Record<string, string> = {
  "read-only": "ro",
  "workspace-write": "wr",
  "danger-full-access": "full",
};

/** 权限等级配色（红色=高危险 / 黄=可写 / 绿=只读安全）：ro 绿、wr 黄、full 红 */
function permColor(themeId: ThemeId, code: string): (s: string) => string {
  if (code === "ro") return colorFor(themeId, "green");
  if (code === "wr") return colorFor(themeId, "yellow");
  if (code === "full") return colorFor(themeId, "red");
  return colorFor(themeId, "gray");
}
/** 焦点面板四边框的保留格：左侧 1 列、右侧 1 列（所有状态恒定，未聚焦留空白占位，防内容重排）。
 *  2026-09-27：不再保留顶部边框行（标题栏即顶部，焦点顶边用标题栏下划线/状态列顶行兼作）。 */
export const FRAME_LEFT_COLS = 1;
export const FRAME_RIGHT_COLS = 1;

/** 左列顶部标题栏行数：标题行 + 实线下划线（2026-09-27 由右侧状态列迁入，
 *  置于会话历史区上方；极矮终端由 topPaneHeights 自适应收缩到 1/0 行） */
export const TITLE_BAR_ROWS = 2;

/** 焦点框（L4 强调级，不引入彩色）：dark=bright[7] 白、light=ansi[0] 黑 */
export function focusFrameColor(themeId: ThemeId): ColorName {
  return themeId === "dark" ? "brightWhite" : "black";
}

/**
 * 活动区可视行数（= 顶部区域「内容行数」= topHeight-边框行的一半；
 * 在 buildTopRegion/inputPanelHeights 中经 topPaneHeights 先扣标题栏行数后应用）
 */
export function activityHeight(contentTopH: number, divisor?: number): number {
  // 活动区高 = contentTopH / divisor（tui.config.json；默认 2 ≈ 原 1/2 比例）
  return contentTopH <= 0
    ? 0
    : Math.max(1, Math.floor(contentTopH / (divisor ?? 2)));
}

/** 顶部左列面板行数划分（标题栏 + 对话区 + 活动区；buildTopRegion/inputPanelHeights 同口径） */
export interface TopPaneHeights {
  /** 标题栏行数（标题行 + 实线下划线；极矮终端自适应收缩到 1/0 行） */
  titleRows: number;
  /** 活动区可视行数 */
  activityH: number;
  /** 对话区可视行数 */
  dialogueH: number;
}

/**
 * 顶部左列行数划分：标题栏优先 TITLE_BAR_ROWS=2 行（标题行 + 实线下划线）；
 * 若对话区将不足 1 行（矮终端）则降级为 1 行（仅标题行），仍不足则省略标题栏
 * （0 行）——保证对话区/活动区至少可展开不溢出。
 * 活动区 = 顶部内容行数的一半（沿用原公式、不因标题栏收缩），对话区取剩余
 * （标题栏行数由对话区承担，与 2026-09-27 标题栏自状态列迁入左侧前的状态列
 * 各行占比语义一致：活动区高度不随标题栏位置变化）。
 */
export function topPaneHeights(
  contentTopH: number,
  divisor?: number,
): TopPaneHeights {
  const activityH = activityHeight(contentTopH, divisor);
  let titleRows = 0;
  for (const t of [TITLE_BAR_ROWS, 1, 0]) {
    const dialogueH = Math.max(
      0,
      contentTopH - t - activityH - (activityH > 0 ? 1 : 0),
    );
    if (t === 0 || dialogueH >= 1) {
      titleRows = t;
      break;
    }
  }
  const dialogueH = Math.max(
    0,
    contentTopH - titleRows - activityH - (activityH > 0 ? 1 : 0),
  );
  return { titleRows, activityH, dialogueH };
}

/** 普通输入态顶部三面板可视行高（P4 整页滚动用，与 buildFrame 同口径） */
export interface PanelHeights {
  /** 状态列内容高（= topHeight - 顶部边框行；PgUp/PgDn 状态列整页用） */
  topHeight: number;
  activityH: number;
  dialogueH: number;
}

/** 对话区按回复组折叠：仅保留最近 keep 组 assistant 回复，更早替换为灰色占位 */
function foldDialogue(
  rows: WrappedRow[],
  themeId: ThemeId,
  keep: number,
): WrappedRow[] {
  // 回复组 = 连续 assistant 行（同一回复的流式/多行）
  const starts: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (
      rows[i]!.kind === "assistant" &&
      (i === 0 || rows[i - 1]!.kind !== "assistant")
    )
      starts.push(i);
  }
  if (starts.length <= keep) return rows;
  // 剪切点：第 keep 新回复组起点，前移包含其前置用户消息/分隔线/空行，
  // 使可见区从“最后 keep 组对话”的用户消息开始，读起来完整。
  let cut = starts[starts.length - keep]!;
  while (cut > 0 && isConversationKind(rows[cut - 1]!.kind)) cut--;
  const marker: WrappedRow = {
    text: colorFor(themeId, NOTICE_TONE_COLOR.log)(DIALOGUE_MORE),
    kind: "plain",
    indent: 0,
  };
  return [marker, ...rows.slice(cut)];
}

/** 对话区前置段类型（剪切点外推）：用户/分隔线/空行属于回复的陪衬 */
function isConversationKind(kind: BufferKind): boolean {
  return kind === "user" || kind === "separator" || kind === "plain";
}

/** 顶部状态列：goal 目标条目行数上限 */
export const STATUS_GOAL_MAX_LINES = 5;

/** goal 阶段 → 标题 phase 状态色：active/complete 绿、paused 黄、blocked 红 */
const GOAL_PHASE_COLOR: Record<string, "green" | "yellow" | "red"> = {
  active: "green",
  paused: "yellow",
  blocked: "red",
  complete: "green",
};
/** 顶部状态列：每条 todo 行数上限 */
export const STATUS_TODO_MAX_LINES = 3;
/** 顶部状态列无内容占位 */
export const STATUS_COL_EMPTY = "（无目标/待办）";

const TODO_MARKER: Record<TodoItemLike["status"], string> = {
  pending: "○ ", // 待办：空心圆
  in_progress: "● ", // 进行中：实心圆（黄）
  completed: "✓ ",
};

/** 折叠：wrap 后超过 max 行则截到 max 行，末行追加折叠提示（统计被折叠行数） */
function capWrap(
  text: string,
  width: number,
  max: number,
): { text: string; color?: (s: string) => string }[] {
  const rows = wrapLine(text, Math.max(1, width));
  const out = rows.map((text) => ({ text }));
  if (out.length <= max) return out;
  const hidden = out.length - max;
  const kept = out.slice(0, max - 1);
  // 末行改为折叠提示（保留被折叠行数）；不再在原内容上追加（避免被截掉）
  kept.push({ text: truncateToWidth(`…(+${hidden}行)`, Math.max(1, width)) });
  return kept;
}

/** 状态列 Mode 块：列出会话运行模式/权限/审批策略的所有可选项，生效项着色强调、其余灰。
 *  plan=青（on/off）；sandbox、permission=ro 绿 / wr 黄 / full 红；policy=ask 绿 / auto 红；
 *  preset=洋红（动态值无可枚举，仅显示当前值）。无会话数据时整块省略。 */
/** 带色文本片段流按显示宽度折行（片段=最小断行单位；放不下才折行、不强制换行）。
 *  同行相邻片段之间插入分隔 sep（如竖线），片段 A 与 B 之间发生折行时不加分隔
 *  （行尾不残留竖线）。片段内嵌 ANSI，宽度按剥离转义后的可见文本计。 */
function wrapSegs(
  segs: readonly string[],
  width: number,
  /** 同行相邻片段之间的分隔（默认单空格） */
  sep = " ",
): { text: string }[] {
  const rows: { text: string }[] = [];
  let row = "";
  let rowW = 0;
  const visW = (s: string): number => {
    let w = 0;
    for (const m of s.matchAll(/\x1b\[[0-9;]*m|[\s\S]/gu)) {
      const t = m[0]!;
      if (!t.startsWith("\x1b")) w += charWidth(t);
    }
    return w;
  };
  // 片段超宽时按词级在内部折行（避免整块被截断；词内嵌 ANSI，空格不在色码内）
  const splitOverflow = (seg: string): string[] => {
    const words = seg.split(" ");
    const lines: string[] = [];
    let line = "";
    let lw = 0;
    for (const wd of words) {
      const ww = visW(wd);
      const gap = line === "" ? 0 : 1;
      if (line !== "" && lw + gap + ww > Math.max(1, width)) {
        lines.push(line);
        line = wd;
        lw = ww;
      } else {
        line += (line === "" ? "" : " ") + wd;
        lw += gap + ww;
      }
    }
    if (line !== "") lines.push(line);
    return lines.length > 0 ? lines : [seg];
  };
  const pushSeg = (seg: string): void => {
    const w = visW(seg);
    if (row === "") {
      if (w <= Math.max(1, width)) {
        row = seg;
        rowW = w;
      } else {
        for (const l of splitOverflow(seg)) rows.push({ text: l });
      }
      return;
    }
    const gap = visW(sep);
    if (rowW + gap + w <= Math.max(1, width)) {
      row += sep + seg; // 同行：插入竖线分隔
      rowW += gap + w;
      return;
    }
    // 折行：上一项行尾不带竖线
    rows.push({ text: row });
    row = "";
    rowW = 0;
    if (w <= Math.max(1, width)) {
      row = seg;
      rowW = w;
    } else {
      for (const l of splitOverflow(seg)) rows.push({ text: l });
    }
  };
  for (const seg of segs) pushSeg(seg);
  if (row !== "") rows.push({ text: row });
  return rows;
}

/** 状态列 Mode 块：会话运行模式/权限/审批策略。各项目（plan/sandbox/permission/
 *  policy/preset）以竖线 ` | ` 分隔连续排布（同水平状态栏段间分隔），放不下才折行；
 *  每项目列出全部可选项、生效项着色强调、其余灰。无会话数据时整块省略。 */
function modeBlock(
  mode: ModeState | undefined,
  policy: "ask" | "never" | undefined,
  preset: string | undefined,
  width: number,
  themeId: ThemeId,
  /** 权限预设目录（原始预设键；缺省/空 → 降级标准三档） */
  permissionOptions?: readonly string[],
  /** agent 预设目录（id 列表；缺省/空 → 只显示当前值） */
  presetOptions?: readonly string[],
): { text: string; color?: (s: string) => string }[] {
  const out: { text: string; color?: (s: string) => string }[] = [];
  const has =
    mode !== undefined ||
    policy !== undefined ||
    (preset !== undefined && preset !== "");
  if (!has) return out;
  out.push({ text: colorFor(themeId, "blue")("Mode") });
  const gray = (s: string) => colorFor(themeId, "gray")(s);
  // 各项目 token（标签默认前景 + 全部可选项，生效项 act 强调色、未生效值灰）。
  // 项目之间的竖线 ` | ` 由 wrapSegs 在「同行的相邻项目」之间插入（灰色），
  // 折行处不加竖线——属性名恒默认前景、只有未生效的属性值才灰
  const tokens: string[] = [];
  const add = (
    tag: string,
    options: readonly string[],
    current: string | undefined,
    act: (s: string) => string,
  ): void => {
    tokens.push(
      tag +
        " " +
        options.map((o) => (o === current ? act(o) : gray(o))).join(" "),
    );
  };
  if (mode) {
    if (mode.plan)
      add("plan", ["off", "on"], mode.plan, (s) =>
        colorFor(themeId, "cyan")(s),
      );
    if (mode.sandbox) {
      // 可选项 = 静态三档；目录（宿主）暂无 sandbox 可选项源，三档外生效值
      // （如 custom）始终补入列表并高亮（洋红），保证「生效值必显示」
      const raw = mode.sandbox;
      const code = MODE_SHORT[raw] ?? raw;
      const opts = ["ro", "wr", "full"].includes(code)
        ? ["ro", "wr", "full"]
        : [...["ro", "wr", "full"], code];
      const curColor =
        raw in MODE_SHORT
          ? (s: string) => permColor(themeId, s)(s)
          : (s: string) => colorFor(themeId, "magenta")(s);
      add("sandbox", opts, code, curColor);
    }
    // permission 独立列出全部可选项（不因与 sandbox 相同而省略——用户要求逐项全列）
    if (mode.permission) {
      // 可选项 = 目录（若已同步）?? 标准三档；三档外生效值（如 custom）始终
      // 补入列表并高亮，保证「生效值必显示」
      const base =
        permissionOptions && permissionOptions.length > 0
          ? permissionOptions
          : ["read-only", "workspace-write", "danger-full-access"];
      const raw = mode.permission;
      // 当前生效值始终补入（无论目录是否为空/降级）：能显示出来才谈得上高亮
      const opts = base.includes(raw) ? base : [...base, raw];
      const curDisp = MODE_SHORT[raw] ?? raw;
      // 生效色：名在三档内按危险等级 ro/wr/full；自定义预设（目录外值）用洋红强调
      const curColor =
        raw in MODE_SHORT
          ? (s: string) => permColor(themeId, s)(s)
          : (s: string) => colorFor(themeId, "magenta")(s);
      add(
        "permission",
        opts.map((o) => MODE_SHORT[o] ?? o),
        curDisp,
        curColor,
      );
    }
  }
  if (policy)
    add("policy", ["ask", "auto"], policy === "never" ? "auto" : "ask", (s) =>
      colorFor(themeId, s === "ask" ? "green" : "red")(s),
    );
  if (preset && preset !== "") {
    // 可选项 = agent 预设目录（若已同步）；否则只显示当前值；目录不含当前值时补入
    const opts =
      presetOptions && presetOptions.length > 0
        ? presetOptions.includes(preset)
          ? presetOptions
          : [...presetOptions, preset]
        : [preset];
    add("preset", opts, preset, (s) => colorFor(themeId, "magenta")(s));
  }
  // 项目竖线属边框：前景色（bright[0]）；未生效值仍 gray
  out.push(...wrapSegs(tokens, width, colorFor(themeId, "border")(" | ")));
  return out;
}

/** 顶部状态列正文行（未按可视高度裁剪；供滚动窗口取窗） */
function statusColumnBody(
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  jobs: JobInfo[] | undefined,
  width: number,
  themeId: ThemeId,
  capGoal = STATUS_GOAL_MAX_LINES,
  capTodo = STATUS_TODO_MAX_LINES,
  omitDone = false,
  mode?: ModeState,
  policy?: "ask" | "never",
  preset?: string,
  permissionOptions?: readonly string[],
  presetOptions?: readonly string[],
): { text: string; color?: (s: string) => string }[] {
  const out: { text: string; color?: (s: string) => string }[] = [];
  // 会话运行模式/权限/策略块（水平状态栏迁来）：放在最前，独立于 goal 是否存在
  const modeRows = modeBlock(
    mode,
    policy,
    preset,
    width,
    themeId,
    permissionOptions,
    presetOptions,
  );
  out.push(...modeRows);
  // Mode 块与 Goal 块之间加虚线分隔（有 Mode 且有 goal 时）
  if (modeRows.length > 0 && goal && goal.status !== "cleared") {
    out.push({
      text: colorFor(themeId, "border")(STATUS_BLOCK_SEPARATOR.repeat(width)),
    });
  }
  // goal 块非必需：无 goal（含 cleared）显示占位，但 todo/jobs 块独立展示（不早退）。
  // Mode 块在最前已 push；todo/jobs 块在有数据时仍渲染（jobs 不再被无 goal 吞掉）
  if (goal && goal.status !== "cleared") {
    const g = goal.goal;
    // 标题行：`Goal <phase>`（Goal 蓝 + phase 状态色：active/complete 绿、paused 黄、blocked 红）
    out.push({
      text:
        colorFor(themeId, "blue")("Goal ") +
        colorFor(themeId, GOAL_PHASE_COLOR[g.phase] ?? "green")(g.phase),
    });
    // objective 正文（可长，上限 capGoal 行；无「目标」前缀）
    out.push(...capWrap(g.objective || "（空目标）", width, capGoal));
    // blocked → blockedReason.message 黄 tone
    if (g.phase === "blocked" && g.blockedReason?.message) {
      out.push({
        text: "阻塞: " + g.blockedReason.message,
        color: colorFor(themeId, "yellow"),
      });
    }
  } else {
    // 无 goal/todo 时直接留空（不显示占位文字，保持行稳定）
    out.push({ text: "" });
  }
  // todo 块标题（完成数/总数，蓝）+ 列表（每条上限 capTodo 行）：
  // `○ ` 待办(默认空心圆) / `● ` 进行中(黄实心圆) / `✓ ` 完成(灰+删除线)
  const list = todos ?? [];
  if (list.length > 0) {
    // goal 块与 todo 块之间以虚线分隔（点更少的虚线，2026-09-17；窗口内板块）保留虚线
    out.push({
      text: colorFor(themeId, "border")(STATUS_BLOCK_SEPARATOR.repeat(width)),
    });
    const done = list.filter((t) => t.status === "completed").length;
    out.push({
      text: colorFor(themeId, "blue")(`Todo ${done}/${list.length}`),
    });
    for (const t of list) {
      // 折叠（溢出）时优先隐藏已完成任务：省略 completed 行（计数标题仍含全部）
      if (omitDone && t.status === "completed") continue;
      const body = t.content === "" ? "（空项）" : t.content;
      const mark = TODO_MARKER[t.status];
      // 正文按剩余宽度（扣掉 marker 两列）折行；续行缩进 marker 宽度与首行正文对齐
      const rows = capWrap(body, width - 2, capTodo).map((r, i) => ({
        text: (i === 0 ? mark : "  ") + r.text,
      }));
      if (t.status === "completed") {
        // 对号（灰，无线）不被删除线覆盖；正文/续行灰+删除线
        rows.forEach((r, i) => {
          if (i === 0) {
            // 首行：对号（灰，无删除线）+ 正文（灰+删除线）
            out.push({
              text:
                colorFor(themeId, "gray")(TODO_MARKER.completed) +
                renderSeg(
                  {
                    text: r.text.slice(TODO_MARKER.completed.length),
                    style: { fg: "gray", strike: true },
                  },
                  themeId,
                ),
            });
          } else {
            out.push({
              text: renderSeg(
                { text: r.text, style: { fg: "gray", strike: true } },
                themeId,
              ),
            });
          }
        });
      } else if (t.status === "in_progress") {
        // 换行后颜色不丢失：整项（含续行）同色；所有进行中项均为黄色
        const color = colorFor(themeId, "yellow");
        rows.forEach((r) => {
          out.push({ text: r.text, color });
        });
      } else {
        rows.forEach((r) => {
          out.push({ text: r.text });
        });
      }
    }
  }
  // jobs 块（后台任务）：只在有任务时显示；标题 `Jobs 运行中/总数`（蓝）+
  // 每任务一行 `● `(运行中黄)/`✗ `(失败红)/`○ `(取消灰)/`✓ `(已完成：正文灰+删除线) + label
  if (jobs && jobs.length > 0) {
    out.push({
      text: colorFor(themeId, "border")(STATUS_BLOCK_SEPARATOR.repeat(width)),
    });
    const active = jobs.filter(
      (j) => j.status === "running" || j.status === "stopping",
    ).length;
    out.push({
      text: colorFor(themeId, "blue")(`Jobs ${active}/${jobs.length}`),
    });
    for (const job of jobs) {
      const mark = statusMark(themeId, job.status);
      // 折叠（溢出）时优先隐藏已完成任务：done 行省略（计数标题仍含全部）
      if (omitDone && mark.symbol === "✓") continue;
      const label = job.label || job.kind || job.id || "（未命名任务）";
      if (mark.symbol === "✓") {
        // 已完成（默认分支，如 done）：正文灰+删除线，与 todo completed 一致
        out.push({
          text:
            colorFor(themeId, "gray")("✓ ") +
            renderSeg(
              { text: label, style: { fg: "gray", strike: true } },
              themeId,
            ),
        });
      } else {
        out.push({ text: mark.symbol + " " + label, color: mark.color });
      }
    }
  }
  // 会话标题已随 2026-09-27 迁入左侧历史区顶部标题栏（见 buildTopRegion），
  // 状态列不再承载标题（首行直接是 Mode 块）
  return out;
}

/** 顶部状态列窗口起点：偏移恒在 [0, max(0, len-rows)] 内 */
function statusStartFor(len: number, offset: number, rows: number): number {
  if (len <= rows || rows <= 0) return 0;
  return Math.min(Math.max(0, offset), len - rows);
}

/** 顶部状态列（右侧列）：输出恰 height 行，每行宽 statusColWidth（末位竖线为分隔竖线边线，
 *  右侧布局下由 buildTopRegion 剥去后重新构图左缘分隔竖线/右缘框列）。
 *  滚动独立于对话区（statusColumnScroll，↑/↓ 仍滚历史，PgUp/PgDn 滚状态列）。 */
export function renderStatusColumn(
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  jobs: JobInfo[] | undefined,
  scroll: number,
  height: number,
  width: number,
  themeId: ThemeId,
  /** 会话运行模式/权限/策略（缺省 undefined：Mode 块省略） */
  mode?: ModeState,
  policy?: "ask" | "never",
  preset?: string,
  /** 权限/agent 预设目录（可选值列表；缺省 Mode 块降级） */
  permissionOptions?: readonly string[],
  presetOptions?: readonly string[],
): string[] {
  const h = Math.max(1, height);
  const w = Math.max(1, width);
  // 状态列折叠策略：整体高度内不折叠任何内容（完整渲染）；
  // 溢出时优先隐藏已完成任务（completed todo / done jobs），仍溢出再折叠长内容
  const inf = Number.MAX_SAFE_INTEGER;
  let body = statusColumnBody(
    goal,
    todos,
    jobs,
    w - 1,
    themeId,
    inf,
    inf,
    false,
    mode,
    policy,
    preset,
    permissionOptions,
    presetOptions,
  );
  if (body.length > h) {
    const noDone = statusColumnBody(
      goal,
      todos,
      jobs,
      w - 1,
      themeId,
      inf,
      inf,
      true,
      mode,
      policy,
      preset,
      permissionOptions,
      presetOptions,
    );
    body =
      noDone.length <= h
        ? noDone
        : statusColumnBody(
            goal,
            todos,
            jobs,
            w - 1,
            themeId,
            STATUS_GOAL_MAX_LINES,
            STATUS_TODO_MAX_LINES,
            true,
            mode,
            policy,
            preset,
            permissionOptions,
            presetOptions,
          );
  }
  const start = statusStartFor(body.length, scroll, h);
  const out: string[] = [];
  for (let r = 0; r < h; r++) {
    const idx = start + r;
    const line = idx < body.length ? body[idx] : undefined;
    const text = (line?.color ?? ((s: string) => s))(line?.text ?? "");
    const inner = truncateToWidth(text, w - 1);
    // 右缘竖线分隔（竖线 │ 跨行连成连续线）：内容后补空格到 (w-1) 再放竖线。
    // 此竖线在 buildTopRegion 被剥去后重画（边框灰/亮由框架构图决定），故保持无色便于剥离
    const pad = " ".repeat(Math.max(0, w - 1 - displayWidth(inner)));
    out.push(inner + pad + "│");
  }
  return out;
}
/** 顶部区域：左列对话历史+活动区（可独立滚动）、右侧详细状态列；焦点面板四边框亮色 */
function buildTopRegion(
  state: AppState,
  topHeight: number,
  statusColWidth: number,
  historyWidth: number,
  focusActive: boolean,
  goal: GoalState | undefined,
  todos: TodoItemLike[] | undefined,
  jobs: JobInfo[] | undefined,
  statusScroll: number,
  mode?: ModeState,
  policy?: "ask" | "never",
  preset?: string,
  permissionOptions?: readonly string[],
  presetOptions?: readonly string[],
  /** 会话标题（左侧历史区顶部标题栏；空标题 <title> 灰占位保持行稳定） */
  title = "",
): RenderLine[] {
  // 焦点框保留格（所有状态恒定，避免内容重排）：左侧框格列（历史/活动区左缘）
  // 与右侧框列（状态列右缘）在宽度允许时各占 1 列；未聚焦/模态态该格留空白占位。
  // 2026-09-27：不再保留独立顶部边框行——标题栏即顶部（标题行在 rc0），焦点框从
  // 对话区开始（history 顶边用标题栏下划线行兼作），状态列从 rc0 起即有内容。
  const contentTopH = Math.max(0, topHeight);
  // 历史/活动区在左、详细状态列在右（2026-09-17 对调）：
  // 左缘框格 = 历史/活动区左缘（historyWidth≥2 时预留）；右缘框列 = 状态列右缘（statusColWidth≥2 时预留）
  const useLeftFrame = historyWidth >= FRAME_LEFT_COLS + 1;
  const useRightFrame = statusColWidth >= FRAME_RIGHT_COLS + 1;
  const contentW = Math.max(
    1,
    historyWidth - (useLeftFrame ? FRAME_LEFT_COLS : 0),
  );
  // 左列顶部为独立标题栏（会话标题行 + 实线下划线，2026-09-27 由右侧状态列迁入）。
  // 活动区高度沿用原公式（基于顶部内容行数，不随标题栏收缩），标题栏行数由对话区
  // 承担（topPaneHeights 与 inputPanelHeights 同口径）；活动区可视行数先于
  // 活动区可视行数先于 wrapBufferLines 计算，作为活动区整体截断窗口（思考/工具/
  // notice/中间输出统一按可视行截断（不再单独折叠思考）
  const { titleRows, activityH, dialogueH } = topPaneHeights(
    contentTopH,
    state.activityDivisor,
  );
  const diaStart = titleRows; // 内容行中对话区起点（标题栏之后）
  const diaEnd = diaStart + dialogueH; // 对话区结束（= 活动区分隔行位置）
  const { dialogue, activity } = wrapBufferLines(
    state.buffer,
    contentW,
    state.messageGutter,
    state.themeId,
  );
  // 对话区折叠：跟随底部（未上滚）时仅保留最近 N 组回复（更早以灰占位）；
  // 用户上滚查看历史时展开全量——否则被折叠丢弃的更早回复无法滚动到（翻页失效）。
  // 折叠在窗口计算前统一进行，保证 scrollOffset 基于同一 rows 数组。
  const dialogueRows =
    state.scrollOffset > 0
      ? dialogue
      : foldDialogue(dialogue, state.themeId, DIALOGUE_KEEP_REPLIES);
  const vp = computeViewport({
    totalRows: dialogueRows.length,
    height: dialogueH,
    followBottom: state.followBottom,
    scrollOffset: state.scrollOffset,
  });
  // 状态列（右侧）：恰「内容行数」行，每行宽 statusColWidth。
  // renderStatusColumn 自带右缘竖线，对调后剥去不用，分隔竖线左缘/右缘框列由本函数构图
  const statusCells = renderStatusColumn(
    goal,
    todos,
    jobs,
    statusScroll,
    contentTopH,
    statusColWidth,
    state.themeId,
    mode,
    policy,
    preset,
    permissionOptions,
    presetOptions,
  );
  // 边框构图参数：分隔竖线列 = historyWidth（历史区右缘/状态列左缘，
  // 为旧 statusColWidth-1 的镜像）；col0 左缘框格属历史/活动区，
  // 右缘框列 R 属状态列。顶部边框行占 index 0，标题栏紧随其后，
  // 活动区分隔行自然位于 diaEnd 后一行。
  const statusBodyW = Math.max(
    0,
    statusColWidth - 1 - (useRightFrame ? FRAME_RIGHT_COLS : 0),
  );
  const panel = state.focusedPanel;
  const statusFocused = focusActive && panel === "status";
  const topHistory = focusActive && panel === "history";
  const activityFocused = focusActive && panel === "activity";
  const fc = focusFrameColor(state.themeId);
  const cf = (s: string): string => colorFor(state.themeId, fc)(s);
  const cg = (s: string): string => colorFor(state.themeId, "gray")(s);
  const blank = (n: number): string => " ".repeat(Math.max(0, n));
  // 活动区分隔线：焦点为历史/流输出时亮色框，状态焦点/模态回边框色（bright[0]）
  const sepFocused = topHistory || activityFocused;
  const sepStr = (): string =>
    colorFor(
      state.themeId,
      sepFocused ? fc : "border", // 边框=前景色，焦点=强调色
    )(ACTIVITY_SEPARATOR.repeat(Math.max(1, contentW)));
  const rows: RenderLine[] = [];
  // 右侧边框列保留格（状态列右缘）：画成框线（┐/│/╝）时亮色着色，否则空白占位
  const rightGlyph = (g: string): string => (g === " " ? " " : cf(g));
  // 内容行（0..contentTopH-1）：标题栏 → 对话区 → 活动区分隔 → 活动区。
  // 内容行（1..contentTopH）：对话区 → 活动区分隔 → 活动区。
  // 中间分隔竖线（历史区右缘/状态列左缘）随焦点面板只亮其垂直边界：
  // status=全行、history=仅对话区、activity=仅分隔行+活动区；模态态全回流边框色。
  const actMaxOffset = Math.max(0, activity.length - activityH);
  const actOffset = Math.min(state.activityScroll, actMaxOffset);
  const act = activity.slice(
    actMaxOffset - actOffset,
    actMaxOffset - actOffset + activityH,
  );
  const topPad = activityH - act.length;
  // 「有问题交互」面板（审批/问答/模型选择）显示位置=流输出（活动区）窗口顶部：
  // 底部交互区不再承载（footer 空白占位保持交互区高度稳定）；面板占满活动区可视
  // 行，活动区瞬态行（thinking/tool/notice）在面板存在时本帧让位
  const modalPanel: RenderLine[] = state.approval
    ? renderApprovalPrompt(state.approval, activityH, contentW, state.themeId)
    : state.question
      ? renderQuestionPanel(state.question, activityH, contentW, state.themeId)
      : state.picker
        ? renderModelPicker(
            {
              picker: state.picker,
              height: activityH,
              width: contentW,
            },
            state.themeId,
          )
        : state.statusPanel
          ? renderStatusPanel({
              panel: state.statusPanel,
              height: activityH,
              width: contentW,
              themeId: state.themeId,
            })
          : state.jobsPanel
            ? renderJobsPanel({
                jobs: state.jobs,
                index: state.jobsPanel.index,
                height: activityH,
                width: contentW,
                themeId: state.themeId,
              })
            : [];
  const divFor = (rc: number): string => {
    // 活动区分隔行两端为面板角字：history=右下角 ┘、activity=右上角 ┐、其余=竖线
    if (rc === diaEnd && activityH > 0) {
      // 分隔行 无焦点/状态焦点：D 列交点用连接字形 `┤`（竖线贯穿+横线从左接入），
      // 与水平状态栏顶线的 `┴` 统一“连接”风格；焦点态用面板角字 ┘/┐（同为连接）
      const g = panel === "history" ? "┘" : panel === "activity" ? "┐" : "┤";
      return colorFor(state.themeId, focusActive ? fc : "border")(g);
    }
    // 状态列顶边（rc0 标题行并排位置）：D 列起 ┌（status 焦点时亮白）
    if (rc === 0 && statusFocused) return colorFor(state.themeId, fc)("┌");
    // 标题栏分隔行（标题栏第 2 行，横线铺满左列）：D 列交点用 `┤`
    //（竖线贯穿 + 横线从左侧接入，与活动区分隔行中性态一致）；归历史面板
    if (titleRows > 1 && rc === diaStart - 1) {
      const bright = focusActive && panel === "history";
      return colorFor(
        state.themeId,
        bright ? fc : "border",
      )(topHistory ? "┐" : "┤");
    }
    // 无焦点（focusedPanel=null）时所有框线回边框色（bright[0]）：bright 仅在有焦点时可能为真
    let bright = focusActive && panel !== null;
    // 焦点窗口不含标题栏：history 只亮对话区行（rc ∈ [diaStart, diaEnd)），
    // 标题行/下划线行 D 列竖线保持边框色
    if (focusActive && panel === "history")
      bright = rc >= diaStart && rc < diaEnd;
    else if (focusActive && panel === "activity") bright = rc >= diaEnd;
    return colorFor(state.themeId, bright ? fc : "border")("│");
  };
  for (let rc = 0; rc < contentTopH; rc++) {
    // col0：历史/活动区左缘框格——history 焦点亮标题栏+对话区行+分隔行左下角 `┘`；
    // activity 焦点亮活动区行+分隔行左上角 `┌`；status 焦点空白占位（状态列在右）
    let left = "";
    if (useLeftFrame) {
      if (rc === diaEnd && activityH > 0) {
        left =
          panel === "history"
            ? topHistory
              ? cf("┘")
              : " "
            : panel === "activity"
              ? activityFocused
                ? cf("┌")
                : " "
              : " ";
      } else if (rc < diaStart) {
        // 标题栏不在焦点窗口：仅下划线行在 history 焦点时作顶边左角 `┌`；
        // 其余左缘空白占位（保持 col0 恒定 1 列，防内容重排）
        if (titleRows > 1 && rc === diaStart - 1 && topHistory) left = cf("┌");
        else left = " ";
      } else if (rc < diaEnd) {
        left = topHistory ? cf("│") : " ";
      } else {
        left = activityFocused ? cf("│") : " ";
      }
    }
    // 状态列正文（右侧）：剥去 renderStatusColumn 自带右缘竖线，正文截到 statusBodyW 定宽，
    // 保证右缘框列恒位于 R 列、不紧贴文字末尾。status 焦点时 rc0 让位为状态列顶边
    //（┌─），状态列内容整体下移一行（statusCells[rc-1]，末行随之截弃）。
    let statusBody: string;
    if (statusFocused && rc === 0) {
      // D 列 ┌ 由 divFor 提供，此处只画状态列横线部分
      statusBody = statusBodyW > 0 ? cf(SEPARATOR.repeat(statusBodyW)) : "";
    } else {
      const cell = statusCells[statusFocused ? rc - 1 : rc];
      const rawBody = truncateToWidth(cell?.slice(0, -1) ?? "", statusBodyW);
      // 已含内嵌色（Mode 块/todo 标题/进行中项等自带 ANSI）的行不再整行外包灰，
      // 否则无色片段（如 Mode 属性名）会被 cg 蒙灰；无 ANSI 的纯内容行仍按约定上灰
      statusBody = rawBody.includes("\x1b")
        ? rawBody + blank(statusBodyW - displayWidth(rawBody))
        : cg(rawBody + blank(statusBodyW - displayWidth(rawBody)));
    }
    let content: string;
    if (rc < diaStart) {
      // 标题栏：首行标题（空标题 <title> 灰占位保持行稳定）、次行实线下划线
      //（极矮终端 titleRows=1 时仅标题行；titleRows=0 时整栏省略）
      if (rc === 0) {
        const rawTitle = (title ?? "").trim();
        content = colorFor(
          state.themeId,
          "border",
        )(truncateToWidth(rawTitle === "" ? "<title>" : rawTitle, contentW));
      } else {
        content = colorFor(
          state.themeId,
          "border",
        )(SEPARATOR.repeat(Math.max(1, contentW)));
      }
    } else if (rc < diaEnd) {
      // 对话区行：followBottom / scrollOffset 只作用于对话区
      const rr = rc - diaStart;
      const w = dialogueRows[vp.start + rr];
      content =
        w && vp.start + rr < vp.end ? " ".repeat(w.indent) + w.text : "";
    } else if (rc === diaEnd && activityH > 0) {
      // 活动区分隔行（对话历史 ↔ 流输出边界），两端角字由 col0/divFor 构图
      content = sepStr();
    } else if (activityH > 0) {
      // 活动区行：交互面板存在时显示面板，否则按滚动偏移取瞬态窗口
      // （0=跟随最新显示尾部；上滚看更早）
      const rr = rc - diaEnd - 1;
      if (modalPanel.length > 0) {
        content = rr < modalPanel.length ? modalPanel[rr]!.text : "";
      } else {
        const a = rr - topPad;
        content = a >= 0 ? " ".repeat(act[a]!.indent) + act[a]!.text : "";
      }
    } else {
      content = "";
    }
    // 历史/活动区正文补齐到 contentW：分隔竖线恒位于 D 列（不紧贴文字末尾）
    content += blank(Math.max(0, contentW - displayWidth(content)));
    // 右缘框列（状态列右缘）：status 焦点亮（rc0 为顶边右角 ┐）；其余空白占位
    const right = statusFocused ? (rc === 0 ? "┐" : "│") : " ";
    rows.push({
      text:
        left +
        content +
        divFor(rc) +
        statusBody +
        (useRightFrame ? rightGlyph(right) : ""),
    });
  }
  return rows;
}

export const USER_MIN_LEFT_GUTTER = 4;
/** 工具调用历史：仅展示最近 TOOL_MAX_GROUPS 个调用组，更早隐藏（折叠标记） */
export const TOOL_MAX_GROUPS = 4;
export const TOOL_MORE = "...(更早工具调用已隐藏)";
/** THINKING_MAX 兼容导出（state.DEFAULT_THINKING_MAX_LINES 为权威默认） */
export const THINKING_MAX: number = 4;

/** 用户消息块最大正文宽：块整体靠右，左侧至少保留 gutter(默认 USER_MIN_LEFT_GUTTER) */
export function userMaxBodyWidth(
  width: number,
  gutter: number = USER_MIN_LEFT_GUTTER,
): number {
  return Math.max(1, width - Math.min(gutter, Math.max(0, width - 1)));
}

/** 模型正文块最大宽：右缘与用户块左缘对称留白(gutter)，与用户输入形成左右交错 */
export function assistantMaxBodyWidth(
  width: number,
  gutter: number = USER_MIN_LEFT_GUTTER,
): number {
  return Math.max(1, width - Math.min(gutter, Math.max(0, width - 1)));
}

interface WrappedRow {
  text: string;
  kind: BufferKind;
  indent: number;
}

interface PaneRows {
  /** 对话区行：user/assistant/separator/plain（可滚动视口） */
  dialogue: WrappedRow[];
  /** 活动区行：thinking/tool/notice（瞬态，底部固定窗口） */
  activity: WrappedRow[];
}

function wrapBufferLines(
  buffer: Buffer,
  width: number,
  gutter: number,
  themeId: ThemeId,
): PaneRows {
  const dialogue: WrappedRow[] = [];
  const activity: WrappedRow[] = [];
  let inFence = false;
  // 工具行按连续 run 收集，flush 时做折叠/分组渲染；遇到非工具行先落盘
  const toolRun: BufferLine[] = [];
  const flushToolRun = (): void => {
    if (toolRun.length === 0) return;
    // 按调用分组：无符号前缀的行=工具调用行（起新组），后续 ✓/✗ 等结果归入当前组
    const groups: BufferLine[][] = [[]];
    for (const l of toolRun) {
      if (isToolCall(l.text) && groups[groups.length - 1]!.length > 0)
        groups.push([]);
      groups[groups.length - 1]!.push(l);
    }
    // 折叠：仅保留最近 TOOL_MAX_GROUPS 组，更早以灰色折叠标记隐藏
    const visible = groups.slice(-TOOL_MAX_GROUPS);
    const hasMore = groups.length > TOOL_MAX_GROUPS;
    if (hasMore) {
      activity.push({
        text: colorFor(themeId, NOTICE_TONE_COLOR.log)(TOOL_MORE),
        kind: "tool",
        indent: 0,
      });
    }
    for (let gi = 0; gi < visible.length; gi++) {
      if (gi > 0) activity.push({ text: "", kind: "tool", indent: 0 }); // 组间空行
      for (let li = 0; li < visible[gi]!.length; li++) {
        const l = visible[gi]![li]!;
        const rows =
          l.text === "" ? [""] : wrapLine(l.text, Math.max(1, width));
        // ✗ 由 tone 整体着红；组首调用行工具名染黄（renderToolNameLine），
        // ✓ 结果行走 renderToolText，其余辅助行（⚑/↻/@…）保持默认
        for (const t of rows) {
          const text = l.tone
            ? colorFor(themeId, NOTICE_TONE_COLOR[l.tone])(t)
            : li === 0 && isToolCall(l.text)
              ? renderToolNameLine(t, themeId)
              : renderToolText(t, themeId);
          activity.push({ text, kind: "tool", indent: 0 });
        }
      }
    }
    toolRun.length = 0;
  };
  for (const line of buffer) {
    if (line.kind !== "tool" && toolRun.length > 0) flushToolRun();
    if (line.kind === "tool") {
      toolRun.push(line);
      continue;
    }
    if (line.kind === "thinking") {
      // 思考行 → 活动区（与工具/notice/中间输出按时间顺序混合；不再单独分组折叠）
      const bar = colorFor(themeId, "brightMagenta")("┃");
      const rows = wrapLine(line.text, Math.max(1, width - 1));
      for (const text of rows)
        activity.push({
          text: text === "" ? "" : bar + text,
          kind: "thinking",
          indent: 0,
        });
      continue;
    }
    if (line.kind === "user") {
      // 用户消息块：按内容收缩宽度并整体靠右（统一 leftPad），块内保持左对齐；
      // 右侧附加浅红竖线用于区分（窄列降级不加，以免正文被挤出）
      // ponytail: width<6 时省略竖线；有富裕再去掉阈值
      const bar =
        width >= USER_MIN_LEFT_GUTTER + 2
          ? colorFor(themeId, "brightRed")("┃")
          : "";
      const maxBody = userMaxBodyWidth(width, gutter);
      const wrapped = wrapLines(line.text.split("\n"), maxBody);
      // 竖线固定在块右缘（紧挨右缘边框），不随行尾：正文先按最长行宽补齐再挂竖线
      const contentWidth = Math.max(1, ...wrapped.map((r) => displayWidth(r)));
      const bodyWidth = contentWidth + (bar ? 1 : 0);
      const pad = Math.max(0, width - bodyWidth);
      for (const r of wrapped)
        dialogue.push({
          text:
            r === ""
              ? ""
              : r +
                " ".repeat(Math.max(0, contentWidth - displayWidth(r))) +
                bar,
          kind: "user",
          indent: pad,
        });
      continue;
    }
    if (line.kind === "assistant") {
      // 模型正文分流：final（回合最终总结）→ 历史区（交错留白布局）；
      // 非 final（中间输出）→ 活动区（全宽渲染，与思考/工具/notice 按时间混合）。
      // fence 代码块内原样展示（块背景不解析），块外按块级/行内 markdown 子集渲染
      const target = line.final ? dialogue : activity;
      const fence = FENCE_RE.exec(line.text);
      if (fence && fence[1]!.length >= 3) {
        if (inFence) {
          inFence = false;
        } else {
          inFence = true;
          const lang = fence[2] ?? "";
          if (lang) {
            // 代码块语言标签行：灰斜体（fence 开关行本身不显示）
            target.push({
              text: renderSeg(
                { text: lang, style: { fg: "gray", italic: true } },
                themeId,
              ),
              kind: line.kind,
              indent: 0,
            });
          }
        }
        continue;
      }
      // 回复正文左侧附加浅蓝竖线用于区分（窄列降级不加，以免正文被挤出）
      // ponytail: width<6 时省略竖线；有富裕再去掉阈值
      const hasBar = width >= USER_MIN_LEFT_GUTTER + 2;
      const bodyWidth = line.final
        ? assistantMaxBodyWidth(width, gutter)
        : hasBar
          ? width - 1 // 活动区全宽渲染 + 左竖线 → 留 1 列，避免溢出到 D 列
          : width;
      const bar = hasBar ? colorFor(themeId, "brightBlue")("┃") : "";
      const rows = inFence
        ? wrapCodeLine(line.text, bodyWidth, themeId)
        : wrapAssistantLine(line.text, bodyWidth, themeId);
      for (const text of rows)
        target.push({
          text: text === "" ? "" : bar + text,
          kind: line.kind,
          indent: 0,
        });
      continue;
    }
    if (line.kind === "notice") {
      // notice → 活动区（瞬态提示）
      const rows =
        line.text === "" ? [""] : wrapLine(line.text, Math.max(1, width));
      const tone = line.tone;
      const color = tone
        ? (s: string) => colorFor(themeId, NOTICE_TONE_COLOR[tone])(s)
        : (s: string) => s;
      for (const text of rows)
        activity.push({ text: color(text), kind: "notice", indent: 0 });
      continue;
    }
    // separator / plain → 对话区（turn 分隔线：虚线条 ╌ 铺满，先按纯文本换行，
    // 再逐行着灰，避免 ANSI 转义进入 wrapLine 被按显示宽度误计）
    const content =
      line.kind === "separator"
        ? TURN_SEPARATOR_CHAR.repeat(Math.max(1, width))
        : line.text;
    const rows = content === "" ? [""] : wrapLine(content, Math.max(1, width));
    for (const text of rows)
      dialogue.push({
        text:
          line.kind === "separator" ? colorFor(themeId, "border")(text) : text,
        kind: line.kind,
        indent: 0,
      });
  }
  flushToolRun();
  // 对话区：用户消息块与随后的答案之间空一行（纯布局展示，不写状态）
  // 对话区：用户消息块与随后的答案之间空一行（纯布局展示，不写状态）
  const spaced: WrappedRow[] = [];
  for (const row of dialogue) {
    const last = spaced[spaced.length - 1];
    if (last && last.kind === "user" && row.kind === "assistant") {
      spaced.push({ text: "", kind: "plain", indent: 0 });
    }
    spaced.push(row);
  }
  // 模型回复尾部空行不显示：流式块以换行结尾时 appendStream 会留下末尾空
  // assistant 行；仅两个正文段之间的空行才有段落意义(保留)，其后不再有正文
  // 的空行（分隔线/下条用户消息/缓冲尾部之前）视为多余。
  let hasBodyAfter = false;
  for (let i = spaced.length - 1; i >= 0; i--) {
    const row = spaced[i]!;
    if (row.kind === "assistant" && row.text !== "") hasBodyAfter = true;
    else if (row.kind === "assistant" && row.text === "" && !hasBodyAfter)
      spaced.splice(i, 1);
  }
  // 对话区着色竖线块内连续：仅剩的块内空行（段落空行/显式换行空行）也挂竖线，
  // 使回复/输入块侧边连成整条竖线；末尾空行已被上方删除，此处只补空块的空行
  if (width >= USER_MIN_LEFT_GUTTER + 2) {
    const barR = colorFor(themeId, "brightRed")("┃");
    const barL = colorFor(themeId, "brightBlue")("┃");
    for (let i = 0; i < spaced.length; i++) {
      const row = spaced[i]!;
      if (row.text !== "" || (row.kind !== "user" && row.kind !== "assistant"))
        continue;
      // 其后还有同 kind 内容才算块内空行（跨 plain/分隔就停）
      let sameAfter = false;
      for (let j = i + 1; j < spaced.length; j++) {
        const nx = spaced[j]!;
        if (nx.kind === row.kind) {
          sameAfter = true;
          break;
        }
        if (nx.kind === "plain" || nx.kind === "separator") break;
      }
      if (!sameAfter) continue;
      if (row.kind === "user") {
        row.text = barR;
        row.indent = Math.max(0, width - 1); // 空用户行右缘对齐块右缘
      } else {
        row.text = barL;
      }
    }
  }
  return { dialogue: spaced, activity };
}

/** 系统状态区：可多行；无标题，`|` 分隔；超宽时溢出到下一行（不截断） */
const identity = (s: string): string => s;
/** 模型段标签：provider/model[:reasoningEffort]，无 effort 时不带冒号后缀 */
export function modelLabel(sel: {
  provider: string;
  model: string;
  reasoningEffort?: string;
}): string {
  return `${sel.provider}/${sel.model}${sel.reasoningEffort ? ":" + sel.reasoningEffort : ""}`;
}

/** provider 紫，模型名青，:后缀 前景色；无 "/" 时整体青（占位 "—" 保持无色）。
 *  状态栏段配色约定：相邻段不同色、不用红/黄/绿状态色、不用亮色系（bright*）。 */
function colorModel(themeId: ThemeId, s: string): string {
  const slash = s.indexOf("/");
  if (slash < 0) return s === "—" ? s : colorFor(themeId, "cyan")(s);
  const rest = s.slice(slash + 1);
  const colon = rest.indexOf(":");
  const model = colon < 0 ? rest : rest.slice(0, colon);
  const effort = colon < 0 ? "" : rest.slice(colon);
  return (
    colorFor(themeId, "magenta")(s.slice(0, slash)) +
    colorFor(themeId, "cyan")("/" + model) +
    (effort ? colorFor(themeId, "border")(effort) : "")
  );
}
/** notice/tool 行 tone → 着色名（log 灰 / info 蓝 / warn 黄 / error 红 / success 绿） */
const NOTICE_TONE_COLOR: Record<NoticeTone, ColorName> = {
  log: "gray",
  info: "blue",
  warn: "yellow",
  error: "red",
  success: "green",
};

/** 工具行前缀着色：○ 前缀黄（运行中）、工具名黄；✓ 前缀绿；✗/续行原样（✗ 由 tone 整体着红） */
function renderToolText(text: string, themeId: ThemeId): string {
  if (text.startsWith("✓ ")) {
    return colorFor(themeId, "green")("✓") + " " + text.slice(2);
  }
  return text;
}

/** 工具行分组判定：无状态符号前缀的行=工具调用（新组起点）。
 * 前缀集与 tool-line.ts 各辅助行对齐（✓/✗/↻/⚑/⤷/↩//>/⇥/⌗/@/step） */
const TOOL_STATUS_PREFIXES = [
  "✓ ",
  "✗ ",
  "↻ ",
  "⚑ ",
  "⤷ ",
  "↩ ",
  "/> ",
  "⇥ ",
  "⌗ ",
  "@ ",
  "step ",
];

function isToolCall(text: string): boolean {
  return !TOOL_STATUS_PREFIXES.some((p) => text.startsWith(p));
}

/** 工具调用行渲染：首词（工具名）染黄，其余原色（无前缀图标） */
function renderToolNameLine(text: string, themeId: ThemeId): string {
  const sp = text.indexOf(" ");
  if (sp < 0) return colorFor(themeId, "yellow")(text);
  return colorFor(themeId, "yellow")(text.slice(0, sp)) + text.slice(sp);
}

/** token 数 → 紧凑缩写（k 千 / M 百万，1 位小数，如 12.4k / 1.5M） */
function formatTokens(n: number): string {
  if (n >= 1_000_000)
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

/** state.usage → 状态栏 contextLen/cacheHit 段（total<=0 或无用量时 undefined，保留占位） */
function usageStatus(u: {
  input: number;
  output: number;
  cacheRead: number;
  contextWindow?: number;
}): { ctx: string; cache: string } | undefined {
  const total = u.input + u.cacheRead;
  if (total <= 0) return undefined;
  const pct = Math.round((u.cacheRead / total) * 100);
  // 上下文占用百分比 = total / 模型上下文窗口（窗口未知/未披露时省略，保持仅绝对大小）
  const win = u.contextWindow;
  const ctxPct =
    win && win > 0
      ? `(${Math.min(100, Math.round((total / win) * 100))}%)`
      : "";
  return {
    ctx: "ctx " + formatTokens(total) + ctxPct,
    cache: "cache " + pct + "%",
  };
}

/** 段文本按预算截断：过长保留开头 + 省略号（w<=3 视作不截断，交给换行兜底） */
function fitHead(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  return truncateToWidth(s, w - 1) + "…";
}

/** 路径段按预算截断：保留末尾 + 省略号（路径尾部更有辨识度） */
function fitTail(s: string, w: number): string {
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  const budget = w - 1; // 省略号占 1 列
  let kept = "";
  let used = 0;
  for (const ch of [...s].reverse()) {
    const cw = charWidth(ch);
    if (budget - used < cw) break; // 剩余预算放不下该字符则停，保留已取尾部
    kept = ch + kept;
    used += cw;
  }
  return "…" + kept;
}

/**
 * 模型段按预算截断：优先截 provider/model 名，保留 effort 后缀（:min/:med/:max 等）。
 * 稳定内容紧凑化，避免长模型名挤占动态段（cwd/ctx/cache）的宽度。
 */
function fitModel(s: string, w: number): string {
  const slash = s.indexOf("/");
  const colon = (slash < 0 ? s : s.slice(slash)).indexOf(":");
  const effort = colon >= 0 ? s.slice(slash + colon) : ""; // 含 : 前缀
  const body = effort ? s.slice(0, s.length - effort.length) : s;
  if (displayWidth(s) <= w) return s;
  if (w <= 1) return "…";
  const bodyW = Math.max(1, w - 1 - displayWidth(effort)); // 留 1 列省略号
  return truncateToWidth(body, bodyW) + "…" + effort;
}

export function renderStatusLine(
  status: AppState["systemStatus"],
  themeId: ThemeId,
  cols: number,
  /** 最新一次模型调用 token 用量（有且 total>0 时覆盖 contextLen/cacheHit 占位） */
  usage?: AppState["usage"],
): RenderLine[] {
  const u = usage ? usageStatus(usage) : undefined;
  const ctxSeg = u?.ctx ?? status.contextLen;
  const cacheSeg = u?.cache ?? status.cacheHit;
  // 思考状态并入 model 段（同一段）：provider/model:{后缀}
  // 后缀=on/off/none 或实际等级名（多等级开启如 high/low/max）
  const modelBase = status.model.replace(/:[^:]*$/, "");
  const thinkOn = status.model !== modelBase;
  // modelThinking 显式后缀；缺失时按字符串回退（有 :effort=on，其余 none）
  const thinkState = status.modelThinking ?? (thinkOn ? "on" : "none");
  const modelSeg = `${modelBase}:${thinkState}`;

  // 状态栏按类分组（组间 `|` 分隔、组内 `·` 分隔），行数动态尽量少：
  //   环境组：time · git · cwd            （本机/工作区信息，与会话无关）
  //   会话组：标题                        （当前会话身份）
  //   LLM 组：model:{后缀} · ctx · cache  （最近一次模型调用指标）
  // 宽度足够 → 单行完整显示；放不下 → 按组折行（标题与模型各自成组、组间可折行），单组超宽才组内截断。
  const maxSegW = Math.max(1, cols - 2); // 留首尾各 1 列
  const blue = (s: string) => colorFor(themeId, "blue")(s);
  type Seg = { text: string; color: (s: string) => string };
  const groupWidth = (g: Seg[]): number =>
    g.reduce((acc, s, i) => acc + (i > 0 ? 1 : 0) + displayWidth(s.text), 0);
  // 各组完整版
  // 段配色：time 默认 / git 洋红 / cwd 蓝 / title 青 / provider 紫 / model 青
  //          / 后缀 灰 / ctx 蓝 / cache 默认（会话模式/策略/preset/jobs 徽标已于
  //          2026-09-07 全部移入顶部状态列 Mode 块，见 statusColumnBody/modeBlock）
  const magenta = (s: string) => colorFor(themeId, "magenta")(s);
  const envFull: Seg[] = [
    { text: status.time, color: identity },
    { text: status.git, color: magenta },
    { text: status.cwd, color: blue },
  ];

  const llmFull: Seg[] = [
    { text: modelSeg, color: (s) => colorModel(themeId, s) },
    { text: ctxSeg, color: blue },
    { text: cacheSeg, color: identity },
  ];
  // 各组超宽兜底（单组放不满一行时组内压缩）
  const envFit = (w: number): Seg[] => {
    const gitS = fitHead(status.git, 12);
    const budget = Math.max(
      1,
      w - displayWidth(status.time) - displayWidth(gitS) - 2 - 1,
    );
    return [
      { text: status.time, color: identity },
      { text: gitS, color: magenta },
      { text: fitTail(status.cwd, budget), color: blue },
    ];
  };
  const llmFit = (w: number): Seg[] => {
    const budget = Math.max(
      1,
      w - displayWidth(ctxSeg) - displayWidth(cacheSeg) - 2 - 1,
    );
    return [
      {
        text: fitModel(modelSeg, budget),
        color: (s) => colorModel(themeId, s),
      },
      { text: ctxSeg, color: blue },
      { text: cacheSeg, color: identity },
    ];
  };
  const groups: Array<{
    full: Seg[];
    fit: (w: number) => Seg[];
  }> = [
    { full: envFull, fit: envFit },
    { full: llmFull, fit: llmFit },
  ];

  const renderRow = (row: Seg[][]): RenderLine => ({
    text:
      " " +
      row.map((g) => g.map((s) => s.color(s.text)).join("·")).join("|") +
      " ",
  });

  // 单行完整（宽度足够）→ 各段完整、无省略号
  const fullW = groups.reduce(
    (acc, g, gi) => acc + (gi > 0 ? 1 : 0) + groupWidth(g.full),
    0,
  );
  if (fullW <= maxSegW) return [renderRow(groups.map((g) => g.full))];

  // 折行（尽量少行）：以组为单位依次放入，放不下整组换行。
  // 模型=LLM 组首段，独立成组（组间 `|`）；单组超行宽时才组内压缩（cwd 保尾 / model 保后缀）。
  const lines: Seg[][][] = [[]];
  let used = 0;
  for (const g of groups) {
    let segs = g.full;
    if (groupWidth(segs) > maxSegW) segs = g.fit(maxSegW);
    const gap = used > 0 ? 1 : 0;
    if (used > 0 && used + gap + groupWidth(segs) > maxSegW) {
      lines.push([]);
      used = 0;
    }
    const row = lines[lines.length - 1]!;
    row.push(segs);
    used += (used > 0 ? 1 : 0) + groupWidth(segs);
  }
  return lines.map(renderRow);
}

/** 提示符左字符 = 上次提交所用模式的符号（normal > / shell $ / slash /；颜色随状态） */

/** 提示符左字符状态色：绿=成功等待 / 黄=进行中 / 红=失败等待 */
const STATUS_PROMPT_COLOR: Record<InputStatus, ColorName> = {
  success: "green",
  running: "yellow",
  failure: "red",
};
/** 提示符右字符 = 当前输入模式符号（normal > / shell $ / slash /；默认前景色，不着色） */
const MODE_SYMBOL: Record<InputMode, string> = {
  normal: ">",
  shell: "$",
  slash: "/",
};

/** 当前活跃会话的目标/todo/模式/策略/预设/运行中任务数（状态栏与整页高度共用口径） */
function activeSessionFields(state: AppState): {
  goal?: GoalState;
  todos?: TodoItemLike[];
  mode?: ModeState;
  policy?: "ask" | "never";
  preset?: string;
} {
  const goal = state.activeSessionId
    ? state.goalBySession[state.activeSessionId]
    : undefined;
  const todos = state.activeSessionId
    ? state.todoBySession[state.activeSessionId]
    : undefined;
  const mode = state.activeSessionId
    ? state.modeBySession[state.activeSessionId]
    : undefined;
  // C 阶段：当前活跃会话审批策略（approval/policy 事件 latest-wins；无=undefined 省略徽标）
  const policy = state.activeSessionId
    ? state.policyBySession[state.activeSessionId]
    : undefined;
  // P3：当前活跃会话 agent 预设（状态列 Mode 块显示当前值）
  const preset = state.activeSessionId
    ? state.presetBySession[state.activeSessionId]
    : undefined;
  return { goal, todos, mode, policy, preset };
}

/** 普通输入态（无模态面板）顶部三面板可视行高；PgUp/PgDn 整页滚动页大小 */
export function inputPanelHeights(state: AppState, size: Size): PanelHeights {
  const fullWidth = Math.max(1, size.cols);
  const statusLines = renderStatusLine(
    state.systemStatus,
    state.themeId,
    fullWidth,
    state.usage,
  );
  const topHeight = metricsFor(
    size,
    false,
    statusLines.length,
    1,
    state,
  ).topHeight;
  // 2026-09-27：无独立顶部边框行，内容行数 = topHeight（与 buildTopRegion 同口径）
  const contentTopH = Math.max(0, topHeight);
  const { activityH, dialogueH } = topPaneHeights(
    contentTopH,
    state.activityDivisor,
  );
  return { topHeight: contentTopH, activityH, dialogueH };
}

/** 状态栏上方分隔行（焦点四边框的底边）：按焦点面板分段着色 + 角字（└/┴/┘）；
 * 无焦点/模态态全边框色 `─`。左侧历史/活动区底边（activity 焦点亮、col0 左下角 └），
 * 右侧状态列底边（status 焦点亮、R 列右下角 ┘），D 列 ┴ 为共用角。 */
export function buildStatusSeparator(
  cols: number,
  statusColWidth: number,
  themeId: ThemeId,
  sepFocus: "none" | "status" | "activity",
): RenderLine {
  const D = cols - statusColWidth; // 分隔竖线列（历史区右缘/状态列左缘，旧 statusColWidth-1 的镜像）
  const R = cols - 1;
  const useLeftCorner = cols - statusColWidth >= 2; // 历史/活动区左缘框格存在
  const useRightFrame = statusColWidth >= 2; // 状态列右缘框列存在
  const fc = focusFrameColor(themeId);
  const seg = (n: number, ch: string, bright: boolean): string => {
    if (n <= 0) return "";
    const s = ch.repeat(n);
    return bright ? colorFor(themeId, fc)(s) : colorFor(themeId, "border")(s);
  };
  const leftW = Math.max(0, D - (useLeftCorner ? 1 : 0));
  const rightW = Math.max(0, R - D - 1);
  return {
    text:
      // col0：activity 焦点时为历史/活动区底角 └（接左缘框格），否则延续 `─`
      (D > 0
        ? useLeftCorner && sepFocus === "activity"
          ? colorFor(themeId, fc)("└")
          : colorFor(themeId, "border")(STATUS_TOP_SEPARATOR)
        : "") +
      seg(leftW, STATUS_TOP_SEPARATOR, sepFocus === "activity") +
      // D 列交点恒与水平实线相交（无焦点前景色 ┴ / 焦点亮 ┴），不再用点线
      colorFor(themeId, sepFocus === "none" ? "border" : fc)("┴") +
      seg(rightW, STATUS_TOP_SEPARATOR, sepFocus === "status") +
      // R 列（状态列右缘框列）：status 焦点右下角 ┘；无右缘框列（statusColWidth=1）时不输出
      (useRightFrame
        ? sepFocus === "status"
          ? colorFor(themeId, fc)("┘")
          : colorFor(themeId, "border")(STATUS_TOP_SEPARATOR)
        : ""),
  };
}

export function buildFrame(state: AppState, size: Size): RenderLine[] {
  const approval = state.approval;
  const showApproval = approval !== null;
  const picker = state.picker;
  const question = state.question;
  const history = state.history;
  const jobsPanel = state.jobsPanel;
  const statusPanel = state.statusPanel;
  // 顶部面板（对话/活动/状态列）只读当前活跃会话字段
  const { goal, todos, mode, policy, preset } = activeSessionFields(state);
  const fullWidth = Math.max(1, size.cols);
  // 状态区先算出行数，再让 metrics 以便压缩顶部区域（多行状态栏不溢出帧）
  // 按键提示区仅输入态存在（审批/问答/选择/历史面板自带按键提示），与输入区之间不画横线
  const normalInput =
    !showApproval &&
    !question &&
    !picker &&
    !statusPanel &&
    !history &&
    !jobsPanel;
  const statusLines = renderStatusLine(
    state.systemStatus,
    state.themeId,
    fullWidth,
    state.usage,
  );
  // 面板态/输入态共用固定交互区高度（见 metricsFor）；提示区仅输入态计入
  const metrics = metricsFor(
    size,
    !normalInput,
    statusLines.length,
    normalInput ? 1 : 0,
    state,
  );

  const topRegion = buildTopRegion(
    state,
    metrics.topHeight,
    metrics.statusColWidth,
    metrics.historyWidth,
    normalInput,
    goal,
    todos,
    state.jobs,
    state.statusColumnScroll,
    mode,
    policy,
    preset,
    state.permissionOptions,
    state.presetOptions,
    state.sessionTitle,
  );

  let footerLines: RenderLine[];
  // 审批/问答/模型选择/状态选项/任务面板已上移到流输出（活动区）窗口显示，
  // 底部交互区以空白占位（保持交互区高度稳定不跳变）；历史面板仍在底部渲染
  if (showApproval || question || picker || statusPanel || jobsPanel) {
    footerLines = Array.from({ length: metrics.footerHeight }, () => ({
      text: " ".repeat(fullWidth),
    }));
  } else if (history) {
    footerLines = renderHistoryPanel({
      history,
      height: metrics.footerHeight,
      width: fullWidth,
    });
  } else {
    // 两字符提示符：左字符 = 上次提交所用模式符号（MODE_SYMBOL[lastSubmitMode]，
    // 颜色随状态绿/黄/红），右字符 = 当前输入模式符号（MODE_SYMBOL[inputMode]，
    // 默认前景色不着色）；prompt 预先分段着色，renderTextInput 宽度按未着色文本计算。
    // 输入区为多行框：文本按宽度换行、顶部对齐，光标行超出区域时跟随。
    const prompt =
      colorFor(
        state.themeId,
        STATUS_PROMPT_COLOR[state.inputStatus],
      )(MODE_SYMBOL[state.lastSubmitMode] ?? ">") +
      (MODE_SYMBOL[state.inputMode] ?? ">") +
      " ";
    footerLines = renderTextInput(
      state.inputText,
      state.inputCursor,
      "Type a message...",
      fullWidth,
      prompt,
      undefined,
      metrics.footerHeight,
    );
  }

  // 按键提示区（独立区域，与输入区之间不画横线；前景色；窄终端按显示宽度截断）。
  // 末尾追加当前面板焦点标签（Tab 切换），标识可滚动的选中面板
  const hintLines: RenderLine[] = normalInput
    ? [
        {
          text: colorFor(
            state.themeId,
            "border",
          )(truncateToWidth(HINT_LINE, fullWidth)),
        },
      ]
    : [];

  // 分隔行（边框统一边框色 bright[0]：先纯文本截断再着色）。状态区上方与其余横线同为 `─`；
  // 焦点在底部为流输出/状态列时该行用亮色框（钩到面板底边）。
  const makeSep = (ch: string, color: ColorName = "border"): RenderLine => ({
    text: colorFor(
      state.themeId,
      color,
    )(truncateToWidth(ch.repeat(fullWidth), fullWidth)),
  });
  const statusSepFocus: "none" | "status" | "activity" = normalInput
    ? state.focusedPanel === "status"
      ? "status"
      : state.focusedPanel === "activity"
        ? "activity"
        : "none"
    : "none";
  return [
    ...topRegion,
    buildStatusSeparator(
      fullWidth,
      metrics.statusColWidth,
      state.themeId,
      statusSepFocus,
    ),
    ...statusLines,
    makeSep(SEPARATOR),
    ...footerLines,
    ...hintLines,
  ];
}
