// src/app/layout/frame-build.ts — 帧组装：分区、滚动回落、buildFrame 与焦点

import type {
  FrameFocus,
  FrameRow,
  FrameSegment,
} from "../../renderer/index.ts";
import type { FrameGeometry } from "./geometry.ts";
import { frameGeometry } from "./geometry.ts";
import { wrapHintLine } from "./frame-rows.ts";
import { MODE_SYMBOL } from "./run-virt.ts";
import { statusBarSeamCols } from "./status-line.ts";
import { buildTopRegion } from "./top-region.ts";
import type { FrameSection, Size } from "../../renderer/index.ts";
import type { AppState, PickerState } from "../state.ts";
import { hintLine } from "./hints.ts";
import { renderTextInput } from "../components/TextInput.ts";
import { pickerFilterColumn, pickerFilterText } from "../picker-filter.ts";
import type { ColorName } from "../../renderer/theme.ts";
import { noticeLinePresentation } from "./notice-line.ts";
import { h } from "./box.ts";
import { focusFrame } from "./focus-frame.ts";
import type { Box, PaneId, Rect } from "./box.ts";
import { SEPARATOR, STATUS_TOP_SEPARATOR, teeGlyph } from "./content-rules.ts";
import { seg, truncateToWidth, wrapLine } from "./primitives.ts";

// src/app/layout/frame-build.ts — 帧组装：分区、滚动回落、buildFrame 与焦点

/** 状态行上方分隔行（焦点四边框的底边）：按焦点面板分段着色 + 角字（└/┴/┘）；
 * 无焦点/模态态全边框色 `─`。左侧状态列底边（status 焦点亮、col0 左下角 └），
 * 右侧历史/回合区底边（activity 焦点亮、R 列右下角 ┘），D 列 ┴ 为共用角。
 * seamCols：状态行框线竖线列（0 基数组）——竖线在横线**下方**（状态行内），
 * 该列画 `┬` 与竖线相接（竖线自横线向下伸入状态行）；D 列/内部分隔列竖线在
 * 横线**上方**（topRegion），交点画 `┴`（竖线自横线向上顶住）。 */
export function buildStatusSeparator(
  geom: FrameGeometry,
  /** 状态行框线竖线列（0 基）：该列画 ┬ 与状态行竖线相接；缺省不画 */
  seamCols?: number[],
): FrameRow {
  // 焦点中性基线：状态区上方分隔行恒灰 `─`（col0 非 status 底角 └、D 列 ┴
  // border、右缘非 activity 右下角 ┘）；亮角字/亮边由 buildFrame 末尾 focusFrame
  // 按焦点态覆写（status 顶/底边、activity 底边 └┘、history 底边 ┴ 等）。
  // 焦点绘图不在此进行（亮角字/亮边由 buildFrame 末尾 focusFrame 统一覆写）。
  // 尺寸全部取自几何（分隔竖线列/两外缘框列/内部分隔列与帧内其它部分同源）
  const D = geom.dividerCol; // 分隔竖线列（状态列右缘/会话区左缘）
  const R = geom.cols - 1;
  const out: FrameSegment[] = [];
  const segN = (n: number): FrameSegment[] => {
    if (n <= 0) return [];
    return [{ text: STATUS_TOP_SEPARATOR.repeat(n), style: { fg: "border" } }];
  };
  // 内部分隔列（横向排列）只有落在 D 列右侧、R 列之前才是有效交点（否则回落不画）
  const inner =
    geom.innerDividerCol !== undefined &&
    geom.innerDividerCol > D &&
    geom.innerDividerCol <= R
      ? geom.innerDividerCol
      : undefined;
  // 交点列 → 字符：状态行框线竖线在横线**下方**（`┬`）；D 列/内部分隔列竖线在
  // 横线**上方**（`┴`）；同列两者都有 → `┼`（否则只按一侧选字会让另一侧竖线断开，
  // 如段分隔竖线恰好落在 D 列时状态列右边框出现空白）。
  const upCols = new Set<number>();
  if (inner !== undefined) upCols.add(inner);
  if (D >= 0 && D <= R) upCols.add(D);
  const downCols = new Set<number>();
  for (const c of seamCols ?? []) if (c >= 0 && c <= R) downCols.add(c);
  const cols = [...new Set([...upCols, ...downCols])].sort((a, b) => a - b);
  let cursor = 0;
  for (const col of cols) {
    if (col < cursor) continue;
    out.push(...segN(col - cursor));
    out.push({
      text: teeGlyph(upCols.has(col), downCols.has(col)),
      style: { fg: "border" },
    });
    cursor = col + 1;
  }
  out.push(...segN(Math.max(0, R - cursor)));
  // R 列（历史/回合区外缘框列）：灰 `─`（history/activity 焦点由 focusFrame 覆写 ┴/┘）；
  // 该列已被交点占用（cursor > R）时不再补，保证行宽恒为 cols
  if (cursor <= R)
    out.push({ text: STATUS_TOP_SEPARATOR, style: { fg: "border" } });
  return { segments: out };
}
/**
 * 帧构建回填的可滚动上限（行单位，均 ≥ 0）：会话区按**未折叠**全量行数计，
 * 回合区按可视行数计。App 用它把 scrollOffset/activityScroll 收敛到真实范围
 * （否则越界偏移会累积成"按了没反应"的假死，见 state.ts scrollBy 注释）。
 */
export interface FrameScrollReport {
  /** 会话区可滚动上限（总行数 − 可视行数） */
  dialogueMaxScroll: number;
  activityMaxScroll: number;
  /** 回合区段表（每段行数）与段键——位置 = 段键 + 段内行，App 据此换算按键位移 */
  activityCounts?: readonly number[];
  activityKeys?: readonly string[];
  /** 本帧实际渲染的回合区视口顶行号（段键解析 + clamp 后的结果） */
  activityTopIdx?: number;
  /** 会话区总行数（含占位行） */
  dialogueTotal: number;
  /** 会话区段表（每段行数）与段键——位置 = 段键 + 段内行，App 据此换算按键位移 */
  dialogueCounts: readonly number[];
  dialogueKeys: readonly string[];
  /** 本帧实际渲染的视口顶行号（段键解析 + clamp 后的结果） */
  dialogueTopIdx: number;
  /** 会话区可视行数（半屏位移基准，与帧同口径） */
  dialogueViewportH: number;
  /** 各用户块首行的绝对行号（PgUp / PgDn 跳转目标；含占位行偏移） */
  dialogueUserRows: readonly number[];
}

/**
 * 帧行带（**唯一来源**）：各区域屏幕行范围 + 焦点面板矩形。
 * `frameSections`（渲染层区间重写边界）与 `buildFrame` 的 `focusFrame` 调用共用本函数，
 * 取代原先「段表算一遍行数、buildFrame 再写一遍矩形字面量」的两处算术。
 * 行带顺序与 buildFrame 的拼接顺序一致——top（活动/会话区 + 状态列）→
 * status（状态行含其上下两条分隔行）→ footer（输入区 + 提示行）→ hint（按键提示行）。
 */
export function frameBands(geom: FrameGeometry): {
  bands: FrameSection[];
  rects: Map<PaneId, Rect>;
} {
  const top = Math.max(0, geom.contentTopH);
  // 状态段含上下分隔行（视觉同属状态区边界，且底分隔行的交点列随状态行变化）
  const status = geom.statusHeight + 2;
  const bands: FrameSection[] = [
    { startLine: 0, lineCount: top },
    { startLine: top, lineCount: status },
    { startLine: top + status, lineCount: geom.footerHeight },
  ];
  if (geom.hintHeight > 0) {
    bands.push({
      startLine: top + status + geom.footerHeight,
      lineCount: geom.hintHeight,
    });
  }
  // 焦点矩形：左缘 = 分隔竖线列 D（状态列右缘，与状态列共用该框线；隐藏状态列时
  // D = -1 → 左缘取 0，区域吃满整宽）、右缘 = R 列（区域外缘框列）——两 pane 正文
  // 恰在两缘之间（contentW 列）。矩形边界统一 right = x+w-1 / bottom = y+h-1。
  const underlineRow = Math.max(0, geom.titleRows - 1);
  const diaEnd = geom.activitySepRow; // 纵向=回合区分隔行；横向=会话区 底边下一行
  const regionX = Math.max(0, geom.dividerCol);
  const regionW = geom.cols - regionX;
  const rects: Map<PaneId, Rect> = new Map();
  if (geom.mode === "horizontal") {
    // 横向：会话区 在左、回合区 在右、两 pane 等高——顶=标题栏下划线行，
    // 底=状态区上方分隔行 contentTopH；内部分隔列 = history 右缘 / activity 左缘
    const divCol = geom.innerDividerCol ?? geom.cols - 1;
    const h = Math.max(1, top - underlineRow + 1);
    rects.set("history", {
      x: regionX,
      y: underlineRow,
      w: divCol - regionX + 1,
      h,
    });
    rects.set("activity", {
      x: divCol,
      y: underlineRow,
      w: geom.cols - divCol,
      h,
    });
  } else {
    // 纵向：history 顶=标题栏下划线行（titleRows>=2 才有下划线）、底=回合区分隔行
    rects.set("history", {
      x: regionX,
      y: underlineRow,
      w: regionW,
      h: Math.max(1, diaEnd - underlineRow + 1),
    });
    rects.set("activity", {
      x: regionX,
      y: diaEnd,
      w: regionW,
      h: Math.max(1, top - diaEnd + 1),
    });
  }
  // status 矩形：x=0（屏幕最左=状态列外缘）、右缘=D 列、顶=帧顶 rc0、底=状态区上方分隔行
  rects.set("status", {
    x: 0,
    y: 0,
    w: geom.statusColWidth,
    h: Math.max(1, top + 1),
  });
  return { bands, rects };
}

/**
 * 帧段表（纯函数，零排版开销）：行带范围，**不带语义**
 *（决策 6：渲染层只用它做「变化行区间」的切分边界，不读行带含义）。
 * 渲染层按段各自取变化行游程：多段同时变化时只重写各自段内的变化行，不跨越
 * 中间未变化的段（窗口偏移只影响 top 段内容）。
 */
export function frameSections(geom: FrameGeometry): FrameSection[] {
  return frameBands(geom).bands;
}

/** buildFrame 的可选回填输出（与 report 同模式：避免重复计算几何） */
export interface FrameBuildOutput {
  /** 帧段表（行带范围；渲染层区间重写用，见 frameSections） */
  sections?: FrameSection[];
  /** 输入焦点信息（3.1.3）：App 原样转发给 renderer，决定重写结束后光标收尾 */
  focus?: FrameFocus;
}

/**
 * 折行并让续行停靠 `hanging` 列（首行按整宽、续行按 width − hanging 重折后补空格）——
 * 与回合区 Box 的 hanging 语义一致（BACKLOG 3.1.1 的底部 notice 视图用）。
 */
function wrapWithHanging(
  text: string,
  width: number,
  hanging: number,
): string[] {
  const rows = wrapLine(text, width);
  if (rows.length <= 1 || hanging <= 0) return rows;
  const head = rows[0] ?? "";
  const contWidth = Math.max(1, width - hanging);
  const indent = " ".repeat(Math.min(hanging, Math.max(0, width - 1)));
  return [
    head,
    ...wrapLine(text.slice(head.length), contWidth).map((r) => indent + r),
  ];
}

/**
 * 问题交互态（问答 / 审批面板打开）时底部输入区改显 notice（BACKLOG 3.1.1）：
 * 取回合区 buffer 里最近的 `kind === "notice"` 行，按 footer 宽度折行（hanging 续行
 * 停靠，口径与回合区一致）后取**末尾** `rows` 行；不足补空行、行宽补齐整宽。
 * 不新增 buffer、无清空动作——面板关闭即切回输入视图，回合区留痕不动。
 */
function noticeFooterLines(
  state: AppState,
  width: number,
  rows: number,
): FrameRow[] {
  const wrapped: { text: string; fg?: ColorName }[] = [];
  // 无效键提示优先占用这一行（BACKLOG 3.3.8）：它就显示在用户输入区——屏幕左下、
  // 按键提示行正上方；下一次有效操作（清空 approvalHint）即切回 notice 视图。
  const hint = (state.approvalHint ?? "").trim();
  if (hint !== "") {
    for (const part of wrapLine(hint, width)) {
      wrapped.push({ text: part, fg: "yellow" });
    }
  } else {
    for (const line of state.local) {
      if (line.kind !== "notice") continue;
      const { fg, hanging } = noticeLinePresentation(line, false);
      const parts =
        hanging === undefined
          ? wrapLine(line.text, width)
          : wrapWithHanging(line.text, width, hanging);
      for (const part of parts) {
        wrapped.push(fg === undefined ? { text: part } : { text: part, fg });
      }
    }
  }
  const tail = wrapped.slice(Math.max(0, wrapped.length - rows));
  return Array.from({ length: rows }, (_, i) => {
    const item = tail[i];
    const text = (item?.text ?? "").padEnd(width, " ");
    return {
      segments: [
        item?.fg !== undefined ? seg(text, { fg: item.fg }) : seg(text),
      ],
    };
  });
}

/**
 * 模型选择面板态：底部输入区改显**筛选输入行**（用户裁定 —— 筛选词就落在用户输入区，
 * 面板内不占行）。焦点列 = provider / model 时显示 `筛选 <列>: <词>`（空词显示
 * placeholder，提示这一行可键入；caret 落在词尾，硬件光标随之）；effort 列不筛 →
 * 回落空白占位（输入区 + 提示行高度恒不变）。
 */
function pickerFooterLines(
  picker: PickerState,
  width: number,
  rows: number,
): FrameRow[] {
  const col = pickerFilterColumn(picker.phase);
  if (col === null) {
    return Array.from({ length: rows }, () => ({
      segments: [seg(" ".repeat(width))],
    }));
  }
  const text = pickerFilterText(picker);
  const prompt: FrameSegment[] = [seg(`筛选 ${col}: `)];
  return renderTextInput(
    text,
    Array.from(text).length, // caret 恒在词尾（筛选词只支持追加 / 删尾）
    "输入以筛选 (匹配度排序)",
    width,
    prompt,
    rows,
  );
}

export function buildFrame(
  state: AppState,
  size: Size,
  report?: FrameScrollReport,
  out?: FrameBuildOutput,
): FrameRow[] {
  // 尺寸唯一来源：几何一次算定（顶部内容行数/两 pane 宽高/排列/排队块占位/状态行行）
  const geom = frameGeometry(state, size);
  const {
    cols: fullWidth,
    contentTopH,
    statusColWidth,
    titleRows,
    innerDividerCol,
    modalOpen,
  } = geom;
  const topRegion = buildTopRegion(state, geom, report);

  let footerLines: FrameRow[];
  // 审批/问答/模型选择/状态选项/任务/历史会话面板 + 输入补全均上移到流输出（回合区）窗口显示；
  // 输入补全不占输入区（输入行与光标必须可见）；问题交互态（问答 / 审批）底部改显最近 notice
  // （BACKLOG 3.1.1）；模型选择面板底部改显**筛选输入行**（筛选词落在用户输入区）；
  // 其余模态面板保持空白占位（输入区 + 提示行高度稳定）。
  if (modalOpen) {
    footerLines =
      state.approval !== null || state.question !== null
        ? noticeFooterLines(state, fullWidth, geom.footerHeight)
        : state.picker !== null
          ? pickerFooterLines(state.picker, fullWidth, geom.footerHeight)
          : Array.from({ length: geom.footerHeight }, () => ({
              segments: [seg(" ".repeat(fullWidth))],
            }));
  } else {
    // 单字符提示符：当前输入模式符号（MODE_SYMBOL[inputMode]，默认前景色不着色）；
    // 上次命令结果/运行状态符号已移至**用户块首行**（见 userBlockSymbol）。
    // prompt 预先分段，renderTextInput 宽度按未着色文本计算。
    const prompt: FrameSegment[] = [
      seg(MODE_SYMBOL[state.inputMode] ?? ">"),
      seg(" "),
    ];
    footerLines = renderTextInput(
      state.inputText,
      state.inputCursor,
      "Type a message...",
      fullWidth,
      prompt,
      geom.footerHeight,
    );
  }

  // 按键提示行（独立区域，与输入区之间不画横线；正常前景色；超宽按 ` · ` 边界折成 2 行）。
  // 补全候选打开时改为补全键位（面板本身不再占回合区行放提示）；
  // 历史会话面板的按键提示也在此显示（面板标题行不再内嵌键位，避免回合区顶部堆提示）。
  // 行数 = hintRowsFor（与 frameGeometry 同源），当前状态文案由 hints.ts 统一提供。
  const hintLines: FrameRow[] = wrapHintLine(hintLine(state), fullWidth).map(
    (line) => ({ segments: [seg(line)] }),
  );

  // 分隔行（边框统一边框色：先纯文本截断再段化）。状态区上方与其余横线同为 `─`；
  // 焦点在底部为流输出/状态列时该行用亮色框（钩到面板底边）。
  // teeCols：状态行框线竖线列——竖线在横线**上方**（状态行内），该列画 `┴`
  // 与竖线相接（竖线自横线向上顶住；上横线交点 ┬ 在 buildStatusSeparator）。
  const makeSep = (
    ch: string,
    color: ColorName = "border",
    teeCols?: number[],
  ): FrameRow => {
    const valid = (teeCols ?? []).filter((c) => c > 0 && c < fullWidth - 1);
    if (valid.length === 0)
      return {
        segments: [
          seg(truncateToWidth(ch.repeat(fullWidth), fullWidth), { fg: color }),
        ],
      };
    const out: FrameSegment[] = [];
    let cursor = 0;
    for (const c of [...new Set(valid)].sort((a, b) => a - b)) {
      out.push(seg(ch.repeat(c - cursor), { fg: color }));
      out.push(seg("┴", { fg: color }));
      cursor = c + 1;
    }
    out.push(seg(ch.repeat(fullWidth - cursor), { fg: color }));
    return { segments: out };
  };
  // 状态行框线竖线列：上横线按首行竖线画交点 ┬（竖线自横线向下伸入状态行）、
  // 下横线按末行竖线画交点 ┴（竖线自横线向上顶住状态行），两端相接成格
  const topSeams = statusBarSeamCols(geom.statusLines[0]);
  const lastLine = geom.statusLines[geom.statusLines.length - 1];
  const bottomSeams = statusBarSeamCols(lastLine);
  const { rects } = frameBands(geom);
  const rows: FrameRow[] = [
    ...topRegion,
    buildStatusSeparator(geom, topSeams),
    ...geom.statusLines,
    makeSep(SEPARATOR, "border", bottomSeams),
    ...footerLines,
    ...hintLines,
  ];
  // 焦点框全局覆写：buildTopRegion/buildStatusSeparator 已产出焦点中性基线，
  // 末帧一次扫描按焦点分区矩形（帧坐标，right=x+w-1/bottom=y+h-1）覆写亮
  // 角字/边线（TUI/docs/DESIGN.md §8 / SPEC.md §8 唯一焦点框机制）。模态态（面板打开）
  // 焦点用 null 传入：面板占回合区时无焦点框高亮。
  // 焦点框上下文所需的标题栏下划线行号（矩形本身来自 frameBands）
  const underlineRow = Math.max(0, titleRows - 1);
  focusFrame(
    {
      // P7：状态列隐藏时不聚焦 status（宽 0 的焦点框会压掉内容首列）
      focusedPanel: modalOpen
        ? null
        : state.focusedPanel === "status" && statusColWidth === 0
          ? null
          : state.focusedPanel,
      // 结构行号：status 焦点 D 列竖线在下划线行保持灰（该处归属 history 顶边）
      titleUnderlineRow: underlineRow,
      // 横向排列：history 右缘/activity 左缘 = 内部分隔列（缺省走 D 列）
      innerDividerCol,
    },
    rects,
    rows,
  );
  // 帧段表回填（几何已算定，零额外开销）：渲染层按段切分变化区间
  if (out) out.sections = frameSections(geom);
  // 输入焦点回填（3.1.3）：渲染器据此决定「重写结束后是否把光标定位回输入位置」——
  // 输入态（!modalOpen）或面板内编辑焦点（BACKLOG 3.2.7：问答自定义回答编辑）允许
  // 显示光标：面板编辑态由帧内是否出现 caret 行判定（面板行 caret 只在编辑态产出），
  // 位置从帧内带 caret 的行直接取（唯一来源）
  const panelEditing = rows.some((r) => r.caret !== undefined);
  if (out) out.focus = frameFocus(rows, !modalOpen || panelEditing);
  return rows;
}

/**
 * 从帧行提取输入焦点信息（3.1.3）：caret 只出现在底部输入行（见 renderTextInput），
 * 扫描帧行取第一个带 caret 的行即为输入位置（**帧内 1 基行号 + 0 基列**）。
 * 面板态 / 无输入行时只回 inputFocus，渲染器据此保持光标隐藏。
 */
export function frameFocus(rows: FrameRow[], inputFocus: boolean): FrameFocus {
  for (let i = 0; i < rows.length; i++) {
    const col = rows[i]?.caret;
    if (col !== undefined) {
      return { inputFocus, caret: { row: i + 1, col } };
    }
  }
  return { inputFocus };
}
