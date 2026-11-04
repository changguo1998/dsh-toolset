// TUI/src/app/layout/top-region.ts — 顶部区域装配：状态列 + 会话区 + 回合区面板选型

import type { FrameRow, FrameSegment } from "../../renderer/index.ts";
import type { FrameGeometry } from "./geometry.ts";
import type { FrameScrollReport } from "./frame-build.ts";
import { panelShownInActivity } from "./geometry.ts";
import type { Viewport } from "./frame-rows.ts";
import { DIALOGUE_MORE, FRAME_LEFT_COLS } from "./frame-rows.ts";
import { renderStatusColumn, titleBarSegments } from "./title-bar.ts";
import { activeSessionFields, userBlockSymbolResolver } from "./run-virt.ts";
import type { AppState } from "../state.ts";
import {
  activeGoalSnapshot,
  goalActivationDisplay,
  currentProjectCwd,
  historyVisibleRecords,
} from "../state.ts";
import { buildModelPickerBox } from "../components/ModelPicker.ts";
import { buildHistoryPanelBox } from "../components/HistoryPanel.ts";
import {
  buildQuestionPanelBox,
  questionCaretFor,
} from "../components/QuestionPrompt.ts";
import { buildJobsPanelBox } from "../components/JobsPanel.ts";
import { buildCommandListPanelBox } from "../components/CommandListPanel.ts";
import { buildStatusPanelBox } from "../components/StatusPanel.ts";
import { buildCompletionBox } from "../components/CommandCompletion.ts";
import type { ColorName } from "../../renderer/theme.ts";
import { buildApprovalBox } from "../components/ApprovalPrompt.ts";
import { pipelineContent, sectionsOf } from "./pipeline/frame.ts";
import { MARKER_KEY, createLineTable, indexOfTop } from "./pipeline/rows.ts";
import { layout } from "./measure.ts";
import { fillToList } from "./fill.ts";
import { focusColor } from "./focus-frame.ts";
import { dividerGlyph, gridRole, rightEdgeGlyph } from "./grid.ts";
import type { ContentRow } from "./fill.ts";
import { displayWidth } from "./markdown.ts";
import {
  ACTIVITY_SEPARATOR,
  NOTICE_TONE_COLOR,
  SEPARATOR,
  TURN_SEPARATOR_CHAR,
  TOOL_INTERRUPTED_GLYPH,
  TOOL_PENDING_GLYPH,
  TOOL_PENDING_GLYPH_ALT,
} from "./content-rules.ts";
import { rowWidth2, seg, truncateSegs } from "./primitives.ts";

// TUI/src/app/layout/top-region.ts — 顶部区域装配：状态列 + 会话区 + 回合区面板选型

/** 顶部区域：最左详细状态列、右侧对话历史+回合区（可独立滚动）；焦点面板四边框亮色 */
/** 当前激活的回合区面板 Box（approval/question/picker/statusPanel/jobs/
 * history/completion 多分支选型；无面板返回 null——回合区显示瞬态行）。
 * 各面板组件导出 buildXxxBox（Box 生成器），这里统一选型。 */
function buildActivePanelBox(
  state: AppState,
  activityH: number,
  contentW: number,
): import("./box.ts").Box | null {
  if (state.approval)
    return buildApprovalBox(
      state.approval,
      activityH,
      contentW,
      state.approvalScroll,
      // 选项焦点 + 倒计时 + 焦点窗（BACKLOG 3.2.4 / 3.2.5 / 3.3.4）
      {
        focus: state.approvalFocus,
        deadline: state.approvalDeadline,
        window: state.approvalWindow,
      },
    );
  if (state.question)
    return buildQuestionPanelBox(state.question, activityH, contentW);
  if (state.picker)
    return buildModelPickerBox({
      picker: state.picker,
      height: activityH,
      width: contentW,
    });
  if (state.statusPanel)
    return buildStatusPanelBox(state.statusPanel, activityH, contentW);
  if (state.jobsPanel)
    return buildJobsPanelBox(
      state.jobs,
      state.jobsPanel.index,
      activityH,
      contentW,
    );
  if (state.commandPanel)
    return buildCommandListPanelBox(state.commandPanel, activityH, contentW);
  if (state.history)
    return buildHistoryPanelBox({
      history: state.history,
      records: historyVisibleRecords(state),
      totalCount: state.history.records.length,
      projectCwd: currentProjectCwd(state),
      height: activityH,
      width: contentW,
    });
  // 补全面板（两类共用回合区窗口：命令候选 / 文件提及候选，按 kind 分发渲染）
  if (state.completion)
    return buildCompletionBox({
      completion: state.completion,
      height: activityH,
      width: contentW,
    });
  return null;
}

/** 面板 Box 生成器 → 回合区 ContentRow[]（measure/allocate/fill 统一摊平） */
function fillPanelBox(
  box: import("./box.ts").Box,
  height: number,
  width: number,
): ContentRow[] {
  const w = Math.max(1, width);
  const rects = layout(box, w);
  const rect = rects.get(box) ?? { x: 0, y: 0, w, h: Math.max(1, height) };
  return fillToList({ viewportWidth: w }, box, rect, rects);
}

/**
 * 顶部区域（标题栏 + 历史/回合区 + 状态列）构帧。
 * 尺寸全部取自 geom（FrameGeometry，唯一来源）；state 只用于内容与主题。
 *
 * @param report 回填两 pane 可滚动上限与会话区滚动几何（App 用于收敛偏移）
 */
/**
 * 工具名字行的**相位标记**（工具块改版决策 06）：名字行由管线按**稳定字形**排版并进行缓存
 * （随秒变化的东西不能进缓存，否则命中即冻结），故相位改写放在帧层——只整格改写首列、
 * 不重排、不新建定时器（随既有 1s ticker 的重绘节律走）：
 * - 本回合活跃（`agentStatus ≠ idle` 或 `inputStatus = running`）→ `●` / `○` 按 1 toggle/s 相位，黄
 * - 已不活跃且该调用无结果 → `■`，灰
 * - `✓` / `✗`（管线按配对结果写死并着色）原样不动
 */
function markToolNameRows(
  rows: readonly ContentRow[],
  state: AppState,
): readonly ContentRow[] {
  const active =
    state.agentStatus !== "idle" || state.inputStatus === "running";
  const phase = Math.floor(Date.now() / 1000) % 2;
  let changed = false;
  const out = rows.map((row) => {
    if (row.kind !== "tool-name") return row;
    // 字形段可能在左缘竖线之后（工具行挂会话 chrome ┃）——按段定位，不假设首段
    const idx = row.segments.findIndex((s) => s.text[0] === TOOL_PENDING_GLYPH);
    if (idx < 0) return row;
    const first = row.segments[idx]!;
    const glyph = active
      ? phase === 0
        ? TOOL_PENDING_GLYPH
        : TOOL_PENDING_GLYPH_ALT
      : TOOL_INTERRUPTED_GLYPH;
    const fg: ColorName = active ? "yellow" : "gray";
    const segments = [...row.segments];
    changed = true;
    segments[idx] = {
      ...first,
      text: glyph + first.text.slice(1),
      style: { ...first.style, fg },
    };
    return { ...row, segments };
  });
  return changed ? out : rows;
}

export function buildTopRegion(
  state: AppState,
  geom: FrameGeometry,
  report?: FrameScrollReport,
): FrameRow[] {
  const {
    contentTopH,
    statusColWidth,
    contentW,
    titleRows,
    activityH,
    dialogueH,
    dialogueW,
    activityW,
    dialogueTextW,
    activityTextW,
    queuedRows,
    viewportH,
  } = geom;
  // 状态列在最左、历史/回合区在右（自左至右：状态列 ‖ 会话区 ‖ 回合区）：
  // 左缘框格 = 状态列左缘；右缘框列 = 历史/回合区右缘（均非聚焦/模态态留空白占位）
  const useLeftFrame = geom.leftFrame;
  const useRightFrame = geom.rightFrame;
  // 当前活跃会话字段（goal 历史/todo/模式/策略/预设）：状态列与状态行共用口径
  const { goals, todos, mode, policy, preset } = activeSessionFields(state);
  // 区域顶部为独立标题栏（会话标题行 + 实线下划线）。
  // 排列方式与两 pane 宽高在 frameGeometry 内一次算定（纵向：标题栏行数由会话区
  // 承担；横向：两 pane 等高，中间 1 列内部分隔竖线）。
  const horizontal = geom.mode === "horizontal";
  const diaStart = titleRows; // 内容行中会话区起点（标题栏之后）
  // #5 窗口标题：Session / Turn / Tool 三窗左上角写名字。Turn 与 Tool 共用下半区标题位
  // （谁在显示写谁）：回合区内显示交互面板（问答 / 审批 / 模型选择 / 命令面板）时写 Tool。
  // 配色：未聚焦 = 边框色，聚焦 = 焦点色；放不下则整条省略（不折行、不占内容列）。
  const sessionFocused = !geom.modalOpen && state.focusedPanel === "history";
  const lowerFocused = !geom.modalOpen && state.focusedPanel === "activity";
  const lowerTitle = panelShownInActivity(state) ? "Tool" : "Turn";
  /** 标题行：`-- <title> --` + 边框线补满；宽度放不下（标题后不足 1 列线）返回 null（省略） */
  const titledRow = (
    width: number,
    title: string,
    focused: boolean,
  ): FrameSegment[] | null => {
    // 用**边框线字形**包夹标题（`── Session ──`），与既有横线同族、连成一体
    const label = `── ${title} ──`;
    const w = displayWidth(label);
    if (w + 1 > width) return null;
    return [
      seg(label, { fg: focused ? focusColor() : "border" }),
      seg(SEPARATOR.repeat(width - w), { fg: "border" }),
    ];
  };
  const diaEnd = geom.activitySepRow; // 回合区分隔行（横向无分隔行，此值 = 会话区 底边下一行）
  // 内容来源**唯一**：节缓存 → box → pane → 行（六步流水线）。
  // App 注入节缓存（`state.pipeline`）；测试 / 嵌入用法未注入时按 `state.local` 重放一份
  // （按缓冲身份 memo —— 重放只在内容整体替换后发生）。
  const activityWidth = horizontal ? activityTextW : dialogueTextW;
  const built = pipelineContent(sectionsOf(state), {
    dialogueTextW,
    activityTextW: activityWidth,
    windowGroups: state.windowGroups,
    userSym: userBlockSymbolResolver(state),
    render: {
      gutter: state.messageGutter,
      // 回合区六开关（SPEC §6.8）：/collapse 管压缩（按类压 1 行）、/verbose 管显示（按类显隐）
      activityCompact: state.activityCompact,
      activityShow: state.activityShow,
      width: dialogueTextW,
      activityWidth,
    },
  });
  const { dialogue, activity: activityRaw } = built;
  // 工具名字行的在飞相位标记（决策 06）：帧层整格改写首列，见 markToolNameRows
  const activity = markToolNameRows(activityRaw, state);
  // 顶部占位行（line = -1）：窗口未覆盖最旧内容时提示更早回复已折叠
  const markerRow: ContentRow | null =
    built.dropped > 0
      ? {
          segments: [seg(DIALOGUE_MORE, { fg: NOTICE_TONE_COLOR.log })],
          kind: "plain",
          indent: 0,
        }
      : null;
  const dialogueRows: ContentRow[] = markerRow
    ? [markerRow, ...dialogue]
    : dialogue;
  // ── 定位（第 ⑤ 步）：视口顶 = 段键 + 段内行（`state.dialogueTop`；null = 贴底）──
  // 段 = 占位行（若有）+ 会话区各 pane 项。位置按段键表达 ⇒ 上方插入段（扩窗纳入更早回合）
  // 时同一内容留在原处；宽度变化时按段键重定位到同一段。视口高 = viewportH（会话区 高
  // 扣掉底部排队块占位）——滚动上限与定位换算同此口径。
  const segCounts = markerRow
    ? [1, ...built.dialogueCounts]
    : [...built.dialogueCounts];
  const segKeys = markerRow
    ? [MARKER_KEY, ...built.dialogueKeys]
    : [...built.dialogueKeys];
  const segTable = createLineTable(segCounts);
  const maxTop = Math.max(0, dialogueRows.length - viewportH);
  const topIdx = indexOfTop(
    segTable,
    segKeys,
    state.dialogueTop,
    state.scrollOffset,
    maxTop,
  );
  const vp: Viewport = {
    start: topIdx,
    end: Math.min(dialogueRows.length, topIdx + viewportH),
  };
  // 内容不足一屏时**底部对齐**（与回合区 `topPad` 同口径）：历史从 pane 底部往上长，空白留在
  // 上方。只影响行放置——视口 / 段表 / 报告字段一律不变（内容超视口时补白恒为 0，逐字节同现状）。
  // 按**视口内实有行数**（`vp.end - vp.start`）算而不是内容总长：滚动中（`topIdx > 0`）时补白
  // 必须为 0，否则会少显示 topIdx 行（滚动窗口与贴底补白是互斥的两种状态）。
  const dialoguePadTop = Math.max(0, viewportH - (vp.end - vp.start));
  // 回填段表与视口信息：App 用它把按键换算成新的视口顶、并同步 state
  if (report) {
    report.dialogueMaxScroll = maxTop;
    report.dialogueTotal = dialogueRows.length;
    report.dialogueCounts = segCounts;
    report.dialogueKeys = segKeys;
    report.dialogueTopIdx = topIdx;
    report.dialogueViewportH = viewportH;
    report.dialogueUserRows = markerRow
      ? built.dialogueUserRows.map((row) => row + 1)
      : [...built.dialogueUserRows];
  }

  // 状态列（最左）：内容行只到**正文宽**；截断 / 补白 / 分隔竖线 / 外缘框格由本函数构图。
  // P7：垂直状态列隐藏（Ctrl+S）时不构建内容（宽度 0，渲染侧也不拼该段）
  const showStatusCol = statusColWidth > 0;
  // 状态列正文宽 = statusColWidth − 外缘框格(1) − 分隔竖线(1)：内容层排版宽与拼帧层
  // 截断/补白宽**同源**（多算一列会把恰好拼满的行截掉末字符，少算一列会早折行）
  const statusBodyW = Math.max(
    0,
    statusColWidth - 1 - (useLeftFrame ? FRAME_LEFT_COLS : 0),
  );
  const statusCells: ContentRow[] = !showStatusCol
    ? []
    : renderStatusColumn(
        goals,
        todos,
        state.jobs,
        state.statusColumnScroll,
        contentTopH,
        statusBodyW,
        // TUI#39：Agents 块数据（当前活跃会话切片；无数据时该块整块省略）
        state.activeSessionId
          ? state.agentsBySession[state.activeSessionId]
          : undefined,
        // goal 自动续轮开关（⟳；进程本地态，仅 active 相位有值）
        goalActivationDisplay(state, state.activeSessionId ?? undefined),
        // BACKLOG #1：Agents 块前导符号的闪烁相位来源（虚拟 token 累计）
        state.runVirt.tokens,
        // 条目 30：goal 进度（当前轮取 goal 条目、上限取快照——两者本就在 state 上，无需适配层改动）
        state.activeSessionId
          ? {
              ...(state.goalBySession[state.activeSessionId]?.[0]
                ?.roundsStarted === undefined
                ? {}
                : {
                    started:
                      state.goalBySession[state.activeSessionId]?.[0]
                        ?.roundsStarted,
                  }),
              ...(activeGoalSnapshot(state, state.activeSessionId)
                ?.maxGoalRounds === undefined
                ? {}
                : {
                    max: activeGoalSnapshot(state, state.activeSessionId)
                      ?.maxGoalRounds,
                  }),
            }
          : undefined,
      );

  // 边框构图参数：分隔竖线列 = statusColWidth-1（状态列右缘/会话区左缘，
  // 为旧 historyWidth 的镜像）；col0 左缘框格属状态列，
  // 右缘框列 R 属历史/回合区。顶部边框行占 index 0，标题栏紧随其后，
  // 回合区分隔行自然位于 diaEnd 后一行。
  // #4 起焦点态不再影响顶部构图：状态列不因聚焦自画顶边、history/activity 同样只由
  // focusFrame 改既有框线颜色（无布局差异）
  // 焦点中性基线：回合区分隔线 / 分隔竖线 / 左缘框格 / 右缘框列全部以灰
  // 边框色或空白占位产出；亮角字/亮边由 buildFrame 末尾的 focusFrame
  // 按焦点态覆写（TUI/docs/DESIGN.md §8，唯一焦点框机制）。
  const sepSegments = (): FrameSegment[] => [
    {
      text: ACTIVITY_SEPARATOR.repeat(Math.max(1, contentW)),
      style: { fg: "border" },
    },
  ];
  const rows: FrameRow[] = [];
  // 右缘边框列保留格（历史/回合区外缘）：空白占位由各行拼装，字形由 grid.ts 基线写
  // 内容行（0..contentTopH-1）：标题栏 → 会话区 → 回合区分隔 → 回合区。
  // 中间分隔竖线（状态列右缘/会话区左缘）随焦点面板只亮其垂直边界：
  // status=全行、history=仅会话区、activity=仅分隔行+回合区；模态态全回流边框色。
  const actAllLen = activity.length;
  const actMaxOffset = Math.max(0, actAllLen - activityH);
  if (report) report.activityMaxScroll = actMaxOffset;
  // 回合区视口改用「节键 + 行偏移」（与会话区同口径）：`activityTop`(顶键+行)≠null 时日
  // 据此定位、位置按内容段身份表达（上方插段不动画面）；null = 跟随底部。`activityScroll`
  // 作段键失配时的回落偏移（距底）。
  const actCounts = [...built.activityCounts];
  const actKeys = [...built.activityKeys];
  const actTable = createLineTable(actCounts);
  // `activityTop`(节键+行) 非 null → 按段键解析定位（扩窗不动画面，滑动时重设顶键）；
  // null = 跟随底部，沿用原「距底行数切片」口径（`activityScroll`）。
  const actTopIdx =
    state.activityTop === null
      ? actMaxOffset - Math.min(state.activityScroll, actMaxOffset)
      : indexOfTop(
          actTable,
          actKeys,
          state.activityTop,
          state.activityScroll,
          actMaxOffset,
        );
  const act = activity.slice(actTopIdx, actTopIdx + activityH);
  if (report) {
    report.activityTopIdx = actTopIdx;
    report.activityKeys = actKeys;
    report.activityCounts = actCounts;
  }
  // 内容不足一屏时底部对齐（两种排列一致）：流从 pane 底部往上长，最新一行贴 pane 底边，
  // 逐渐填满整块 pane 后才开始折叠最早内容——折叠点恒为「pane 高」而不是「一半」
  const topPad = activityH - act.length;
  // 「有问题交互」面板（审批/问答/模型选择）显示位置=流输出（回合区）窗口顶部：
  // 底部两行（输入区 + 提示行）不再承载（footer 空白占位保持输入区 + 提示行高度稳定）；面板占满回合区可视
  // 行，回合区瞬态行（thinking/tool/notice）在面板存在时本帧让位
  // 回合区面板 Box 生成器统一入口（buildActivePanelBox 多分支选型）
  const activeBox = buildActivePanelBox(state, activityH, activityTextW);
  const modalPanel: ContentRow[] = activeBox
    ? fillPanelBox(activeBox, activityH, activityTextW)
    : [];
  // 面板内编辑光标（BACKLOG 3.2.7）：仅问答面板的「自定义回答」编辑态产出；行号为
  // 面板内 0 基行（与回合区行号同口径），拼帧时按回合区列偏移写入对应帧行
  const panelCaret =
    state.question !== null && modalPanel.length > 0
      ? questionCaretFor(state.question, activityH, activityTextW)
      : null;
  // 分隔竖线列 / 右缘框列的**字形**由 grid.ts 按行角色写（焦点中性基线），此处只留
  // 等宽空白占位；亮角字/亮边仍由 buildFrame 末尾的 focusFrame 覆写（DESIGN §8）。
  // 段数组补齐到定宽（横向两 pane 各自补齐，分隔竖线恒落在各自右边界）
  const padTo = (
    segs: FrameSegment[],
    w: number,
    fill = " ",
  ): FrameSegment[] => {
    const used = rowWidth2(segs);
    return used < w ? [...segs, seg(fill.repeat(w - used))] : [...segs];
  };
  /** 会话区 内容行（越界或排队块行 → undefined；排队块不属回合分隔线） */
  const dialogueRowAt = (rr: number): ContentRow | undefined =>
    rr >= dialoguePadTop && rr < viewportH
      ? dialogueRows[vp.start + rr - dialoguePadTop]
      : undefined;
  // 会话区 行：历史视口（viewportH 行）之后是排队块（钉在 pane 底部右下角，始终可见）
  const dialoguePaneSegs = (rr: number): FrameSegment[] => {
    if (rr < 0 || rr >= dialogueH) return [];
    if (rr >= viewportH) {
      const q = queuedRows[rr - viewportH];
      return q ? [...q.segments] : [];
    }
    if (rr < dialoguePadTop) return [];
    const w = dialogueRows[vp.start + rr - dialoguePadTop];
    if (!w || vp.start + rr - dialoguePadTop >= vp.end) return [];
    return [...w.segments];
  };
  // 回合区 行：交互面板存在时显示面板（顶部对齐），否则按滚动偏移取瞬态窗口（底部对齐）
  const activityPaneSegs = (rr: number): FrameSegment[] => {
    if (rr < 0 || rr >= activityH) return [];
    if (modalPanel.length > 0)
      return rr < modalPanel.length ? [...modalPanel[rr]!.segments] : [];
    const a = rr - topPad;
    return a < 0 || a >= act.length ? [] : [...act[a]!.segments];
  };
  for (let rc = 0; rc < contentTopH; rc++) {
    // 回合区 pane 内行号（与面板内行号同口径；非回合区行 = -1）+ 回合区列偏移
    const actRowIdx = horizontal
      ? rc - diaStart
      : activityH > 0 && rc > diaEnd
        ? rc - diaEnd - 1
        : -1;
    let actColOffset = 0;
    // col0：状态列左缘框格（段数组）——焦点中性基线恒空白占位，
    // 竖线/角字由 buildFrame 末尾 focusFrame 按焦点态覆写（DESIGN §8）。
    let left: FrameSegment[] = [];
    if (useLeftFrame) left = [seg(" ")];
    // 状态列正文（最左）：内容行只到正文宽（截断 / 补白都在此定宽，分隔竖线由 divFor 画）
    const statusBody: FrameSegment[] = (() => {
      if (!showStatusCol) return [];
      // 状态列**无顶边**（用户裁定：上方不要多余边框）；聚焦只改其右缘竖线颜色
      const cell = statusCells[rc];
      if (!cell) return [seg(" ".repeat(Math.max(0, statusBodyW)))];
      // 截断到 statusBodyW → 右补空格
      const inner = truncateSegs(cell.segments, statusBodyW);
      const innerW = rowWidth2(inner);
      if (innerW < statusBodyW)
        inner.push(seg(" ".repeat(statusBodyW - innerW)));
      return inner;
    })();
    // 区域内容（标题栏 / 会话区行 / 回合区分隔 / 回合区行）→ 段数组
    const contentSegs: FrameSegment[] = (() => {
      if (rc < diaStart) {
        // 标题栏：首行标题（空标题 <title> 灰占位保持行稳定）、次行实线下划线
        if (rc === 0) {
          // P7：标题栏首行 = preset 符号+名字 + 状态符号组 + 标题（窄宽按让位顺序收缩）
          return titleBarSegments(
            state,
            { mode, policy, preset },
            {
              verbose: !Object.values(state.activityCompact).some(Boolean),
              symbolUnify: state.symbolUnify,
              notifyEnabled: state.notifyEnabled,
            },
            contentW,
          );
        }
        // 下划线行：横向排列时内部竖线自此下行 → 该列让位 `┬`；
        // #5：两 pane 各在自己左端写窗口标题（并排即 `-- Session --|-- Turn --` 形态）
        if (horizontal) {
          const dTitle = titledRow(dialogueW, "Session", sessionFocused);
          const aTitle = titledRow(activityW, lowerTitle, lowerFocused);
          return [
            ...(dTitle ?? [
              seg(SEPARATOR.repeat(Math.max(1, dialogueW)), { fg: "border" }),
            ]),
            seg("┬", { fg: "border" }),
            ...(aTitle ?? [
              seg(SEPARATOR.repeat(Math.max(1, activityW)), { fg: "border" }),
            ]),
          ];
        }
        // 垂直：本行即 Session pane 顶边，标题写在其左端
        return (
          titledRow(contentW, "Session", sessionFocused) ?? [
            seg(SEPARATOR.repeat(Math.max(1, contentW)), { fg: "border" }),
          ]
        );
      }
      if (horizontal) {
        // 横向：会话区（左）| 内部分隔竖线 | 回合区（右）——会话区 补齐到
        // dialogueW（让分隔竖线恒在固定列；回合分隔线用 ╌ 补齐=横线铺满 pane）；
        // **回合区 行尾不补空格**（内容到文字右缘为止，右侧留白列不落字形、
        // 也不画外缘框列）
        const dRow = dialogueRowAt(rc - diaStart);
        const leftSegs = padTo(
          dialoguePaneSegs(rc - diaStart),
          dialogueW,
          dRow?.kind === "separator" ? TURN_SEPARATOR_CHAR : " ",
        );
        // 回合区 正文在帧内的起始列（caret 定位用）= 左 pane 补齐宽 + 竖线 1 列
        actColOffset = rowWidth2(leftSegs) + 1;
        return [
          ...leftSegs,
          seg("│", { fg: "border" }),
          ...activityPaneSegs(rc - diaStart),
        ];
      }
      if (rc < diaEnd) {
        // 会话区行：followBottom / scrollOffset 只作用于会话区
        return dialoguePaneSegs(rc - diaStart);
      }
      if (rc === diaEnd && activityH > 0) {
        // 回合区分隔行 = 下半区（Turn / Tool）顶边：#5 标题写在其左端
        return titledRow(contentW, lowerTitle, lowerFocused) ?? sepSegments();
      }
      if (activityH > 0) {
        // 回合区行：交互面板存在时显示面板，否则按滚动偏移取瞬态窗口
        return activityPaneSegs(rc - diaEnd - 1);
      }
      return [];
    })();
    // 区域正文补齐到 contentW：右缘框列恒位于 R 列（不紧贴文字末尾）。
    // 例外：**回合区行**不补空格、也不画外缘框列（行到回合区文字右缘为止，
    // 右侧留白列不落任何字形；焦点框同样不画回合区右边框）。
    const actRow = horizontal ? rc >= diaStart : activityH > 0 && rc > diaEnd;
    // 回合分隔线行（kind=separator）：与正文同宽——内容层已铺到文字排版宽
    // （contentW − PANE_TEXT_MARGIN_COLS），这里按空格补到 contentW，右缘框列留空，
    // 不再用 ╌ 顶到屏幕最右列（2026-10-27 用户裁定：分隔线宽度 = 文本宽度）
    const ruleRow =
      !actRow && dialogueRowAt(rc - diaStart)?.kind === "separator";
    const contentW2 = rowWidth2(contentSegs);
    const padSegs: FrameSegment[] =
      !actRow && contentW2 < contentW
        ? [seg(" ".repeat(contentW - contentW2))]
        : [];
    // 右缘框列（历史/回合区外缘）：焦点中性基线恒空白占位（history/activity 焦点
    // 由 focusFrame 覆写 ┐/│/┘）；**水平边框行**（标题栏下划线 / 回合区分隔行）
    // 例外——该列补 `─`，横线铺满整行到屏幕最右列（边框不留缺口）。
    const borderRow =
      (titleRows > 1 && rc === diaStart - 1) ||
      (rc === diaEnd && activityH > 0);
    // 行角色（grid.ts 据此给 D 列 / 右缘框列字形）：横线行 → border；回合区行 →
    // activity（不补白、右缘不落字形）；回合分隔行 → rule；其余 → body
    const role = gridRole({ borderRow, actRow, ruleRow });
    // 右缘框列字形：null（回合区行）不拼该列；空白占位不带样式
    const rightGlyph = rightEdgeGlyph(role);
    // 行拼装（自左至右）：状态列外缘框格 ‖ 状态列正文 ‖ 分隔竖线 ‖ 区域正文 ‖ 区域外缘框列
    // P7：垂直状态列隐藏时，左缘框格 / 状态列正文 / 分隔竖线三段都不拼。
    // D 列与右缘框列先落**等宽空白占位**，字形由 grid 基线按角色写（同 focusFrame 口径）
    const rowSegments: FrameSegment[] = [
      ...(showStatusCol ? left : []),
      ...(showStatusCol ? statusBody : []),
      ...(showStatusCol ? [seg(dividerGlyph(role), { fg: "border" })] : []),
      ...contentSegs,
      ...padSegs,
      ...(useRightFrame && rightGlyph !== null
        ? [rightGlyph === " " ? seg(" ") : seg(rightGlyph, { fg: "border" })]
        : []),
    ];
    // 面板内编辑光标（BACKLOG 3.2.7）：命中回合区行时写 caret——列 = 回合区正文
    // 起始列（前缀段实测宽 + 回合区列偏移）+ 面板内列（0 基），行号用帧内 1 基
    const contentStartIdx = showStatusCol
      ? left.length + statusBody.length + 1
      : 0;
    const caretCol =
      panelCaret !== null && actRowIdx === panelCaret.row
        ? rowWidth2(rowSegments.slice(0, contentStartIdx)) +
          actColOffset +
          panelCaret.col
        : undefined;
    rows.push(
      caretCol === undefined
        ? { segments: rowSegments }
        : { segments: rowSegments, caret: caretCol },
    );
  }
  return rows;
}

/**
 * 工具调用行折行（含续行缩进）：整体首行不缩进、可用全宽；其余行——同段软换行的
 * 续行、参数内显式换行后的各行——统一缩进 TOOL_CONT_INDENT 列，且折行宽度扣掉缩进，
 * 保证缩进后每行总宽不超 width（行首超宽字符仍强制放下，不丢字符）。
 * 参数内空行保留（与 split("\n") 语义一致）；窄窗口（width ≤ 缩进）降级不缩进，
 * 避免缩进本身溢出。
 */
