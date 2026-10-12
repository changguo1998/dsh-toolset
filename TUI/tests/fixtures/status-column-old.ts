// tests/fixtures/status-column-old.ts — 改造前状态列实现的**冻结副本**（等价性对照用）
//
// 来源：`git show cca30c3:TUI/src/app/layout.ts` 的 renderStatusColumn + 四个行生成器 +
// foldAt / capRows / wrapWithHanging / statusStartFor 与相关常量与类型，按模块边界原样搬运
// （只改导出名、只补 import 与搬运段外的常量声明；函数体一字未动）。
//
// 用途：`tests/status-column-equivalence.test.ts` 把同一批 state 快照分别喂旧实现与新实现
// （`src/app/components/StatusColumn.ts` + `renderStatusColumn`），断言逐行文本与行数一致
// ——行为等价改造（视觉零回归）的可执行证据。
//
// **不要**按新实现修改本文件：它是历史快照，改了证据就失效。

import type { FrameRow, FrameSegment } from "../../src/renderer/screen.ts";
import type { ColorName } from "../../src/renderer/theme.ts";
import type { GoalEntry, GoalHistory } from "../../src/app/state.ts";
import type {
  AgentRowInfo,
  GoalActivation,
  GoalSnapshotLike,
  JobInfo,
  TodoItemLike,
} from "../../src/app/adapter/dsh.ts";
import { NOTICE_TONE_COLOR } from "../../src/app/layout/content-rules.ts";
import { displayWidth } from "../../src/app/layout/markdown.ts";
import {
  rowWidth2,
  seg,
  truncateSegs,
  wrapLine,
} from "../../src/app/layout/primitives.ts";
import { statusMark } from "../../src/app/components/JobsPanel.ts";
import { runPhase, RUN_TOGGLE_TOKENS } from "../../src/app/layout.ts";

/** 状态列内 goal/todo/jobs 块间分隔（旧实现常量；源文件同位置） */
const STATUS_BLOCK_SEPARATOR = "╌";

/** goal 阶段符号（用户 2026-10-02 定稿；与 phase 词并存——符号给扫视、词保可读） */
/** 相位符号（2026-10-05 起**单独承担语义**：当前行不再出 `active` 等词——10 格窄列会把词
 *  截成 `Goal ▷ ac`；相位色与符号一起表意，历史行仍以 `Goal <phase>` 区分） */
const GOAL_PHASE_SYMBOL: Record<string, string> = {
  active: "▷", // 空心右三角（绿）
  paused: "∥", // U+2225 PARALLEL TO（黄）——字面度量与 ▷ ✓ ⟳ 一致，无 emoji 属性
  blocked: "△", // U+25B3 空心上三角（黄；无 emoji 属性、单列可着色）
  complete: "✓",
};

/** goal 阶段 → 标题 phase 状态色：active/complete 绿、paused/blocked 黄
 *  （blocked 2026-10-02 由红改黄——与 `turn/end blocked` 及阻塞原因行同口径） */
const GOAL_PHASE_COLOR: Record<string, "green" | "yellow" | "red"> = {
  active: "green",
  paused: "yellow",
  blocked: "yellow",
  complete: "green",
};

/** goal 自动续轮开关符号（同一符号仅颜色区分：armed 绿 / disarmed 灰，用户 2026-10-02 定稿） */
const GOAL_ACTIVATION_SYMBOL = "⟳";

/** goal 自动续轮开关色：armed（宿主会自动续轮）绿 / disarmed（需用户驱动）灰 */
const GOAL_ACTIVATION_COLOR: Record<GoalActivation, "green" | "gray"> = {
  armed: "green",
  disarmed: "gray",
};

const TODO_MARKER: Record<TodoItemLike["status"], string> = {
  pending: "○ ", // 待办：空心圆
  in_progress: "● ", // 进行中：实心圆（黄）
  completed: "✓ ",
};

/** 状态列行（段数组；样式已内联到各段） */
interface StatusRow {
  segments: FrameSegment[];
}

/** 状态列块：head=分隔线/标题等必保行；items=可按优先级折叠的条目（todo/jobs/goal 历史） */
interface StatusBlock {
  id: "mode" | "goal" | "todo" | "jobs" | "agents";
  head: StatusRow[];
  items: { rows: StatusRow[]; done: boolean; active: boolean }[];
  /** goal 块专用：items[≥ historyFrom] 为历史（旧）goal 条目——L1 只保留首条，L2 起全隐藏 */
  historyFrom?: number;
}

/** 状态列折叠等级（全局统一递增尝试）：
 *  L0 不折叠；L1 隐藏已完成条目（goal 保留最近 1 条历史）；L2 仅保留进行中条目
 *  （goal 压成标题行）；L3 进行中条目也压为 1 行。 */
type FoldLevel = 0 | 1 | 2 | 3;

/** 按折叠等级折叠块：goal 的 items 分「当前 goal 行 + 历史条目」（L1 保留最近 1 条历史、
 *  L2 起压成标题行「Goal <phase>」）；todo/jobs 按 done/active 过滤并带隐藏计数提示；
 *  mode 恒完整。 */
function foldAt(block: StatusBlock, level: FoldLevel): StatusRow[] {
  if (block.id === "goal") {
    // head 末行恒为标题（首块无 sep），L2 起只留标题：删除分隔线、objective 与历史
    if (level >= 2) return [block.head[block.head.length - 1]!];
    let kept = block.items;
    let hidden = 0;
    const from = block.historyFrom ?? kept.length;
    // L1：历史只留最近 1 条（当前 goal 行不受折叠影响）
    if (level >= 1 && kept.length > from + 1) {
      hidden = kept.length - (from + 1);
      kept = kept.slice(0, from + 1);
    }
    const rows = kept.flatMap((it) => it.rows);
    if (hidden > 0) {
      rows.push({
        segments: [
          seg(`…(+${hidden}个历史 goal 已隐藏)`, { fg: NOTICE_TONE_COLOR.log }),
        ],
      });
    }
    return [...block.head, ...rows];
  }
  if (block.id === "todo" || block.id === "jobs" || block.id === "agents") {
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
    const rows =
      level >= 3
        ? kept.map((it) => it.rows[0]!)
        : kept.flatMap((it) => it.rows);
    if (hidden > 0) {
      rows.push({
        segments: [seg(`…(+${hidden}项已隐藏)`, { fg: NOTICE_TONE_COLOR.log })],
      });
    }
    return [...block.head, ...rows];
  }
  // mode：无折叠语义，恒完整
  return [...block.head, ...block.items.flatMap((it) => it.rows)];
}

/** 行级兑底截断：超出预算时保留前 budget-1 行、末行换折叠提示（统计被折叠行数） */
function capRows(rows: StatusRow[], budget: number): StatusRow[] {
  if (rows.length <= budget) return rows;
  if (budget <= 0) return [];
  if (budget === 1) return [rows[0]!]; // 仅 1 行：内容优先，折叠标记让位
  const hidden = rows.length - budget;
  const kept = rows.slice(0, budget - 1);
  kept.push({ segments: [seg(`…(+${hidden}行)`)] });
  return kept;
}

/** 当前 goal 的 objective 行：**只展示首个逻辑行**（概括位；全文入口 = 宿主 `/goal` 输出）。
 *  首个逻辑行按列宽**完整折行**——行数由宽度与内容共同决定（窄列自然多占几行），**不截断**；
 *  「一句概括」的字数限制在**起草侧**把关（goal-contract 要求首句 ≤ 40 显示列，见其 README）。
 *  历史旧 goal 行不受此口径影响（见 `goalHistoryRows`）。
 *  phase=complete 已完成 → 灰 + 删除线，与 todo 完成态同口径 */
function goalObjectiveRows(g: GoalSnapshotLike, width: number): StatusRow[] {
  const first = (g.objective || "（空目标）")
    .split("\n")
    .find((line) => line.trim() !== "");
  const body = first?.trim() || "（空目标）";
  return wrapLine(body, Math.max(1, width)).map((line) => ({
    segments: [
      g.phase === "complete"
        ? seg(line, { fg: "gray", strike: true })
        : seg(line),
    ],
  }));
}

/** 历史（旧）goal 行：标题行「Goal <phase>」（灰）+ objective（灰 + 删除线） */
function goalHistoryRows(e: GoalEntry, width: number): StatusRow[] {
  const rows = wrapLine(
    e.goal.objective || "（空目标）",
    Math.max(1, width),
  ).map((text) => ({
    segments: [seg(text, { fg: "gray", strike: true })],
  }));
  return [
    {
      segments: [
        seg("Goal ", { fg: "gray" }),
        seg(e.goal.phase, { fg: "gray" }),
      ],
    },
    ...rows,
  ];
}

/** todo 条目渲染行（首行带标记，续行缩进对齐） */
function todoItemRows(t: TodoItemLike, width: number): StatusRow[] {
  const body = t.content === "" ? "（空项）" : t.content;
  const mark = TODO_MARKER[t.status];
  const rows = wrapLine(body, Math.max(1, width - 2));
  if (t.status === "completed") {
    // 对号（灰，无线）不被删除线覆盖；正文/续行灰+删除线
    return rows.map((r, i) =>
      i === 0
        ? {
            segments: [
              seg(TODO_MARKER.completed, { fg: "gray" }),
              seg(r, { fg: "gray", strike: true }),
            ],
          }
        : {
            segments: [seg(r, { fg: "gray", strike: true })],
          },
    );
  }
  if (t.status === "in_progress") {
    // 换行后颜色不丢失：整项（含续行）同色；所有进行中项均为黄色
    return rows.map((r, i) => ({
      segments: [seg((i === 0 ? mark : "  ") + r, { fg: "yellow" })],
    }));
  }
  return rows.map((r, i) => ({
    segments: [seg((i === 0 ? mark : "  ") + r)],
  }));
}

/** job 条目渲染行（✓ 完成灰+删除线，其余按状态色） */
function jobItemRows(job: JobInfo): StatusRow[] {
  const mark = statusMark(job.status);
  const label = job.label || job.kind || job.id || "（未命名任务）";
  if (mark.symbol === "✓") {
    return [
      {
        segments: [
          seg("✓ ", { fg: "gray" }),
          seg(label, { fg: "gray", strike: true }),
        ],
      },
    ];
  }
  return [{ segments: [seg(mark.symbol + " " + label, { fg: mark.color })] }];
}

/**
 * 状态列 **Agents 块**条目行（BACKLOG TUI#39）：`符号 名称 · 工作摘要`（工作摘要无记录时省略；按宽折行）。
 * 色义：**运行中黄 / 空闲灰 / 一切异常态红**（诊断条目、枚举失败；附宿主给出的 reason 短因）。
 * 纯只读展示：不吃按键、不提供中断入口（中断仍走 `/agents` 面板）。
 */
/** 闪烁节拍分档：档 1 = 每个 tick 翻转一次（与主会话符号同频）；档越大越慢——条目 1「速度与该代理 tps 相关」 */
function agentBlinkBucket(tps: number | undefined): number {
  // 缺省 = 1：**与主会话同频**（用户口径：机制复用就该同频）；只有测到较低速率时才放慢
  if (tps === undefined) return 1;
  if (tps >= 8) return 1;
  if (tps >= 3) return 2;
  if (tps >= 1) return 3;
  return 4;
}

function agentItemRows(a: AgentRowInfo, width: number, tick = 0): StatusRow[] {
  const diag = a.diagnostic;
  const running = a.status === "running";
  const fg: ColorName = diag ? "red" : running ? "yellow" : "gray";
  // BACKLOG 条目 1（用户口径）：闪烁在**条目行自己的**符号上（● / ○ 切换，两态等宽 2 列，
  // 颜色保持「运行中」的黄，避免被误读成空闲）；速度按该子代理 tps 分档。空闲仍 ○、异常仍 ! 常亮。
  const blink = Math.floor(tick / agentBlinkBucket(a.tps)) % 2 === 1;
  const sym = diag ? "! " : running && blink ? "○ " : running ? "● " : "○ ";
  // BACKLOG「Agents 列表显示别名 + 工作内容」：显示名 = 别名 ?? label；工作内容 = 最近一次
  // 工具调用摘要（无记录省略）；不再输出状态词与短 id（状态由符号/配色表达，详细见 /agents 面板）。
  const text =
    `${sym}${a.alias ?? a.label}${a.work ? ` · ${a.work}` : ""}`.trimEnd();
  // BACKLOG「Agents 条目改列表式悬挂对齐」：续行停在首行**文字**起点（跳过符号宽度），
  // 与活动区 Box 的 hanging 语义一致（复用 wrapWithHanging）。
  return wrapWithHanging(text, Math.max(1, width), displayWidth(sym)).map(
    (line) => ({
      segments: [seg(line, { fg })],
    }),
  );
}

/** 状态列各块（Goal / Todo / Jobs；完整自然高度，无强制行数上限；
 *  是否折叠由 renderStatusColumn 按窗口总高决定） */

function statusBlocks(
  goals: GoalHistory | undefined,
  todos: TodoItemLike[] | undefined,
  jobs: JobInfo[] | undefined,
  agents: AgentRowInfo[] | undefined,
  width: number,
  /** 当前 goal 的自动续轮开关展示值（undefined = 不显示 ⟳；仅 active 相位有值） */ activation?: GoalActivation,
  phase: 0 | 1 = 0,
  /** 闪烁节拍（整数，运行期单调递增）：条目行符号按各自 tps 分档取相位 */
  tick = 0,
  /** 条目 30：goal 自动续轮进度（当前轮 / 上限；两者皆缺 → 整段不显） */
  goalRounds?: { started?: number; max?: number },
): StatusBlock[] {
  const blocks: StatusBlock[] = [];
  const sep = (): StatusRow => ({
    // 虚线分隔与字体同色（不染边框蓝）
    segments: [seg(STATUS_BLOCK_SEPARATOR.repeat(width))],
  });
  // P7：Mode 块已移除（会话运行模式/权限/策略/预设/开关改由标题栏状态符号承载）
  // goal 块非必需；todo/jobs 块独立展示（不早退）
  // 条目布局：[当前 goal（objective，+blocked 原因）] + [历史（旧）goal 至少一条]
  const goalList = goals ?? [];
  if (goalList.length > 0) {
    const current = goalList[0]!;
    const head: StatusRow[] = [];
    if (blocks.length > 0) head.push(sep());
    // 条目 30：进度文本（` 53/999`；缺上限只显轮数；轮次缺失 → 整段不显）
    const roundsText =
      goalRounds?.started === undefined
        ? undefined
        : goalRounds.max === undefined
          ? ` ${goalRounds.started}`
          : ` ${goalRounds.started}/${goalRounds.max}`;
    const phase = current.goal.phase;
    const phaseColor = GOAL_PHASE_COLOR[phase] ?? "green";
    const phaseSymbol = GOAL_PHASE_SYMBOL[phase];
    head.push({
      segments: [
        seg("Goal ", { fg: "blue" }),
        // 未知 phase：不出符号（避免多出空格），也不出相位词 → 整行只剩 `Goal`
        // 只出符号（2026-10-05：相位词在 10 格窄列会被截断成 `Goal ▷ ac`，信息量低于噪声；
        // 语义由符号 + 颜色承担。历史旧 goal 行仍带相位词——它们按约定不出符号）
        ...(phaseSymbol === undefined
          ? []
          : [seg(`${phaseSymbol}`, { fg: phaseColor })]),
        // 自动续轮开关（⟳）只在当前 goal 处于 active 时有意义：其它相位本就不在推进，
        // 显示是噪声；无数据（含回放/重启后未收到 activation 边）由 selector 推导
        ...(activation === undefined
          ? []
          : [
              seg(` ${GOAL_ACTIVATION_SYMBOL}`, {
                fg: GOAL_ACTIVATION_COLOR[activation],
              }),
            ]),
        // 条目 30：自动续轮进度（当前轮 / 上限）——缺上限只显轮数、两者皆缺整段不显；
        // 用中性灰，不复用相位/开关配色（避免把「进度」误读成状态）
        ...(roundsText === undefined ? [] : [seg(roundsText, { fg: "gray" })]),
      ],
    });
    const items: StatusBlock["items"] = [
      {
        rows: goalObjectiveRows(current.goal, width),
        done: current.goal.phase === "complete",
        active: current.goal.phase === "active",
      },
    ];
    // blocked → blockedReason.message 黄 tone
    if (
      current.goal.phase === "blocked" &&
      current.goal.blockedReason?.message
    ) {
      items.push({
        rows: [
          {
            segments: [
              seg("阻塞: " + current.goal.blockedReason.message, {
                fg: "yellow",
              }),
            ],
          },
        ],
        done: false,
        active: false,
      });
    }
    const historyFrom = items.length;
    for (const e of goalList.slice(1)) {
      items.push({
        rows: goalHistoryRows(e, width),
        done: true,
        active: false,
      });
    }
    blocks.push({ id: "goal", head, items, historyFrom });
  }
  // todo 块：标题（完成数/总数，蓝）+ 列表（每条完整折行，不设强制行数上限）
  const list = todos ?? [];
  if (list.length > 0) {
    const head: StatusRow[] = [];
    if (blocks.length > 0) head.push(sep());
    const done = list.filter((t) => t.status === "completed").length;
    head.push({
      segments: [seg(`Todo ${done}/${list.length}`, { fg: "blue" })],
    });
    blocks.push({
      id: "todo",
      head,
      items: list.map((t) => ({
        rows: todoItemRows(t, width),
        done: t.status === "completed",
        active: t.status === "in_progress",
      })),
    });
  }
  // jobs 块：只在有任务时显示；标题 `Jobs 运行中/总数`（蓝）+ 每任务一行
  if (jobs && jobs.length > 0) {
    const head: StatusRow[] = [];
    if (blocks.length > 0) head.push(sep());
    const active = jobs.filter(
      (j) => j.status === "running" || j.status === "stopping",
    ).length;
    head.push({
      segments: [seg(`Jobs ${active}/${jobs.length}`, { fg: "blue" })],
    });
    blocks.push({
      id: "jobs",
      head,
      items: jobs.map((j) => ({
        rows: jobItemRows(j),
        done: statusMark(j.status).symbol === "✓",
        active: j.status === "running" || j.status === "stopping",
      })),
    });
  }
  // Agents 块（BACKLOG TUI#39）：只在有子代理数据时显示；标题 `Agents 运行中/总数`（蓝）。
  // 折叠语义：运行中 = active，其余（空闲 / 异常态）= done（L1 先隐藏、L2 只留运行中）。
  if (agents && agents.length > 0) {
    const head: StatusRow[] = [];
    if (blocks.length > 0) head.push(sep());
    const running = agents.filter((a) => a.status === "running").length;
    // BACKLOG #1（用户真机澄清）：**标题不加任何状态符号** —— 闪烁在条目行自身的符号上
    head.push({
      segments: [seg(`Agents ${running}/${agents.length}`, { fg: "blue" })],
    });
    blocks.push({
      id: "agents",
      head,
      items: agents.map((a) => ({
        rows: agentItemRows(a, width, tick),
        done: a.status !== "running",
        active: a.status === "running",
      })),
    });
  }
  return blocks;
}

/** 顶部状态列窗口起点：偏移恒在 [0, max(0, len-rows)] 内 */
function statusStartFor(len: number, offset: number, rows: number): number {
  if (len <= rows || rows <= 0) return 0;
  return Math.min(Math.max(0, offset), len - rows);
}

/** 顶部状态列（最左侧列）：输出恰 height 行，每行宽 statusColWidth（末位竖线为分隔竖线边线，
 *  由 buildTopRegion 剥去后重新构图左缘外框格/右缘分隔竖线）。
 *  滚动独立于对话区（statusColumnScroll，↑/↓ 仍滚历史，PgUp/PgDn 滚状态列）。 */
export function oldRenderStatusColumn(
  goals: GoalHistory | undefined,
  todos: TodoItemLike[] | undefined,
  jobs: JobInfo[] | undefined,
  scroll: number,
  height: number,
  width: number,
  /** TUI#39：子代理目录快照（Agents 块；缺省 = 不显示该块，保持既有调用口径） */
  agents?: AgentRowInfo[],
  /** 当前 goal 的自动续轮开关展示值（`goalActivationDisplay`；缺省 = 不显示 ⟳） */
  activation?: GoalActivation,
  /** BACKLOG #1：Agents 块前导符号的闪烁相位来源（虚拟 token 累计；缺省 0 = 静态） */
  runTokens = 0,
  /** 条目 30：goal 进度（当前轮 / 上限） */
  goalRounds?: { started?: number; max?: number },
): FrameRow[] {
  const h = Math.max(1, height);
  const w = Math.max(1, width);
  // 状态列折叠策略：无强制行数上限——各块完整渲染，仅当总高度超过窗口高度时
  // 才折叠：高度按块尽量平均分配，块内按「已完成 → 靠后的未完成」优先级隐藏条目
  const blocks = statusBlocks(
    goals,
    todos,
    jobs,
    agents,
    w - 1,
    activation,
    runPhase(runTokens),
    // 条目 1：条目行符号的闪烁节拍 = 全局相位序号（虚拟 token 积分单调递增，App 的节拍门
    // 已含「有子代理在跑」）→ 各代理再按自己的 tps 分档取相位，相对快慢即不同
    Math.floor(runTokens / RUN_TOGGLE_TOKENS),
    goalRounds,
  );
  // 状态列折叠策略：无强制行数上限——从 L0 到 L3 依次尝试折叠等级，
  // 首次放下即采用；全部等级用尽仍放不下（goal 大头）→ 整列行级截断兜底
  let body: StatusRow[] = [];
  for (const level of [0, 1, 2, 3] as const) {
    body = blocks.flatMap((b) => foldAt(b, level));
    if (body.length <= h) break;
  }
  if (body.length > h) body = capRows(body, h);
  const start = statusStartFor(body.length, scroll, h);
  const out: FrameRow[] = [];
  for (let r = 0; r < h; r++) {
    const idx = start + r;
    const line = idx < body.length ? body[idx] : undefined;
    const segments = line ? [...line.segments] : [];
    // 内容截到 (w-1)：段级截断（不切半个 CJK）
    const inner = truncateSegs(segments, w - 1);
    // 右缘竖线分隔（竖线 │ 跨行连成连续线）：内容后补空格到 (w-1) 再放竖线。
    // 此竖线在 buildTopRegion 被剥去后重画（边框灰/亮由框架构图决定），故保持无色便于剥离
    const innerW = rowWidth2(inner);
    if (innerW < w - 1) inner.push(seg(" ".repeat(w - 1 - innerW)));
    inner.push(seg("│"));
    out.push({ segments: inner });
  }
  return out;
}

/**
 * 折行并让续行停靠 `hanging` 列（首行按整宽、续行按 width − hanging 重折后补空格）——
 * 与活动区 Box 的 hanging 语义一致（BACKLOG 3.1.1 的底部 notice 视图用）。
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
