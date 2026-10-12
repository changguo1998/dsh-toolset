// src/app/components/StatusColumn.ts — 状态列（顶部最左列）内容层：条目模型 + Box 生成器
//
// 状态列四个**子面板**（Goal / Todo / 后台任务 / 子代理）的内容在此构建成一棵 Box 树，
// 出行交排版库（`measure` → `allocate` → `fillToList`，见 layout.ts 的 renderStatusColumn）：
// 条目持有**未折行**内容，折行 / 缩进 / 物理行（`\n`）切分由库负责，状态列不再自建行段。
//
// 树形：`v([goal, todo, jobs, agents], { separator: ╌ })`（Box 的 `separator` 语义即
// 「兄弟之间画、首尾不画」）；每块 = `v([标题行, ...条目, 隐藏计数提示?])`。
// 折叠只决定「出哪些条目」（foldBlock），不改条目内容；L3「每条压一行」在叶子侧用
// `wrap: false` 表达。
//
// 口径：块顺序、块间虚线、条目顺序、状态符号与配色、灰色删除线、符号后的悬挂缩进、
// 折叠分级语义全部与改造前逐字对齐（行为等价改造，视觉零回归）。
//
// 实现偏差（相对追踪文档 D2.3「标记用 prefix」）：`prefix` 在 fill 阶段**逐行重绘**
// （fill.ts decorateRows），折行后每行都会再出一次标记，与「续行停在首行文字起点」的既有
// 表现冲突；故标记内联进条目首段、续行缩进用 `hanging`（与旧 wrapWithHanging 同语义）。

import type { FrameSegment } from "../../renderer/screen.ts";
import type { GoalEntry, GoalHistory } from "../state.ts";
import type {
  AgentRowInfo,
  GoalActivation,
  GoalSnapshotLike,
  JobInfo,
  TodoItemLike,
} from "../adapter/dsh.ts";
import type { Box, Node, StyledText } from "../layout/box.ts";
import { styled, v } from "../layout/box.ts";
import { NOTICE_TONE_COLOR } from "../layout/content-rules.ts";
import { displayWidth } from "../layout/markdown.ts";
import { seg } from "../layout/primitives.ts";
import { statusMark } from "./JobsPanel.ts";

/** 状态列块间分隔：点更少的虚线（窗口内部板块分隔保留虚线） */
export const STATUS_BLOCK_SEPARATOR = "╌";

/** goal 相位符号（2026-10-05 起**单独承担语义**：当前行不再出 `active` 等词——10 格窄列
 *  会把词截成 `Goal ▷ ac`；相位色与符号一起表意，历史行仍以 `Goal <phase>` 区分） */
const GOAL_PHASE_SYMBOL: Record<string, string> = {
  active: "▷", // 空心右三角（绿）
  paused: "∥", // U+2225 PARALLEL TO（黄）——字面度量与 ▷ ✓ ⟳ 一致，无 emoji 属性
  blocked: "△", // U+25B3 空心上三角（黄；无 emoji 属性、单列可着色）
  complete: "✓",
};

/** goal 相位 → 标题 phase 状态色：active/complete 绿、paused/blocked 黄
 *  （blocked 2026-10-02 由红改黄——与 `turn/end blocked` 及阻塞原因行同口径） */
const GOAL_PHASE_COLOR: Record<string, "green" | "yellow" | "red"> = {
  active: "green",
  paused: "yellow",
  blocked: "yellow",
  complete: "green",
};

/** goal 自动续轮开关符号（同一符号仅颜色区分：armed 绿 / disarmed 灰） */
const GOAL_ACTIVATION_SYMBOL = "⟳";

/** goal 自动续轮开关色：armed（宿主会自动续轮）绿 / disarmed（需用户驱动）灰 */
const GOAL_ACTIVATION_COLOR: Record<GoalActivation, "green" | "gray"> = {
  armed: "green",
  disarmed: "gray",
};

/** todo 状态标记（占 2 列：符号 + 1 空格；续行缩进与之等宽） */
const TODO_MARKER: Record<TodoItemLike["status"], string> = {
  pending: "○ ", // 待办：空心圆
  in_progress: "● ", // 进行中：实心圆（黄）
  completed: "✓ ",
};

/** 状态列折叠等级（全局统一递增尝试）：
 *  L0 不折叠；L1 隐藏已完成条目（goal 保留最近 1 条历史）；L2 仅保留进行中条目
 *  （goal 压成标题行）；L3 进行中条目也压为 1 行。 */
export type FoldLevel = 0 | 1 | 2 | 3;

/** 状态列条目（概念名 StatusItem）：持有**未折行**内容，折行归 measure / fill。
 *  `segments` 首段为条目标记（如 `○ `、`● `），续行按 `hanging` 缩进到首行文字起点。 */
interface StatusItem {
  /** 首行标题段（**单行不折行**，超宽交拼帧层截断；仅历史 goal 的 `Goal <phase>` 用）。
   *  与 `segments` 分属两个叶子：标题恒一行，正文按列宽折行——与改造前「标题独立成行
   *  （超宽截断）+ objective 整段折行」同口径。 */
  title?: FrameSegment[];
  /** 未折行样式段（样式已内联到各段） */
  segments: FrameSegment[];
  /** 续行缩进列数（= 首行标记宽；0 = 无标记，续行与首行同列） */
  hanging: number;
  /** false = 单行截断不折行（改造前即「一行一条」的条目：jobs / 阻塞原因；截断交拼帧层）。
   *  缺省折行——这是改造前的老口径（todo / goal / agents 条目按列宽折行）。 */
  wrap?: false;
  /** 已完成（L1 先隐藏） */
  done: boolean;
  /** 进行中（L2 只留这些；L3 压 1 行） */
  active: boolean;
}

/** 状态列块：head = 标题行（恒保留，单行）；items = 可按优先级折叠的条目 */
interface StatusBlock {
  id: "goal" | "todo" | "jobs" | "agents";
  head: FrameSegment[];
  items: StatusItem[];
  /** goal 块专用：items[≥ historyFrom] 为历史（旧）goal 条目——L1 只保留首条，L2 起全隐藏 */
  historyFrom?: number;
}

/** 折叠结果：`titleOnly` = 只出标题行（goal L2：objective 与历史全隐藏） */
interface FoldedBlock {
  titleOnly: boolean;
  items: StatusItem[];
  /** 隐藏计数提示文本（单行、不折行；undefined = 不显示） */
  hiddenNote?: string;
}

/** 状态列数据（内容层入参；宽度不进内容层——折行归排版库） */
export interface StatusColumnData {
  goals?: GoalHistory;
  todos?: TodoItemLike[];
  jobs?: JobInfo[];
  /** 子代理目录快照（Agents 块；缺省 / 空数组 = 整块省略） */
  agents?: AgentRowInfo[];
  /** 当前 goal 的自动续轮开关展示值（undefined = 不显示 ⟳） */
  activation?: GoalActivation;
  /** 条目行符号的闪烁节拍（整数；Agents 条目按各自 tps 分档取相位） */
  tick?: number;
  /** goal 自动续轮进度（当前轮 / 上限；两者皆缺 → 整段不显） */
  goalRounds?: { started?: number; max?: number };
}

/**
 * 状态列 Box 生成器（与 8 个工具面板的生成器同构）：按折叠等级产出整列 Box 树。
 * 内容层不含宽度——`measure` / `allocate` 由组装层（layout.ts）负责。
 */
export function buildStatusColumnBox(
  data: StatusColumnData,
  level: FoldLevel,
): Box {
  const children: Node[] = [];
  for (const block of statusColumnBlocks(data)) {
    const folded = foldBlock(block, level);
    const leaves: Node[] = [headLeaf(block.head)];
    if (!folded.titleOnly) {
      for (const item of folded.items) leaves.push(...itemLeaves(item, level));
      // 隐藏计数提示：合成单行（截断交拼帧层，与旧 StatusRow 同口径）
      if (folded.hiddenNote !== undefined) {
        leaves.push(
          styled([seg(folded.hiddenNote, { fg: NOTICE_TONE_COLOR.log })], {
            wrap: false,
          }),
        );
      }
    }
    children.push(v(leaves));
  }
  // 块间虚线（首尾不画）；不染色（默认前景，与旧 sep() 的 `seg(text)` 同口径）
  return v(children, {
    separator: { char: STATUS_BLOCK_SEPARATOR, color: "plain" },
  });
}

/** 标题行叶子：单行不折行（超出宽度由拼帧层截断，与旧 StatusRow 同口径） */
function headLeaf(head: FrameSegment[]): StyledText {
  return styled(head, { wrap: false });
}

/** 条目叶子（1 或 2 个）：标题（若有）恒单行；正文悬挂缩进交 `hanging`，
 *  `wrap: false` 的条目（jobs / 阻塞原因）与 L3「每条压一行」同样单行截断不换行
 *  ——截断交拼帧层，与旧 StatusRow 同口径。
 *  （历史 goal 条目在 L3 本会是「标题 + 正文」两行，旧实现取 `rows[0]` 只留标题；
 *   但 goal 块 L2 起即 titleOnly，该分支不可达。） */
function itemLeaves(item: StatusItem, level: FoldLevel): Node[] {
  const body = styled(item.segments, {
    hanging: item.hanging,
    ...(level >= 3 || item.wrap === false ? { wrap: false } : {}),
  });
  return item.title === undefined
    ? [body]
    : [styled(item.title, { wrap: false }), body];
}

/** 按折叠等级折叠块：goal 的 items 分「当前 goal 行 + 历史条目」（L1 保留最近 1 条历史、
 *  L2 起压成标题行「Goal <phase>」）；todo/jobs/agents 按 done/active 过滤并带隐藏计数提示。 */
function foldBlock(block: StatusBlock, level: FoldLevel): FoldedBlock {
  if (block.id === "goal") {
    // 标题行恒在；L2 起只留标题：objective 与历史全部隐藏
    if (level >= 2) return { titleOnly: true, items: [] };
    let kept = block.items;
    let hidden = 0;
    const from = block.historyFrom ?? kept.length;
    // L1：历史只留最近 1 条（当前 goal 行不受折叠影响）
    if (level >= 1 && kept.length > from + 1) {
      hidden = kept.length - (from + 1);
      kept = kept.slice(0, from + 1);
    }
    return {
      titleOnly: false,
      items: kept,
      ...(hidden > 0 ? { hiddenNote: `…(+${hidden}个历史 goal 已隐藏)` } : {}),
    };
  }
  let kept = block.items;
  let hidden = 0;
  if (level >= 1) {
    const rest = kept.filter((it) => !it.done);
    hidden += kept.length - rest.length;
    kept = rest;
  }
  if (level >= 2) {
    const rest = kept.filter((it) => it.active);
    hidden += kept.length - rest.length;
    kept = rest;
  }
  return {
    titleOnly: false,
    items: kept,
    ...(hidden > 0 ? { hiddenNote: `…(+${hidden}项已隐藏)` } : {}),
  };
}

/** 状态列各块（Goal / Todo / Jobs / Agents；条目为**未折行**内容，完整自然高度、
 *  无强制行数上限——是否折叠由组装层按窗口总高决定） */
function statusColumnBlocks(data: StatusColumnData): StatusBlock[] {
  const blocks: StatusBlock[] = [];
  // P7：Mode 块已移除（会话运行模式/权限/策略/预设/开关改由标题栏状态符号承载）
  // 条目布局：[当前 goal（objective，+blocked 原因）] + [历史（旧）goal 至少一条]
  const goalList = data.goals ?? [];
  if (goalList.length > 0) {
    const current = goalList[0]!;
    const items: StatusItem[] = [goalObjectiveItem(current.goal)];
    // blocked → blockedReason.message 黄 tone
    if (
      current.goal.phase === "blocked" &&
      current.goal.blockedReason?.message
    ) {
      items.push(blockedItem(current.goal.blockedReason.message));
    }
    const historyFrom = items.length;
    for (const e of goalList.slice(1)) items.push(goalHistoryItem(e));
    blocks.push({
      id: "goal",
      head: goalHead(current, data.activation, data.goalRounds),
      items,
      historyFrom,
    });
  }
  // todo 块：标题（完成数/总数，蓝）+ 列表（每条完整折行，不设强制行数上限）
  const list = data.todos ?? [];
  if (list.length > 0) {
    const done = list.filter((t) => t.status === "completed").length;
    blocks.push({
      id: "todo",
      head: [seg(`Todo ${done}/${list.length}`, { fg: "blue" })],
      items: list.map(todoItem),
    });
  }
  // jobs 块：只在有任务时显示；标题 `Jobs 运行中/总数`（蓝）+ 每任务一条
  const jobs = data.jobs ?? [];
  if (jobs.length > 0) {
    const active = jobs.filter(
      (j) => j.status === "running" || j.status === "stopping",
    ).length;
    blocks.push({
      id: "jobs",
      head: [seg(`Jobs ${active}/${jobs.length}`, { fg: "blue" })],
      items: jobs.map(jobItem),
    });
  }
  // Agents 块（BACKLOG TUI#39）：只在有子代理数据时显示；标题 `Agents 运行中/总数`（蓝）。
  // 折叠语义：运行中 = active，其余（空闲 / 异常态）= done（L1 先隐藏、L2 只留运行中）。
  const agents = data.agents ?? [];
  if (agents.length > 0) {
    const running = agents.filter((a) => a.status === "running").length;
    // 标题不加任何状态符号（闪烁在条目行自身的符号上）
    blocks.push({
      id: "agents",
      head: [seg(`Agents ${running}/${agents.length}`, { fg: "blue" })],
      items: agents.map((a) => agentItem(a, data.tick ?? 0)),
    });
  }
  return blocks;
}

/** goal 块标题行：`Goal`（蓝）+ 相位符号（相位色）+ 续轮开关 ⟳（armed 绿 / disarmed 灰）
 *  + 自动续轮进度（中性灰，不复用相位/开关配色——避免把「进度」误读成状态） */
function goalHead(
  current: GoalEntry,
  activation: GoalActivation | undefined,
  goalRounds: { started?: number; max?: number } | undefined,
): FrameSegment[] {
  // 进度文本（` 53/999`；缺上限只显轮数；轮次缺失 → 整段不显）
  const roundsText =
    goalRounds?.started === undefined
      ? undefined
      : goalRounds.max === undefined
        ? ` ${goalRounds.started}`
        : ` ${goalRounds.started}/${goalRounds.max}`;
  const phase = current.goal.phase;
  const phaseColor = GOAL_PHASE_COLOR[phase] ?? "green";
  const phaseSymbol = GOAL_PHASE_SYMBOL[phase];
  return [
    seg("Goal ", { fg: "blue" }),
    // 未知 phase：不出符号（避免多出空格），也不出相位词 → 整行只剩 `Goal`
    // 只出符号（2026-10-05：相位词在 10 格窄列会被截断成 `Goal ▷ ac`，信息量低于噪声；
    // 语义由符号 + 颜色承担。历史旧 goal 行仍带相位词——它们按约定不出符号）
    ...(phaseSymbol === undefined
      ? []
      : [seg(`${phaseSymbol}`, { fg: phaseColor })]),
    // 自动续轮开关（⟳）无数据（含回放/重启后未收到 activation 边）由 selector 推导
    ...(activation === undefined
      ? []
      : [
          seg(` ${GOAL_ACTIVATION_SYMBOL}`, {
            fg: GOAL_ACTIVATION_COLOR[activation],
          }),
        ]),
    ...(roundsText === undefined ? [] : [seg(roundsText, { fg: "gray" })]),
  ];
}

/** 当前 goal 的 objective 条目：**只展示首个逻辑行**（概括位；全文入口 = 宿主 `/goal` 输出）。
 *  首个逻辑行按列宽**完整折行**——行数由宽度与内容共同决定，**不截断**；
 *  「一句概括」的字数限制在**起草侧**把关（goal-contract 要求首句 ≤ 40 显示列，见其 README）。
 *  phase=complete 已完成 → 灰 + 删除线，与 todo 完成态同口径 */
function goalObjectiveItem(g: GoalSnapshotLike): StatusItem {
  const first = (g.objective || "（空目标）")
    .split("\n")
    .find((line) => line.trim() !== "");
  const body = first?.trim() || "（空目标）";
  return {
    segments: [
      g.phase === "complete"
        ? seg(body, { fg: "gray", strike: true })
        : seg(body),
    ],
    hanging: 0,
    done: g.phase === "complete",
    active: g.phase === "active",
  };
}

/** blocked 原因条目（黄 tone；改造前即单行，超宽由拼帧层截断——`wrap: false` 保持原表现） */
function blockedItem(message: string): StatusItem {
  return {
    segments: [seg("阻塞: " + message, { fg: "yellow" })],
    hanging: 0,
    wrap: false,
    done: false,
    active: false,
  };
}

/** 历史（旧）goal 条目：标题行「Goal <phase>」（灰，单行）+ objective（灰 + 删除线，折行）。
 *  标题与 objective 分属两个叶子：旧实现也是两段独立行（标题超宽由拼帧层截断）。 */
function goalHistoryItem(e: GoalEntry): StatusItem {
  return {
    title: [seg("Goal ", { fg: "gray" }), seg(e.goal.phase, { fg: "gray" })],
    segments: [
      seg(e.goal.objective || "（空目标）", { fg: "gray", strike: true }),
    ],
    hanging: 0,
    done: true,
    active: false,
  };
}

/** todo 条目：首行带标记，续行停在首行文字起点（悬挂缩进 = 标记宽）。
 *  完成态对号（灰，无线）不被删除线覆盖；正文/续行灰 + 删除线；进行中整项黄（换行后颜色不丢） */
function todoItem(t: TodoItemLike): StatusItem {
  const body = t.content === "" ? "（空项）" : t.content;
  const mark = TODO_MARKER[t.status];
  const hanging = displayWidth(mark);
  if (t.status === "completed") {
    return {
      segments: [
        seg(TODO_MARKER.completed, { fg: "gray" }),
        seg(body, { fg: "gray", strike: true }),
      ],
      hanging,
      done: true,
      active: false,
    };
  }
  if (t.status === "in_progress") {
    return {
      segments: [seg(mark + body, { fg: "yellow" })],
      hanging,
      done: false,
      active: true,
    };
  }
  return {
    segments: [seg(mark + body)],
    hanging,
    done: false,
    active: false,
  };
}

/** job 条目（✓ 完成灰 + 删除线，其余按状态色）。改造前口径 = **每任务一行**
 *  （长 label 由拼帧层截断，不折行）——`wrap: false` 保持该表现，只去掉裸 `\n` 断行风险。 */
function jobItem(job: JobInfo): StatusItem {
  const mark = statusMark(job.status);
  const label = job.label || job.kind || job.id || "（未命名任务）";
  const done = mark.symbol === "✓";
  const active = job.status === "running" || job.status === "stopping";
  if (mark.symbol === "✓") {
    return {
      segments: [
        seg("✓ ", { fg: "gray" }),
        seg(label, { fg: "gray", strike: true }),
      ],
      hanging: displayWidth("✓ "),
      wrap: false,
      done,
      active,
    };
  }
  return {
    segments: [seg(mark.symbol + " " + label, { fg: mark.color })],
    hanging: displayWidth(mark.symbol + " "),
    wrap: false,
    done,
    active,
  };
}

/** 闪烁节拍分档：档 1 = 每个 tick 翻转一次（与主会话符号同频）；档越大越慢——
 *  条目 1「速度与该代理 tps 相关」 */
function agentBlinkBucket(tps: number | undefined): number {
  // 缺省 = 1：**与主会话同频**（用户口径：机制复用就该同频）；只有测到较低速率时才放慢
  if (tps === undefined) return 1;
  if (tps >= 8) return 1;
  if (tps >= 3) return 2;
  if (tps >= 1) return 3;
  return 4;
}

/** Agents 块条目：`符号 别名??label · 工作摘要`（无记录省略）。
 *  色义：**运行中黄 / 空闲灰 / 一切异常态红**（诊断条目附宿主给出的 reason 短因）。
 *  纯只读展示：不吃按键、不提供中断入口（中断仍走 `/agents` 面板）。 */
function agentItem(a: AgentRowInfo, tick: number): StatusItem {
  const diag = a.diagnostic;
  const running = a.status === "running";
  const fg: "red" | "yellow" | "gray" = diag
    ? "red"
    : running
      ? "yellow"
      : "gray";
  // 闪烁在**条目行自己的**符号上（● / ○ 切换，两态等宽，颜色保持「运行中」的黄，
  // 避免被误读成空闲）；速度按该子代理 tps 分档。空闲仍 ○、异常仍 ! 常亮。
  const blink = Math.floor(tick / agentBlinkBucket(a.tps)) % 2 === 1;
  const sym = diag ? "! " : running && blink ? "○ " : running ? "● " : "○ ";
  // 显示名 = 别名 ?? label；工作内容 = 最近一次工具调用摘要（无记录省略）；
  // 不再输出状态词与短 id（状态由符号/配色表达，详细见 /agents 面板）。
  const text = `${sym}${a.alias ?? a.label}${a.work ? ` · ${a.work}` : ""}`;
  // 续行停在首行**文字**起点（跳过符号宽度）——与活动区 Box 的 hanging 语义一致
  return {
    segments: [seg(text.trimEnd(), { fg })],
    hanging: displayWidth(sym),
    done: a.status !== "running",
    active: running,
  };
}
