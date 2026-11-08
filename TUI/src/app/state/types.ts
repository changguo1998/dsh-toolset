// TUI/src/app/state/types.ts — 状态模型（类型、常量、纯查询与默认值）

import type {
  ApprovalItem,
  AgentStatus,
  SessionMeta,
  SessionInfo,
  HistoryMessage,
  NoticeTone,
  CompactionSummaryPayloadLike,
  GoalOperation,
  GoalActivation,
  GoalSnapshotLike,
  TodoItemLike,
  JobInfo,
  CommandPanelRow,
  CommandPanelKind,
  AgentRowInfo,
} from "../adapter/dsh.ts";
import type { ModelSelection, ModelSelectionLike } from "../adapter/dsh.ts";
import type { SectionsState } from "../layout/pipeline/sections.ts";
import type { ActiveAtToken, FileMentionCandidate } from "../file-mention.ts";
import type { ActivityPlacement } from "../config.ts";
import { type RunVirtState } from "../layout.ts";
import type { DialogueTop } from "../layout/pipeline/rows.ts";
import { type CommandCandidate } from "../commands.ts";
import { type ThemeId } from "../../renderer/theme.ts";

// TUI/src/app/state/types.ts — 状态模型（类型、常量、纯查询与默认值）

/** 顶部三面板（会话区 / 回合区 / 状态列）：`Ctrl+E` / `Ctrl+T` / `Ctrl+S` 一键一区域 */
export type PanelId = "history" | "activity" | "status";

/** scrollback 行数上限（纯物理上限；DESIGN:2000 行） */
export const MAX_BUFFER_LINES = 2000;

/**
 * 缓冲头部裁剪（就地）：超过上限时丢弃最旧行。
 *
 * 会话内容真源已迁到节缓存（`state.pipeline`），缓冲不再参与构帧，故裁剪**不再需要
 * 为阅读位置让路**（视口顶按段键定位，与缓冲无关）：直接按上限裁。
 */
export function trimBufferHead(buffer: HistoryRow[]): void {
  const over = buffer.length - MAX_BUFFER_LINES;
  if (over > 0) buffer.splice(0, over);
}

/** 用户块左缘/回复右缘对称留空默认列数（可经 initialState 配置，交错布局用）。
 *  4：两侧各留 gutter-1 = 3 列 → 输入最长折行左缘对齐回复正文第 3 个字符。 */
export const DEFAULT_MESSAGE_GUTTER = 4;

/** 输入模式（$ shell / / slash / < followup / ! interrupt（打断并发送）；提交后自动回退默认
 *  steer，不再有 Esc 回退）。打断的唯一入口是 `interrupt` 模式（2026-10-15 起：Esc 不再打断、
 *  Alt+Enter 不再有独立语义，见 BACKLOG「Esc 取消打断，打断统一由 `!` 模式承担」）。 */
export type InputMode = "steer" | "followup" | "shell" | "slash" | "interrupt";

/** 回合区**输出内容档位**（BACKLOG #8，`/verbose think|tool|step`；缺省 `think`）：
 *  - `think`：思考 + 正文 + 工具调用（调用行 / 参数 / 结果 / 辅助行全显示）；
 *  - `tool`：正文 + 工具调用（去思考行）；
 *  - `step`：正文 + 工具调用的**调用行**（去结果行 / 辅助行；step 头与 notice 保留）。 */
/** 回合区内容类别（`/verbose` 显示开关与 `/collapse` 压缩开关各按三类维护）。 */
export type ActivityCategory = "think" | "tool" | "reply";

/** 三类开关的取值表。 */
export type ActivitySwitches = Record<ActivityCategory, boolean>;

/** 三类全开（显示缺省）。 */
export const ACTIVITY_SHOW_DEFAULT: ActivitySwitches = {
  think: true,
  tool: true,
  reply: true,
};

/** 三类全关（压缩缺省；全关 = 完整折行）。 */
export const ACTIVITY_COMPACT_DEFAULT: ActivitySwitches = {
  think: false,
  tool: false,
  reply: false,
};

/** 输入历史条目（BACKLOG TUI#34）：提交时的**提示符口径文本** + 当时的输入模式。
 *  模式必须随条目保存——否则 `/agents` 回溯后会变成普通输入（真机缺陷修复，2026-09-27）。 */
export interface InputHistoryEntry {
  text: string;
  mode: InputMode;
}

/** 排队项（BACKLOG TUI#43）：`followup` = 等下一回合认领；`steer` = 等本回合下一次 step 认领。
 *  两类共用一条队列（按提交顺序存）；渲染时 steer 整体排在 followup 之上、右缘竖线颜色不同。 */
export interface QueuedItem {
  text: string;
  kind: "followup" | "steer";
}

/** 输入状态（P1 起用于**用户块首行**符号，不再渲染在状态行最左侧）：绿✓=成功 /
 *  红✗=失败 / 黄●/○=运行中（实心/空心圆按流式输出节奏交替，见 RUN_TOGGLE_CHARS）/
 *  黄△=等待交互（审批/问答面板打开等用户决策）/ idle=尚无结果（渲染回退 ?） */
export type InputStatus =
  "success" | "failure" | "running" | "waiting" | "idle";

/** 当前接收中的流式内容类型（接收中运行符号着色依据; undefined = 未定/发送中）。
 *  思考紫 / 正文蓝 / 工具黄 / notice 灰 / shell 青（见 run-virt 的 STREAM_KIND_COLOR）。 */
export type StreamKind = "thinking" | "assistant" | "tool" | "notice" | "shell";

/** turn/end 的收尾原因（宿主 `reason.kind`；缺省/未识别 = undefined）。
 *  P1 用它决定用户块终态符号：`completed`→✓ / `aborted`→■ / `error`→✗ / 其余→`?` */
export type TurnEndReason =
  "completed" | "aborted" | "error" | "blocked" | "max-tokens" | "interrupted";

/** 行的 kind 取值：内容行（user / assistant / thinking / separator / step）+ UI 本地行
 *  （notice / tool / shell / plain）——渲染与重放按本全集判别，缓冲只落本地行那一半。 */
export type HistoryRowKind =
  | "user"
  | "assistant"
  | "thinking"
  | "separator"
  | "step"
  | "notice"
  | "tool"
  | "shell"
  | "plain";

/** 缓冲行类型（**UI 本地行**）：条目 16 段 C2 之后，缓冲只承载本地行（notice / tool /
 *  shell / plain）——内容（用户块 / 正文 / 思考 / 回合分隔线 / step 概要）不再有缓冲行形态，
 *  唯一来源是节缓存（`state.pipeline`，交付驱动）。需要「按行重放成节」的路径（会话恢复 /
 *  测试重放）用 `HistoryRow`；渲染层按「行的通用形态」消费（`HistoryRow[]`）。 */
export type BufferKind = "notice" | "tool" | "shell" | "plain";

/** 行的通用形态（内容行 ∪ UI 本地行）：节缓存重放（`sectionsFromBuffer`）、行 → 渲染叶子
 *  （`buildContentRows` / `buildBox`）与恢复行共用。**kind 放宽到全部 9 种**——内容行的
 *  比较分支（`=== "assistant"` 等）在这一层仍是活分支。 */
export interface HistoryRow {
  text: string;
  kind: HistoryRowKind;
  /** 着色分级（notice / tool 行） */
  tone?: NoticeTone | undefined;
  /** 回合最终总结（进会话区） */
  final?: boolean | undefined;
  /** 回合分隔线 / step 概要的时间戳与回合号 */
  time?: number | undefined;
  turn?: number | undefined;
  /** 用户块终态符号（完成 ✓ / 失败 ✗ / 中止 ■）；缺省 = 未收到终态（渲染 `?`） */
  status?: "success" | "failure" | "aborted" | undefined;
  /** 与上一条输入之间留空行（steer 插队送达） */
  spaceBefore?: boolean | undefined;
  /** 「被 steer 续接」标记（终态符号显示 ←） */
  steerContinued?: boolean | undefined;
  /** 排队中的用户消息（followup 右缘竖线灰 / steer 黄） */
  queued?: "followup" | "steer" | undefined;
  /** 悬垂缩进（notice 用，/help 双列表格）：本行折行时续行停靠列（描述列起点） */
  hanging?: number | undefined;
  /** 紧凑模式（/collapse off）豁免：本行仍完整折行显示（/help 用，不被压成 1 行隐藏） */
  noCompact?: boolean | undefined;
  /** #1：落行时的活动 step 号（会话区正文分块与问答来源段共用该标） */
  step?: number | undefined;
  /** 活跃用户块标记（由节模型 `panes.ts` 打标；解析器直接读本字段） */
  active?: boolean | undefined;
  /**
   * 工具块行角色（2026-10-13 工具块改版，见 `TUI/docs/archived/2026-10-13-tool-block-display.md`）：
   * `name` = 名字行（标记 + 空格 + 工具名）/ `param` = 参数行 / `result` = 结果行。
   * 缺省 = 旧口径的单文本工具行（辅助行 / 恢复产物）。
   */
  toolRole?: "name" | "param" | "result" | undefined;
  /** 参数行的名与值（名染灰、值原色；折行与悬挂 6 列由排版层按宽度做，
   *  行数上限 = 折行核的预算：最多 5 行，超出保留前 3 + 后 2） */
  toolParam?: { name: string; value: string } | undefined;
  /** 该调用 / 结果的成败（失败：名字行 `✗` 红 + 结果行整行红）；缺省 = 尚无结果（在飞） */
  toolOk?: boolean | undefined;
}

/** 缓冲行（UI 本地行；`kind` 收窄到 `BufferKind` 的 `HistoryRow`） */
export type BufferLine = HistoryRow & { kind: BufferKind };

/** 行表（`state.local`；渲染与重放按通用形态消费） */
export type Buffer = HistoryRow[];

/** 状态行各字段：time/cwd/git 由 StatusTicker 合并节流读取，其余为占位 */
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
  /** 会话别名（session-channel 插件的 `alias`；缺省不显示。TUI#48） */
  alias?: string;
}

/** turn 分隔线（横线占位；实际宽度由会话区换行决定） */
export const TURN_SEPARATOR = "--------";

/** P2 goal 条目（`goal/change` set 分支：完整快照 + 事件元数据；clear 分支即出栈不留条目） */
export interface GoalEntry {
  operation: Exclude<GoalOperation, "clear">;
  goal: GoalSnapshotLike;
  roundsStarted?: number;
  createdAt?: number;
  updatedAt?: number;
}

/** P2 goal 历史（按会话隔离；index 0 = 当前/最新 goal，其后为已完成或已被取代的旧 goal）。
 *  create（含未知 id）入栈、edit/pause/resume/complete/block 按 id 原位更新、clear 出栈；
 *  状态列据此把旧 goal 以「已结束」样式（灰 + 删除线）与当前 goal 一并展示。 */
export type GoalHistory = readonly GoalEntry[];

/** P2 selector：取当前会话最新 goal 快照（含 objective/phase）；无/已清除 → undefined */
export function activeGoalSnapshot(
  state: AppState,
  sessionId: string | undefined,
): GoalSnapshotLike | undefined {
  if (!sessionId) return undefined;
  return state.goalBySession[sessionId]?.[0]?.goal;
}

/** goal 自动续轮开关的**展示值**（进程本地态）：
 *  只要本进程收到过该会话的 activation 边就显示——armed / disarmed 都是有效值，**不再按相位门控**
 *  （paused / blocked / complete 也会显示灰 ⟳，颜色口径不变：armed 绿、disarmed 灰）；
 *  取值 = 本进程收到的**最后一条** activation 边；**无记录 → 不显示**（宿主重启 / 回放 / 会话切换后
 *  不再推导为 `disarmed`——用户 2026-10-06 裁定，推翻归档文档「可推导初值」的当时决策）。
 *  宿主 `goal-round-driver` 会在相位仍为 active 时主动 disarm，此时有 disarmed 边 → 显示灰 ⟳，
 *  故不做「见过 armed 就恒绿」的粘性记忆）。 */
export function goalActivationDisplay(
  state: AppState,
  sessionId: string | undefined,
): GoalActivation | undefined {
  if (!sessionId) return undefined;
  return state.goalActivationBySession[sessionId];
}

/** P2 模式徽标状态（plan 用 "on"/"off"；sandbox/permission 存原始值字符串；缺省省略） */
export interface ModeState {
  plan?: "on" | "off" | undefined;
  sandbox?: string | undefined;
  permission?: string | undefined;
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

/** /history 历史会话面板状态（阶段见 HistoryPhase：列表浏览 + resume 切换 + 删除/清理引导） */
export interface HistoryPanelState {
  phase: HistoryPhase;
  /** 会话列表（newest-first；list 阶段填充） */
  records: SessionInfo[];
  /** 列表高亮索引 */
  index: number;
  /** view 阶段浏览的会话 id */
  currentId?: string | undefined;
  /** view 阶段归一化消息列表 */
  messages: HistoryMessage[];
  /** view 阶段滚动行偏移（渲染层按可视高度 clamp） */
  scroll: number;
  /** error 阶段错误消息 */
  error?: string | undefined;
  /** resume 切换的目标会话 id（resuming 阶段）；成功后清空 */
  pendingResume?: string | undefined;
  /** confirm-delete/deleting 阶段的目标会话 id（确认后由调用方经 adapter 删除） */
  pendingDelete?: string | undefined;
  /** confirm-delete/deleting 阶段的**批量**目标会话 id（有标记时按标记集删除；
   *  与 pendingDelete 互斥，二者恰有其一非空） */
  pendingDeleteIds?: string[] | undefined;
  /** 批量删除标记集（Space 标记/取消、a 全选当前范围、c 清空；按 id 记录，跨范围切换保留） */
  marked?: string[] | undefined;
  /** confirm-clean/cleaning 阶段待清理的空会话 id 列表（范围=当前列表范围） */
  pendingClean?: string[] | undefined;
  /** confirm-clean/cleaning 阶段的当前项目路径（确认文案展示） */
  cleanCwd?: string | undefined;
  /** 面板内结果提示（删除/清理结果与护栏文案；首行展示，下次操作时清除）。
   *  面板占满回合区时 notice 不可见（notice 归回合区），故结果需面板内呈现 */
  result?: string | undefined;
  /** 列表范围：project=仅当前目录（默认）/ all=全部目录；list 阶段 [Tab] 切换 */
  scope?: "project" | "all" | undefined;
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
export function dropHistoryRecords(
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

/**
 * 输入补全候选状态（两类共用一套面板 / 键位 / 可视行口径，见 decisions「面板承载」）：
 * - `command`：输入仍是首个命令 token（同步可得，本地目录 + 宿主注册表）；
 * - `file`：提示文本里光标处有活动 `@` token（**异步**：items 首帧为空，App 请求宿主
 *   `ctx.fileReferences` 后用 completion-data 回填；token 用于接受时就地替换与过期丢弃）。
 */
export type CompletionState =
  | {
      kind: "command";
      items: readonly CommandCandidate[];
      index: number;
    }
  | {
      kind: "file";
      items: readonly FileMentionCandidate[];
      index: number;
      /** 本次候选对应的活动提及 token（prefix = 接受时要替换掉的完整 token） */
      token: ActiveAtToken;
    };

/** 状态列五块的数据快照（task / flow / pin / daemon / group；缺省字段 = 该块无内容 → 不渲染）。 */
export interface StatusExtras {
  /** 任务引擎：活跃帧 / 总帧 + 当前任务栈（自底向顶）。 */
  task?: { active: number; total: number; stack: string[] } | undefined;
  /** flow-track：标题用的最新 `slug@阶段` + 每 slug 明细。 */
  flow?:
    | {
        stage: string;
        items: Array<{
          slug: string;
          stage: string;
          status: string;
          active: boolean;
        }>;
      }
    | undefined;
  /** pin-note：条数 / 合计字数 / 标题。 */
  pin?: { count: number; chars: number; titles: string[] } | undefined;
  /** background-daemon：开关 / 运行中 / 总数 / 每任务。 */
  daemon?:
    | {
        enabled: boolean;
        running: number;
        total: number;
        items: Array<{ name: string; status: string }>;
      }
    | undefined;
  /** agent-group：我创建的组（直接子） / 我加入的组（直接上级）。 */
  group?:
    | {
        created: Array<{ name: string; children: string[] }>;
        joined: Array<{ name: string; parent: string }>;
      }
    | undefined;
}

export interface AppState {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  /** 会话纯文本行（未换行，展示时才按列宽切分） */
  local: Buffer;
  /** 是否跟随底部（= `dialogueTop` 为 null；由位置派生，供既有调用口径使用） */
  followBottom: boolean;
  /** 距底部行数（派生缓存：每帧由布局回填；段键失配时的回落基准，供既有断言口径使用） */
  scrollOffset: number;
  /**
   * 会话区视口顶位置（段键 + 段内行；`null` = 跟随底部/最新）。
   * 位置按**内容段身份**表达：上方插入段（扩窗纳入更早回合）不动画面；宽度变化按段键重定位；
   * 段消失时回落 `scrollOffset`（距底偏移）。
   */
  dialogueTop: DialogueTop | null;
  /** 回合(活动)区视口顶位置（段键 + 段内行；`null` = 跟随底部/最新；语义同 `dialogueTop`） */
  activityTop: DialogueTop | null;
  /** 渐进窗口：物化的尾部回合组数（上滚接近窗口顶部时增大；回到最新时复位默认） */
  windowGroups: number;
  /**
   * 六步流水线的节缓存（App 注入；内容真源）。
   * 缺省（测试 / 嵌入用法）由 `layout.ts` 的 `sectionsOf` 按 `buffer` 重放一份。
   */
  pipeline?: SectionsState | undefined;
  inputText: string;
  inputCursor: number;
  /** 输入历史（已提交输入连同**提交时的输入模式**；仅本会话生命周期，不持久化）。
   *  末尾 = 最近一条；相邻重复（文本 + 模式均相同）不入栈；条数上限见 `inputHistoryPush` */
  inputHistory: readonly InputHistoryEntry[];
  /** 输入历史游标（0 = 未翻看；n = 距最新第 n 条；超过长度时夹到最早一条） */
  inputHistoryCursor: number;
  /** 进入翻看前的草稿（回到最新条目之下时恢复；非翻看态恒为空串） */
  inputHistoryDraft: string;
  /** 进入翻看前的草稿模式（随草稿一起恢复；非翻看态为 steer） */
  inputHistoryDraftMode: InputMode;
  /** 排队项（**已投递给核心、尚未被认领**的文本，按提交顺序存；本机只用于显示）：
   *  `followup` 等下一回合、`steer` 等本回合下一次 step（TUI#43）。核心认领时该条转入
   *  历史流（按类型认领：`queued-claim` 取最早 followup、`queued-claim-steer` 取最早 steer）。 */
  queued: QueuedItem[];
  /** 输入模式（符号代表模式；提交后自动回退默认 steer） */
  inputMode: InputMode;
  /** 输入状态（用户块首行符号来源；P1 起状态行不再渲染该符号）：绿✓=成功 /
   *  红✗=失败 / 黄旋转箭头（首字节未到, 发送中）→ 黄●/○（接收中, 按流类型着色）
   *  / 黄△=等待交互（审批/问答面板打开等用户决策）/ idle=尚无结果（渲染回退 ?） */
  inputStatus: InputStatus;
  /** 当前接收中的流式内容类型（运行符号类型色; 发送期 / turn-end 时清空, 见
   *  reducer-input / reducer-turn; undefined = 发送中或无活动流） */
  streamKind?: StreamKind | undefined;
  approval: ApprovalItem | null;
  /** 审批面板描述窗口首行偏移（BACKLOG 3.2.1 统一窗口机制；打开/关闭归零） */
  approvalScroll: number;
  /** 审批选项焦点（BACKLOG 3.2.4）：approve=批准项 / reject=拒绝项；打开时归 approve */
  approvalFocus: "approve" | "reject";
  /** 审批当前焦点窗（BACKLOG 3.3.4，与问答面板同构）：desc=草稿 / options=选项；打开时归 options */
  approvalWindow: "desc" | "options";
  /** 审批超时时刻（epoch ms，BACKLOG 3.2.5 倒计时来源；null = 无倒计时） */
  approvalDeadline: number | null;
  /** 审批态无效键提示（BACKLOG 3.3.1）：非空时提示行显示它；切换焦点/提交/关闭时清空 */
  approvalHint: string | null;
  agentStatus: AgentStatus;
  /** 最新一次模型调用的 token 用量（assistant/message.usage 归一化；阶段 2 状态行 contextLen/cacheHit 读取）。
   *  会话切换/恢复（`history-resume-ok` / `session-switch`）**清空**——换会话后该值不可知，
   *  状态行与 `/stats` 相应槽位回落 `—` 占位（BACKLOG TUI#12）。 */
  usage?:
    | {
        input: number;
        output: number;
        cacheRead: number;
        contextWindow?: number | undefined;
      }
    | undefined;
  /** 本会话累计 token 用量（`usage` 事件逐次累加；BACKLOG TUI#9）——与会话切换同步清零
   *  （`history-resume-ok` / `session-switch`），`/clearscreen` 等只清显示的路径不清零。
   *  与 `usage`（**最近一次**调用）是两个口径，`/stats` 两者并列展示。 */
  usageTotals: {
    input: number;
    output: number;
    cacheRead: number;
  };
  systemStatus: SystemStatus;
  /** 主题（默认 dark=fffdark；/theme 运行时切换，仅当前会话） */
  themeId: ThemeId;
  /** 用户块左缘/回复右缘对称留空列数（交错布局，默认 4，可配置） */
  messageGutter: number;
  /** 布局配置（false 语义：footerHeight/divisor undefined=默认） */
  footerHeight: number | undefined;
  /** 回合区高分母（contentTopH / divisor；默认 2 ≈ 1/2） */
  activityDivisor: number | undefined;
  /** 回合区分隔行锚定（"half" = floor(rows/2)，或绝对行号；配置后替代 divisor 比例；undefined = 走 divisor） */
  activityTopRow: "half" | number | undefined;
  /** 回合区排列方式（tui.config.json layout.activityPlacement；undefined = 恒上下排列，
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
  /** 通用状态选项面板（/policy /permission 无参打开；↑/↓ 选、空格预选、Enter 提交关闭） */
  statusPanel: StatusPanelState | null;
  /** 当前会话标题（resume 后由 surface 首条用户消息生成；新会话为空，状态行以 <title> 占位） */
  sessionTitle: string;
  /** P2：按 sessionId 隔离的 goal 状态（判别联合；完整保留原始载荷字段） */
  goalBySession: Record<string, GoalHistory>;
  /** goal 自动续轮开关：按 sessionId 存的**最后一条 activation 原始边**（进程本地事件
   *  `goal/activation-changed`，不进会话日志、不随 tui-state.json 落盘；无记录 = 未收到） */
  goalActivationBySession: Record<string, GoalActivation>;
  /** P2：按 sessionId 隔离的 todo 列表（全量快照 last-write-wins） */
  todoBySession: Record<string, TodoItemLike[]>;
  /** TUI#39：按 sessionId 隔离的子代理目录快照（状态列 Agents 块；last-write-wins） */
  agentsBySession: Record<string, AgentRowInfo[]>;
  /** P2：按 sessionId 隔离的模式徽标（plan/sandbox/permission 三合一） */
  modeBySession: Record<string, ModeState>;
  /** C 阶段：按 sessionId 隔离的当前审批策略（approval/policy 事件 latest-wins；无则为 undefined=未收到省略） */
  policyBySession: Record<string, "ask" | "never">;
  /** P2：按 sessionId 隔离的 compaction 摘要（每会话仅最近一条；raw 完整保留） */
  compactionBySession: Record<
    string,
    { raw: CompactionSummaryPayloadLike; text: string }
  >;
  /** B3：step 分组（当前活动 step 组；step/start 落组、step/end 关组）。
   *  分割线自 #7 起在 `step/start` 时直接画，本字段保留供"buffer 行带 step 标"等后续用途。 */
  stepGroup: {
    sessionId: string;
    step: number;
    /** 分组头时间戳（epoch ms；渲染为 `hh:mm:ss ⇆N #M`） */
    time?: number | undefined;
  } | null;
  /** P8：按 sessionId 隔离的「上下文压缩中」标记——压缩期间该会话算活跃
   *  （用户块显示运行中、新消息走排队、Ctrl+D 不退出）；compaction/end 清除 */
  compactingBySession: Record<string, boolean>;
  /** P3：按 sessionId 隔离的 agent 预设（agent-preset/selected 事件 latest-wins；无=未收到） */
  presetBySession: Record<string, string>;
  /** 事件回读的生效模型（model/selection）；状态行模型徽标 fallback 来源 */
  modelBySession: Record<string, ModelSelectionLike | undefined>;
  /** 权限预设目录（ctx.permissionPresets.names；原状态列 Mode 块的可选项，
   *  P7 移除该块后暂无消费方；[]=未同步降级三档） */
  permissionOptions: string[];
  /** agent 预设目录（ctx.agentPresets.list 的 id；原状态列 Mode 块的可选项，
   *  P7 移除该块后暂无消费方；[]=未同步降级当前值） */
  presetOptions: string[];
  /** P3：最近一次后台任务快照（adapter 经 jobs-changed 事件推送；[]=无任务） */
  jobs: JobInfo[];
  /** P3：/jobs 任务面板（null=未打开；index=高亮行，Enter 取消） */
  jobsPanel: { index: number } | null;
  /** 共享列表面板（/skills、/agents、/tools 共用；null = 未打开） */
  commandPanel: CommandPanelState | null;
  /** 输入补全候选（命令 token 或活动 `@` 提及 token；index 0 = 最匹配默认项；null=无候选/未激活） */
  completion: CompletionState | null;
  /** 宿主命令注册表目录（ctx.commands.list，启动同步一次；补全候选并入，同名以本地目录优先） */
  registryCommands: readonly CommandCandidate[];
  /** 宿主文件提及候选服务可用（ctx.fileReferences，启动探测一次）：false 时 `@` 按普通字符输入 */
  fileMentionAvailable: boolean;
  /** P3：顶部状态列纵向滚动偏移（详细 goal/todo；渲染层 clamp） */
  statusColumnScroll: number;
  /** 顶部三面板键盘选中：null=无焦点（新输入/输出后回到无焦点，Tab 才进入）；history=对话历史 / activity=流输出 / status=详细状态列 */
  focusedPanel: PanelId | null;
  /** 回合区（流输出）滚动偏移（距回合区底部行数；0=跟随最新，渲染层 clamp） */
  activityScroll: number;
  /** 回合区**压缩开关**（`/collapse [think|tool|reply] [on|off]`）：按类别决定该条目
   *  是否压成 1 行 + 行尾省略号；三项全关（缺省）= 完整折行 */
  activityCompact: ActivitySwitches;
  /** 回合区**显示开关**（`/verbose [think|tool|reply] [on|off]`）：按类别决定这类内容
   *  是否显示；三项全开（缺省）。与压缩开关正交 */
  activityShow: ActivitySwitches;
  /** 模型输出符号统一（symbol-unify）：true=把变体符号替换为推荐符号并提醒（缺省）；
   *  false=关闭（原样展示，不替换不提醒）。`/symbol-unify on|off` 切换 */
  symbolUnify: boolean;
  /** P7：垂直状态列是否显示（`Ctrl+S` = 聚焦 / 收起两态；随会话持久化 tui-state.json；缺省显示）。
   *  隐藏时状态列宽 0、分隔竖线不绘制、会话区变宽 */
  statusColumnVisible: boolean;
  /** #9：下半区（Turn 流 + 工具区）是否显示（`Ctrl+T` = 聚焦 / 收起两态；随会话持久化；缺省显示）。
   *  隐藏时回合区高度/宽度归零、空间并入会话区；输入区不受影响，
   *  回合区内的交互面板（问答/审批等）仍照常弹出。 */
  lowerPanesVisible: boolean;
  /** 声音提醒总开关（tui.config.json `notify.enabled`；启动时接线）。无会话内切换路径，
   *  标题栏状态符号组按当前值只读展示（on 绿 / off 灰） */
  notifyEnabled: boolean;
  /** flow-track 注入开关（`flowTrack.enabled()` 懒读，随状态行 ticker 同步）。undefined =
   *  还没读到服务（标题栏不渲染该符号）/ true = 打开（绿）/ false = 关闭（灰） */
  flowTrackEnabled: boolean | undefined;
  /** background-daemon 开关（`daemon.status().enabled` 懒读，随状态行 ticker 同步）。
   *  undefined = 还没读到服务, 标题栏仍渲染该符号但按关（灰）显示（2026-11-08 用户裁定） */
  daemonEnabled: boolean | undefined;
  /** 状态列新增五块的快照（task / flow / pin / daemon / group；随状态行 ticker 刷新）。
   *  undefined = 还没读到可用来源 → 五块都不渲染 */
  statusExtras: StatusExtras | undefined;
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

/** 通用状态选项面板（/policy /permission）：单列选项 + 预选星号。
 *  index=焦点行（>）；selected=预选值（空格写入/同值取消；Enter 提交它，回退焦点行）。 */
export interface StatusPanelState {
  kind: "policy" | "permission";
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
  selectedProvider?: string | undefined;
  selectedModel?: string | undefined;
  selectedEffort?: string | undefined;
  /** provider 列筛选词（键入选入；空 = 默认序，只作用于本列，见 picker-filter.ts） */
  providerFilter?: string | undefined;
  /** model 列筛选词（同上，与 provider 列各自独立） */
  modelFilter?: string | undefined;
  /** 当前生效选择（各列浅绿显示） */
  current?: ModelSelection | undefined;
}

/** 问答面板单题交互状态 */
export interface QuestionPanelItem {
  id: string;
  question: string;
  /** 待审计划正文（plan-review intent 展示用） */
  detail?: string | undefined;
  header?: string | undefined;
  options: { label: string; description?: string | undefined }[];
  multiSelect: boolean;
  intent?: { kind: "plan-review"; approve: string } | undefined;
  /** 列表高亮索引：0..options.length（=options.length 表示高亮在“自定义回答”兜底项） */
  optionIndex: number;
  /** 已选选项 label（单选最多 1 项；多选可多项） */
  selected: string[];
  /** 自定义回答文本 */
  custom: string;
  /** 自定义回答的编辑光标（字符偏移，`0..custom.length`；null/缺省 = 未编辑态，见 BACKLOG TUI#35）。
   *  约定：`null` ⟺ 「未编辑」——`←/→` 在未编辑时仍是切题导航，编辑态才在串内移动 */
  customCaret?: number | null;
  /** 被并兜底项的原文（BACKLOG TUI#5）：选项文案命中语义标记（自定义/其它/…）时
   *  从预设列表摘除、原文并入自定义项作为解释文字展示；缺省 = 无合并。 */
  customHint?: string | undefined;
  /** 焦点窗（BACKLOG 3.2.1）：desc=描述窗（↑/↓ 滚动题干/detail），options=选项窗（↑/↓ 移项） */
  focus: "desc" | "options";
  /** 描述窗首行偏移（0 基；上界由渲染层按折行行数算出，App 按键时传 max 进 action） */
  descScroll: number;
}

/** 问答面板整体状态（一次 ask() = 一批题；每屏显示一题，第 n/m 题导航） */
export interface QuestionPanelState {
  /** 面板 id（question 事件 id，answerQuestion/cancelQuestion 用它） */
  id: string;
  items: QuestionPanelItem[];
  /** 当前显示题号（0-based） */
  itemIndex: number;
  /** 面板打开时的问题前正文（回合区最近一条非思考正文，BACKLOG 3.2.10；缺省/空串 = 不显示） */
  source?: string;
}
