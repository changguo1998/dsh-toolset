// src/app/state.ts — 状态模型 + 纯 reducer
//
// buffer 持有会话文本行（无界，超出 MAX_BUFFER_LINES 裁剪旧行）。
// 滚动状态：followBottom 跟随底部；scrollOffset = 上滚的行单位偏移。

import type {
  ApprovalItem,
  AgentStatus,
  SessionMeta,
  QuestionItem,
  SessionInfo,
  HistoryMessage,
  NoticeTone,
  CompactionSummaryPayloadLike,
  GoalOperation,
  GoalRefLike,
  GoalSnapshotLike,
  TodoItemLike,
  JobInfo,
  CommandPanelRow,
  CommandPanelKind,
} from "./adapter/dsh.ts";
import type { ModelSelection, ModelSelectionLike } from "./adapter/dsh.ts";
import type { ActivityPlacement } from "./config.ts";
import {
  DIALOGUE_KEEP_REPLIES,
  DIALOGUE_MARKER_SEQ,
  WINDOW_GROW_STEP,
  anchorToIndex,
  anchorToOffset,
  dialogueWindow,
  emptyRunVirt,
  estimateOutputTokens,
  moveDialogueAnchor,
  nextRunVirt,
  turnGroupStarts,
  virtTick,
  VIRT_SPEED_MIN,
  TOKEN_CALIB_ALPHA,
  TOKEN_CALIB_MAX,
  TOKEN_CALIB_MIN,
  type DialogueAnchor,
  type DialogueGeometry,
  type RunVirtState,
} from "./layout.ts";
import { completeCommandInput, type CommandCandidate } from "./commands.ts";
import { DEFAULT_THEME, type ThemeId } from "../renderer/theme.ts";
import {
  codeDispatchLine,
  commandErrorLine,
  commandRunLine,
  hookLine,
  retryStartedLine,
  stepHeaderLine,
  subagentLine,
  toolCallLine,
  toolResultLine,
  workflowLine,
} from "./layout/tool-line.ts";

/** 顶部三面板 Tab 焦点循环顺序（history → activity → status → history） */
export const PANEL_CYCLE = ["history", "activity", "status"] as const;

/** scrollback 行数上限（纯物理上限；DESIGN:2000 行） */
export const MAX_BUFFER_LINES = 2000;

/** 用户块左缘/回复右缘对称留空默认列数（可经 initialState 配置，交错布局用）。
 *  6：两侧各留 gutter-1 = 5 列 → 输入最长折行左缘对齐回复正文第 5 个字符。 */
export const DEFAULT_MESSAGE_GUTTER = 6;

/** 输入栏临时模式（$ shell / / slash；提交后自动回退 normal，不再有 Esc 回退） */
export type InputMode = "normal" | "shell" | "slash";

/** 输入状态（状态栏最左侧符号）：绿✓=成功 / 红✗=失败 / 黄●/○=运行中（实心/空心
 *  圆按流式输出节奏交替，见 RUN_TOGGLE_CHARS）/ 黄△=等待交互（审批/问答面板打开等
 *  用户决策）/ idle=尚无结果（渲染回退 ?，未知状态也回退 ?） */
export type InputStatus =
  "success" | "failure" | "running" | "waiting" | "idle";

/** 缓冲行类型:用户输出靠右缩进展示,模型正文靠左;思考行限高,完成后清除 */
export type BufferKind =
  "user" | "assistant" | "thinking" | "notice" | "tool" | "separator" | "plain";

/** 缓冲行:纯文本 + 类型标记(展示时决定缩进/配色) + 可选 tone（notice/tool 行着色分级）
 *  final: true = 该回合最终总结（历史区展示）；false/缺省 = 过程行（活动区展示） */
export interface BufferLine {
  text: string;
  kind: BufferKind;
  /** 稳定行序号（插入时分配；语义锚点身份——buffer 被 filter/裁剪后行下标会平移，
   *  序号不变，故「视口顶行」在清瞬态行/裁剪后仍指向同一内容） */
  seq?: number;
  tone?: NoticeTone;
  /** 回合最终总结标记：turn-end 时由 markFinalSummary 打标；历史恢复行恒为 true */
  final?: boolean;
  /** 排队中的用户消息（历史区右下角的待发块；右缘竖线改灰色标识未发出） */
  queued?: boolean;
  /** 悬垂缩进（notice 用，/help 双列表格）：本行折行时续行停靠列（描述列起点） */
  hanging?: number;
  /** 紧凑模式（/verbose off）豁免：本行仍完整折行显示（/help 用，不被压成 1 行隐藏） */
  noCompact?: boolean;
}

export type Buffer = BufferLine[];

/** 系统状态区各字段：time/cwd/git 由 StatusTicker 合并节流读取，其余为占位 */
export interface SystemStatus {
  time: string;
  cwd: string;
  git: string;
  /** 无数据源时的占位符（上下文长度/缓存命中率；model 默认占位、切换会话模型后更新） */
  model: string;
  /** 思考后缀：none=不支持、off=支持但未开启、on=单等级开启、实际等级名=多等级开启（缺失=未知，按 none 渲染） */
  modelThinking?: string;
  contextLen: string;
  cacheHit: string;
}

/** turn 分隔线（横线占位；实际宽度由历史区换行决定） */
export const TURN_SEPARATOR = "--------";

/** P2 goal 状态（判别联合同 DshEvent：set 完整保留快照字段，clear 保留墓碑 ref） */
export type GoalState =
  | {
      status: "set";
      operation: Exclude<GoalOperation, "clear">;
      goal: GoalSnapshotLike;
      roundsStarted?: number;
      createdAt?: number;
      updatedAt?: number;
    }
  | {
      status: "cleared";
      operation: "clear";
      cleared: GoalRefLike;
      clearedAt?: number;
    };

/** P2 selector：取当前会话 set 态 goal 快照（含 objective/phase）；无/清除 → undefined */
export function activeGoalSnapshot(
  state: AppState,
  sessionId: string | undefined,
): GoalSnapshotLike | undefined {
  if (!sessionId) return undefined;
  const g = state.goalBySession[sessionId];
  if (!g || g.status !== "set") return undefined;
  return g.goal;
}

/** P2 模式徽标状态（plan 用 "on"/"off"；sandbox/permission 存原始值字符串；缺省省略） */
export interface ModeState {
  plan?: "on" | "off";
  sandbox?: string;
  permission?: string;
}

/** 历史会话面板阶段：列表加载 → 列表 → 会话加载 → 浏览 → 错误（任一阶段可关闭） */
export type HistoryPhase =
  | "loading-list"
  | "list"
  | "loading-view"
  | "view"
  | "resuming"
  | "confirm-delete"
  | "deleting"
  | "confirm-clean"
  | "cleaning"
  | "error";

/** /history 历史会话面板状态（只读浏览；list 与 view 两阶段） */
export interface HistoryPanelState {
  phase: HistoryPhase;
  /** 会话列表（newest-first；list 阶段填充） */
  records: SessionInfo[];
  /** 列表高亮索引 */
  index: number;
  /** view 阶段浏览的会话 id */
  currentId?: string;
  /** view 阶段归一化消息列表 */
  messages: HistoryMessage[];
  /** view 阶段滚动行偏移（渲染层按可视高度 clamp） */
  scroll: number;
  /** error 阶段错误消息 */
  error?: string;
  /** resume 切换的目标会话 id（resuming 阶段）；成功后清空 */
  pendingResume?: string;
  /** confirm-delete/deleting 阶段的目标会话 id（确认后由调用方经 adapter 删除） */
  pendingDelete?: string;
  /** confirm-delete/deleting 阶段的**批量**目标会话 id（有标记时按标记集删除；
   *  与 pendingDelete 互斥，二者恰有其一非空） */
  pendingDeleteIds?: string[];
  /** 批量删除标记集（Space 标记/取消、a 全选当前范围、c 清空；按 id 记录，跨范围切换保留） */
  marked?: string[];
  /** confirm-clean/cleaning 阶段待清理的空会话 id 列表（范围=当前列表范围） */
  pendingClean?: string[];
  /** confirm-clean/cleaning 阶段的当前项目路径（确认文案展示） */
  cleanCwd?: string;
  /** 面板内结果提示（删除/清理结果与护栏文案；首行展示，下次操作时清除）。
   *  面板占满活动区时 notice 不可见（notice 归活动区），故结果需面板内呈现 */
  result?: string;
  /** 列表范围：project=仅当前目录（默认）/ all=全部目录；list 阶段 [Tab] 切换 */
  scope?: "project" | "all";
}

/** 当前项目路径：活跃会话记录的 cwd 优先，回退状态区 cwd（占位符不算）；未知 → undefined */
export function currentProjectCwd(state: AppState): string | undefined {
  const rec = state.history?.records.find((r) => r.current === true);
  if (rec?.cwd !== undefined) return rec.cwd;
  const cwd = state.systemStatus.cwd;
  return cwd !== "" && cwd !== "—" ? cwd : undefined;
}

/**
 * 当前列表范围下可清理的空会话 id：范围跟随可见列表（scope=all → 全部目录；
 * project（默认）→ 与活跃会话同 cwd），且已持久化、非 live、无用户消息
 * （SessionInfo.isEmpty）。project 范围下无法确定当前项目 → 空数组。
 */
export function cleanableSessionIds(state: AppState): string[] {
  const h = state.history;
  if (!h) return [];
  const all = h.scope === "all";
  const cwd = currentProjectCwd(state);
  if (!all && cwd === undefined) return [];
  const ids: string[] = [];
  for (const r of h.records) {
    // 可清理：已持久化、非 live、非当前、范围内（全部或同项目）、无用户消息
    if (
      r.isEmpty === true &&
      r.persisted === true &&
      !r.live &&
      r.current !== true &&
      (all || r.cwd === cwd)
    ) {
      ids.push(r.id);
    }
  }
  return ids;
}

/**
 * 启动自动清理的空会话 id（全目录范围）：
 * 已持久化 + 非 live + 非当前 + 无用户消息（SessionInfo.isEmpty）。
 * 与面板 cleanableSessionIds 同判据，仅不依赖 history 面板状态（启动时未必打开）。
 */
export function startupCleanableIds(records: readonly SessionInfo[]): string[] {
  const ids: string[] = [];
  for (const r of records) {
    if (
      r.isEmpty === true &&
      r.persisted === true &&
      !r.live &&
      r.current !== true
    ) {
      ids.push(r.id);
    }
  }
  return ids;
}

/**
 * 面板当前范围下的可见会话：project（默认）只保留与当前目录同 cwd 的会话，
 * all 返回全量。当前目录无法识别（无活跃记录且状态区为占位）→ 空列表：
 * 由渲染层给出明确空态，不静默把全量当作「当前目录」展示。
 */
export function historyVisibleRecords(state: AppState): SessionInfo[] {
  const h = state.history;
  if (!h) return [];
  if (h.scope === "all") return h.records;
  const cwd = currentProjectCwd(state);
  if (cwd === undefined) return [];
  return h.records.filter((r) => r.cwd === cwd);
}

/**
 * 单条会话可删除判据：已持久化 + 非 live + 非当前活跃。
 * 面板 d（单条）、Space 标记、a 全选与批量删除共用同一守卫。
 */
export function deletableSession(rec: SessionInfo): boolean {
  return rec.persisted === true && !rec.live && rec.current !== true;
}

/** 当前列表范围下可标记（可删除）的会话 id 集：a 全选与批量确认的范围来源 */
export function markableSessionIds(state: AppState): string[] {
  return historyVisibleRecords(state)
    .filter(deletableSession)
    .map((r) => r.id);
}

/** 从列表移除若干会话 id：按新范围可见数收敛高亮索引、清空 pending/查看态字段并回到 list。
 *  标记集只摘除已删除项（部分失败时失败项保留标记，便于重试）。 */
function dropHistoryRecords(
  h: HistoryPanelState,
  ids: readonly string[],
  visibleIds: readonly string[],
): HistoryPanelState {
  const drop = new Set(ids);
  const records = h.records.filter((r) => !drop.has(r.id));
  const visibleCount = visibleIds.filter((id) => !drop.has(id)).length;
  return {
    ...h,
    phase: "list",
    records,
    index: Math.max(0, Math.min(visibleCount - 1, h.index)),
    pendingDelete: undefined,
    pendingDeleteIds: undefined,
    pendingClean: undefined,
    cleanCwd: undefined,
    marked: h.marked?.filter((id) => !drop.has(id)),
    currentId: undefined,
    messages: [],
    scroll: 0,
  };
}

/** 共享列表面板状态（/skills、/agents、/tools 共用一套 reducer 与渲染；契约见 COMMANDS-SPEC.md §4） */
export interface CommandPanelState {
  kind: CommandPanelKind;
  /** 高亮行索引（clamp 到 rows 范围；可见窗口随 index 平移） */
  index: number;
  /** 归一化行（打开后经 command-panel-data 到达） */
  rows: CommandPanelRow[];
  /** 数据尚未到达（open 置 true；data 写入后清除） */
  loading?: boolean;
  /** 数据侧错误（渲染为红行） */
  error?: string;
}

export interface AppState {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  /** 会话纯文本行（未换行，展示时才按列宽切分） */
  buffer: Buffer;
  /** 是否跟随底部（= scrollAnchor 为 null；由锚点派生，供既有调用口径使用） */
  followBottom: boolean;
  /** 距底部行数（派生缓存：每帧由布局回填，供既有调用与断言口径使用） */
  scrollOffset: number;
  /** 对话区语义锚点（视口顶行 = (buffer 行, 行内换行序号)；null = 跟随底部/最新）。
   *  位置身份化：底部新增内容、resize 重排、渐进窗口扩窗都不会把视图顶走 */
  scrollAnchor: DialogueAnchor | null;
  /** 渐进窗口：物化的尾部回合组数（上滚接近窗口顶部时增大；回到最新时复位默认） */
  windowGroups: number;
  /** 下一个可用的 buffer 行序号（单调递增；只增不减，裁剪/清行后不复用） */
  nextSeq: number;
  /** 对话区滚动几何（派生缓存：每帧由布局回填 + 由滚动 action 的 geom 覆盖） */
  dialogueGeometry: DialogueGeometry;
  inputText: string;
  inputCursor: number;
  /** 排队消息（**已按官方流程 followup 交给核心 next-turn 队列**、但本回合尚未被
   *  认领的文本，按提交顺序；本机只用于显示——核心认领最早一条时该条转入历史流。
   *  空数组 = 无排队） */
  queued: string[];
  /** 输入模式（符号代表模式；提交后自动回退 normal） */
  inputMode: InputMode;
  /** 输入状态（状态栏最左侧符号来源）：绿✓=成功 / 红✗=失败 / 黄●/○=运行中（按
   *  流式输出节奏交替）/ 黄△=等待交互（审批/问答面板打开）/ idle=尚无结果（渲染回退 ?） */
  inputStatus: InputStatus;
  approval: ApprovalItem | null;
  agentStatus: AgentStatus;
  /** 最新一次模型调用的 token 用量（assistant/message.usage 归一化；阶段 2 状态栏 contextLen/cacheHit 读取） */
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    contextWindow?: number;
  };
  systemStatus: SystemStatus;
  /** 主题（默认 dark=fffdark；/theme 运行时切换，仅当前会话） */
  themeId: ThemeId;
  /** 用户块左缘/回复右缘对称留空列数（交错布局，默认 4，可配置） */
  messageGutter: number;
  /** 用户块左缘/回复右缘对称留空列数（交错布局，默认 4，可配置） */
  /** 布局配置（false 语义：footerHeight/divisor undefined=默认） */
  footerHeight: number | undefined;
  /** 活动区高分母（contentTopH / divisor；默认 2 ≈ 1/2） */
  activityDivisor: number | undefined;
  /** 活动区分隔行锚定（"half" = floor(rows/2)，或绝对行号；配置后替代 divisor 比例；undefined = 走 divisor） */
  activityTopRow: "half" | number | undefined;
  /** 活动区排列方式（tui.config.json layout.activityPlacement；undefined = 恒上下排列，
   *  "auto" = 按黄金比自动在上下/左右间选择，见 topPaneSplit） */
  activityPlacement: ActivityPlacement | undefined;
  /** 状态列宽分母（cols / divisor；默认 3 ≈ 1/3） */
  statusDivisor: number | undefined;
  /** 模型交互选择模式（/model 无参进入；null = 未激活） */
  picker: PickerState | null;
  /** 问答面板（userQuestions 提问；null = 未激活） */
  question: QuestionPanelState | null;
  /** /history 历史会话面板（只读浏览 + resume 切换）；null = 未打开 */
  history: HistoryPanelState | null;
  /** 通用状态选项面板（/policy /permission /preset 无参打开；↑/↓ 选、空格预选、Enter 提交关闭） */
  statusPanel: StatusPanelState | null;
  /** 当前会话标题（resume 后由 surface 首条用户消息生成；新会话为空，状态栏以 <title> 占位） */
  sessionTitle: string;
  /** P2：按 sessionId 隔离的 goal 状态（判别联合；完整保留原始载荷字段） */
  goalBySession: Record<string, GoalState>;
  /** P2：按 sessionId 隔离的 todo 列表（全量快照 last-write-wins） */
  todoBySession: Record<string, TodoItemLike[]>;
  /** P2：按 sessionId 隔离的模式徽标（plan/sandbox/permission 三合一） */
  modeBySession: Record<string, ModeState>;
  /** C 阶段：按 sessionId 隔离的当前审批策略（approval/policy 事件 latest-wins；无则为 undefined=未收到省略） */
  policyBySession: Record<string, "ask" | "never">;
  /** P2：按 sessionId 隔离的 compaction 摘要（每会话仅最近一条；raw 完整保留） */
  compactionBySession: Record<
    string,
    { raw: CompactionSummaryPayloadLike; text: string }
  >;
  /** B3：step 分组（当前活动工具组；headerEmitted=分组头已插入，供步内首条工具行插头） */
  stepGroup: {
    sessionId: string;
    step: number;
    headerEmitted: boolean;
  } | null;
  /** P3：按 sessionId 隔离的 agent 预设（agent-preset/selected 事件 latest-wins；无=未收到） */
  presetBySession: Record<string, string>;
  /** 事件回读的生效模型（model/selection）；状态栏模型徽标 fallback 来源 */
  modelBySession: Record<string, ModelSelectionLike | undefined>;
  /** 权限预设目录（ctx.permissionPresets.names；状态列 Mode 块 permission 可选项；[]=未同步降级三档） */
  permissionOptions: string[];
  /** agent 预设目录（ctx.agentPresets.list 的 id；状态列 Mode 块 preset 可选项；[]=未同步降级当前值） */
  presetOptions: string[];
  /** P3：最近一次后台任务快照（adapter 经 onJobsChanged 推送；[]=无任务） */
  jobs: JobInfo[];
  /** P3：/jobs 任务面板（null=未打开；index=高亮行，Enter 取消） */
  jobsPanel: { index: number } | null;
  /** 共享列表面板（/skills、/agents、/tools 共用；null = 未打开） */
  commandPanel: CommandPanelState | null;
  /** 输入命令补全候选（输入仍处于首个命令 token 时存在；index 0 = 最匹配默认项；null=无候选/未激活） */
  completion: { items: readonly CommandCandidate[]; index: number } | null;
  /** 宿主命令注册表目录（ctx.commands.list，启动同步一次；补全候选并入，同名以本地目录优先） */
  registryCommands: readonly CommandCandidate[];
  /** P3：顶部状态列纵向滚动偏移（详细 goal/todo；渲染层 clamp） */
  statusColumnScroll: number;
  /** 顶部三面板键盘选中：null=无焦点（新输入/输出后回到无焦点，Tab 才进入）；history=对话历史 / activity=流输出 / status=详细状态列 */
  focusedPanel: "history" | "activity" | "status" | null;
  /** 活动区（流输出）滚动偏移（距活动区底部行数；0=跟随最新，渲染层 clamp） */
  activityScroll: number;
  /** 活动区是否完整显示（verbose）：true=每条目完整折行显示（缺省）；
   *  false=紧凑模式（SPEC §6.8 状态 2：每条目压 1 行 + 行尾省略号）。`/verbose on|off` 切换 */
  activityVerbose: boolean;
  /** 模型输出符号统一（symbol-unify）：true=把变体符号替换为推荐符号并提醒（缺省）；
   *  false=关闭（原样展示，不替换不提醒）。`/symbol-unify on|off` 切换 */
  symbolUnify: boolean;
  /** 声音提醒总开关（tui.config.json `notify.enabled`；启动时接线）。无会话内切换路径，
   *  状态列 Mode 块按其当前值只读展示（勾绿 / 叉灰） */
  notifyEnabled: boolean;
  /** 本回合剔除的非打印控制字符计数（appendStream 累计；turn-begin 清零、turn-end 警告） */
  strippedChars: number;
  /** 运行中闪烁虚拟状态（速度/虚拟总 token/时间基准/速率估计窗口）。run 边界 =
   *  两次用户输入之间：下次用户输入（turn-begin clearActivity=true）时重置；
   *  turn-end 仅把速度更新为下限（输出停止），虚拟总 token 保留 */
  runVirt: RunVirtState;
  /** 本 step 估算 token 累计（P5：流末 usage 真值到达时用于校准 tokenCalib） */
  stepEstTokens: number;
  /** 估算 token 校准系数（P5：usage 真值/估算值的 EMA，跨 step 保留，缺省 1） */
  tokenCalib: number;
}

/** /model 交互选择面板状态：三列列表（provider/model/effort）+ 高亮索引 */

/** 通用状态选项面板（/policy /permission /preset）：单列选项 + 预选星号。
 *  index=焦点行（>）；selected=预选值（空格写入/同值取消；Enter 提交它，回退焦点行）。 */
export interface StatusPanelState {
  kind: "policy" | "permission" | "preset";
  /** 标题（命令名 + 说明） */
  title: string;
  /** 选项列表（id=提交值；label 显示名；desc 后缀说明） */
  options: { id: string; label?: string; desc?: string }[];
  /** 焦点行 */
  index: number;
  /** 预选（星号所指）；Enter 提交它，无预选回退焦点行 */
  selected: string | null;
}
export interface PickerState {
  /** 去重后的 provider 列表 */
  providers: string[];
  /** provider 列高亮索引 */
  providerIndex: number;
  /** 每个 provider 的模型列表（model 列随 provider 动态调整） */
  providerModels: Record<string, string[]>;
  /** 选中 provider（星号）的模型列表（跟随星号移动，不随 > 焦点切换） */
  models: string[];
  /** model 列高亮索引 */
  modelIndex: number;
  /** 选中模型（星号）的思考等级选项（id/name；非思考模型为空） */
  efforts: { id: string; name: string }[];
  /** thinking 列高亮索引 */
  effortIndex: number;
  /** 焦点区：0=provider 列，1=model 列，2=thinking 列（Tab 循环切换三列同屏） */
  phase: 0 | 1 | 2;
  /** 待提交选中（各列星号标记；Enter 提交它，独立于焦点箭头） */
  selectedProvider?: string;
  selectedModel?: string;
  selectedEffort?: string;
  /** 当前生效选择（各列浅绿显示） */
  current?: ModelSelection;
}

/** 选择面板单个选项 */
/** 选择面板单个选项 */
export interface PickerOption {
  /** 纯 ASCII 展示文本，如 "deepseek/deepseek-chat" */
  label: string;
  /** 确认后应用的模型选择 */
  selection: ModelSelection;
  /** 是否为当前会话模型（行内标记 + 高亮） */
  current: boolean;
}

/** 问答面板单题交互状态 */
export interface QuestionPanelItem {
  id: string;
  question: string;
  /** 待审计划正文（plan-review intent 展示用） */
  detail?: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  intent?: { kind: "plan-review"; approve: string };
  /** 列表高亮索引：0..options.length（=options.length 表示高亮在“自定义回答”兜底项） */
  optionIndex: number;
  /** 已选选项 label（单选最多 1 项；多选可多项） */
  selected: string[];
  /** 自定义回答文本 */
  custom: string;
}

/** 问答面板整体状态（一次 ask() = 一批题；每屏显示一题，第 n/m 题导航） */
export interface QuestionPanelState {
  /** 面板 id（question 事件 id，answerQuestion/cancelQuestion 用它） */
  id: string;
  items: QuestionPanelItem[];
  /** 当前显示题号（0-based） */
  itemIndex: number;
}

export function initialState(
  themeId: ThemeId = DEFAULT_THEME,
  opts?: {
    messageGutter?: number;
    footerHeight?: number;
    activityDivisor?: number;
    activityTopRow?: "half" | number;
    activityPlacement?: ActivityPlacement;
    statusDivisor?: number;
    /** 声音提醒总开关（缺省 true，与 App 的 `deps.notify?.enabled ?? true` 同口径） */
    notifyEnabled?: boolean;
  },
): AppState {
  const messageGutter =
    opts?.messageGutter === undefined
      ? DEFAULT_MESSAGE_GUTTER
      : Math.max(0, Math.floor(opts.messageGutter));
  const footerHeight =
    opts?.footerHeight === undefined
      ? undefined
      : Math.max(1, Math.floor(opts.footerHeight));
  const activityDivisor =
    opts?.activityDivisor === undefined
      ? undefined
      : Math.max(1, Math.floor(opts.activityDivisor));
  const activityTopRow =
    opts?.activityTopRow === "half"
      ? "half"
      : typeof opts?.activityTopRow === "number" &&
          Number.isFinite(opts.activityTopRow)
        ? Math.max(0, Math.floor(opts.activityTopRow))
        : undefined;
  const statusDivisor =
    opts?.statusDivisor === undefined
      ? undefined
      : Math.max(1, Math.floor(opts.statusDivisor));
  const activityPlacement: ActivityPlacement | undefined =
    opts?.activityPlacement === "auto" ||
    opts?.activityPlacement === "vertical" ||
    opts?.activityPlacement === "horizontal"
      ? opts.activityPlacement
      : undefined;
  return {
    sessions: [],
    activeSessionId: null,
    sessionTitle: "", // 默认标题为空，渲染层（renderStatusLine）用 <title> 占位
    goalBySession: {},
    todoBySession: {},
    modeBySession: {},
    policyBySession: {},
    compactionBySession: {},
    stepGroup: null,
    presetBySession: {},
    modelBySession: {},
    permissionOptions: [],
    presetOptions: [],
    jobs: [],
    jobsPanel: null,
    commandPanel: null,
    statusColumnScroll: 0,
    focusedPanel: null, // 无焦点；Tab 进入焦点循环
    activityScroll: 0,
    activityVerbose: true, // 活动区完整显示（缺省）；/verbose off 切紧凑
    symbolUnify: true, // 模型输出符号统一（缺省开）；/symbol-unify off 切原样
    notifyEnabled: opts?.notifyEnabled ?? true, // 声音提醒（配置项，只读展示）
    strippedChars: 0, // 本回合剔除的非打印控制字符计数（turn-begin 清零）
    runVirt: emptyRunVirt(), // 运行中闪烁虚拟状态（下次用户输入时重置）
    stepEstTokens: 0, // 本 step 估算 token 累计（usage 真值到达时校准）
    tokenCalib: 1, // 估算 token 校准系数（usage 真值/估算值 EMA，跨 step 保留）
    buffer: [],
    followBottom: true,
    scrollOffset: 0,
    scrollAnchor: null,
    windowGroups: DIALOGUE_KEEP_REPLIES,
    nextSeq: 1,
    dialogueGeometry: { rows: 0, height: 0, spans: [], topIdx: 0 },
    inputText: "",
    inputCursor: 0,
    queued: [], // 无排队（agent 运行期间 Enter 的文本登记在此，核心认领后转入历史）
    inputMode: "normal",
    inputStatus: "idle",
    approval: null,
    picker: null,
    question: null,
    statusPanel: null,
    completion: null,
    registryCommands: [],
    history: null,
    agentStatus: "idle",
    themeId,
    systemStatus: {
      time: "—",
      cwd: "—",
      git: "—",
      model: "—",
      contextLen: "—",
      cacheHit: "—",
    },
    messageGutter,
    footerHeight,
    activityDivisor,
    activityTopRow,
    activityPlacement,
    statusDivisor,
  };
}

/** 清理文本中的非打印控制字符（渲染保护）：CRLF/孤立 CR 归一为 LF，
 *  其余 C0/C1 控制字符（含 \t）剔除；返回清理后文本与被剔除字符数。
 *  ponytail: 按码点扫描，不处理组合符/零宽字符（宽度原语同样不处理）。 */
export function sanitizeText(text: string): { text: string; stripped: number } {
  // 1) 换行符归一：CRLF/孤立 CR → LF（\r 属换行语义，不计入 stripped）
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // 2) 剔除其余 C0/C1 控制字符（\n 保留；终端遇 \r 回行首抹内容、遇其他控制符
  //    会乱码或破坏帧布局，统一移除）。完整 ANSI 转义序列（CSI ESC[…、OSC ESC]…BEL/ST）
  //    是样式/光标控制，属已有功能（渲染着色、/copy 剥离），保留不剔；孤立/残缺序列剔除。
  let out = "";
  let stripped = 0;
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "\n") {
      out += ch;
      i++;
      continue;
    }
    if (ch === "\x1b") {
      const rest = normalized.slice(i);
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
      if (csi) {
        out += csi[0];
        i += csi[0].length;
        continue;
      }
      const osc = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest);
      if (osc) {
        out += osc[0];
        i += osc[0].length;
        continue;
      }
      stripped++; // 孤立/残缺 ESC
      i++;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      stripped++;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, stripped };
}
/**
 * 追加流式文本。语义：
 *  - 文本中的第一个段落（不含换行符）合并到 buffer 末行（流式续写）
 *  - 换行之后的段落各自新开一行
 *  - 若文本以换行结尾，末尾出现一个空行
 *  - 末行为 turn 分隔线时不合并（分隔线是硬边界，下个 turn 另起一行）
 *  - `kind="user"` 例外：整段保留（含显式换行）为**一条** buffer 行——一次输入
 *    即一个用户块，布局层按物理行折行渲染（块内行首左对齐、块宽 = 最长行、整块右对齐）
 */
export function appendStream(
  state: AppState,
  text: string,
  kind: BufferKind = "assistant",
  /** 流式事件到达时刻（ms；assistant/thinking 时驱动虚拟速度/虚拟总 token 更新） */
  time?: number,
): AppState {
  // 思考/正文分属活动区与历史区两个窗口：正文到达不清思考，思考保留显示到本
  // turn 结束，由下轮 turn-begin 统一清空（活动区瞬态整轮重置）。
  const buffer = state.buffer.length ? [...state.buffer] : [];
  // 渲染保护：剔除非打印控制字符（CRLF/孤立 CR 归一为 LF、其余 C0/C1 移除），
  // 剔除计数累计入 state.strippedChars，turn-end 时统一警告
  const { text: clean, stripped } = sanitizeText(text);
  // 用户输入不按 \n 拆行（多行输入 = 一块）；流式 assistant/thinking 仍逐行拆
  const parts = kind === "user" ? [clean] : clean.split("\n");
  const lastIndex = buffer.length - 1;
  const last = buffer[lastIndex];
  let seq = state.nextSeq;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // 首个段落合并进末尾同类行(流式续写)；不合并时不产生中间状态
    if (i === 0 && last && last.kind === kind && last.kind !== "separator") {
      if (part !== "") buffer[lastIndex] = { ...last, text: last.text + part };
    } else {
      // 新行分配稳定序号（同块续写沿用原行序号）
      buffer.push({ text: part, kind, seq: seq++ });
    }
  }
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  // 模型流式输出（assistant/thinking）推进虚拟状态（窗口速率估计 → slew/clamp
  // 虚拟速度 → 虚拟总 token 积分，驱动 ●/○ 交替）；用户行不参与。
  // 估算 token 按 tokenCalib 校正（P5：流末 usage 真值学习）；stepEstTokens 累计
  // 原始估算量供校准对比
  const streamed = kind === "assistant" || kind === "thinking";
  const estTokens = streamed ? estimateOutputTokens(clean) : 0;
  const virt = streamed
    ? nextRunVirt(state.runVirt, time, estTokens * state.tokenCalib)
    : undefined;
  return {
    ...state,
    buffer,
    nextSeq: seq,
    strippedChars: state.strippedChars + stripped,
    ...(virt
      ? { runVirt: virt, stepEstTokens: state.stepEstTokens + estTokens }
      : {}),
  };
}

/**
 * 追加一条命令通知(notice)：独立成行，不并入 buffer 末行(与流式 append 不同)。
 * 用于 slash 命令的提示/结果文本(绝不进入模型历史，仅 UI 展示)。
 */
export function appendNotice(
  state: AppState,
  text: string,
  error = false,
  tone?: NoticeTone,
): AppState {
  // 多行 notice 拆成多行 buffer，否则 wrapLine 把 \n 当普通字符(宽1)会让列宽对不齐，
  // 字词在中间被截断(例如 /quit 在 i 与 t 之间换行)。
  const buffer = state.buffer.length ? [...state.buffer] : [];
  let seq = state.nextSeq;
  for (const line of sanitizeText(text).text.split("\n"))
    buffer.push({
      text: line,
      kind: "notice",
      seq: seq++,
      ...(tone ? { tone } : {}),
    });
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  // 失败标记(error notice，如未知 slash 命令 fail-close)→ 输入栏失败色(红)；
  // agent 仍活跃时保持黄（活跃守卫），绿/红仅空闲时暴露
  return {
    ...state,
    buffer,
    nextSeq: seq,
    inputStatus: error ? statusFor(state, "failure") : state.inputStatus,
  };
}

/** 一条可挂载悬垂缩进的 notice 行（/help 双列表格：折行续行停靠到描述列） */
export interface NoticeLine {
  text: string;
  hanging?: number;
  /** 紧凑模式（/verbose off）豁免：仍完整折行显示（如 /help 双列表格），不被压成 1 行 */
  noCompact?: boolean;
}

/**
 * 追加多条命令通知（带可选悬垂缩进）：每条独立成行（不并入 buffer 末行）。
 * /help 双列表格用它让续行停靠到描述列起点；普通 notice 仍走 appendNotice。
 */
export function appendNoticeLines(
  state: AppState,
  lines: readonly NoticeLine[],
  tone?: NoticeTone,
): AppState {
  const buffer = state.buffer.length ? [...state.buffer] : [];
  let seq = state.nextSeq;
  for (const l of lines) {
    for (const line of sanitizeText(l.text).text.split("\n"))
      buffer.push({
        text: line,
        kind: "notice",
        seq: seq++,
        ...(tone ? { tone } : {}),
        ...(l.hanging !== undefined ? { hanging: l.hanging } : {}),
        ...(l.noCompact === true ? { noCompact: true } : {}),
      });
  }
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  return { ...state, buffer, nextSeq: seq };
}

/**
 * 追加一条工具行（工具调用 ○ / 结果 ✓|✗）：独立成行、不进模型历史（与 notice 同）。
 * tone=error 时渲染红色（工具结果失败 ✗），其余默认色。
 */
export function appendToolLine(
  state: AppState,
  text: string,
  tone?: NoticeTone,
  params?: { keepLineBreaks?: boolean },
): AppState {
  // 工具内容可能夹带 \r/\n/控制符（参数/结果原文）。剔除其余非打印字符、避免控制符
  // 干扰终端（宽度限制由渲染层按窗口宽度处理）；\n 默认折叠成单行（结果/辅助行），
  // 工具调用参数行保留换行（keepLineBreaks，渲染层 split + 续行 4 空格缩进）
  const clean = sanitizeText(text).text;
  const text2 = params?.keepLineBreaks ? clean : clean.replace(/\n/g, " ");
  const buffer = state.buffer.length ? [...state.buffer] : [];
  buffer.push({
    text: text2,
    kind: "tool",
    seq: state.nextSeq,
    ...(tone ? { tone } : {}),
  });
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  return { ...state, buffer, nextSeq: state.nextSeq + 1 };
}

/**
 * B3：step 分组工具行——当前活动 step 组尚未插分组头时先插入 `step N`，再追加工具行。
 * 无 step 上下文（旧会话 / mock 无 step 事件）时不插头，保持既有 append-only 行为。
 */
export function appendStepToolLine(
  state: AppState,
  sessionId: string,
  text: string,
  tone?: NoticeTone,
  params?: { keepLineBreaks?: boolean },
): AppState {
  const group = state.stepGroup;
  if (!group || group.sessionId !== sessionId)
    return appendToolLine(state, text, tone, params);
  // 分组头先插（组内首条工具行前），随后标记已发头，避免重复插头
  const next = group.headerEmitted
    ? state
    : appendToolLine(state, stepHeaderLine(group.step));
  return {
    ...appendToolLine(next, text, tone, params),
    stepGroup: { ...group, headerEmitted: true },
  };
}

/**
 * 追加模型思考行。复用流式续写(并入末尾 thinking 行)语义；思考显示于活动区，
 * 正文(历史区)到达不再清除——保留至 turn-end 后、下回合 turn-begin
 * 由 appendTurnSeparator 统一清空(活动区瞬态整轮重置)。
 */
export function appendThinking(
  state: AppState,
  text: string,
  time?: number,
): AppState {
  return appendStream(state, text, "thinking", time);
}

/** 输入状态权威：审批/问答面板打开 = 等待用户决策（黄△）；agent 活跃期间
 *  不接受绿/红结果覆盖（压回运行中黄●/○），绿/红仅空闲时暴露 */
function statusFor(state: AppState, fallback: InputStatus): InputStatus {
  if (state.approval || state.question) return "waiting";
  return state.agentStatus === "idle" ? fallback : "running";
}

/**
 * 回合结束：把当前回合（最后一个分隔线之后）最后一段连续 assistant 行标记为
 * final（最终总结，历史区展示）。无分隔线（首回合）则从 buffer 开头起算。
 * 幂等：已 final 的行不再重复标记。
 */
export function markFinalSummary(state: AppState): AppState {
  const buffer = state.buffer;
  if (buffer.length === 0) return state;
  // 当前回合起点 = 最后一个 separator 之后
  let start = 0;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i]!.kind === "separator") {
      start = i + 1;
      break;
    }
  }
  // 回合内最后一段连续 assistant 行（从尾部向前找最近的 assistant 块）
  let end = buffer.length;
  while (end > start && buffer[end - 1]!.kind !== "assistant") end--;
  if (end === start) return state; // 本回合无模型正文
  let begin = end;
  while (begin > start && buffer[begin - 1]!.kind === "assistant") begin--;
  if (buffer.slice(begin, end).every((l) => l.final)) return state;
  const next = [...buffer];
  for (let i = begin; i < end; i++) next[i] = { ...next[i]!, final: true };
  return { ...state, buffer: next };
}

/**
 * turn 开始：在历史末尾追加分隔线；`clearActivity` 为真时先清掉活动区内容
 * （思考/工具调用/notice/非 final 中间输出——**整类一起清**，不做单类清除）。
 *
 * clearActivity 由触发方决定：**用户输入开启的回合**（提交 / 排队消息被认领）清空，
 * 核心自发的回合（goal 轮次、定时唤醒等）保留上一轮活动内容继续往上堆——活动区
 * 内容只在下一次输入后整体清空。空 buffer 或末尾已是分隔线时不追加分隔线
 * （避免孤立/重复分隔）。由 `turn-begin` 触发。
 */
export function appendTurnSeparator(
  state: AppState,
  clearActivity = true,
): AppState {
  let buffer = state.buffer.length ? [...state.buffer] : [];
  if (clearActivity) {
    buffer = buffer.filter(
      (l) =>
        l.kind !== "thinking" &&
        l.kind !== "tool" &&
        l.kind !== "notice" &&
        !(l.kind === "assistant" && !l.final),
    );
  }
  // 活动区被清空时滚动偏移一并归零，新回合回到跟随最新。不归零则旧 activityScroll
  // 超出新内容的可视上限，渲染钳制下 ↓ 需连续按到偏移耗尽才恢复（“向下没反应”死区）。
  const next: AppState = clearActivity
    ? { ...state, buffer, activityScroll: 0 }
    : { ...state, buffer };
  if (buffer.length === 0) return next;
  const last = buffer[buffer.length - 1];
  if (last && last.kind === "separator" && last.text === TURN_SEPARATOR)
    return next;
  buffer.push({
    text: TURN_SEPARATOR,
    kind: "separator",
    seq: state.nextSeq,
  });
  next.nextSeq = state.nextSeq + 1;
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  return next;
}

/** 合并更新系统状态区（StatusTicker 每 tick 调用；缺失字段保持原值） */
export function setSystemStatus(
  state: AppState,
  status: Partial<SystemStatus>,
): AppState {
  return { ...state, systemStatus: { ...state.systemStatus, ...status } };
}

/** 清空显示缓冲(本地 /clearscreen，别名 /cls)——只清 UI，不动会话上下文。 */
export function clearBuffer(state: AppState): AppState {
  return {
    ...state,
    buffer: [],
    scrollOffset: 0,
    followBottom: true,
    activityScroll: 0,
  };
}

/** 追加 agent 状态 */
export function setAgentStatus(state: AppState, status: AgentStatus): AppState {
  return { ...state, agentStatus: status };
}

/** 审批面板：打开 = 等待用户决策（黄△）；关闭按 agent 活跃度恢复（运行中/上次结果） */
export function setApproval(
  state: AppState,
  approval: ApprovalItem | null,
): AppState {
  if (!approval) {
    const next = { ...state, approval: null };
    return { ...next, inputStatus: statusFor(next, "success") };
  }
  return { ...state, approval, inputStatus: "waiting" };
}

export function setSessions(
  state: AppState,
  sessions: SessionMeta[],
): AppState {
  const active =
    state.activeSessionId &&
    sessions.some((s) => s.id === state.activeSessionId)
      ? state.activeSessionId
      : (sessions[0]?.id ?? null);
  return { ...state, sessions, activeSessionId: active };
}

/** 针对 buffer 做一次只读操作（Reducer 模式入口），返回新的不改动原对象 */
/** 会话内容推进（新输入/输出）的 action 集合：处理完自动回到无焦点（focusedPanel=null），
 *  直至用户再按 Tab 进入焦点循环；UI 类 action（picker/question/approval/history/jobs/
 *  input/scroll/theme…）不重置，避免打断面板内浏览 */
const FOCUS_RESET_ACTIONS: ReadonlySet<string> = new Set([
  "append", // 模型正文/用户消息流
  "user-line", // 用户消息行
  "queued-push", // 排队消息（agent 运行期间 Enter 提交）
  "queued-claim", // 排队消息被核心认领（转入历史流）
  "thinking", // 思考流
  "notice", // 命令/系统通知
  "turn-begin",
  "turn-end",
  "tool-call",
  "tool-result",
  "retry",
  "retry-started",
  "compaction",
  "compaction-summary",
  "compaction-prune",
  "step",
  "subagent",
  "workflow",
  "command",
  "code-dispatch",
  "hook",
  "schedule",
  "feedback",
  "goal-change",
  "todo-write",
  "jobs-changed",
  "permission-catalog",
  "agent-preset-catalog",
]);

export function reduceState(state: AppState, action: StateAction): AppState {
  // 新输入/输出后焦点回到无焦点（null）；其它 action 原样
  const next: AppState = (() => {
    switch (action.type) {
      case "append":
        return appendStream(state, action.text, "assistant", action.time);
      case "user-line":
        return appendStream(state, action.text, "user");
      case "queued-push":
        // 排队消息登记（不合并、不写 buffer）：显示由布局层按 queued 渲染，
        // 消息本身已由 App 经 adapter.sendMessage 交给核心 next-turn 队列
        return { ...state, queued: [...state.queued, action.text] };
      case "queued-claim": {
        // 核心认领最早一条（新回合开始）：该条转入历史流（灰块 → 用户行）
        const [head, ...rest] = state.queued;
        if (head === undefined) return state;
        return appendStream({ ...state, queued: rest }, head, "user");
      }
      case "queued-clear":
        return { ...state, queued: [] };
      case "thinking":
        return appendThinking(state, action.text, action.time);
      case "virt-tick": {
        // 运行中闪烁时间驱动：虚拟速度按指数衰减回落、虚拟总 token 按衰减中的
        // 速度持续积分（无数据时闪烁频率渐降到最低而不断）；速率窗口同步衰减
        return { ...state, runVirt: virtTick(state.runVirt, action.time) };
      }
      case "notice":
        if (action.lines && action.lines.length > 0)
          return appendNoticeLines(state, action.lines, action.tone);
        return appendNotice(state, action.text, action.error, action.tone);
      case "clear-buffer":
        return clearBuffer(state);
      case "agent-status":
        // 外部活动兜底：审批/问答打开保持等待交互(黄△)；thinking/tool 视为
        // 进行中(黄●/○)；idle 不改状态色
        return {
          ...setAgentStatus(state, action.status),
          inputStatus:
            state.approval || state.question
              ? "waiting"
              : action.status === "thinking" || action.status === "tool"
                ? "running"
                : state.inputStatus,
        };
      case "approval":
        return setApproval(state, action.approval);
      case "sessions":
        return setSessions(state, action.sessions);
      case "picker-open":
        // 面板打开保留输入模式；仅真实 Esc（主输入态或关闭面板）才重置为 normal
        return { ...state, picker: action.picker };
      case "picker-move":
        return movePicker(state, action);
      case "picker-tab":
        return tabPicker(state);
      case "picker-phase":
        return phasePicker(state, action);
      case "picker-select":
        return selectPicker(state);
      case "picker-efforts":
        return setPickerEfforts(
          state,
          action as {
            type: "picker-efforts";
            efforts: { id: string; name: string }[];
            effortIndex?: number;
          },
        );
      case "picker-close":
        return { ...state, picker: null };
      case "status-panel-open":
        return { ...state, statusPanel: action.panel };
      case "status-panel-move":
        return moveStatusPanel(state, action);
      case "status-panel-select":
        return selectStatusPanel(state);
      case "status-panel-close":
        return { ...state, statusPanel: null };
      case "completion-move":
        return moveCompletion(state, action);
      case "completion-close":
        return { ...state, completion: null };
      case "command-catalog":
        return {
          ...state,
          registryCommands: action.commands,
          completion: completeCommandInput(
            state.inputText,
            action.commands,
            state.inputMode,
          ),
        };
      case "question-open":
        return openQuestion(state, action);
      case "question-move":
        return moveQuestion(state, action);
      case "question-nav":
        return navQuestion(state, action);
      case "question-select":
        return selectQuestionOption(state);
      case "question-custom":
        return setQuestionCustom(state, action.text);
      case "question-close": {
        // 关闭问答面板：按 agent 活跃度恢复（运行中/上次结果），不再等待交互
        const next = { ...state, question: null };
        return { ...next, inputStatus: statusFor(next, "success") };
      }
      case "history-refresh": {
        // 删除/清理后重拉列表：保留面板结果提示与高亮位置（按**可见**长度 clamp）；
        // 标记集按新列表裁剪（已消失的 id 不再计入，避免幽灵标记）
        const hrf = state.history;
        if (!hrf || hrf.phase !== "list") return state;
        const alive = new Set(action.records.map((r) => r.id));
        const refreshed: HistoryPanelState = {
          ...hrf,
          records: action.records,
          error: undefined,
          marked: hrf.marked?.filter((id) => alive.has(id)),
        };
        const visible = historyVisibleRecords({ ...state, history: refreshed });
        return {
          ...state,
          history: {
            ...refreshed,
            index: Math.max(0, Math.min(visible.length - 1, hrf.index)),
          },
        };
      }
      case "history-result": {
        // 面板内结果提示：面板已关则忽略（调用方另有 buffer notice 留痕）
        const hrs = state.history;
        if (!hrs) return state;
        return { ...state, history: { ...hrs, result: action.text } };
      }
      case "history-scope-toggle": {
        // 切换列表范围（当前目录 ⇄ 全部）：尽量按 id 保留选中项，不可见则回首项
        const hst = state.history;
        if (!hst || hst.phase !== "list") return state;
        const scope: "project" | "all" =
          hst.scope === "all" ? "project" : "all";
        const prevId = historyVisibleRecords(state)[hst.index]?.id;
        const next: HistoryPanelState = { ...hst, scope };
        const visible = historyVisibleRecords({ ...state, history: next });
        const found =
          prevId === undefined ? -1 : visible.findIndex((r) => r.id === prevId);
        return {
          ...state,
          history: { ...next, index: found < 0 ? 0 : found },
        };
      }
      case "history-open":
        return {
          ...state,
          history: {
            phase: "loading-list",
            scope: "project",
            records: [],
            index: 0,
            messages: [],
            scroll: 0,
          },
        };
      case "history-list":
        // 面板已关闭则丢弃过期结果（异步竞态守卫）
        if (!state.history) return state;
        return {
          ...state,
          history: {
            ...state.history,
            phase: "list",
            records: action.records,
            index: 0,
            error: undefined,
          },
        };
      case "history-list-error":
        if (!state.history) return state;
        return {
          ...state,
          history: { ...state.history, phase: "error", error: action.error },
        };
      case "history-move": {
        if (!state.history || state.history.phase !== "list") return state;
        const hmv = state.history;
        const next = Math.max(
          0,
          Math.min(
            historyVisibleRecords(state).length - 1,
            hmv.index + action.delta,
          ),
        );
        return { ...state, history: { ...hmv, index: next } };
      }
      case "history-mark-toggle": {
        // Space：切换高亮行标记并下移一行（连续标记不必反复按 ↓）；
        // 不可删项（当前活跃 / live / 未持久化）不标记也不移动，由调用方 notice 说明
        const hmt = state.history;
        if (!hmt || hmt.phase !== "list") return state;
        const marked = hmt.marked ?? [];
        const rec = historyVisibleRecords(state)[hmt.index];
        if (!rec || !deletableSession(rec)) return state;
        const next = marked.includes(rec.id)
          ? marked.filter((id) => id !== rec.id)
          : [...marked, rec.id];
        const rows = historyVisibleRecords(state).length;
        return {
          ...state,
          history: {
            ...hmt,
            marked: next,
            index: Math.min(Math.max(0, rows - 1), hmt.index + 1),
          },
        };
      }
      case "history-mark-all": {
        // a：全选当前列表范围的可删项（**替换**标记集：删除集恒等于当前范围可删项，再按 Space 微调）
        const hma = state.history;
        if (!hma || hma.phase !== "list") return state;
        const ids = markableSessionIds(state);
        if (ids.length === 0) return state;
        return { ...state, history: { ...hma, marked: ids } };
      }
      case "history-mark-clear": {
        // c：清空标记集（无标记时不动状态，调用方据此提示）
        const hmc = state.history;
        if (!hmc || hmc.phase !== "list" || (hmc.marked?.length ?? 0) === 0) {
          return state;
        }
        return { ...state, history: { ...hmc, marked: [] } };
      }
      case "history-open-view": {
        if (!state.history || state.history.phase !== "list") return state;
        const hov = state.history;
        const rec = historyVisibleRecords(state)[hov.index];
        if (!rec) return state;
        return {
          ...state,
          history: { ...hov, phase: "loading-view", currentId: rec.id },
        };
      }
      case "history-view":
        if (!state.history || state.history.phase !== "loading-view")
          return state;
        return {
          ...state,
          history: {
            ...state.history,
            phase: "view",
            currentId: action.id,
            messages: action.messages,
            scroll: 0,
            error: undefined,
          },
        };
      case "history-view-error":
        if (!state.history || state.history.phase !== "loading-view")
          return state;
        return {
          ...state,
          history: { ...state.history, phase: "error", error: action.error },
        };
      case "history-scroll": {
        if (!state.history || state.history.phase !== "view") return state;
        const hsc = state.history;
        return {
          ...state,
          history: { ...hsc, scroll: Math.max(0, hsc.scroll + action.delta) },
        };
      }
      case "history-back": {
        if (!state.history || state.history.phase !== "view") return state;
        const hbk = state.history;
        return {
          ...state,
          history: {
            ...hbk,
            phase: "list",
            currentId: undefined,
            messages: [],
            scroll: 0,
          },
        };
      }
      case "history-resume":
        return state.history
          ? {
              ...state,
              history: {
                ...state.history,
                phase: "resuming",
                pendingResume: action.id,
                error: undefined,
              },
            }
          : state;
      case "history-resume-error":
        // 会话陈旧则丢弃（面板已关闭/已切换目标）
        if (
          !state.history ||
          state.history.phase !== "resuming" ||
          state.history.pendingResume !== action.id
        ) {
          return state;
        }
        return {
          ...state,
          history: {
            ...state.history,
            phase: "error",
            error: action.error,
            pendingResume: undefined,
          },
        };
      case "history-resume-ok":
        // 会话陈旧则丢弃（面板已关闭/已切换目标）
        if (
          !state.history ||
          state.history.phase !== "resuming" ||
          state.history.pendingResume !== action.id
        ) {
          return state;
        }
        return {
          ...state,
          activeSessionId: action.id,
          sessionTitle: action.title,
          history: null,
          buffer: (action.rows as BufferLine[]).map((l, i) => ({
            ...l,
            seq: state.nextSeq + i,
          })),
          nextSeq: state.nextSeq + action.rows.length,
          followBottom: true,
          scrollOffset: 0,
          activityScroll: 0,
        };
      case "session-switch":
        // /new：全新会话 → 缓冲、滚动、窗口、焦点与排队登记全部归零。
        // 按会话隔离的 mode/goal/todo/model 与 TUI 本地开关由 App 随后的
        // restoreSessionState 回填（新会话无记录 → 各回默认值）。
        return {
          ...state,
          activeSessionId: action.id,
          sessionTitle: action.title,
          history: null,
          buffer: [],
          followBottom: true,
          scrollOffset: 0,
          scrollAnchor: null,
          activityScroll: 0,
          windowGroups: DIALOGUE_KEEP_REPLIES,
          focusedPanel: null,
          queued: [],
          stepGroup: null,
        };
      case "history-confirm-delete": {
        const hcd = state.history;
        if (!hcd || hcd.phase !== "list") return state;
        // 有标记 → 批量删除标记集（跨范围保留的标记也计入；已不可删的项自动剔除）
        const batch = (hcd.marked ?? []).filter((id) => {
          const target = hcd.records.find((r) => r.id === id);
          return target !== undefined && deletableSession(target);
        });
        if (batch.length > 0) {
          return {
            ...state,
            history: {
              ...hcd,
              phase: "confirm-delete",
              pendingDelete: undefined,
              pendingDeleteIds: batch,
              result: undefined,
            },
          };
        }
        const rec = historyVisibleRecords(state)[hcd.index];
        // 当前活跃 / live / 未持久化 → 不进入确认（调用方以 notice 说明原因）
        if (!rec || !deletableSession(rec)) {
          return state;
        }
        return {
          ...state,
          history: {
            ...hcd,
            phase: "confirm-delete",
            pendingDelete: rec.id,
            pendingDeleteIds: undefined,
            result: undefined,
          },
        };
      }
      case "history-confirm-clean": {
        const hcc = state.history;
        if (!hcc || hcc.phase !== "list") return state;
        const ids = cleanableSessionIds(state);
        if (ids.length === 0) return state;
        return {
          ...state,
          history: {
            ...hcc,
            phase: "confirm-clean",
            pendingClean: ids,
            cleanCwd: currentProjectCwd(state),
            result: undefined,
          },
        };
      }
      case "history-confirm-cancel": {
        const hcx = state.history;
        if (
          !hcx ||
          (hcx.phase !== "confirm-delete" && hcx.phase !== "confirm-clean")
        ) {
          return state;
        }
        return {
          ...state,
          history: {
            ...hcx,
            phase: "list",
            pendingDelete: undefined,
            pendingDeleteIds: undefined,
            pendingClean: undefined,
            cleanCwd: undefined,
          },
        };
      }
      case "history-delete":
        return state.history?.phase === "confirm-delete"
          ? { ...state, history: { ...state.history, phase: "deleting" } }
          : state;
      case "history-delete-done": {
        // 单条与批量共用：ids = 成功删除的集合（空集 = 全部失败 → 记录与标记原样保留，仍回列表）
        const hdd = state.history;
        if (!hdd || hdd.phase !== "deleting") return state;
        return {
          ...state,
          history: dropHistoryRecords(
            hdd,
            action.ids,
            historyVisibleRecords(state).map((r) => r.id),
          ),
        };
      }
      case "history-clean":
        return state.history?.phase === "confirm-clean"
          ? { ...state, history: { ...state.history, phase: "cleaning" } }
          : state;
      case "history-clean-done": {
        const hcd2 = state.history;
        if (!hcd2 || hcd2.phase !== "cleaning") return state;
        return {
          ...state,
          history: dropHistoryRecords(
            hcd2,
            action.ids,
            historyVisibleRecords(state).map((r) => r.id),
          ),
        };
      }
      case "history-close":
        return { ...state, history: null };
      case "session-identify":
        return {
          ...state,
          activeSessionId: action.id,
          sessionTitle: action.title,
        };
      case "input":
        return setInput(state, action);
      case "input-mode":
        // 模式决定命令 token 语义（slash 模式文本无前导 `/`）：切换即重算候选
        return {
          ...state,
          inputMode: action.mode,
          completion: completeCommandInput(
            state.inputText,
            state.registryCommands,
            action.mode,
          ),
        };
      case "input-status":
        // 活跃守卫：agent 非 idle 时绿/红结果不暴露（压回黄），空闲后才显示结果色
        return { ...state, inputStatus: statusFor(state, action.status) };
      case "move-cursor":
        return moveCursor(state, action);
      case "scroll":
        return scrollDialogue(state, action.delta, action.geom);
      case "scroll-to-bottom":
        // 回到最新：跟随底部并复位渐进窗口（窗口内容随之上滚时再按需扩窗）
        return {
          ...state,
          followBottom: true,
          scrollOffset: 0,
          scrollAnchor: null,
          windowGroups: DIALOGUE_KEEP_REPLIES,
        };
      case "scroll-to-oldest": {
        // 跳到最旧：把窗口一次扩到全部回合组，并把锚点钉在首行（首行的稳定序号）
        const first = state.buffer[0];
        const anchor = { seq: first?.seq ?? DIALOGUE_MARKER_SEQ, row: 0 };
        return {
          ...state,
          followBottom: false,
          scrollAnchor: anchor,
          windowGroups: Math.max(
            state.windowGroups,
            turnGroupStarts(state.buffer).length,
          ),
          scrollOffset: anchorToOffset(
            state.dialogueGeometry.spans,
            anchor,
            state.dialogueGeometry.height,
          ),
        };
      }
      case "anchor-resolved":
        // 每帧由 App 回填：布局收敛后的锚点/几何/偏移（派生缓存同步）
        return {
          ...state,
          scrollAnchor: action.anchor,
          followBottom: action.anchor === null,
          scrollOffset: action.offset,
          dialogueGeometry: action.geometry,
        };
      case "window-groups":
        return {
          ...state,
          windowGroups: Math.max(DIALOGUE_KEEP_REPLIES, action.groups),
        };
      case "user-jump":
        // PgUp/PgDn 用户输入跳转：直接给锚点（null = 落到底部）
        return {
          ...state,
          scrollAnchor: action.anchor,
          followBottom: action.anchor === null,
          scrollOffset: anchorToOffset(
            state.dialogueGeometry.spans,
            action.anchor,
            state.dialogueGeometry.height,
          ),
        };
      case "turn-begin": {
        // 回合开始：先画分隔线(空历史/已画则跳过)，再进入新回合内容；
        // 非打印字符剔除计数按回合清零（turn-end 时警告后不复用旧值）。
        // run 边界 = 两次用户输入之间（见 runVirt 注释）：仅用户输入开启的回合
        // （clearActivity=true，含排队消息被认领）才重置虚拟状态与本 step 累计；
        // 核心自发的回合（goal 轮次/定时唤醒，clearActivity=false）属同一 run，保留
        const clearActivity = action.clearActivity ?? true;
        const virt = clearActivity ? { runVirt: emptyRunVirt() } : {};
        return appendTurnSeparator(
          { ...state, strippedChars: 0, stepEstTokens: 0, ...virt },
          clearActivity,
        );
      }
      case "clear-stripped":
        return { ...state, strippedChars: 0 };
        // 回合开始：先画分隔线(空历史/已画则跳过)，再进入新回合内容
        return appendTurnSeparator(state);
      case "turn-end":
        // 回合结束：不再画分隔线(下个回合 begin 时画)；也不清思考/中间输出——
        // 保留显示，至下回合 turn-begin 统一清空(输出结束后不立即清)；
        // 本回合最后一段模型正文打 final 标记进历史区（最终总结）；置成功色(绿)。
        // 虚拟状态：仅把虚拟速度大小更新为下限（回合结束=输出停止→最低闪烁频率），
        // 虚拟总 token **不清零**（run 边界 = 两次用户输入之间，到下次用户输入
        // turn-begin clearActivity=true 时才重置），lastTime/速率窗口保持
        return markFinalSummary({
          ...state,
          inputStatus: "success",
          runVirt: { ...state.runVirt, speed: VIRT_SPEED_MIN },
        });
      case "status":
        return setSystemStatus(state, action.status);
      case "set-theme":
        return { ...state, themeId: action.themeId };
      case "activity-verbose":
        // 活动区显示详略（SPEC §6.8 两态）：true=完整折行；false=紧凑（每条目 1 行 + 省略号）
        return { ...state, activityVerbose: action.on };
      case "symbol-unify":
        // 模型输出符号统一开关：true=变体替换为推荐并提醒；false=原样（不替换不提醒）
        return { ...state, symbolUnify: action.on };
      case "tool-call":
        // 工具调用：紧凑工具行（○ <name> <summary> 由 tool-line.ts 组装），不进模型历史；
        // B3：当前 step 组首条工具行前先插分组头 `step N`（无 step 上下文不插头）
        return appendStepToolLine(
          state,
          action.sessionId,
          toolCallLine(action.name, action.summary),
          undefined,
          { keepLineBreaks: true },
        );
      case "tool-result":
        // 工具结果：✓ 成功 / ✗ 失败（失败红色，tone=error）；B3：同 tool-call 参与 step 分组
        return appendStepToolLine(
          state,
          action.sessionId,
          toolResultLine(action.ok, action.detail, action.meta),
          action.ok ? undefined : "error",
        );
      case "compaction":
        // 长会话压缩 toast：start/end 提示
        return appendNotice(
          state,
          action.phase === "start" ? "正在压缩上下文..." : "压缩完成",
          false,
          action.phase === "start" ? "info" : "success",
        );
      case "retry":
        // 模型重试 toast：第 attempt/max 次 + 退避 + 失败码（黄色，表进行中）
        return appendNotice(
          state,
          `重试 ${action.attempt}/${action.max} (${(action.delayMs / 1000).toFixed(1)}s): ${action.code}` +
            (action.message ? " " + action.message : ""),
          false,
          "warn",
        );
      case "usage": {
        // 阶段 1：入状态（阶段 2 状态栏 contextLen/cacheHit 从 state.usage 读取）。
        // P5 估算校准：usage 真值（output，每 step 一次）与本 step 估算累计对比，
        // 比例经 EMA 平滑并 clamp 后写入 tokenCalib，供后续 run 校正启发式估算；
        // 本 step 累计清零（真值已消费）。provider 未报 usage（output<=0）不校准。
        const est = state.stepEstTokens;
        const tokenCalib =
          est > 0 && action.output > 0
            ? Math.min(
                TOKEN_CALIB_MAX,
                Math.max(
                  TOKEN_CALIB_MIN,
                  TOKEN_CALIB_ALPHA * (action.output / est) +
                    (1 - TOKEN_CALIB_ALPHA) * state.tokenCalib,
                ),
              )
            : state.tokenCalib;
        return {
          ...state,
          stepEstTokens: 0,
          tokenCalib,
          usage: {
            input: action.input,
            output: action.output,
            cacheRead: action.cacheRead,
            ...(action.contextWindow === undefined
              ? {}
              : { contextWindow: action.contextWindow }),
          },
        };
      }
      case "goal-change": {
        // P2：goal 全量快照/clear 墓碑，按 sessionId 隔离存储（判别联合同事件，完整保留字段）
        if (action.operation === "clear") {
          return {
            ...state,
            goalBySession: {
              ...state.goalBySession,
              [action.sessionId]: {
                status: "cleared",
                operation: "clear",
                cleared: action.cleared,
                clearedAt: action.clearedAt,
              },
            },
          };
        }
        return {
          ...state,
          goalBySession: {
            ...state.goalBySession,
            [action.sessionId]: {
              status: "set",
              operation: action.operation,
              goal: action.goal,
              roundsStarted: action.roundsStarted,
              createdAt: action.createdAt,
              updatedAt: action.updatedAt,
            },
          },
        };
      }
      case "todo-write":
        // P2：todo 全量快照 last-write-wins，按 sessionId 隔离
        return {
          ...state,
          todoBySession: {
            ...state.todoBySession,
            [action.sessionId]: action.todos,
          },
        };
      case "mode": {
        // P2：模式徽标按 sessionId 隔离（plan/sandbox/permission 三合一，缺省省略）
        const current = state.modeBySession[action.sessionId] ?? {};
        const updated =
          action.kind === "plan"
            ? { ...current, plan: action.value as "on" | "off" }
            : action.kind === "sandbox"
              ? { ...current, sandbox: action.value }
              : { ...current, permission: action.value };
        return {
          ...state,
          modeBySession: {
            ...state.modeBySession,
            [action.sessionId]: updated,
          },
        };
      }
      case "step":
        // B3：step/start 打开新工具组（append-only，旧组既有行即“flush”）；step/end 关闭分组
        return action.phase === "start"
          ? {
              ...state,
              stepGroup: {
                sessionId: action.sessionId,
                step: action.step,
                headerEmitted: false,
              },
            }
          : { ...state, stepGroup: null };
      case "subagent":
        // B4：subagent 行（`@ <label> <os|ct>`，append-only 不配对不折叠）入 buffer，不进模型历史
        return appendToolLine(
          state,
          subagentLine(action.label, action.mode),
          "info",
        );
      case "compaction-summary": {
        // B5：压缩摘要仅 toast（`压缩完成：<text 首行>`；空摘要给占位）+ 每会话保留最近一条原始载荷（raw，不改写）
        const toast = action.text
          ? "压缩完成：" + action.text.split("\n")[0]
          : "压缩完成（无摘要）";
        return appendNotice(
          {
            ...state,
            compactionBySession: {
              ...state.compactionBySession,
              [action.sessionId]: { raw: action.raw, text: action.text },
            },
          },
          toast,
          false,
          "success",
        );
      }
      case "approval-policy":
        // C 阶段：当前审批策略按 sessionId latest-wins（approval/policy 事件源=宿主 setPolicy）；
        // 无对应会话事件时保留旧值（切会话读对应 policyBySession 键）
        return {
          ...state,
          policyBySession: {
            ...state.policyBySession,
            [action.sessionId]: action.policy,
          },
        };
      case "workflow":
        // P3：workflow 运行行（run-start/agent-start/agent-end 为活动区行，append-only）；
        // run-end 折叠为 toast（携 stopReason detail）。不参与 step 分组（独立运行大动作）。
        if (action.phase === "run-end") {
          return appendNotice(
            state,
            "workflow 结束" + (action.detail ? " (" + action.detail + ")" : ""),
            false,
            "success",
          );
        }
        return appendToolLine(
          state,
          workflowLine(action.phase, action.label, action.detail),
          action.phase === "agent-end" ? "success" : "info",
        );
      case "command":
        // P3：命令执行流——run 低调灰行；done 成功静默（结果由命令自身 notice 呈现，避免重复），
        // 失败红行（✗ /name: text）。append-only 不保留历史命令状态。
        if (action.phase === "done") {
          if (action.ok !== false) return state;
          return appendToolLine(
            state,
            commandErrorLine(action.name, action.text ?? ""),
            "error",
          );
        }
        return appendToolLine(state, commandRunLine(action.name), "log");
      case "code-dispatch":
        // P3：run_code 内子派发——start 灰行；settle 成功静默降噪（子调用多，避免刷屏），
        // 失败红行（✗ <name>）。
        if (action.phase === "settle") {
          if (action.ok) return state;
          return appendToolLine(state, "✗ " + action.name, "error");
        }
        return appendToolLine(
          state,
          codeDispatchLine(action.name, action.summary),
          "log",
        );
      case "hook":
        // P3：hooks 协议事件——invoked 灰行；result 按是否通过着色（失败红）。
        return appendToolLine(
          state,
          hookLine(action.phase, action.point, action.decision, action.ok),
          action.phase === "result" && !action.ok ? "error" : "log",
        );
      case "schedule":
        // P3：schedule 提醒——仅 dispatch 到点提示（create/delete 降噪，无用户可见价值）。
        if (action.operation !== "dispatch") return state;
        return appendNotice(state, "计划提醒触发", false, "log");
      case "compaction-prune":
        // P3：压缩剪枝计数 toast（co tool-result pruner 剪除的节点数/千分 token 启发值）
        return appendNotice(
          state,
          "压缩：已剪除 " +
            action.nodeCount +
            " 个节点 (~" +
            action.tokenCount +
            " tok)",
          false,
          "log",
        );
      case "feedback":
        // P3：feedback/record 确认（/feedback 命令落库后回读）
        return appendNotice(state, "反馈已记录", false, "success");
      case "retry-started":
        // P3：llm/retry-started 启动行（↻ 灰行）——与 retry toast 互补：启动可见 + 失败原因 toast
        return appendToolLine(state, retryStartedLine(action.attempt), "log");
      case "model-selection":
        // 0.1.2-rc.1：会话内生效模型选择事件 → 落 state（状态栏模型徽标可选读取）
        return {
          ...state,
          modelBySession: {
            ...state.modelBySession,
            [action.sessionId]: {
              provider: action.provider,
              model: action.model,
              reasoningEffort: action.reasoningEffort,
            },
          },
        };
      case "agent-preset":
        // P3：agent-preset/selected → 当前预设 latest-wins（会话隔离）
        return {
          ...state,
          presetBySession: {
            ...state.presetBySession,
            [action.sessionId]: action.preset,
          },
        };
      case "permission-catalog":
        // P4：权限预设目录（ctx.permissionPresets.names）——状态列 Mode 块列出可选值
        return { ...state, permissionOptions: action.names };
      case "agent-preset-catalog":
        // P4：agent 预设目录 id 列表（ctx.agentPresets.list）——状态列 Mode 块 preset 可选项
        return { ...state, presetOptions: action.ids };
      case "jobs-changed":
        // P3：jobs 快照 last-write-wins（adapter onJobsChanged + 打开时刷新推送）
        return { ...state, jobs: action.jobs };
      case "jobs-panel-open":
        return { ...state, jobsPanel: { index: 0 } };
      case "jobs-panel-move": {
        // 上下移动高亮行（clamp 到列表范围）
        const size = state.jobs.length;
        if (size === 0) return state;
        const index = Math.max(
          0,
          Math.min(size - 1, action.focus + action.delta),
        );
        return { ...state, jobsPanel: { index } };
      }
      case "jobs-panel-page": {
        // PgUp/PgDn 整页移动（页高由调用方按活动区可视行数给出；与 command-panel-page 同口径）
        const size = state.jobs.length;
        if (size === 0 || !state.jobsPanel) return state;
        const step = Math.max(1, action.page) * action.delta;
        const index = Math.max(
          0,
          Math.min(size - 1, state.jobsPanel.index + step),
        );
        return { ...state, jobsPanel: { index } };
      }
      case "jobs-panel-close":
        return { ...state, jobsPanel: null };
      case "command-panel-open":
        // 打开共享列表面板：先置 loading，数据经 command-panel-data 到达后填充
        return {
          ...state,
          commandPanel: {
            kind: action.kind,
            index: 0,
            rows: [],
            loading: true,
          },
        };
      case "command-panel-move": {
        const panel = state.commandPanel;
        if (!panel || panel.rows.length === 0) return state;
        const index = Math.max(
          0,
          Math.min(panel.rows.length - 1, panel.index + action.delta),
        );
        return { ...state, commandPanel: { ...panel, index } };
      }
      case "command-panel-page": {
        // PgUp/PgDn 整页移动（页高由调用方按活动区可视行数给出）
        const panel = state.commandPanel;
        if (!panel || panel.rows.length === 0) return state;
        const step = Math.max(1, action.page) * action.delta;
        const index = Math.max(
          0,
          Math.min(panel.rows.length - 1, panel.index + step),
        );
        return { ...state, commandPanel: { ...panel, index } };
      }
      case "command-panel-close":
        return { ...state, commandPanel: null };
      case "command-panel-data": {
        // 数据 last-write-wins：仅当前面板 kind 一致时写入（挡迟到数据覆盖新面板）
        const panel = state.commandPanel;
        if (!panel || panel.kind !== action.kind) return state;
        return {
          ...state,
          commandPanel: {
            kind: panel.kind,
            index: Math.max(
              0,
              Math.min(panel.index, Math.max(0, action.rows.length - 1)),
            ),
            rows: action.rows,
            ...(action.error === undefined ? {} : { error: action.error }),
          },
        };
      }
      case "status-column-scroll":
        // 顶部状态列纵向滚动：偏移累加，渲染层按可视行数 clamp；不进入对话区滚动
        return {
          ...state,
          statusColumnScroll: Math.max(
            0,
            state.statusColumnScroll + action.delta,
          ),
        };
      case "focus-panel-cycle":
        // 顶部三面板焦点循环：无焦点(null) → history → activity → status → history
        return {
          ...state,
          focusedPanel:
            state.focusedPanel === null
              ? "history"
              : PANEL_CYCLE[
                  (PANEL_CYCLE.indexOf(state.focusedPanel) + 1) %
                    PANEL_CYCLE.length
                ]!,
        };
      case "activity-scroll": {
        // 活动区（流输出）滚动：偏移累加（距底部行数）；0=跟随最新。
        // max = 上一帧回填的可滚动上限：先收敛越界偏移再叠加、结果不超上限，
        // 避免越界累积后"按了没反应"（与对话区 scrollBy 同口径）
        const max = Math.max(0, action.max ?? Number.MAX_SAFE_INTEGER);
        const cur = Math.min(state.activityScroll, max);
        return {
          ...state,
          activityScroll: Math.min(max, Math.max(0, cur + action.delta)),
        };
      }
      default:
        return state;
    }
  })();
  return FOCUS_RESET_ACTIONS.has(action.type)
    ? { ...next, focusedPanel: null }
    : next;
}

export type StateAction =
  | { type: "append"; text: string; time?: number }
  | { type: "user-line"; text: string }
  /** 排队消息登记：**追加**一条（不合并；发送走官方 followup，核心逐条认领） */
  | { type: "queued-push"; text: string }
  /** 核心认领最早一条排队消息（新回合开始）：弹出并作为用户行落历史 */
  | { type: "queued-claim" }
  | { type: "queued-clear" }
  | { type: "thinking"; text: string; time?: number }
  /** 运行中闪烁时间驱动（App 在 running 期间周期性发送）：无数据时虚拟速度
   *  衰减回落、虚拟总 token 持续积分（闪烁不停、频率渐降到最低） */
  | { type: "virt-tick"; time: number }
  | {
      type: "notice";
      text: string;
      /** 结构化多行（/help 表格）：每条独立成行并可带悬垂缩进；缺省走 text */
      lines?: NoticeLine[];
      error?: boolean;
      tone?: NoticeTone;
    }
  | { type: "clear-buffer" }
  | { type: "agent-status"; status: AgentStatus }
  | { type: "approval"; approval: ApprovalItem | null }
  | { type: "picker-open"; picker: PickerState }
  | { type: "picker-move"; delta: number }
  | { type: "picker-tab" }
  | { type: "picker-phase"; delta: 1 | -1 }
  | { type: "picker-select" }
  | {
      type: "picker-efforts";
      efforts: { id: string; name: string }[];
      /** 非 0 时代表预设高亮等级（模型行自带等级时的默认选中），匹配不到回退 0 */
      effortIndex?: number;
    }
  | { type: "picker-close" }
  | { type: "question-open"; id: string; questions: QuestionItem[] }
  | { type: "question-move"; delta: 1 | -1 }
  | { type: "question-nav"; delta: 1 | -1 }
  | { type: "question-select" }
  | { type: "question-custom"; text: string }
  | { type: "question-close" }
  | { type: "history-open" }
  | { type: "history-list"; records: SessionInfo[] }
  | { type: "history-list-error"; error: string }
  | { type: "history-move"; delta: number }
  | { type: "history-scope-toggle" }
  | { type: "history-mark-toggle" }
  | { type: "history-mark-all" }
  | { type: "history-mark-clear" }
  | { type: "history-open-view" }
  | { type: "history-view"; id: string; messages: HistoryMessage[] }
  | { type: "history-view-error"; error: string }
  | { type: "history-resume"; id: string }
  | { type: "history-resume-error"; id: string; error: string }
  | {
      type: "history-resume-ok";
      id: string;
      title: string;
      rows: { text: string; kind: "user" | "assistant" }[];
    }
  /** 切换活跃会话（/new 新建后切过去）：缓冲/滚动/窗口按空会话重置 */
  | { type: "session-switch"; id: string; title: string }
  | { type: "history-scroll"; delta: number }
  | { type: "history-back" }
  | { type: "history-result"; text: string }
  | { type: "history-refresh"; records: SessionInfo[] }
  | { type: "history-confirm-delete" }
  | { type: "history-confirm-clean" }
  | { type: "history-confirm-cancel" }
  | { type: "history-delete" }
  | { type: "history-delete-done"; ids: string[] }
  | { type: "history-clean" }
  | { type: "history-clean-done"; ids: string[] }
  | { type: "history-close" }
  | { type: "session-identify"; id: string; title: string }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "input"; text: string; cursor: number }
  | { type: "input-mode"; mode: InputMode }
  | { type: "input-status"; status: InputStatus }
  | { type: "move-cursor"; delta: number }
  | { type: "scroll"; delta: number; max?: number; geom?: DialogueGeometry }
  | { type: "scroll-to-bottom" }
  | { type: "scroll-to-oldest" }
  | {
      type: "anchor-resolved";
      anchor: DialogueAnchor | null;
      offset: number;
      geometry: DialogueGeometry;
    }
  | { type: "window-groups"; groups: number }
  | { type: "user-jump"; anchor: DialogueAnchor | null }
  /** clearActivity：是否清空活动区内容（缺省 true；核心自发回合传 false，见 appendTurnSeparator） */
  | { type: "turn-begin"; clearActivity?: boolean }
  | { type: "turn-end" }
  | { type: "clear-stripped" }
  | { type: "status"; status: Partial<SystemStatus> }
  | { type: "set-theme"; themeId: ThemeId }
  | { type: "activity-verbose"; on: boolean }
  | { type: "symbol-unify"; on: boolean }
  | { type: "tool-call"; sessionId: string; name: string; summary: string }
  | {
      type: "model-selection";
      sessionId: string;
      provider?: string;
      model?: string;
      reasoningEffort?: unknown;
    }
  | {
      type: "tool-result";
      sessionId: string;
      ok: boolean;
      detail: string;
      meta?: unknown;
    }
  | {
      type: "model-selection";
      sessionId: string;
      provider?: string;
      model?: string;
      reasoningEffort?: unknown;
    }
  | {
      type: "usage";
      sessionId: string;
      input: number;
      output: number;
      cacheRead: number;
      contextWindow?: number;
    }
  | { type: "compaction"; phase: "start" | "end" }
  | {
      type: "retry";
      attempt: number;
      max: number;
      delayMs: number;
      code: string;
      message?: string;
    }
  // --- P2 阶段 A 新增（goal 为判别联合，compaction 摘要携完整 raw；step/subagent 阶段 A 透传） ---
  | {
      type: "goal-change";
      sessionId: string;
      operation: Exclude<GoalOperation, "clear">;
      goal: GoalSnapshotLike;
      roundsStarted?: number;
      createdAt?: number;
      updatedAt?: number;
    }
  | {
      type: "goal-change";
      sessionId: string;
      operation: "clear";
      cleared: GoalRefLike;
      clearedAt?: number;
    }
  | { type: "todo-write"; sessionId: string; todos: TodoItemLike[] }
  | {
      type: "mode";
      sessionId: string;
      kind: "plan" | "sandbox" | "permission";
      value: string;
    }
  | {
      type: "step";
      sessionId: string;
      turn: number;
      step: number;
      phase: "start" | "end";
    }
  | {
      type: "subagent";
      sessionId: string;
      label: string;
      mode: "one-shot" | "continuable";
    }
  | {
      type: "compaction-summary";
      sessionId: string;
      text: string;
      raw: CompactionSummaryPayloadLike;
    }
  | {
      type: "approval-policy";
      sessionId: string;
      policy: "ask" | "never";
    }
  | {
      type: "workflow";
      sessionId: string;
      phase: "run-start" | "agent-start" | "agent-end" | "run-end";
      label: string;
      detail?: string;
    }
  | {
      type: "command";
      sessionId: string;
      phase: "run" | "done";
      name: string;
      text?: string;
      ok?: boolean;
    }
  | {
      type: "code-dispatch";
      sessionId: string;
      phase: "start" | "settle";
      name: string;
      summary: string;
      ok: boolean;
    }
  | {
      type: "hook";
      sessionId: string;
      phase: "invoked" | "result";
      point: string;
      decision?: string;
      ok: boolean;
    }
  | {
      type: "schedule";
      sessionId: string;
      operation: "create" | "delete" | "dispatch";
      id?: string;
    }
  | {
      type: "compaction-prune";
      sessionId: string;
      nodeCount: number;
      tokenCount: number;
    }
  | { type: "feedback"; sessionId: string; text: string }
  | { type: "retry-started"; sessionId: string; attempt: number }
  | { type: "agent-preset"; sessionId: string; preset: string }
  | { type: "permission-catalog"; names: string[] }
  | { type: "agent-preset-catalog"; ids: string[] }
  | { type: "jobs-changed"; sessionId: string; jobs: JobInfo[] }
  | { type: "status-panel-open"; panel: StatusPanelState }
  | { type: "status-panel-move"; delta: number }
  | { type: "status-panel-select" }
  | { type: "status-panel-close" }
  | { type: "jobs-panel-open" }
  | { type: "jobs-panel-move"; focus: number; delta: number }
  | { type: "jobs-panel-page"; delta: number; page: number }
  | { type: "jobs-panel-close" }
  | { type: "command-panel-open"; kind: CommandPanelKind }
  | { type: "command-panel-move"; delta: number }
  | { type: "command-panel-page"; delta: number; page: number }
  | { type: "command-panel-close" }
  | {
      type: "command-panel-data";
      kind: CommandPanelKind;
      rows: CommandPanelRow[];
      error?: string;
    }
  | { type: "status-column-scroll"; delta: number }
  | { type: "focus-panel-cycle" }
  | { type: "activity-scroll"; delta: number; max?: number }
  /** max = 可视候选数上界（App 按活动区行数给；超出可视区的候选不参与焦点导航） */
  | { type: "completion-move"; delta: number; max?: number }
  | { type: "completion-close" }
  | { type: "command-catalog"; commands: readonly CommandCandidate[] };

function setInput(
  state: AppState,
  action: Extract<StateAction, { type: "input" }>,
): AppState {
  const cursor = Math.max(0, Math.min(action.cursor, action.text.length));
  // 输入变更的单一漏斗点：候选随文本同步重算（非命令 token 输入自动得到 null → 面板收起）
  return {
    ...state,
    inputText: action.text,
    inputCursor: cursor,
    completion: completeCommandInput(
      action.text,
      state.registryCommands,
      state.inputMode,
    ),
  };
}

function moveCursor(
  state: AppState,
  action: Extract<StateAction, { type: "move-cursor" }>,
): AppState {
  const cursor = Math.max(
    0,
    Math.min(state.inputCursor + action.delta, state.inputText.length),
  );
  return { ...state, inputCursor: cursor };
}

/** statusPanel 焦点移动：在选项内 clamp（↑/↓）。 */
function moveStatusPanel(
  state: AppState,
  action: Extract<StateAction, { type: "status-panel-move" }>,
): AppState {
  const p = state.statusPanel;
  if (!p || p.options.length === 0) return state;
  const index = Math.max(
    0,
    Math.min(p.options.length - 1, p.index + action.delta),
  );
  if (index === p.index) return state;
  return { ...state, statusPanel: { ...p, index } };
}

/** 命令补全面板焦点移动：在可视候选数内 clamp（↑/↓，不循环；max=活动区可容纳的候选数） */
function moveCompletion(
  state: AppState,
  action: Extract<StateAction, { type: "completion-move" }>,
): AppState {
  const c = state.completion;
  if (!c || c.items.length === 0) return state;
  const visible = Math.max(
    1,
    Math.min(c.items.length, action.max ?? c.items.length),
  );
  const index = Math.max(0, Math.min(c.index + action.delta, visible - 1));
  return { ...state, completion: { ...c, index } };
}

/** statusPanel 空格预选：焦点行 id 写入 selected（同值再按取消）；避免误提交。 */
function selectStatusPanel(state: AppState): AppState {
  const p = state.statusPanel;
  if (!p || p.options.length === 0) return state;
  const id = p.options[p.index]!.id;
  const selected = p.selected === id ? null : id;
  return { ...state, statusPanel: { ...p, selected } };
}

/**
 * picker 高亮移动：在 0..options.length-1 内 clamp（上下键导航）。
 */
function movePicker(
  state: AppState,
  action: Extract<StateAction, { type: "picker-move" }>,
): AppState {
  const picker = state.picker;
  if (!picker) return state;
  // 分区各自的列表独立 clamp：
  // phase0=provider 列, phase1=model 列, phase2=thinking 列
  if (picker.phase === 0) {
    if (picker.providers.length === 0) return state;
    const pi = Math.max(
      0,
      Math.min(
        picker.providerIndex + action.delta,
        picker.providers.length - 1,
      ),
    );
    if (pi === picker.providerIndex) return state;
    // model 列跟随星号（selectedProvider），不随 > 焦点切换（见 selectPicker）
    return { ...state, picker: { ...picker, providerIndex: pi } };
  }
  if (picker.phase === 1) {
    if (picker.models.length === 0) return state;
    const mi = Math.max(
      0,
      Math.min(picker.modelIndex + action.delta, picker.models.length - 1),
    );
    if (mi === picker.modelIndex) return state;
    return { ...state, picker: { ...picker, modelIndex: mi } };
  }
  // thinking 焦点区：在 efforts 内 clamp；无等级时忽略方向键
  if (picker.efforts.length === 0) return state;
  const ei = Math.max(
    0,
    Math.min(picker.effortIndex + action.delta, picker.efforts.length - 1),
  );
  if (ei === picker.effortIndex) return state;
  return { ...state, picker: { ...picker, effortIndex: ei } };
}

/**
 * 选择面板「选中」：把当前 phase 焦点行值写入对应列的选中字段（星号标记），
 * 与焦点箭头（位置指示）分离。Enter 提交的是各列选中值。
 */
function selectPicker(state: AppState): AppState {
  const picker = state.picker;
  if (!picker) return state;
  if (picker.phase === 0) {
    const v = picker.providers[picker.providerIndex];
    if (!v) return state;
    if (v === picker.selectedProvider) {
      // 幂等：重选同一 provider 不重置 model/思考等级列
      return { ...state, picker: { ...picker, selectedProvider: v } };
    }
    // 星号移到新 provider：model 列跟随选中 provider，旧 model 选中失效
    // （effort 列表由 App 重载；思考等级星号保留，新列表中存在才显示）
    const models = picker.providerModels[v] ?? [];
    return {
      ...state,
      picker: {
        ...picker,
        selectedProvider: v,
        models,
        modelIndex: 0,
        selectedModel: undefined,
        efforts: [],
        effortIndex: 0,
      },
    };
  }
  if (picker.phase === 1) {
    const v = picker.models[picker.modelIndex];
    if (!v) return state;
    // 思考等级星号保留（跨模型沿用，如当前 reasoningEffort），effort 列表由 App 重载
    return { ...state, picker: { ...picker, selectedModel: v } };
  }
  // phase 2：effort 区，仅列表非空时标记
  if (picker.efforts.length === 0) return state;
  const v = picker.efforts[picker.effortIndex];
  if (!v) return state;
  return { ...state, picker: { ...picker, selectedEffort: v.id } };
}

/** Tab 循环切换三列焦点区（efforts 为空时切到 thinking 列仍为灰色提示） */
function tabPicker(state: AppState): AppState {
  const picker = state.picker;
  if (!picker) return state;
  const phase = ((picker.phase + 1) % 3) as 0 | 1 | 2;
  return { ...state, picker: { ...picker, phase, effortIndex: 0 } };
}

/** 左右方向键切换三列焦点区（clamp 不循环：左到头/右到尾保持不动） */
function phasePicker(
  state: AppState,
  action: Extract<StateAction, { type: "picker-phase" }>,
): AppState {
  const picker = state.picker;
  if (!picker) return state;
  const phase = Math.max(0, Math.min(picker.phase + action.delta, 2)) as
    0 | 1 | 2;
  if (phase === picker.phase) return state;
  return { ...state, picker: { ...picker, phase } };
}

/** 替换当前高亮模型的思考等级选项（异步加载完成后下发） */
function setPickerEfforts(
  state: AppState,
  action: {
    type: "picker-efforts";
    efforts: { id: string; name: string }[];
    effortIndex?: number;
  },
): AppState {
  const picker = state.picker;
  if (!picker) return state;
  const preset = action.effortIndex ?? 0;
  const effortIndex =
    preset > 0 && preset < action.efforts.length
      ? preset
      : preset >= action.efforts.length && action.efforts.length > 0
        ? action.efforts.length - 1
        : 0; // 预设越界时回退末尾/0
  return {
    ...state,
    picker: { ...picker, efforts: action.efforts, effortIndex },
  };
}

/** 打开问答面板：把一次 ask() 的整批题转为交互状态（无题则不变） */
function openQuestion(
  state: AppState,
  action: { type: "question-open"; id: string; questions: QuestionItem[] },
): AppState {
  if (action.questions.length === 0) return state;
  const items: QuestionPanelItem[] = action.questions.map((q) => ({
    id: q.id,
    question: q.question,
    header: q.header,
    detail: q.detail,
    options: q.options ?? [],
    multiSelect: q.multiSelect ?? false,
    intent: q.intent
      ? { kind: "plan-review", approve: q.intent.approve }
      : undefined,
    optionIndex: 0,
    selected: [],
    custom: "",
  }));
  // 移除 unused first 引用（自定义兑底项始终存在，列表总长度 = options.length + 1）
  return {
    ...state,
    question: {
      id: action.id,
      items,
      itemIndex: 0,
    },
    // 问答面板打开 = 等待用户决策（黄△）
    inputStatus: "waiting",
  };
}

/** 列表高亮移动：↑/↓ 在 0..options.length（末位为“自定义回答”兑底项）内 clamp */
function moveQuestion(
  state: AppState,
  action: { type: "question-move"; delta: 1 | -1 },
): AppState {
  const panel = state.question;
  if (!panel) return state;
  const item = panel.items[panel.itemIndex];
  if (!item) return state;
  const max = item.options.length; // 末位 = 自定义兑底项
  const next = Math.max(0, Math.min(item.optionIndex + action.delta, max));
  if (next === item.optionIndex) return state;
  const items = [...panel.items];
  items[panel.itemIndex] = { ...item, optionIndex: next };
  return { ...state, question: { ...panel, items } };
}

/** 第 n/m 题导航：左右切换题目（clamp 不循环），每题重置于列表首项 */
function navQuestion(
  state: AppState,
  action: { type: "question-nav"; delta: 1 | -1 },
): AppState {
  const panel = state.question;
  if (!panel) return state;
  const next = Math.max(
    0,
    Math.min(panel.itemIndex + action.delta, panel.items.length - 1),
  );
  if (next === panel.itemIndex) return state;
  const items = [...panel.items];
  items[next] = { ...items[next]!, optionIndex: 0 };
  return { ...state, question: { ...panel, itemIndex: next, items } };
}

/** 标记/取消标记高亮选项（空格）：单选替换（同时清掉自定义文本，二选一互斥）、多选 toggle */
function selectQuestionOption(state: AppState): AppState {
  const panel = state.question;
  if (!panel) return state;
  const items = [...panel.items];
  const item = items[panel.itemIndex];
  if (!item) return state;
  const label = item.options[item.optionIndex]?.label;
  if (!label) return state; // 高亮在自定义兑底项（无 label）时空格无效
  items[panel.itemIndex] = item.multiSelect
    ? {
        ...item,
        selected: item.selected.includes(label)
          ? item.selected.filter((s) => s !== label)
          : [...item.selected, label],
      }
    : { ...item, selected: [label], custom: "" }; // 单选选预设即覆盖自定义
  return { ...state, question: { ...panel, items } };
}

/** 自定义回答文本（每次键入全量替换）；单选时输入会清空已选预设（二选一互斥） */
function setQuestionCustom(state: AppState, text: string): AppState {
  const panel = state.question;
  if (!panel) return state;
  const items = [...panel.items];
  const item = items[panel.itemIndex];
  if (!item) return state;
  items[panel.itemIndex] = item.multiSelect
    ? { ...item, custom: text }
    : { ...item, custom: text, selected: text === "" ? item.selected : [] };
  return { ...state, question: { ...panel, items } };
}

/**
 * 对话区行位移（正数上滚、负数下滚）：语义锚点 + 渐进窗口。
 *
 * - 位移经 `moveDialogueAnchor` 在锚点坐标上换算（顶到窗口末行 → 锚点 null 跟随底部）；
 *   几何（行分组表/可视行数）来自本帧布局（`geom`；缺省用 state 里的派生缓存），
 *   因此「上滚半屏」在任意换行宽度/窗口大小下都落在同一行身份上。
 * - 上滚后视口顶行距物化窗口顶部不足半屏 → 增窗（每次 +WINDOW_GROW_STEP 组）：
 *   扩窗在视口上方插入行，锚点保证同一内容留在原地（"渐进定位"的可见效果）。
 * - 回到跟随底部时窗口复位为默认组数（释放增量物化）。
 */
export function scrollDialogue(
  state: AppState,
  delta: number,
  geom?: DialogueGeometry,
): AppState {
  const g = geom ?? state.dialogueGeometry;
  const totalGroups = turnGroupStarts(state.buffer).length;
  const anchor = moveDialogueAnchor(state.scrollAnchor, delta, g);
  // 增窗判定：上滚 + 视口顶行已进入窗口顶部「半屏」区间（或窗口内已无可滚行、上方
  // 仍有更早回合组）→ 再物化一批更早回合组。扩窗在视口上方插入行，锚点不变 →
  // 同一内容留在原地，多出来的更早历史从其上方长出来（渐进定位的可见效果）。
  const top =
    anchor === null
      ? Math.max(0, g.rows - g.height)
      : anchorToIndex(g.spans, anchor);
  const margin = Math.max(1, Math.floor(g.height / 2));
  const nearTop = top <= margin || g.rows <= g.height;
  let windowGroups = state.windowGroups;
  if (delta > 0 && windowGroups < totalGroups && nearTop)
    windowGroups = Math.min(totalGroups, windowGroups + WINDOW_GROW_STEP);
  if (anchor === null) {
    // 跟底：下滚方向（delta < 0）才复位窗口（释放增量物化）；上滚触发的扩窗保留
    return {
      ...state,
      scrollAnchor: null,
      followBottom: true,
      windowGroups: delta < 0 ? DIALOGUE_KEEP_REPLIES : windowGroups,
    };
  }
  return {
    ...state,
    scrollAnchor: anchor,
    followBottom: false,
    windowGroups,
    // 派生缓存同步（既有调用/断言口径；绘制期 syncScrollAnchor 会再校准一次）
    scrollOffset: anchorToOffset(g.spans, anchor, g.height),
  };
}

/**
 * 按 delta 滚动：正数上滚（delta>0 暂停跟随），负数下滚；滚回底部恢复跟随。
 * scrollOffset 语义 = 距底部多少行。
 *
 * `maxOffset` 为当前内容/窗口下真正可滚动的上限（App 从上一帧 FrameScrollReport 取）。
 * 偏移必须收敛到它：渲染层只做显示侧 clamp，状态里若留着越界偏移（连续上滚越顶、
 * `End` 跳到顶部、窗口变高/内容变短），此后下滚要先"还债"——按了没反应，看起来假死。
 * 因此这里先收敛当前偏移再叠加 delta；缺省无上限（调用方未提供时行为不变）。
 */
export function scrollBy(
  state: AppState,
  delta: number,
  maxOffset: number = Number.MAX_SAFE_INTEGER,
): AppState {
  const cur = Math.min(state.scrollOffset, Math.max(0, maxOffset));
  if (delta > 0) {
    return {
      ...state,
      followBottom: false,
      scrollOffset: Math.min(cur + delta, Math.max(0, maxOffset)),
    };
  }
  const next = Math.max(0, cur + delta);
  return {
    ...state,
    scrollOffset: next,
    followBottom: next === 0 ? true : state.followBottom,
  };
}
