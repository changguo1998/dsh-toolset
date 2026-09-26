// src/app/components/QuestionPrompt.ts — 问答面板渲染（纯函数）
//
// 以文本面板呈现 DSH 提问（与 ApprovalPrompt 同风格）：标题区 + 单题视图
// （描述窗 + 选项窗两段）。标题区（BACKLOG TUI#4）：单题 = 1 行（类型符号
// ○ / □ / △ 并入标题行），多题 = 2 行（最顶行按题序列出「题号 + 符号」）。
// 按键提示**不在面板内**，统一由底部提示区按状态显示（见 layout/hints.ts 的 questionHintLine）。
//
// 两窗模型（BACKLOG 3.2.1）：面板体按高度拆为
//   - **描述窗**：题干 + detail（plan-review 追加计划卡片分隔行）；
//   - **选项窗**：选项列表 + 自定义兜底项。
// 分配为动态制（BACKLOG 3.2.11）：描述窗上限 = maxBody 的 2/3（内容不足只占实际行数），
// 选项窗吃剩余行——两窗恒同屏，长题干 / 长 detail 不再把选项挤出可视区。
// Tab 在 `state.question.items[i].focus` 上切焦点窗（desc <-> options）：
// 焦点在选项窗时 ↑/↓ 移项（沿用原手感），焦点在描述窗时 ↑/↓ 逐行滚动题干。
// 选项窗起点始终保证「焦点项」可见；焦点在描述窗时改锚定「首个已标记项」
// （BACKLOG 3.2.1：已标记项不允许被滚出视野）。
//
// plan-review intent 以“计划卡片”突出显示 detail（决策卡片，approve 选项按
// intent.approve 标签识别，渲染上与普通选项一致、由用户在选项中选取）。
// “自定义回答”是固定在选项列表末尾的兜底项（无预设选项时列表仅此一项），
// 与普通选项一样用 ↑/↓ 高亮；高亮在其上时键入字符即输入自定义文本，此时
// 面板产出 caret（BACKLOG 3.2.7，见 questionCaretFor）。
// 选项行形态（BACKLOG 3.2.3 / 3.2.12）：首行 ` >✓ 1. 选项正文`（标记统一 `✓`，
// BACKLOG TUI#4），**解释另起一行**并按选项正文起点缩进，光标 `>` 与标记 `✓`
// 只出现在选项首行。
//
// 输出恰好 height 行；题干/detail/选项超出面板可用宽均按行 soft-wrap（题干/选项
// 续行按正文起点缩进、选项续行缩进 6 列更深（选项文字起点第 4 列 + 2），
// 便于辨认新选项起点；见 OPTION_CONT_INDENT）。

import type {
  FrameRow,
  FrameSegment,
  FrameStyle,
} from "../../renderer/index.ts";
import type { QuestionPanelState, QuestionPanelItem } from "../state.ts";
import type { Box, StyledText } from "../layout/box.ts";
import { v, styled } from "../layout/box.ts";
import { seg } from "../layout/primitives.ts";
import { windowStart } from "../layout/panel.ts";
import { fillBoxTree } from "../layout/fill.ts";
// 列宽口径与 fill / 渲染器 / markdown 同源（吃运行时宽度探针的覆盖表；BACKLOG TUI#4）
import { charWidth, displayWidth } from "../layout/markdown.ts";

/**
 * 选项续行缩进（6 列 = 选项首行前缀 ` >* ` 4 列 + 2 列阶梯差）。选项行未选中
 * 且光标不在其上时前缀全为空格、与 4 列续行缩进同形，长文本折行后无法辨认
 * 新选项从哪一行开始；加深到 6 列后续行缩进于选项文字起点（第 4 列）。
 * 面板可用宽不足 6 列时退回 4 列（见 buildQuestionPanelBox 的 contIndent）。
 */
const OPTION_CONT_INDENT = "      ";

/** 选项正文起点列（前缀 ` >* ` = 4 列）：解释行按此缩进（BACKLOG 3.2.3） */
const OPTION_DESC_INDENT = "    ";

/** 类型标识符号（BACKLOG TUI#4）：plan-review 视同审批；空心几何符号、均黄色 */
const SYM_PLAN = "△";
const SYM_MULTI = "□";
const SYM_SINGLE = "○";

/** 类型符号与标题文字之间的间隔（BACKLOG TUI#4 用户裁定：符号后 2 空格） */
const SYM_GAP = "  ";

/** 选项标记（BACKLOG TUI#4）：类型已由符号表达，标记不再区分单/多选，统一对勾 */
const OPTION_MARK = "✓";

/** 面板内光标位置（0 基行 + 0 基列；活动区列偏移由 layout 拼装时补上） */
export interface PanelCaret {
  row: number;
  col: number;
}

/** 面板行（文本 + 可选整行着色） */
interface PanelLine {
  text: string;
  color?: FrameStyle;
  /** 行首 1 列的滚动条 / 焦点条：字符与样式在窗口算定后回填（占原有缩进、不增宽） */
  bar?: { char: string; style: FrameStyle };
}

/** 问答面板排版结果：渲染 / caret / 滚动上界共用同一份计算（单一来源） */
interface QuestionLayout {
  title: StyledText;
  /** 多题时最顶行的「题号 + 类型符号」行（单题 = null：符号并入标题行；BACKLOG TUI#4） */
  symbolRow: StyledText | null;
  /** 标题区行数（单题 1 / 多题 2）：面板体 = height − headerRows */
  headerRows: number;
  body: PanelLine[];
  /** 面板内 0 基 caret 行（标题区占开头 headerRows 行）；无编辑焦点或不可见时为 null */
  caret: PanelCaret | null;
  /** 描述窗最大首行偏移（0 = 内容不足，无需滚动） */
  maxDescScroll: number;
}

/** 问答面板 Box 生成器（TUI/docs/DESIGN.md §7 / SPEC.md §7）：整棵 activity 内容树
 *  替换。标题行 + 描述窗 + 选项窗两段按高度分配，逐行产 styled 叶子（选项行选中绿 /
 *  未选中的光标行黄、无 markdown 解析）。按键提示不在面板内（见 layout/hints.ts）。 */
export function buildQuestionPanelBox(
  panel: QuestionPanelState,
  height: number,
  width: number,
): Box {
  const layout = layoutQuestionPanel(panel, height, width);
  const maxBody = Math.max(0, height - layout.headerRows);
  // body 行（着色取自排版结果：选项行含折行续行与解释行整块同色）
  const bodyLeaves = Array.from({ length: maxBody }, (_, i) => {
    const line = layout.body[i];
    if (!line) return styled([seg("")], { wrap: false });
    const segments: FrameSegment[] = [];
    if (line.bar) {
      // 行首 1 列 = 滚动条 / 焦点条（字符与样式已回填），其余文本按行色
      segments.push(seg(line.bar.char, line.bar.style));
      const rest = line.text.slice(1);
      if (rest !== "") {
        segments.push(line.color ? seg(rest, line.color) : seg(rest));
      }
    } else {
      segments.push(line.color ? seg(line.text, line.color) : seg(line.text));
    }
    return styled(segments, { wrap: false });
  });
  // 多题：顶部独立一行列出全部题的「题号 + 类型符号」（当前题黄、其余灰；BACKLOG TUI#4）
  return v([
    ...(layout.symbolRow ? [layout.symbolRow] : []),
    layout.title,
    ...bodyLeaves,
  ]);
}

/** 描述窗滚动上界（App 按键时算 max 进 action：state 层不知道折行宽度） */
export function maxDescScrollFor(
  panel: QuestionPanelState,
  height: number,
  width: number,
): number {
  return layoutQuestionPanel(panel, height, width).maxDescScroll;
}

/** 面板内编辑光标（BACKLOG 3.2.7）：焦点在「自定义回答」且该行在选项窗内时返回位置 */
export function questionCaretFor(
  panel: QuestionPanelState,
  height: number,
  width: number,
): PanelCaret | null {
  return layoutQuestionPanel(panel, height, width).caret;
}

/**
 * 面板排版（纯函数）：标题行 + 两窗可见行 + caret + 描述窗滚动上界。
 * 行数分配与窗口起点见文件头注释（BACKLOG 3.2.1）。
 */
function layoutQuestionPanel(
  panel: QuestionPanelState,
  height: number,
  width: number,
): QuestionLayout {
  // 面板可用宽：右侧只留 1 列（原为 4 列，人工验收反馈「内容行右侧留白太多」）
  const avail = Math.max(4, width - 2);
  // 标题区：单题 = 1 行（类型符号并入标题行）；多题 = 2 行（最顶行单独列出全部题符号）
  // ——BACKLOG TUI#4；按键提示移到底部提示区，不占面板行
  const total = panel.items.length;
  const headerRows = total > 1 ? 2 : 1;
  const maxBody = Math.max(0, height - headerRows);
  const item = panel.items[panel.itemIndex];
  // 选项行格式（BACKLOG 3.2.6 / 3.2.12）：` ${光标}${标记} ${编号}. ${内容}`
  //   - 编号宽度按「最大编号位数」取（含自定义兜底项）：1 位（≤9 项）或 2 位（≥10 项）
  //   - 内容起点 = 1(行首缩进) + 光标 + 标记 + 1(空格) + numW + `.` + 1(空格) = numW + 6
  const numW = String((item?.options.length ?? 0) + 1).length;
  const optTextStart = numW + 6;
  // 续行与选项解释一律缩进到内容起点（数字悬挂：续行不重复编号）；面板极窄时退回 4 列，
  // 避免缩进自身被折行（BACKLOG 3.2.1）
  const contIndent = avail > optTextStart ? " ".repeat(optTextStart) : "    ";
  const isPlan = item?.intent?.kind === "plan-review";
  const multi = item?.multiSelect ?? false;
  /** 焦点是否在描述窗（BACKLOG 3.2.8 修订：滚动条滑块着色与选项光标降色共用同一判据） */
  const descFocus = item?.focus === "desc";

  // 1) 描述窗内容：题干（含 header）+ detail（plan-review 追加计划卡片分隔行）
  const descRows: PanelLine[] = [];
  if (item) {
    // 描述窗内容：行首恒留 1 列占位（题干与 detail 同宽），该列在窗口算定后回填为
    // 滚动条 / 焦点条（见第 6 步）——占原有缩进、不增宽、不改折行
    const pushDesc = (text: string): void => {
      for (const r of wrapPrefixed(` ${text}`, avail, " ")) {
        descRows.push({ text: r });
      }
    };
    // 问题前正文（BACKLOG 3.2.10）：面板打开时记录的活动区正文（≤6 行），灰色置于描述窗
    // 顶部、随描述窗一起滚动；与题干之间留一个空行分隔（缺省/空串时不占行）
    const sourceText = (panel.source ?? "").trim();
    if (sourceText !== "") {
      for (const part of sourceText.split("\n")) {
        if (part.trim() === "") continue;
        for (const r of wrapByWidth(part, avail)) {
          // 醒目青色（BACKLOG 3.2.10 人工反馈：灰色太暗难辨认）
          descRows.push({ text: " " + r, color: { fg: "cyan" } });
        }
      }
      descRows.push({ text: "" });
    }
    pushDesc(`${item.header ? item.header + "：" : ""}${item.question}`);
    if (item.detail) {
      if (isPlan) pushDesc("-- 待审计划 --");
      for (const part of item.detail.split("\n")) {
        if (part === "") continue;
        pushDesc(part);
      }
      if (isPlan) pushDesc("--------------");
    }
  }

  // 2) 选项窗内容：每项首行含标记、解释另起一行（BACKLOG 3.2.3）；
  //    optEnd 记录每项（含末位自定义兜底项）在选项窗内的末行（窗口锚点与 caret 用）
  const optRows: PanelLine[] = [];
  const optEnd: number[] = [];
  /** 追加一个选项块：首行 ` >* 文本`（折行续行 6 列缩进），解释行缩进 4 列 */
  /** 选项行前缀：编号 + 光标 + 标记（编号 BACKLOG 3.2.6；光标/标记沿用原语义） */
  const optionLead = (idx: number, cursor: string, mark: string): string =>
    `${cursor}${mark} ${String(idx + 1).padStart(numW)}.`;

  const pushOption = (
    idx: number,
    lead: string,
    text: string,
    desc: string | undefined,
    color: FrameStyle | undefined,
  ): void => {
    for (const r of wrapPrefixed(` ${lead} ${text}`, avail, contIndent)) {
      optRows.push({ text: r, color });
    }
    if (desc) {
      // 解释另起一行，且与选项内容左对齐（BACKLOG 3.2.12）
      const w = Math.max(1, avail - contIndent.length);
      for (const r of wrapByWidth(desc, w)) {
        optRows.push({ text: contIndent + r, color });
      }
    }
    optEnd[idx] = optRows.length - 1;
  };
  if (item) {
    // 选项窗聚焦判据：焦点在描述窗时选项光标降色（不再着黄），避免与描述窗焦点条同时
    // 出现两个「焦点黄」（人工验收反馈「两个黄色标记分不清焦点」）
    const optionFocused = item.focus !== "desc";
    for (let i = 0; i < item.options.length; i++) {
      const opt = item.options[i]!;
      if (opt === undefined) break;
      const selected = item.selected.includes(opt.label);
      const cursor = item.optionIndex === i ? ">" : " ";
      const mark = selected ? OPTION_MARK : " ";
      pushOption(
        i,
        optionLead(i, cursor, mark),
        opt.label,
        opt.description,
        // 已标记选中绿优先，未标记的光标行黄（对齐 ModelPicker；失焦时不着色）
        selected
          ? { fg: "green" }
          : item.optionIndex === i && optionFocused
            ? { fg: "yellow" }
            : undefined,
      );
    }
    const ci = item.options.length;
    const cursor = item.optionIndex === ci ? ">" : " ";
    const mark = item.custom === "" ? " " : OPTION_MARK;
    pushOption(
      ci,
      optionLead(ci, cursor, mark),
      `自定义回答${item.custom === "" ? "" : "：" + item.custom}`,
      undefined,
      item.custom !== ""
        ? { fg: "green" }
        : item.optionIndex === ci && optionFocused
          ? { fg: "yellow" }
          : undefined,
    );
  }

  // 3) 两窗高度分配（BACKLOG 3.2.11 规则）：描述窗上限 = 面板体 2/3（向下取整，至少 1 行），
  //    内容不足时只占实际行数——两窗紧邻、中间不留大段空白，空行只落在活动区下方
  const descMaxRows = Math.max(1, Math.floor((maxBody * 2) / 3));

  // 4) 描述窗起点：偏移按**固定上限** descMaxRows clamp（不随内容抖动，到底后反向按键即时
  //    响应）；可见行数按实际内容与面板高收敛；选项窗吃剩余行且不设上限——两段合计溢出时
  //    由选项窗先滚动（描述窗仅在自身超过 2/3 时才滚动）
  const maxDescScroll = Math.max(0, descRows.length - descMaxRows);
  const descStart = Math.max(0, Math.min(item?.descScroll ?? 0, maxDescScroll));
  const descVisible = Math.min(
    descMaxRows,
    Math.max(0, descRows.length - descStart),
    maxBody,
  );
  const optWindowRows = Math.min(
    optRows.length,
    Math.max(0, maxBody - descVisible),
  );

  // 5) 选项窗起点：锚定「有编辑焦点的自定义项 > 焦点项」（焦点在描述窗时退到首个
  //    已标记项），保证焦点项与已标记项都不被滚出视野（BACKLOG 3.2.1）
  const customIdx = item?.options.length ?? 0;
  let anchor = item?.optionIndex ?? 0;
  if (item && item.focus === "desc" && item.optionIndex !== customIdx) {
    const selIdx = item.options.findIndex((o) =>
      item.selected.includes(o.label),
    );
    if (selIdx >= 0) anchor = selIdx;
  }
  const optStartIdx = windowStart(
    optRows.length,
    optWindowRows,
    optEnd[anchor] ?? 0,
    "tail",
  );

  // 6) 可见 body：描述窗（行首 1 列回填滚动条）+ 选项窗紧邻（不足由 build 补空行）
  //    滚动条（BACKLOG 3.2.8 修订）：轨道 = 描述窗可见行，滑块长度按「可见 / 总行数」比例、
  //    位置按当前偏移比例；聚焦描述窗时滑块黄（兼作焦点指示，滚动后仍在），失焦时整条转灰。
  //    内容不足一屏时不画滚动条，改回「聚焦 = 整列黄 ┃、失焦 = 空格」的纯焦点指示。
  const descScrolled = descRows.length > descVisible;
  const thumbLen = descScrolled
    ? Math.max(1, Math.round((descVisible * descVisible) / descRows.length))
    : descVisible;
  const thumbPos = descScrolled
    ? Math.round(
        (descStart * (descVisible - thumbLen)) /
          Math.max(1, descRows.length - descVisible),
      )
    : 0;
  const descBody: PanelLine[] = descRows
    .slice(descStart, descStart + descVisible)
    .map((line, i) => {
      if (!descScrolled) {
        return descFocus
          ? { ...line, bar: { char: "┃", style: { fg: "yellow" } } }
          : line;
      }
      const onThumb = i >= thumbPos && i < thumbPos + thumbLen;
      return {
        ...line,
        bar: onThumb
          ? {
              char: "┃",
              style: descFocus ? { fg: "yellow" } : { fg: "border" },
            }
          : { char: "│", style: { fg: "border" } },
      };
    });
  const body: PanelLine[] = [
    ...descBody,
    ...optRows.slice(optStartIdx, optStartIdx + optWindowRows),
  ];

  // 7) caret（BACKLOG 3.2.7）：编辑焦点在自定义兜底项、且该行落在选项窗内时给出
  //    文本末尾位置（列 = 末行显示宽度，0 基）
  let caret: PanelCaret | null = null;
  if (item && item.optionIndex === customIdx) {
    const rowInWindow = (optEnd[customIdx] ?? -1) - optStartIdx;
    if (rowInWindow >= 0 && rowInWindow < optWindowRows) {
      const last = optRows[optEnd[customIdx]!];
      if (last) {
        caret = {
          row: headerRows + descVisible + rowInWindow,
          col: displayWidth(last.text),
        };
      }
    }
  }

  // 8) 标题区（BACKLOG TUI#4）：类型标识符号化——单选 ○ / 多选 □ / 审批 △（均黄）；
  //    题号导航移除。单题：符号并入标题行（` △ ○  请回答`）；多题：最顶行单独列符号
  const typeSym = typeSymOf(item);
  const head = isPlan ? "计划审批" : "请回答";
  const title = styled(
    [
      seg(" △ "), // 状态标记用推荐符号 △（symbols.ts 把 U+26A0 归一到 △，BACKLOG 3.2.9）
      ...(headerRows === 1
        ? [seg(typeSym, { fg: "yellow" }), seg(SYM_GAP)]
        : []),
      seg(head),
    ],
    { wrap: false },
  );
  const symbolRow =
    headerRows === 2
      ? buildSymbolRow(panel.items, panel.itemIndex, avail)
      : null;
  return { title, symbolRow, headerRows, body, caret, maxDescScroll };
}

/** 单题类型符号（BACKLOG TUI#4）：plan-review 视同审批 */
function typeSymOf(item: QuestionPanelItem | undefined): string {
  if (item?.intent?.kind === "plan-review") return SYM_PLAN;
  return item?.multiSelect ? SYM_MULTI : SYM_SINGLE;
}

/** 多题符号行（BACKLOG TUI#4）：` 1○ 2□ 3△`——题号灰、当前题符号黄、其余灰；
 *  超出可用宽即截断并以灰 `…` 收尾（恒占 1 行、不折行）。width = 面板可用宽。 */
function buildSymbolRow(
  items: readonly QuestionPanelItem[],
  active: number,
  width: number,
): StyledText {
  const parts: FrameSegment[] = [];
  let used = 0;
  const push = (text: string, style?: FrameStyle): void => {
    parts.push(style === undefined ? seg(text) : seg(text, style));
    used += displayWidth(text);
  };
  push(" "); // 行首 1 列缩进（与面板其它行同口径）
  let truncated = false;
  for (let i = 0; i < items.length; i++) {
    const sym = typeSymOf(items[i]);
    const gap = i === 0 ? "" : " ";
    // 为截断标记 `…` 预留 1 列
    if (used + displayWidth(gap) + displayWidth(`${i + 1}${sym}`) + 1 > width) {
      truncated = true;
      break;
    }
    push(gap);
    push(String(i + 1), { fg: "gray" });
    push(sym, { fg: i === active ? "yellow" : "gray" });
  }
  if (truncated) push("…", { fg: "gray" });
  return styled(parts, { wrap: false });
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

/** 按列适配宽度做简单换行（与 layout.wrapLine 语义一致，避免循环依赖；
 *  列宽走 `charWidth`——与 fill / 渲染器 / 宽度探针同源，BACKLOG TUI#4） */
function wrapByWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
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
