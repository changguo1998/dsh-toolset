// TUI/src/app/layout/title-bar.ts — 标题栏与状态列渲染（纯函数）

import type { FrameSegment } from "../../renderer/index.ts";
import { RUN_TOGGLE_TOKENS } from "./run-virt.ts";
import { capRows } from "./geometry.ts";
import type {
  AppState,
  GoalHistory,
  ModeState,
  StatusExtras,
} from "../state.ts";
import type {
  JobInfo,
  TodoItemLike,
  GoalActivation,
  AgentRowInfo,
} from "../adapter/dsh.ts";
import {
  buildStatusColumnBox,
  type StatusColumnData,
} from "../components/StatusColumn.ts";
import type { ColorName } from "../../renderer/theme.ts";
import { layout } from "./measure.ts";
import { fillToList } from "./fill.ts";
import type { Box } from "./box.ts";
import type { ContentRow } from "./fill.ts";
import { displayWidth } from "./markdown.ts";
import { seg, truncateToWidth } from "./primitives.ts";

// TUI/src/app/layout/title-bar.ts — 标题栏与状态列渲染（纯函数）

/** 权限/沙箱等级缩写（标题栏沙箱状态符号的等级缩写来源） */
const MODE_SHORT: Record<string, string> = {
  "read-only": "ro",
  "workspace-write": "wr",
  "danger-full-access": "full",
};
/** P7 起：会话开关态（verbose / symbol-unify / 声音提醒）不再由状态列 Mode 块展示，
 *  而是作为**标题栏状态符号**的取值来源（on = 默认前景，off = 灰）。 */
export interface StatusSwitches {
  /** 回合区详略（`/collapse on|off`） */
  verbose: boolean;
  /** 输出符号统一（`/symbol-unify on|off`） */
  symbolUnify: boolean;
  /** 声音提醒总开关（`notify.enabled`，配置项：只读显示当前值） */
  notifyEnabled: boolean;
  /** flow-track 注入开关（服务面 `flowTrack.enabled()` 懒读）；undefined = 未读到 → 不渲染 */
  flowTrack?: boolean | undefined;
  /** background-daemon 开关（服务面 `daemon.status().enabled` 懒读）；**始终渲染**,
   *  undefined（服务未挂载 / 读不到）按关（灰）显示 —— 2026-11-08 用户裁定「该符号始终显示」 */
  daemon?: boolean | undefined;
}

/** 顶部状态列窗口起点：偏移恒在 [0, max(0, len-rows)] 内 */
function statusStartFor(len: number, offset: number, rows: number): number {
  if (len <= rows || rows <= 0) return 0;
  return Math.min(Math.max(0, offset), len - rows);
}

/** P7：标题栏状态符号（Nerd Font 私有区字形，宽度实测各 1 列；写成转义便于核对码位）。
 *  - 沙箱：`md-package_variant_closed` U+F03D7（只读）/ `md-package_variant` U+F03D6（可写、全权、其它）
 *  - 审批策略：`md-chat_question_outline` U+F1739（ask）/ `md-chat_remove_outline` U+F1414（never）
 *  - 开关：`fa-route` U+EDA6（plan）/ `md-text_long` U+F09AA（verbose）/
 *    `md-spellcheck` U+F04C6（符号统一）/ `md-bell_ring_outline` U+F009F（声音提醒）/
 *    `fa-tasks` U+F0AE（flow-track 注入开关）/ `fa-clock_o` U+F017（background-daemon 开关）
 *  - 预设：`md-puzzle_outline` U+F0A66（后接预设名） */
export const TITLE_ICON = {
  boxClosed: "\u{F03D7}",
  boxOpen: "\u{F03D6}",
  policyAsk: "\u{F1739}",
  policyNever: "\u{F1414}",
  plan: "\u{EDA6}",
  verbose: "\u{F09AA}",
  symbolUnify: "\u{F04C6}",
  bell: "\u{F009F}",
  flowTrack: "\u{F0AE}",
  daemon: "\u{F017}",
  preset: "\u{F0A66}",
} as const;

/** P7：标题栏首行段数组 = [preset 符号 + 名字] 1 空格 [6 个状态符号（空格分隔）] 2 空格 [标题]。
 *  颜色即语义值：沙箱 ro 绿 / wr 黄 / full 红 / 其它灰；policy ask 黄 / never 绿；
 *  四个开关 on 绿 / off 灰；preset 统一默认前景。`permission` 不再显示。
 *  窄宽让位顺序：① 去掉 preset → ② 截断标题 → ③ 去掉整组符号 → ④ 既有标题栏降级。 */
export function titleBarSegments(
  state: AppState,
  fields: {
    mode?: ModeState | undefined;
    policy?: "ask" | "never" | undefined;
    preset?: string | undefined;
  },
  switches: StatusSwitches,
  width: number,
): FrameSegment[] {
  // preset 段：拼图符号 + 1 空格 + 预设名（统一默认前景）
  const presetSegs: FrameSegment[] =
    fields.preset && fields.preset !== ""
      ? [seg(TITLE_ICON.preset), seg(" "), seg(fields.preset)]
      : [];
  // 状态符号组（空格分隔，顺序固定：sandbox / policy / plan / verbose / 符号统一 / 声音）
  const symSegs: FrameSegment[] = [];
  const push = (text: string, fg?: ColorName): void => {
    if (symSegs.length > 0) symSegs.push(seg(" "));
    symSegs.push(fg === undefined ? seg(text) : seg(text, { fg }));
  };
  const sandbox = fields.mode?.sandbox;
  if (sandbox) {
    const code = MODE_SHORT[sandbox] ?? sandbox;
    const fg: ColorName =
      code === "ro"
        ? "green"
        : code === "wr"
          ? "yellow"
          : code === "full"
            ? "red"
            : "gray";
    push(code === "ro" ? TITLE_ICON.boxClosed : TITLE_ICON.boxOpen, fg);
  }
  if (fields.policy) {
    const never = fields.policy === "never";
    push(
      never ? TITLE_ICON.policyNever : TITLE_ICON.policyAsk,
      never ? "green" : "yellow",
    );
  }
  // 五个开关（plan / verbose / 符号统一 / 声音提醒 / flow-track）：颜色即取值——on 绿 / off 灰
  const on: ColorName = "green";
  const off: ColorName = "gray";
  if (fields.mode?.plan)
    push(TITLE_ICON.plan, fields.mode.plan === "on" ? on : off);
  push(TITLE_ICON.verbose, switches.verbose ? on : off);
  push(TITLE_ICON.symbolUnify, switches.symbolUnify ? on : off);
  push(TITLE_ICON.bell, switches.notifyEnabled ? on : off);
  // flow-track 注入开关：未读到服务（undefined）时整项省略，避免在没装插件的 profile 里常灰
  if (switches.flowTrack !== undefined)
    push(TITLE_ICON.flowTrack, switches.flowTrack ? on : off);
  // daemon 开关：**始终显示**（未读到服务时按关灰），开关语义只在这里表达，状态列不再写「开/关」
  push(TITLE_ICON.daemon, switches.daemon === true ? on : off);

  const rawTitle = (state.sessionTitle ?? "").trim();
  const title = rawTitle === "" ? "<title>" : rawTitle;
  const MIN_TITLE = 8; // 标题至少保留 8 列，不足则按让位顺序收缩符号区
  const GAP = 2; // 符号区与标题之间 2 空格
  const widthOf = (segs: readonly FrameSegment[]): number =>
    segs.reduce((a, x) => a + displayWidth(x.text), 0);
  const compose = (withPreset: boolean): FrameSegment[] => {
    const out: FrameSegment[] = [];
    if (withPreset && presetSegs.length > 0) out.push(...presetSegs);
    if (symSegs.length > 0) {
      if (out.length > 0) out.push(seg(" "));
      out.push(...symSegs);
    }
    return out;
  };
  const used = (head: readonly FrameSegment[]): number =>
    head.length > 0 ? widthOf(head) + GAP : 0;
  let head = compose(true);
  if (head.length > 0 && width - used(head) < MIN_TITLE) head = compose(false); // ① preset 让位
  if (head.length > 0 && width - used(head) < MIN_TITLE) head = []; // ③ 符号组让位
  // ② 标题按剩余宽截断（空标题 `<title>` 占位保持边框色）
  const titleText = truncateToWidth(title, Math.max(1, width - used(head)));
  const out: FrameSegment[] = [...head];
  if (out.length > 0) out.push(seg(" ".repeat(GAP)));
  out.push(rawTitle === "" ? seg(titleText, { fg: "border" }) : seg(titleText));
  return out;
}

/** 状态列 Box 树 → 内容行（排版库唯一出行路径：layout → fillToList）。
 *  分配高取**自然高**：不让布局按帧高压缩子项——帧高只用于折叠等级与兜底截断。 */
function fillStatusColumnBox(box: Box, width: number): ContentRow[] {
  const w = Math.max(1, width);
  const rects = layout(box, w);
  const rect = rects.get(box) ?? { x: 0, y: 0, w, h: 1 };
  return fillToList({ viewportWidth: w }, box, rect, rects);
}

/** 顶部状态列（最左侧列）内容行：`width` = 状态列**正文宽**（`statusBodyW`，调用点传入）。
 *  产出 `ContentRow[]`——**不再**自建右缘竖线、不补白：截断 / 补白 / 分隔竖线由
 *  buildTopRegion 统一构图（与其它区域同口径）。
 *  折叠策略：无强制行数上限——从 L0 到 L3 依次尝试折叠等级，首次放下即采用；全部等级
 *  用尽仍放不下（goal 大头）→ 整列行级截断兜底（capRows）。
 *  滚动独立于会话区（statusColumnScroll，↑/↓ 仍滚历史，PgUp/PgDn 滚状态列）：
 *  `scroll == 0` = 折叠视图（默认视图）；`scroll > 0` = 在 L0 完整行集上开窗（见函数内注释）。 */
export function renderStatusColumn(
  goals: GoalHistory | undefined,
  todos: TodoItemLike[] | undefined,
  jobs: JobInfo[] | undefined,
  scroll: number,
  height: number,
  width: number,
  /** TUI#39：子代理目录快照（Agents 块；缺省 = 不显示该块，保持既有调用口径） */
  agents?: AgentRowInfo[] | undefined,
  /** 当前 goal 的自动续轮开关展示值（`goalActivationDisplay`；缺省 = 不显示 ⟳） */
  activation?: GoalActivation | undefined,
  /** BACKLOG #1：Agents 块前导符号的闪烁相位来源（虚拟 token 累计；缺省 0 = 静态） */
  runTokens = 0,
  /** 条目 30：goal 进度（当前轮 / 上限） */
  goalRounds?:
    { started?: number | undefined; max?: number | undefined } | undefined,
  /** 新增五块的快照（task / flow / pin / daemon / group）。 */
  extras?: StatusExtras | undefined,
): ContentRow[] {
  const h = Math.max(1, height);
  const w = Math.max(1, width);
  const data: StatusColumnData = {
    goals,
    todos,
    jobs,
    agents,
    activation,
    // 条目 1：条目行符号的闪烁节拍 = 全局相位序号（虚拟 token 积分单调递增，App 的节拍门
    // 已含「有子代理在跑」）→ 各代理再按自己的 tps 分档取相位，相对快慢即不同
    tick: Math.floor(runTokens / RUN_TOGGLE_TOKENS),
    goalRounds,
    extras,
  };
  // 滚动（用户 2026-10-12 裁定「恢复真滚动」+ 口径 A「滚动即展开」）：
  //  scroll == 0 → 折叠视图（L0→L3 首次放得下即采用 + capRows 兜底）＝ 默认视图，逐字同改造前；
  //  scroll > 0  → 在 **L0（不折叠）完整行集**上开窗（不 capRows）——被 L1/L2/L3 折叠掉、或被
  //                capRows 截掉的条目由此全部可滚到；PgUp 回到 0 即恢复折叠视图。
  //  窗口起点由 statusStartFor clamp 到 [0, len − h]，故状态侧只需非负 clamp（不引入几何耦合）。
  if (scroll > 0) {
    const full = fillStatusColumnBox(buildStatusColumnBox(data, 0), w);
    const start = statusStartFor(full.length, scroll, h);
    return full.slice(start, start + h);
  }
  let body: ContentRow[] = [];
  for (const level of [0, 1, 2, 3] as const) {
    body = fillStatusColumnBox(buildStatusColumnBox(data, level), w);
    if (body.length <= h) break;
  }
  if (body.length > h) body = capRows(body, h);
  // 折叠视图长度必 ≤ h（capRows 兜底）→ 起点恒 0
  return body.slice(0, h);
}
