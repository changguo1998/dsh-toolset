// src/app/index.ts — App 组装层：renderer + 状态 + adapter 事件流
//
// 只依赖 renderer 公共 API 与 adapter 接口契约，不感知 adapter 实现。
// 处理按键、接收事件、重绘。

import type { Renderer, KeyEvent } from "../renderer/index.ts";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AppState,
  InputMode,
  ActivityLevel,
  QuestionPanelState,
  StateAction,
  StatusPanelState,
} from "./state.ts";
import {
  cleanableSessionIds,
  historyVisibleRecords,
  initialState,
  isCompacting,
  markableSessionIds,
  recentQuestionSource,
  reduceState,
  setSystemStatus,
  startupCleanableIds,
} from "./state.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelCatalog,
  ModelSelection,
  ModelReasoning,
  HistoryMessage,
  SessionInfo,
  SessionChannelLike,
  SessionSurfaceView,
  SymbolNormalizerLike,
  RuleEngineLike,
} from "./adapter/dsh.ts";
import type { NoticeTone, CandidateRowLike } from "./adapter/types.ts";
import {
  applyDelivery,
  createSections,
  type SectionsState,
} from "./layout/pipeline/sections.ts";
import type { BlockDelivery } from "./layout/pipeline/types.ts";
import {
  deliveryOfLine,
  sectionsFromBuffer,
  stepOf,
} from "./layout/pipeline/replay.ts";
import { TURN_SEPARATOR, type BufferLine } from "./state.ts";
import {
  setWidthOverrides,
  setWidthProbeEnabled,
  takePendingWidthProbes,
  widthOverrideEntries,
} from "./layout/markdown.ts";
import {
  readWidthTable,
  terminalKey,
  writeWidthTable,
} from "./layout/width-table.ts";
import { maxDescScrollFor } from "./components/QuestionPrompt.ts";
import { maxApprovalScroll } from "./components/ApprovalPrompt.ts";

/** 审批超时回落值（ms）：adapter 未提供 `approvalTimeoutMs()` 时使用（BACKLOG 3.2.5 / 3.3.2） */
const APPROVAL_TIMEOUT_FALLBACK_MS = 60_000;

/** 帧前实测的超时上限(ms)：探测期间不出帧，故取小值；整批无回包即判定不支持 CPR */
const WIDTH_PROBE_TIMEOUT_MS = 150;
import {
  parseSlashCommand,
  SESSION_UI_STATE_VERSION,
  pickContinueTarget,
  type ContinueTarget,
  type CommandPanelKind,
  type SessionUiState,
  contractSummaryText,
  type SecurityGuardLike,
} from "./adapter/dsh.ts";
import { activeGoalSnapshot, currentProjectCwd } from "./state.ts";
import {
  makeShellGuardChecker,
  resolveShellCwd,
  runShellCommand,
  SHELL_GUARD_SKIPPED_LINE,
  shellGuardBlockedLines,
  shellResultLines,
  type ShellGuardChecker,
  type ShellRunner,
} from "./local-shell.ts";
import {
  INIT_PROMPT,
  buildOsc52,
  deriveTitle,
  lastAssistantText,
  modelCommandSpec,
  renameCommandDecision,
  resolveModelSpec,
  routeSlashCommand,
  slashCommandArg,
  surfaceToBuffer,
  themeCommandDecision,
} from "./commands.ts";
export { formatModelCatalog, resolveModelSpec } from "./commands.ts";
import {
  buildQuestionAnswers,
  questionKeyDecision,
} from "./question-transition.ts";
import {
  buildPickerInit,
  pickerEffortIndex,
  planModelSwitch,
  resolvePickerSelection,
} from "./model-transition.ts";
import {
  buildFrame,
  DIALOGUE_KEEP_REPLIES,
  WINDOW_GROW_STEP,
  type FrameScrollReport,
  type FrameBuildOutput,
  dialogueHalfPage,
  frameGeometry,
  modelLabel,
  userRowJump,
  type FrameGeometry,
  helpTableLines,
  sortHelpRows,
  runPhase,
} from "./layout.ts";
import { createLineTable, positionAt } from "./layout/pipeline/rows.ts";
import { sectionGroupCount, sectionsOf } from "./layout/pipeline/frame.ts";
import {
  DEFAULT_THEME,
  normalizeThemeId,
  type ThemeId,
} from "../renderer/theme.ts";
import { StatusTicker, type StatusQueries } from "./status.ts";
import type { ActivityPlacement } from "./config.ts";

/** Ctrl+D 退出守卫（P8 口径）：agent 空闲、**未在压缩上下文**、且输入区为空才退出。
 *  压缩期间视为活跃——此时按 Ctrl+D 不退出（与排队判据同源，见 App.agentBusy）。 */
export function canExitOnCtrlD(state: AppState): boolean {
  return (
    state.agentStatus === "idle" &&
    !isCompacting(state) &&
    state.inputText === ""
  );
}

/** Ctrl+C 双击退出窗口(毫秒)：窗口内第二次 Ctrl+C 退出程序 */
const CTRL_C_DOUBLE_MS = 750;
/** 退出确认面板的合成问答面板 id（非宿主 ask；`submitQuestion`/`cancelQuestion` 按它分支，
 *  绝不调用 adapter 的 answerQuestion/cancelQuestion）。普通 id 不会与之冲突（宿主 id 为 uuid 类） */
const EXIT_CONFIRM_PANEL_ID = "exit-confirm";
/** /memory review 审阅面板的合成问答面板 id（TUI 自主面板、本地结算，不经宿主应答链） */
const MEMORY_REVIEW_PANEL_ID = "memory-review";
/** 退出确认面板「重启 dsh」项与启动器的约定退出码（BACKLOG #51）：
 *  TUI 置 `process.exitCode = 75` 后正常收尾退出，启动器看到 75 即重启下一轮
 *  （会话 id 经 `DSH_RESTART_FILE` 交接；语义见 `TUI/docs/DESIGN.md`「退出确认 ·「重启」方案」） */
export const DSH_RESTART_EXIT_CODE = 75;
/** 「重启 dsh（保留会话）」选项文案：`finishExitConfirm` 按它分支，测试与文案同源 */
export const EXIT_CONFIRM_RESTART_LABEL = "重启 dsh（保留会话）";
/** 退出时清理空会话的最长等待(ms)：防会话服务挂起把退出卡死。
 *  正常清理毫秒级即可完成，超时仅放弃清理并继续退出。 */
const EXIT_CLEAN_TIMEOUT_MS = 5000;
/** 运行中闪烁时间驱动的 tick 周期(ms)：running 期间周期性推进虚拟状态
 *  （无数据时虚拟速度衰减回落、虚拟总 token 持续积分，闪烁频率渐降到最低而不断） */
const VIRT_TICK_MS = 250;
/** 会话状态快照落盘合并窗口(ms)：/model、/collapse、模式事件等连续变更只写一次文件 */
const SESSION_STATE_SAVE_MS = 400;
/** 别名段读取失败告警阈值（连续失败次数）：别名段是增强项，session-channel 首连失败会
 *  后台重试，启动窗口内静默；连续失败到阈值才留痕一次 */
const ALIAS_WARN_AFTER_FAILS = 3;

/** 末条用户行的行号：App 本地用户交付带上它，流水线用户行经 seq 回查 buffer 同源行
 *  （用户块符号 / 终态 / 活跃判定的单一事实源在 buffer，见 userBlockSymbolResolver） */
function lastUserLineSeq(buffer: AppState["buffer"]): number | undefined {
  for (let i = buffer.length - 1; i >= 0; i--) {
    const line = buffer[i]!;
    if (line.kind === "user") return line.seq;
  }
  return undefined;
}

/**
 * 焦点面板单行滚动 action 映射：activity 偏移语义=距底部（上滚=+），
 * status 偏移语义=距顶部（上滚=-），方向不可混用。
 *
 * 对话区不在其中：它按「段键 + 段内行」定位，位移在 App 用本帧段表换算
 * （见 `App.scrollDialogueBy`）。
 */
export function focusedLineScroll(
  panel: "activity" | "status",
  dir: 1 | -1, // 1=上, -1=下
  max?: PaneScrollMax,
): StateAction {
  if (panel === "activity") {
    return {
      type: "activity-scroll",
      delta: dir,
      ...(max ? { max: max.activity } : {}),
    };
  }
  return { type: "status-column-scroll", delta: -dir };
}

/** 焦点面板整页滚动 action 映射（页 = 该面板当前可视行数；对话区同上） */
export function focusedPageScroll(
  panel: "activity" | "status",
  dir: 1 | -1, // 1=上一页, -1=下一页
  page: FrameGeometry,
  max?: PaneScrollMax,
): StateAction {
  if (panel === "activity") {
    return {
      type: "activity-scroll",
      delta: dir * page.activityH,
      ...(max ? { max: max.activity } : {}),
    };
  }
  return { type: "status-column-scroll", delta: -dir * page.contentTopH };
}

/** 两 pane 的可滚动上限（行单位；App 经 paneMaxes() 取得，见 FrameScrollReport） */
export interface PaneScrollMax {
  dialogue: number;
  activity: number;
}

export interface AppDeps {
  renderer: Renderer;
  adapter: DshAdapter;
  /** 可选：系统状态区数据源；提供后 App 自动启动合并节流 ticker */
  status?: {
    queries: StatusQueries;
    intervalMs?: number;
  };
  /** 初始主题（默认 dark=fffdark；/theme 切换仅当前会话） */
  initialTheme?: ThemeId;
  /** 跨回合最小帧间隔(ms)：>0 时限帧到该频率（窗口内跨宏任务的标脏合并到窗口末
   *  统一出帧）；缺省 0=不限帧（测试/演示保持立即出帧）。真实接线 main.ts 传 100=10Hz。 */
  frameIntervalMs?: number;
  /** 用户块左缘/回复右缘对称留空(列数，默认 4，经 initialState 落到 state) */
  messageGutter?: number;
  /** 交互区绝对行数（tui.config.json layout.footerHeight；缺省自动 1/5 上限 4） */
  footerHeight?: number;
  /** 活动区高分母（tui.config.json layout.activityHeightDivisor；1/2 → 2） */
  activityHeightDivisor?: number;
  /** 活动区分隔行锚定（tui.config.json layout.activityTopRow；"half" = floor(rows/2) 或绝对行号；
   *  配置后替代 activityHeightDivisor 的比例分配，缺省走 divisor） */
  activityTopRow?: "half" | number;
  /** 活动区排列方式（tui.config.json layout.activityPlacement；"auto" 按黄金分割比
   *  自动在上下/左右间选择，缺省恒上下排列。见 layout.ts topPaneSplit） */
  activityPlacement?: ActivityPlacement;
  /** 状态列宽分母（tui.config.json layout.statusColumnDivisor；1/3 → 3） */
  statusColumnDivisor?: number;
  /** /agents 面板定时刷新间隔(ms)；缺省 2000。宿主无 subagent 状态事件面，由
   *  打开期间定时 + 手动 `r` 双路保鲜（C2；评估结论见 TUI/docs/DESIGN.md「非显然实现要点」） */
  agentsRefreshIntervalMs?: number;
  /** 声音提醒（P2#33）：任务运行结束 / 等待用户输入超阈值 → 终端 BEL（\x07）。
   *  可选；不传=默认开启。配置源 tui.config.json `notify`（见 config.ts）。 */
  notify?: {
    /** bell 总开关；缺省 true */
    enabled?: boolean;
    /** 等待用户输入超时(ms)；缺省 8000。最小 1000（由 config 归一化兜底） */
    idleThresholdMs?: number;
  };
  /**
   * 六步流水线装配：App 在此注册「块交付」sink 并
   * 自己持有节缓存（`state.pipeline`）。缺省不注册 → adapter 零开销、旧路径不变。
   */
  pipelineSink?: { current?: (delivery: BlockDelivery) => void };
  /** 符号服务读取器（懒读，容忍插件装载顺序）：返回 undefined = symbol-normalizer 未挂载，
   *  此时展示层原文透传、无 notice（BACKLOG TUI#18 / 项目级 #48） */
  getSymbols?: () => SymbolNormalizerLike | undefined;
  /** 会话通道读取器（懒读）：返回 undefined = session-channel 未挂载，状态栏不显示别名段
   *  （BACKLOG TUI#48） */
  getSessionChannel?: () => SessionChannelLike | undefined;
  /** rule-engine 服务读取器（懒读）：返回 undefined（或未实现 onNotice）= 告警不经总线，
   *  由插件侧 stderr 兜底（BACKLOG「rule-engine 的用户提示应显示在活动区」） */
  getRuleEngine?: () => RuleEngineLike | undefined;
  /** 运行期告警出口（缺省静默；真实接线由 main.ts 写 stderr，格式 `warn: …`） */
  logger?: (message: string) => void;
  /** 启动自检 kickoff 正文（门控通过时由 main.ts 传入；App 代替用户发出以完成锚定解锁）。
   *  不传 / adapter 未实现 sendBootstrapKickoff = 不发送 */
  bootstrapKickoffText?: string;
  /** `/new` 的启动自检惰性门控（BACKLOG TUI#57；main.ts 接线）：每次新建会话**切换完成后**
   *  调用，返回正文则补发 kickoff，undefined = 不发。不能复用 `bootstrapKickoffText`——
   *  那是按启动会话判定的静态值（启动会话已解锁时为空） */
  bootstrapKickoffForNewSession?: () => string | undefined;
  /** 自动清理空会话（tui.config.json `session.autoCleanEmpty`；main.ts 接线缺省 true）。
   *  true 时 start() 异步扫描全部目录删除空会话（notice 汇报），且优雅退出时
   *  （/quit、Ctrl+D、双击 Ctrl+C、插件 unload）先打印提示并等待清理完成再关闭渲染器。 */
  autoCleanEmpty?: boolean;
  /** 重启交接文件路径（main.ts 从 `process.env.DSH_RESTART_FILE` 接线；BACKLOG #51）。
   *  非空 = 由会处理退出码 75 的启动器启动：退出确认面板才提供「重启 dsh（保留会话）」，
   *  选中后把当前活跃会话 id 写进该文件并置退出码 75（不自己 respawn）。 */
  restartHandoffPath?: string;
  /** `$` 模式本地执行器（BACKLOG TUI#37）：缺省走 node:child_process（local-shell.ts），
   *  测试可注入假实现避免真起进程 */
  runShell?: ShellRunner;
  /** `$` 模式执行前复查的 security-guard 服务读取器（懒读，容忍插件装载顺序；BACKLOG
   *  「TUI `$` 模式执行面不经 guard」）：main.ts 接 `ctx.get("guard")`；返回 undefined /
   *  无 inspectCommand / 读取或调用抛错 → fail-open 照常执行 + 每种失效模式告警一次。
   *  缺省（不传）= 未接线：不复查也不告警（测试与无 guard 的嵌入方保持原行为）。 */
  getGuard?: () => SecurityGuardLike | undefined;
  /** profile 目录（main.ts 从 `ctx.get('profileContext').dir` 接线）：实测宽度表
   *  落盘位置（`<profile 目录>/tui-width-table.json`）。缺省 / 空串 = 不落盘
   *  （仍按需实测，只是不跨会话复用）；见 layout/width-table.ts。 */
  profileDir?: string;
}

export class App {
  private state: AppState;
  /** `$` 模式本地执行器（BACKLOG TUI#37；缺省真实 spawn，测试经 deps.runShell 注入假实现） */
  private readonly shellRunner: ShellRunner;
  /** `$` 模式执行前复查器（BACKLOG「TUI `$` 模式执行面不经 guard」）：缺省 = 未接线（不复查、
   *  不告警）；main.ts 传 getGuard（惰性 `ctx.get("guard")`）时由复查器兜 fail-open 与告警去重 */
  private readonly shellGuard: ShellGuardChecker | undefined;
  private unbindEvents: (() => void)[] = [];
  private disposed = false;
  /** 启动自检 kickoff 正文（门控通过时由 main.ts 传入）：恢复会话先挂起，等启动历史折叠
   *  落定后再发（history-restore 会整表替换 buffer，早发会被替换掉）；null = 无待发内容 */
  private kickoffPending: string | null = null;
  /** 启动期外部日志（stderr 桥 / 插件告警总线的早到行）：恢复会话时先挂起，等启动历史
   *  折叠落定后补发——`history-restore` 会整表替换 buffer，早发会被替换掉（BACKLOG TUI#9）。
   *  null = 非挂起态（未恢复会话或已落定）。 */
  private bootLogPending: Array<{ text: string; tone?: NoticeTone }> | null =
    null;
  /** 退出确认面板已打开（合成问答面板 `EXIT_CONFIRM_PANEL_ID`）：确认「退出 dsh」才 dispose，
   *  取消/Esc 只关面板；防止单字节误触（BACKLOG「tmux 断连后 dsh 退出」）直接结束会话 */
  private exitConfirmOpen = false;
  /** 退出确认面板选的是「重启 dsh（保留会话）」（BACKLOG #51）：退出收尾跳过空会话清理
   *  ——重启场景不该改动其它会话，且要继续用同一个会话；见 DESIGN「退出确认 ·「重启」方案」 */
  private restartPending = false;
  /** /memory review 审阅面板（合成问答面板 `MEMORY_REVIEW_PANEL_ID`，照 exit-confirm 模式）：
   *  待审快照（item id → 候选行）、编辑草稿（宿主提问覆盖时按候选暂存、重开恢复）、
   *  结算 in-flight 守卫（禁重开 / 二次 submit，防并发结算同候选）。 */
  private memoryReviewRows = new Map<string, CandidateRowLike>();
  private memoryReviewDrafts = new Map<string, string>();
  private memoryReviewSettling = false;
  /** 已实时渲染的 rule-engine 注入消息 id（BACKLOG TUI#49；双通道去重，容量上限同 adapter 口径） */
  private renderedRuleInjections = new Set<string>();
  /** 待绘制脏标记：同一 tick 内多次标脏合并为一次 render（见 paint/flushPaint） */
  private paintDirty = false;
  /** 实测宽度表落盘目录（`profileDir`；"" = 不落盘，见 layout/width-table.ts） */
  private profileDir = "";
  /** 宽度实测在途：同一时刻只发一批，在途期间不再登记新批（避免探测字节叠发） */
  private widthProbeInFlight = false;
  /** 终端不支持 CPR（整批无回包）→ 关闭后续实测，一律沿用静态表 */
  private widthProbeUnavailable = false;
  /** 已排队待冲刷的合帧标志（与 paintDirty 成对；dispose 时清零使排队帧变 no-op） */
  private paintScheduled = false;
  /** 跨回合最小帧间隔(ms)：0=不限帧（缺省，测试/演示保持立即出帧）；
   *  真实接线 main.ts 传 100（10Hz）。>0 时窗口内跨宏任务的标脏合并到窗口末统一出帧 */
  private frameIntervalMs = 0;
  /** 上一帧渲染时刻（帧率上限用；paintNow/定时器出帧都会刷新） */
  private lastFrameAt = 0;
  /** 窗口末出帧定时器（帧率上限用） */
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private statusTicker: StatusTicker | null = null;
  /** 已渲染的会话别名（TUI#48：值变化才重绘；undefined = 不显示别名段） */
  private aliasCache: string | undefined;
  /** 别名读取失败是否已告警（每进程一次，避免刷屏） */
  private aliasWarned = false;
  /** 别名读取连续失败次数（成功即清零；阈值见 `ALIAS_WARN_AFTER_FAILS`） */
  private aliasFailStreak = 0;
  /** 运行中闪烁时间驱动定时器（running 期间周期性发 virt-tick：无数据时虚拟速度
   *  衰减回落、虚拟总 token 持续积分——闪烁频率渐降到最低而不断） */
  private virtTimer: ReturnType<typeof setInterval> | null = null;
  /** 面板定时刷新 timer（/agents、/workflows 共用；仅面板打开期间存活，tick 自检 kind） */
  private panelRefreshTimer: ReturnType<typeof setInterval> | null = null;
  /** 当前定时刷新面板 kind 对应的 refresh + 服务名（stop 前检查） */
  private panelRefreshCtx: {
    kind: CommandPanelKind;
    refresh: (() => Promise<void>) | undefined;
    label: string;
  } | null = null;
  /** 声音提醒（3.4.3）：需交互面板打开后的「无操作超阈值」计时器（超时转每秒催促） */
  private pendingBellTimer: ReturnType<typeof setTimeout> | null = null;
  /** 声音提醒（3.4.3）：需交互催促的每秒重复计时器（有操作 / 面板关闭 / dispose 停止） */
  private repeatBellTimer: ReturnType<typeof setInterval> | null = null;
  /** 声音提醒：bell 总开关（deps.notify?.enabled ?? true） */
  private bellEnabled = true;
  /** 声音提醒：需交互「无操作」阈值(ms)（deps.notify?.idleThresholdMs ?? 8000） */
  private idleBellMs = 8000;
  /** 符号服务（懒读；首次可用时解析并订阅审查事件） */
  private symbolService: SymbolNormalizerLike | null = null;
  /** 审查事件订阅注销函数（dispose 时调用） */
  private symbolUnsubscribe: (() => void) | null = null;
  /** rule-engine 服务（懒读；首次可用时订阅告警总线） */
  private ruleEngineService: RuleEngineLike | null = null;
  /** 告警总线订阅注销函数（dispose 时调用） */
  private ruleEngineUnsubscribe: (() => void) | null = null;
  /** 启动自动清理空会话开关（deps.autoCleanEmpty === true；未接线时关闭） */
  private autoCleanEmpty = false;
  /** 上次 Ctrl+C 时间戳；双击窗口内再次按下则退出（含输入为空时计数） */
  private lastCtrlCAt = 0;
  /** 当前 turn 是否已画分隔线(回合开始画；turn-end 清) */
  private turnOpen = false;
  /** 两 pane 可滚动上限（renderFrame 出帧时回填；滚键据此收敛偏移，防越界假死） */
  private paneScrollMax: FrameScrollReport = {
    dialogueMaxScroll: 0,
    activityMaxScroll: 0,
    dialogueTotal: 0,
    dialogueCounts: [],
    dialogueKeys: [],
    dialogueTopIdx: 0,
    dialogueViewportH: 0,
    dialogueUserRows: [],
  };
  /** 会话状态快照待落盘定时器（见 scheduleSessionStateSave） */
  private sessionStateTimer: ReturnType<typeof setTimeout> | null = null;
  /** 待落盘的会话 id（切换会话/退出前 flush；null = 无待写） */
  private sessionStatePendingSid: string | null = null;
  /** paneScrollMax 对应的 state 引用（同一 state 不重复补算） */
  private paneScrollMaxState: AppState | null = null;
  /** 上一帧 buffer 的回合组数（用户停在历史里时按新增组数撑住窗口起点） */
  private groupCount: number | null = null;
  /** 六步流水线节缓存（开关开启时持有；会话切换即重建） */
  private sections: SectionsState | null = null;
  /** 节缓存归属的会话 id（切换会话时重建，避免跨会话串节） */
  private sectionsSessionId: string | null = null;
  /** 流水线视角的当前回合号（turn-begin 交付用；宿主回合号经块交付已带到） */
  private pipelineLastTurn: number | null = null;

  /**
   * 六步流水线：把**已构造的历史行**重放成节缓存（恢复 / 会话切换路径）。
   *
   * 条目 7 选项 1：行由调用方本地构造（`surfaceToBuffer`）并直传，不再回读
   * `state.buffer` —— 生产路径不把缓冲内容当恢复入口（缓冲仅测试 / 嵌入用）。
   */
  private replaySectionsFromRows(rows: readonly BufferLine[]): void {
    if (this.deps.pipelineSink === undefined) return;
    this.sections = sectionsFromBuffer(rows);
    // 回合号基线：重放后取最大节回合（下一回合本地预测 +1 的基准）
    const scanned =
      this.sections.current === undefined
        ? this.sections.sections
        : [...this.sections.sections, this.sections.current];
    let lastTurn = 0;
    for (const section of scanned) {
      if (section.turn > lastTurn) lastTurn = section.turn;
    }
    this.pipelineLastTurn = lastTurn > 0 ? lastTurn : null;
    this.sectionsSessionId = this.state.activeSessionId;
    const pipeline = this.sections;
    this.apply((s) => reduceState(s, { type: "pipeline-state", pipeline }));
  }

  /**
   * 六步流水线接收：块交付 → 节缓存 → 注入 state（会话切换即重建节缓存）。
   * 接收跟事件（去重不能延迟），处理与排版仍跟帧。
   */
  private ingestDelivery(delivery: BlockDelivery): void {
    const sid = this.state.activeSessionId;
    if (
      this.sections === null ||
      (this.sectionsSessionId !== null && this.sectionsSessionId !== sid)
    ) {
      // 首次建立 or 会话切换（真实 sid 变化）→ 重建节缓存并归零回合号基线
      this.sections = createSections();
      this.sectionsSessionId = sid;
      this.pipelineLastTurn = null;
    } else if (this.sectionsSessionId === null && sid !== null) {
      // 会话建立过渡（null → sid，启动早期事件带上了会话号）：保留既有缓存
      // （启动期内容同属该会话），只登记归属，不重建
      this.sectionsSessionId = sid;
    }
    this.sections = applyDelivery(this.sections, delivery);
    // 回合号基线只跟回合边界（beginTurn 预测 +1 的基准）；用户/通知等自带 turn 的
    // 交付不推进基线（启动注入按回合 1 归组后，首回合预测不得被推到 2）
    if (delivery.kind === "turn-start") this.pipelineLastTurn = delivery.turn;
    const pipeline = this.sections;
    this.apply((s) => reduceState(s, { type: "pipeline-state", pipeline }));
  }

  /** App 本地写入的双写交付（用户回显 / 注入 / 通知 / 本地 shell）：流水线关闭时空转 */
  private deliverLocal(delivery: BlockDelivery): void {
    if (this.sections === null) return;
    this.ingestDelivery(delivery);
  }

  /**
   * 事件驱动的本地写入补块交付（条目 7 批 A）：`reduceState` 写下的可见行（retry /
   * subagent / hook / feedback / 压缩提示 …）过去只进缓冲、不投块 → 流水线（唯一渲染
   * 来源）看不到（用户真机「回合区不显示警告」）。
   *
   * 复用重放的「行 → 交付」映射（`deliveryOfLine`），口径与恢复路径完全一致；scope 取
   * 接收层最近一次 (turn, step)。**step 头与分隔线**在这里按重放同款规则转成
   * `step-start` / `turn-start`（但 `step` / `compaction-prune` 事件由 adapter 侧直接
   * 投递，调用方跳过本方法以免重复）。
   */
  private deliverBufferTail(before: number): void {
    if (this.sections === null) return;
    const scope = this.sections.lastScope;
    let index = 0;
    for (const line of this.state.buffer.slice(before)) {
      const step =
        line.kind === "step" || line.kind === "tool"
          ? stepOf(line.text)
          : undefined;
      if (step !== undefined) {
        this.deliverLocal({
          kind: "step-start",
          turn: scope.turn,
          step,
          ...(line.time === undefined ? {} : { time: line.time }),
        });
        continue;
      }
      if (line.kind === "separator") {
        this.deliverLocal({
          kind: "turn-start",
          turn:
            typeof line.turn === "number" && line.turn > 0
              ? line.turn
              : scope.turn,
          ...(line.time === undefined ? {} : { time: line.time }),
        });
        continue;
      }
      const delivery = deliveryOfLine(line, scope, index);
      index += 1;
      if (delivery !== undefined) this.deliverLocal(delivery);
    }
  }

  /** 当前 state 的可滚动上限：出帧回填过就直接用，否则就地补算一次（同一帧口径） */
  private paneMaxes(): FrameScrollReport {
    if (this.paneScrollMaxState !== this.state) {
      buildFrame(this.state, this.deps.renderer.getSize(), this.paneScrollMax);
      this.paneScrollMaxState = this.state;
    }
    return this.paneScrollMax;
  }

  /**
   * 出帧后同步派生缓存（视口顶位置 + 距底偏移 + 渐进窗口）：帧已按段键解析后的位置渲染，
   * 故直接写 state（不经 apply，不触发重绘），与 paneScrollMax 的缓存语义一致。
   *
   * 两件事：① 段落收敛（位置键已消失 → 布局按距底偏移回落，这里把结果写回，保持
   * 「state 里记的就是画面上那一行」）；② 用户停在历史里时，尾部新增回合组会把窗口
   * 起点向前挤（窗口按「尾部 N 组」计）→ 按新增组数把窗口撑住，视口顶所在段不被挤出。
   */
  private syncDialoguePos(): void {
    const r = this.paneScrollMax;
    const st = this.state;
    const groups = sectionGroupCount(sectionsOf(st));
    const grew = groups - (this.groupCount ?? groups);
    this.groupCount = groups;
    const keepWindow =
      st.dialogueTop !== null && grew > 0
        ? Math.min(groups, st.windowGroups + grew)
        : st.windowGroups;
    if (st.dialogueTop === null) {
      // 贴底：位置就是「跟随最新」，只需收敛窗口
      if (st.windowGroups !== keepWindow)
        this.state = { ...st, windowGroups: keepWindow };
      return;
    }
    const offset = Math.max(0, r.dialogueMaxScroll - r.dialogueTopIdx);
    const resolved = positionAt(
      createLineTable(r.dialogueCounts),
      r.dialogueKeys,
      r.dialogueTopIdx,
    );
    if (
      st.scrollOffset === offset &&
      st.windowGroups === keepWindow &&
      st.dialogueTop.key === resolved.key &&
      st.dialogueTop.row === resolved.row
    )
      return;
    this.state = {
      ...st,
      dialogueTop: resolved,
      scrollOffset: offset,
      windowGroups: keepWindow,
    };
  }

  /**
   * 对话区按键滚动（`delta` 行：正 = 上滚看更早内容）。
   *
   * 顺序：**先扩窗、再按扩窗后的段表施加位移** —— 位置按段键表达，扩窗只在视口上方插段，
   * 画面不动；位移量因此始终等于 `delta`（撞窗口顶那次也只是多物化，不多滚）。
   */
  private scrollDialogueBy(delta: number): void {
    if (delta === 0) return;
    let r = this.paneMaxes();
    for (let guard = 0; delta > 0 && guard < 4; guard++) {
      if (this.state.windowGroups >= sectionGroupCount(sectionsOf(this.state)))
        break; // 更早回合已全部物化，没有可扩的窗口
      const margin = Math.max(1, Math.floor(r.dialogueViewportH / 2));
      const needMore = r.dialogueTopIdx - delta < 0;
      const nearTop = r.dialogueTopIdx <= margin;
      if (!needMore && !nearTop) break;
      const before = r.dialogueTotal;
      this.apply((s) =>
        reduceState(s, {
          type: "window-grow",
          groups: s.windowGroups + WINDOW_GROW_STEP,
        }),
      );
      r = this.paneMaxes();
      if (r.dialogueTotal <= before) break; // 没有更多内容可纳入
    }
    const target = Math.min(
      Math.max(0, r.dialogueTopIdx - delta),
      r.dialogueMaxScroll,
    );
    // 滚回底部 → 恢复跟随最新（窗口复位默认组数，释放增量物化）
    if (delta < 0 && target >= r.dialogueMaxScroll) {
      this.apply((s) => reduceState(s, { type: "scroll-to-bottom" }));
      return;
    }
    this.apply((s) =>
      reduceState(s, {
        type: "dialogue-scroll",
        top: positionAt(
          createLineTable(r.dialogueCounts),
          r.dialogueKeys,
          target,
        ),
        offset: Math.max(0, r.dialogueMaxScroll - target),
      }),
    );
  }

  /** 按面板取可滚动上限（status 列不按行滚动，返回 undefined = 不设上限） */
  private paneScrollMaxOf(
    panel: AppState["focusedPanel"],
  ): PaneScrollMax | undefined {
    if (panel === "status") return undefined;
    const m = this.paneMaxes();
    return { dialogue: m.dialogueMaxScroll, activity: m.activityMaxScroll };
  }

  constructor(private deps: AppDeps) {
    this.shellRunner = deps.runShell ?? runShellCommand;
    // `$` 模式执行前 security-guard 复查（BACKLOG「TUI `$` 模式执行面不经 guard」）：
    // 未接线 getGuard → undefined（不复查、不告警）；告警出口走 deps.logger（真实接线 = stderr 桥），
    // 带 `warn: ` 前缀才会被判成 warn 色（见 stderr-bridge.ts externalLogTone / 既有别名告警同款）
    this.shellGuard =
      deps.getGuard === undefined
        ? undefined
        : makeShellGuardChecker(deps.getGuard, (msg) =>
            deps.logger?.("warn: " + msg),
          );
    // 声音提醒配置（P2#33）：不传 notify = 默认开启 + 8s 阈值
    this.bellEnabled = deps.notify?.enabled ?? true;
    // 阈值合法性：>0 有限数即可（1000ms 下限是 tui.config.json 用户配置层的职责，
    // 见 config.normalizeConfig；AppDeps 直接注入面（测试等）允许更小值便于可控验证）
    const th = deps.notify?.idleThresholdMs;
    if (typeof th === "number" && Number.isFinite(th) && th > 0) {
      this.idleBellMs = Math.max(1, Math.floor(th));
    }
    // 跨回合帧率上限：0=不限帧（缺省）；>0 时限帧到对应频率（见 flushPaint）
    const fi = deps.frameIntervalMs;
    if (typeof fi === "number" && Number.isFinite(fi) && fi > 0) {
      this.frameIntervalMs = Math.floor(fi);
    }
    // 启动自动清理空会话（tui.config.json session.autoCleanEmpty；main.ts 接线缺省 true，
    // 未接线时为关闭）
    this.autoCleanEmpty = deps.autoCleanEmpty === true;
    // 实测宽度表落盘目录（缺省 "" = 不落盘；见 layout/width-table.ts）
    this.profileDir = deps.profileDir ?? "";
    this.state = initialState(
      normalizeThemeId(this.deps.initialTheme ?? DEFAULT_THEME),
      {
        messageGutter: this.deps.messageGutter,
        footerHeight: this.deps.footerHeight,
        activityDivisor: this.deps.activityHeightDivisor,
        activityTopRow: this.deps.activityTopRow,
        activityPlacement: this.deps.activityPlacement,
        statusDivisor: this.deps.statusColumnDivisor,
        // 标题栏状态符号组的只读配置项（声音提醒）
        notifyEnabled: this.bellEnabled,
      },
    );
  }

  /** 预留日志注入点（当前无内部消费方，保持 API 兼容为 no-op） */
  setLogger(_fn: (msg: string) => void): void {}

  /**
   * 载入实测宽度表（`<profile 目录>/tui-width-table.json`，见 layout/width-table.ts）：
   * 上次会话实测过的字符直接按实测值排版，本会话不再探测。表缺失 / 换终端（term 标识
   * 不匹配）→ 空表，回落静态表。
   *
   * `TUI_WIDTH_PROBE=0`：整体关闭按需实测（不载表、不登记、不探测），用于对照排查
   * 「静态表基线」。
   */
  private loadWidthTable(): void {
    if (process.env.TUI_WIDTH_PROBE === "0") {
      setWidthProbeEnabled(false);
      return;
    }
    if (this.profileDir === "") return;
    const entries = readWidthTable(this.profileDir, terminalKey());
    if (entries.size > 0) setWidthOverrides(entries);
  }

  /** 实测宽度表落盘（profile 目录；写失败静默——排版已按实测值生效，落盘只是复用手段） */
  private saveWidthTable(): void {
    if (this.profileDir === "") return;
    writeWidthTable(this.profileDir, terminalKey(), widthOverrideEntries());
  }

  /**
   * 帧前按需实测（用户 2026-10-01 裁定「帧绘制前计算宽度时」）：本帧排版期间登记的
   * 「呈现不确定」字符（markdown.ts `takePendingWidthProbes`）在**写屏前**发一次终端
   * 实测（`CSI 6n` 列差，见 renderer.probeSymbolWidths）。实测值写入覆盖表并重新排版，
   * 随后以**整帧重绘**出帧——探测字符画在屏幕原点，由这一帧覆盖；且这一帧即按实测宽度排版。
   *
   * 整批无回包 → 判定终端不支持 CPR，关闭后续实测（否则每个新字符都要白等一次超时）。
   * 探测期间不出帧（上限 `WIDTH_PROBE_TIMEOUT_MS`），故只在出现新字符的帧上发生。
   */
  private probeThenRender(batch: readonly string[]): void {
    const probe = this.deps.renderer.probeSymbolWidths;
    if (typeof probe !== "function") return;
    this.widthProbeInFlight = true;
    void probe
      .call(this.deps.renderer, batch, WIDTH_PROBE_TIMEOUT_MS)
      .then((widths) => {
        this.widthProbeInFlight = false;
        if (this.disposed) return;
        if (widths.size === 0) {
          this.widthProbeUnavailable = true; // 无 CPR 支持：沿用静态表，不再实测
        } else if (setWidthOverrides(widths)) {
          this.saveWidthTable(); // 新实测值落盘（跨会话复用）
        }
        this.refresh(); // 重排 + 整帧重绘：按实测宽度出这一帧并覆盖探测残留
        this.maybeProbePendingWidths(); // 重排可能登记了新字符（已测过的不再登记）
      })
      .catch(() => {
        this.widthProbeInFlight = false;
        if (!this.disposed) this.refresh();
      });
  }

  /** 取走待实测字符并探测（无待测 / 在途 / 终端不支持 → 不动） */
  private maybeProbePendingWidths(): void {
    if (this.widthProbeInFlight || this.widthProbeUnavailable) return;
    if (typeof this.deps.renderer.probeSymbolWidths !== "function") return;
    const batch = takePendingWidthProbes();
    if (batch.length === 0) return;
    this.probeThenRender(batch);
  }

  start(): void {
    // 恢复会话：启动历史折叠会整表替换 buffer → 早到的外部日志先挂起（落定后补发，见
    // flushKickoffPending）。必须在总线接线（会触发插件侧重放）之前置位。
    if (this.deps.adapter.resumedAtLaunch === true) this.bootLogPending = [];
    // 六步流水线：仅在「开关开启 + 调用方给了 sink」时接管（缺 sink = 未装配 → 旧路径，
    // 测试与嵌入用法不受默认切换影响）
    const sink = this.deps.pipelineSink;
    if (sink !== undefined) {
      this.sections = createSections();
      this.sectionsSessionId = this.state.activeSessionId;
      sink.current = (delivery) => this.ingestDelivery(delivery);
      const pipeline = this.sections;
      this.apply((s) => reduceState(s, { type: "pipeline-state", pipeline }));
    }
    // 告警总线懒接线（未挂载则 no-op；见 ruleEngine()）
    this.ruleEngine();
    this.deps.renderer.onKey((k) => this.handleKey(k));
    this.deps.renderer.onResize(() => this.paint());
    this.unbindEvents.push(
      this.deps.adapter.onEvent((e) => this.handleEvent(e)),
    );
    // 系统状态区：合并节流 ticker（tick 一次批量查 cwd/git/time）
    if (this.deps.status) {
      this.statusTicker = new StatusTicker({
        queries: this.deps.status.queries,
        intervalMs: this.deps.status.intervalMs ?? 5000,
        apply: (status) => {
          this.apply((s) => reduceState(s, { type: "status", status }));
          this.paint();
          // 随 ticker 周期刷新生效模型(会话切换 ?? 宿主默认)：宿主 provider 注册
          // 可能晚于启动，早读会拿到内置兜底(如 deepseek-official)，故常驻跟随，
          // 值变化才重绘。与 /model 显示同一来源。
          this.refreshModelStatus();
          // TUI#39：Agents 块同节律保鲜（状态列隐藏时自动停；不依赖事件面，空数据也轮询）
          this.maybeRefreshAgents();
          // TUI#48：会话别名同节律保鲜（无插件 / 无别名时不动状态）
          void this.maybeRefreshSessionAlias();
        },
      });
      this.statusTicker.start();
      this.unbindEvents.push(() => this.statusTicker?.stop());
    }
    // 运行中闪烁时间驱动（250ms tick）：仅 inputStatus=running 时推进（见 virtTick
    // 方法）。unref：不阻止测试进程退出（node --test 下 interval 会让事件循环挂住）。
    this.virtTimer = setInterval(() => this.virtTick(), VIRT_TICK_MS);
    this.virtTimer.unref?.();
    this.unbindEvents.push(() => {
      if (this.virtTimer) clearInterval(this.virtTimer);
      this.virtTimer = null;
    });
    // 首帧前载入实测宽度表（profile 目录；缺表 / 换终端 → 空表，回落静态表）。
    // 本次会话新出现的「呈现不确定」字符在帧绘制前按需实测（见 probeThenRender）
    this.loadWidthTable();
    // 首帧前同步 renderer 主题（基底色/词槽位随 /theme 切换）
    this.deps.renderer.setTheme(this.state.themeId);
    this.paintNow();
    // 拉取权限/agent 预设目录写入 state（原状态列 Mode 块的可选项，P7 移除该块后
    // 暂无渲染消费方；缺默服务则保持降级）
    this.refreshCatalogs();
    // 拉取宿主命令注册表目录（输入补全候选；服务缺失时仅本地目录）
    this.refreshCommandCatalog();
    // 补会话状态初始值（标题栏状态符号组用；log-only 事件启动不产生，从会话日志折叠一次）
    this.restoreSessionState();
    // 启动自检 kickoff（BACKLOG TUI「启动后自动触发首轮工具调用」）：先挂起，再由下面的
    // 历史折叠决定发送时机（新会话走启动宏任务；恢复会话等折叠落定，见 flushKickoffPending）
    this.startBootstrapKickoff();
    // TUI#40：CLI 启动即恢复（--resume / -c）→ 补一次历史折叠，历史区直接可见既有消息
    this.restoreStartupHistory();
    // 启动自动清理空会话（session.autoCleanEmpty=true 时后台执行，不阻塞 UI）
    if (this.autoCleanEmpty) {
      void this.runStartupCleanEmptySessions();
    }
  }

  /**
   * 列出全部会话并返回可清理的空会话 id（判据 startupCleanableIds：已持久化 + 非 live +
   * 非当前 + 无用户消息）。列表服务缺失或读取失败 → 空数组（不抛，不阻碍调用方）。
   */
  private async cleanableSessionIdsViaAdapter(): Promise<string[]> {
    const list = this.deps.adapter.listSessions;
    if (!list) return [];
    try {
      return startupCleanableIds(await list.call(this.deps.adapter));
    } catch {
      return []; // 列表不可用 → 不清理
    }
  }

  /**
   * 逐个文件级删除给定会话（串行，避免并发 IO 与错误归属混乱），返回成功/失败计数。
   * 删除服务缺失时不删任何项（返回 0/0）。
   */
  private async deleteSessionIds(
    ids: string[],
  ): Promise<{ removed: number; failed: number }> {
    const del = this.deps.adapter.deleteSession;
    if (!del) return { removed: 0, failed: 0 };
    let removed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const res = await del.call(this.deps.adapter, id);
        if (res.ok) removed += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return { removed, failed };
  }

  /**
   * 启动时自动清理空会话（session.autoCleanEmpty=true）：与退出清理共享判据与删除核心，
   * 结果经 notice 汇报（UI 尚在，走对话区提示）。依赖宿主 sessionQuery
   * （listSessions/deleteSession）已挂载；缺失或执行失败静默跳过（清理属于维护性功能，
   * 不让启动失败）。当前活跃/live 会话由判据天然排除。
   */
  private async runStartupCleanEmptySessions(): Promise<void> {
    const ids = await this.cleanableSessionIdsViaAdapter();
    if (ids.length === 0) return;
    const { removed, failed } = await this.deleteSessionIds(ids);
    if (removed === 0) {
      // 全部失败才提示（避免静默）；部分成功走下方成功文案
      if (failed > 0) {
        this.notice(`自动清理空会话失败：${failed} 个删除未生效`, "warn");
      }
      return;
    }
    this.notice(
      failed > 0
        ? `已自动清理 ${removed} 个空会话（${failed} 个失败）`
        : `已自动清理 ${removed} 个空会话`,
      failed > 0 ? "warn" : "success",
    );
  }

  /**
   * 退出时清理其他空会话（复用 session.autoCleanEmpty 开关；优雅退出路径在关渲染器前调用）。
   * 有可清理项才把提示渲染到**活动区**并等待清理完成，完成后才继续后续收尾（释放 adapter/
   * 关闭渲染器退出）；无清理项/无可清理服务时静默直接返回，不拖慢退出。
   */
  private async runExitCleanEmptySessions(): Promise<void> {
    const ids = await this.cleanableSessionIdsViaAdapter();
    if (ids.length === 0) return;
    const t0 = Date.now();
    this.paintExitNotice(`正在清理 ${ids.length} 个空会话...`, "info");
    const { removed, failed } = await this.deleteSessionIds(ids);
    const elapsed = Date.now() - t0;
    if (removed === 0) {
      this.paintExitNotice(`清理空会话失败：${failed} 个删除未生效`, "error");
      return;
    }
    this.paintExitNotice(
      `已自动清理 ${removed} 个空会话` +
        (failed > 0 ? `（${failed} 个失败）` : "") +
        `（${elapsed}ms）`,
      failed > 0 ? "warn" : "success",
    );
  }

  /**
   * 退出清理提示：绕过 disposed 守卫与 10Hz 合帧，把消息直接渲染到活动区。
   * dispose() 已置 disposed=true（常规 notice/paint 均被守卫拦截），且主接线
   * frameIntervalMs>0 时标脏可能被窗口定时器推迟到关终端之后——此处同步 apply + render，
   * 保证提示在 close() 前真实落屏。
   */
  private paintExitNotice(text: string, tone?: NoticeTone): void {
    this.state = reduceState(this.state, {
      type: "notice",
      text,
      ...(tone ? { tone } : {}),
    });
    const size = this.deps.renderer.getSize();
    const out: FrameBuildOutput = {};
    const frame = buildFrame(this.state, size, this.paneScrollMax, out);
    this.paneScrollMaxState = this.state;
    this.syncDialoguePos();
    this.deps.renderer.render(frame, out.sections, out.focus);
  }

  /**
   * 拉取权限/agent 预设目录写入 state（原状态列 Mode 块的可选项，P7 移除该块后
   * 暂无渲染消费方；目录变化低频，start + /permission 命令时刷新已足够）。目录服务
   * 缺失或读失败静默降级（state 保持 []），不崩溃。
   */
  private refreshCatalogs(): void {
    const a = this.deps.adapter;
    if (a.permissionCatalog) {
      void a
        .permissionCatalog()
        .then((info) => {
          if (this.disposed || !info) return;
          this.apply((s) =>
            reduceState(s, { type: "permission-catalog", names: info.names }),
          );
          this.paint();
        })
        .catch(() => {});
    }
    if (a.agentPresetCatalog) {
      void a
        .agentPresetCatalog()
        .then((info) => {
          if (this.disposed || !info) return;
          this.apply((s) =>
            reduceState(s, {
              type: "agent-preset-catalog",
              ids: info.presets.map((pp) => pp.id),
            }),
          );
          this.paint();
        })
        .catch(() => {});
    }
  }

  /** 拉取宿主命令注册表目录（ctx.commands.list）写入 state：补全候选并入本地目录。
   *  服务缺失/未暴露 list → 静默跳过（仅本地命令可补全）。 */
  private refreshCommandCatalog(): void {
    const list = this.deps.adapter.commandList?.();
    if (!list || list.length === 0) return;
    this.apply((s) =>
      reduceState(s, { type: "command-catalog", commands: list }),
    );
  }

  /**
   * 回填当前会话状态（启动、切换会话成功后调用）：模型选择、plan/sandbox/permission/
   * policy、goal/todo、TUI 本地开关（verbose/symbol-unify）。宿主日志里的 log-only
   * 事件启动不产生、切会话也不重放，故主动折叠一次；TUI 本地开关只在会话状态快照里。
   * 回填后刷新状态栏模型徽标（会话内模型引用已被 adapter 写回）。
   */
  private restoreSessionState(): void {
    const a = this.deps.adapter;
    // 启动初期 state.activeSessionId 尚为 null（真实 adapter 不发 session-list、
    // 全新会话 title 要等首条消息）→ 按 adapter 视角的活跃会话 id 兜底
    const sid = this.state.activeSessionId ?? a.sessionId;
    if (!a.restoreSessionState || !sid) return;
    void a
      .restoreSessionState(sid)
      .then(() => {
        if (this.disposed) return;
        this.refreshModelStatus();
        this.paint();
      })
      .catch(() => {});
  }

  /**
   * TUI#40：CLI **启动即恢复**（`--resume <id>` / `-c`）时把既有消息折叠进 buffer。
   *
   * 背景：启动路径只走 `main.ts` 的 `agents.resume` + `restoreSessionState()`（model/mode/
   * goal/todo 回填），历史行折叠原先只在 `/session` 面板切换路径发生 → 启动后历史区为空、
   * 需手动再切一次会话才可见内容（agent 侧上下文其实已恢复）。
   *
   * 口径：复用 `/session` 路径同一段折叠（`surfaceToBuffer` → `history-restore`），
   * 不新建第二条渲染路径；`readSessionSurface` 缺失 / 读取失败 / 空会话 → 保持空历史并提示
   * （不阻塞启动）；迟到结果在 disposed 或会话已切走时丢弃。
   */
  private restoreStartupHistory(): void {
    const a = this.deps.adapter;
    if (a.resumedAtLaunch !== true) {
      this.flushKickoffPending();
      return;
    }
    const read = a.readSessionSurface;
    const sid = this.state.activeSessionId ?? a.sessionId;
    if (!read || !sid) {
      this.flushKickoffPending();
      return;
    }
    void read
      .call(a, sid)
      .then((view) => {
        if (this.disposed) return;
        // 陈旧守卫：会话已切走（非同一 id）→ 丢弃
        if (
          this.state.activeSessionId !== null &&
          this.state.activeSessionId !== sid
        ) {
          return;
        }
        if (view.messages.length === 0) return; // 空会话：保持空历史
        const firstUser = view.messages.find((m) => m.role === "user");
        const title =
          this.state.sessionTitle !== ""
            ? this.state.sessionTitle
            : deriveTitle(firstUser?.text);
        const rows = surfaceToBuffer(view.messages);
        this.apply((s) =>
          reduceState(s, {
            type: "history-restore",
            id: sid,
            title,
            rows,
          }),
        );
        this.apply((s) => reduceState(s, { type: "queued-clear" }));
        // 六步流水线：恢复的历史行重放成节缓存（此后新事件继续按节增量接收）
        this.replaySectionsFromRows(rows);
        this.paint();
      })
      .catch(() => this.notice("启动恢复：既有消息读取失败", "warn"))
      // 无论折叠成功与否都补发挂起的 kickoff（读取失败不该吞掉启动自检）
      .finally(() => this.flushKickoffPending());
  }

  /** 当前 TUI 视角的会话状态快照（宿主不掌握 verbose/symbol-unify；模型/模式作兜底） */
  private sessionUiState(): SessionUiState {
    const sid = this.state.activeSessionId ?? this.deps.adapter.sessionId ?? "";
    const model = this.state.modelBySession[sid];
    const mode = this.state.modeBySession[sid] ?? {};
    const policy = this.state.policyBySession[sid];
    return {
      version: SESSION_UI_STATE_VERSION,
      ...(model?.provider && model.model
        ? {
            model: {
              provider: model.provider,
              model: model.model,
              ...(typeof model.reasoningEffort === "string"
                ? { reasoningEffort: model.reasoningEffort }
                : {}),
            },
          }
        : {}),
      collapse: this.state.activityCompact,
      verbose: this.state.activityVerbose,
      symbolUnify: this.state.symbolUnify,
      // P7：垂直状态列显隐（TUI 本地开关，随会话持久化）
      statusColumn: this.state.statusColumnVisible,
      // #9：下半区（Turn/Tool）显隐（TUI 本地开关，随会话持久化）
      lowerPanes: this.state.lowerPanesVisible,
      modes: {
        ...(mode.plan === undefined ? {} : { plan: mode.plan }),
        ...(mode.sandbox === undefined ? {} : { sandbox: mode.sandbox }),
        ...(mode.permission === undefined
          ? {}
          : { permission: mode.permission }),
        ...(policy === undefined ? {} : { policy }),
      },
    };
  }

  /**
   * 标记会话状态待落盘（400ms 合并多次变更；写的是标记时的活跃会话）。
   * 快照随会话目录走（`<会话目录>/tui-state.json`）：切走/退出前由
   * `flushSessionStateSave()` 立即落盘，会话目录不存在（仅内存会话）时静默跳过。
   */
  private scheduleSessionStateSave(): void {
    const a = this.deps.adapter;
    if (!a.saveSessionUiState) return;
    const sid = this.state.activeSessionId ?? a.sessionId;
    if (!sid) return;
    this.sessionStatePendingSid = sid;
    if (this.sessionStateTimer) clearTimeout(this.sessionStateTimer);
    this.sessionStateTimer = setTimeout(() => {
      this.sessionStateTimer = null;
      this.flushSessionStateSave();
    }, SESSION_STATE_SAVE_MS);
    this.sessionStateTimer.unref?.();
  }

  /** 立即落盘待写的会话状态快照（切换会话前、退出时调用；无待写则 no-op） */
  private flushSessionStateSave(): void {
    if (this.sessionStateTimer) {
      clearTimeout(this.sessionStateTimer);
      this.sessionStateTimer = null;
    }
    const sid = this.sessionStatePendingSid;
    this.sessionStatePendingSid = null;
    const save = this.deps.adapter.saveSessionUiState;
    if (!sid || !save) return;
    try {
      save.call(this.deps.adapter, sid, this.sessionUiState());
    } catch {
      /* 快照落盘失败不影响渲染与退出 */
    }
  }

  /** 生效模型缓存 key；值变化才重绘（避免每 5s 空重绘） */
  private modelStatusKey: string | undefined;

  /** 运行中闪烁时间驱动：仅 inputStatus=running 时推进虚拟状态（virt-tick）——
   *  没有新数据也按衰减中的虚拟速度持续积分（闪烁频率渐降到最低而不断）；
   *  等待交互（△）/空闲（✓/?）不推进。P5：相位未变时不重绘（tick 只改虚拟
   *  状态，画面无变化；相位变化才出一帧） */
  private virtTick(): void {
    if (this.disposed || this.state.inputStatus !== "running") return;
    const before = runPhase(this.state.runVirt.tokens);
    this.apply((s) => reduceState(s, { type: "virt-tick", time: Date.now() }));
    if (runPhase(this.state.runVirt.tokens) !== before) this.paint();
  }

  /** 读取生效模型(会话切换 ?? 宿主默认)写入状态栏 model+思考徽标；无变化时跳过 */
  private async refreshModelStatus(): Promise<void> {
    const catalog = await this.deps.adapter.modelCatalog();
    if (this.disposed) return;
    const cur = catalog.current;
    if (!cur?.provider || !cur.model) return;
    const key = modelLabel(cur);
    if (key === this.modelStatusKey) return;
    this.modelStatusKey = key;
    const thinking = await this.resolveThinking(
      cur.provider,
      cur.model,
      cur.reasoningEffort,
    );
    if (this.disposed || key !== this.modelStatusKey) return;
    this.apply((s) =>
      reduceState(s, {
        type: "status",
        status: { model: key, modelThinking: thinking },
      }),
    );
    this.paint();
  }

  /** 解析思考后缀（写状态栏 model 段）：none=不支持、off=未开启、on=单等级开启、
   *  多等级开启时返回实际等级名（如 high/low/max）。
   *  未显式选择等级时返回 provider 默认等级（defaultEffort），保证状态栏显示的
   *  与实际请求生效的 effort 一致（后台按 provider 级 reasoning 配置兜底，如 max）。 */
  private async resolveThinking(
    provider: string,
    model: string,
    effort?: string,
  ): Promise<string> {
    let info: ModelReasoning | undefined;
    try {
      info = await this.deps.adapter.modelReasoning?.(provider, model);
    } catch {
      return "none";
    }
    const efforts = info?.efforts;
    if (!efforts || efforts.length === 0) return "none";
    if (!effort) return info?.defaultEffort ?? "off";
    if (efforts.length > 1) {
      const picked = efforts.find((e) => e.id === effort);
      return picked ? picked.name : effort;
    }
    return "on";
  }

  dispose(): void {
    if (this.disposed) return;
    // 退出前落盘会话状态快照（未过合并窗口的变更不丢）
    this.flushSessionStateSave();
    this.disposed = true;
    // 待处理合帧作废：已排队的 microtask 见 disposed 直接返回，不再写终端
    this.paintDirty = false;
    this.paintScheduled = false;
    for (const f of this.unbindEvents) f();
    this.unbindEvents = [];
    this.symbolUnsubscribe?.();
    this.symbolUnsubscribe = null;
    this.ruleEngineUnsubscribe?.();
    this.ruleEngineUnsubscribe = null;
    this.stopPanelRefresh();
    this.clearInteractiveBell();
    this.clearFrameTimer();
    // 退出时清理其他空会话（复用 session.autoCleanEmpty 开关）：开启时先打印提示并等待
    // 清理完成，再释放 adapter/关闭渲染器退出；关闭或无可清理服务时保持同步收尾。
    // 注意：仅优雅退出路径（/quit、Ctrl+D、双击 Ctrl+C、插件 unload）覆盖——信号强退
    // （SIGINT/SIGTERM）与崩溃路径由 renderer 直接 process.exit，无法可靠等待异步 IO。
    // 「重启 dsh」路径（restartPending）跳过清理：重启不该改动其它会话（BACKLOG #51）。
    if (!this.autoCleanEmpty || this.restartPending) {
      this.finishDispose();
      return;
    }
    void this.disposeWithExitClean();
  }

  /** 收尾释放：适配器 → 渲染器（close 恢复终端并退出事件循环/进程）。 */
  private finishDispose(): void {
    this.deps.adapter.dispose?.();
    this.deps.renderer.close();
  }

  /** autoCleanEmpty 开启时的退出收尾：等待清理完成（含超时兜底）后再 finishDispose。 */
  private async disposeWithExitClean(): Promise<void> {
    let timedOut = false;
    try {
      await Promise.race([
        this.runExitCleanEmptySessions(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, EXIT_CLEAN_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      this.paintExitNotice(`退出清理异常：${String(err)}`, "error");
    }
    if (timedOut) {
      this.paintExitNotice("清理空会话超时，放弃等待", "warn");
    }
    this.finishDispose();
  }

  // ---------- 声音提醒（P2#33） ----------

  /** 响铃一次（bell 总开关 + 已释放双检查）：turn-end 与「需交互」事件共用（BACKLOG 3.4.1） */
  private ringBell(): void {
    if (!this.bellEnabled || this.disposed) return;
    this.deps.renderer.bell?.();
  }

  /** turn-end 钩子：任务运行结束只响一声（BACKLOG 3.4.2——原「随后 idle 补响一次」已去掉，
   *  一次 run 结束不再听到两声；「需交互而未应答」的催促改由 3.4.3 的交互响铃承担）。 */
  private onTurnEnded(): void {
    this.ringBell();
  }

  /** 需交互开始（BACKLOG 3.4.1 + 3.4.3）：审批 / 问答面板弹出即响一声，并启动「无操作
   *  超阈值」计时；超阈值仍无操作 → 每秒响一次，直到用户有操作或面板关闭。
   *  一次交互内最多进入一次：任意按键（handleKey 入口）即停止且不重启。 */
  private beginInteractiveBell(): void {
    if (!this.bellEnabled || this.disposed) return;
    this.ringBell();
    this.clearInteractiveBell();
    this.pendingBellTimer = setTimeout(() => {
      this.pendingBellTimer = null;
      if (!this.bellEnabled || this.disposed) return;
      this.repeatBellTimer = setInterval(() => this.ringBell(), 1000);
    }, this.idleBellMs);
  }

  /** 停止需交互响铃（任意按键 / 面板关闭 / dispose）：清计时器，且同一次交互不再重启 */
  private clearInteractiveBell(): void {
    if (this.pendingBellTimer) {
      clearTimeout(this.pendingBellTimer);
      this.pendingBellTimer = null;
    }
    if (this.repeatBellTimer) {
      clearInterval(this.repeatBellTimer);
      this.repeatBellTimer = null;
    }
  }

  /** 面板打开期间定时刷新（/agents、/workflows 共用；间隔 agentsRefreshIntervalMs 默认 2s）。
   *  增量事件面不实时推全量（/agents 无事件面、/workflows 增量仅维护内部集合），由本定时器
   *  tick 自检面板 kind 仍匹配时重拉；否则停表（覆盖 Esc/Enter/重复 kind 关闭等全部关闭路径）。 */
  private startPanelRefresh(opts: {
    kind: CommandPanelKind;
    refresh: (() => Promise<void>) | undefined;
    label: string;
  }): void {
    if (this.panelRefreshTimer || this.disposed) return;
    this.panelRefreshCtx = opts;
    const intervalMs = this.deps.agentsRefreshIntervalMs ?? 2000;
    this.panelRefreshTimer = setInterval(
      () => this.panelRefreshTick(),
      intervalMs,
    );
  }

  private stopPanelRefresh(): void {
    if (this.panelRefreshTimer) {
      clearInterval(this.panelRefreshTimer);
      this.panelRefreshTimer = null;
    }
    this.panelRefreshCtx = null;
  }

  private panelRefreshTick(): void {
    if (this.disposed) {
      this.stopPanelRefresh();
      return;
    }
    const panel = this.state.commandPanel;
    const ctx = this.panelRefreshCtx;
    if (!panel || !ctx || panel.kind !== ctx.kind) {
      // 面板已关或切到别的 kind：停表（不空刷）
      this.stopPanelRefresh();
      return;
    }
    void ctx.refresh
      ?.call(this.deps.adapter)
      .catch(() => this.notice(`${ctx.label} 服务不可用`, "warn"));
  }

  /** TUI#39：静默重拉子代理目录（喂状态列 Agents 块；方法缺失或失败都不打扰用户） */
  private refreshAgentsQuiet(): void {
    if (this.disposed) return;
    void this.deps.adapter.refreshAgents?.().catch(() => {});
  }

  /**
   * TUI#39：状态列 Agents 块的**定时**保鲜（随 StatusTicker 节律，缺省 5s）。
   * 停止条件只留「状态列被 Ctrl+S 隐藏 / 无活跃会话」：不依赖 `subagent-activity` 事件面
   * （真机 playbook 场景事件不可靠），空数据也轮询——首个有效快照到达即出块（≤5s）；
   * 事件路径仍作即时加速（见 `subagent-activity` 分支；BACKLOG TUI#55）。
   */
  /** 会话别名保鲜（TUI#48）：懒读 session-channel 别名清单，值变化才重绘。
   *  插件未挂载 / 未设别名 / 读取失败 → 静默跳过（状态栏增强项，不影响主流程）。 */
  private async maybeRefreshSessionAlias(): Promise<void> {
    const get = this.deps.getSessionChannel;
    if (get === undefined) return;
    const sessionId =
      this.state.activeSessionId ?? this.deps.adapter.sessionId ?? "";
    if (sessionId === "") return;
    try {
      const service = get();
      if (service === undefined) return;
      const result = await service.aliasList();
      if (!result.ok) {
        // 增强项失败不阻塞主流程：通道首连失败会后台重试，故启动窗口内（连续失败未达阈值）
        // 静默，达阈值才留痕一次（每进程一次）
        this.aliasFailStreak += 1;
        if (
          this.aliasFailStreak >= ALIAS_WARN_AFTER_FAILS &&
          !this.aliasWarned
        ) {
          this.aliasWarned = true;
          this.deps.logger?.(
            `warn: 会话别名读取失败（状态栏不显示别名段）：${result.error ?? "未知原因"}`,
          );
        }
        return;
      }
      this.aliasFailStreak = 0;
      const alias = result.aliases?.find(
        (entry: { sessionId: string; alias: string }) =>
          entry.sessionId === sessionId,
      )?.alias;
      if (alias === this.aliasCache) return;
      this.aliasCache = alias;
      this.apply((s) =>
        setSystemStatus(s, alias === undefined ? {} : { alias }),
      );
      this.paint();
    } catch (err) {
      if (!this.aliasWarned) {
        this.aliasWarned = true;
        this.deps.logger?.(`warn: 会话别名刷新异常：${String(err)}`);
      }
    }
  }

  private maybeRefreshAgents(): void {
    if (this.disposed) return;
    if (!this.state.statusColumnVisible) return;
    if (!this.state.activeSessionId) return;
    this.refreshAgentsQuiet();
  }

  private handleEvent(e: DshEvent): void {
    // 启动初期 activeSessionId 尚未建立（真实 adapter 不发 session-list，全新会话
    // 的 title 要等首条用户消息）：首个带 sessionId 的事件到达即确立活跃会话，
    // 使 Mode 快照等按会话槽位的内容在未输入前即可展示（随后真实 title 覆盖）
    if (!this.state.activeSessionId) {
      const sid = (e as { sessionId?: unknown }).sessionId;
      if (typeof sid === "string" && sid !== "") {
        this.apply((s) =>
          reduceState(s, { type: "session-identify", id: sid, title: "" }),
        );
      }
    }
    switch (e.type) {
      case "session-list":
        this.apply((s) =>
          reduceState(s, { type: "sessions", sessions: e.sessions }),
        );
        break;
      case "session-title":
        // 官方 dsh-session-title 事件（fallback/provider/user 任一 source）。
        // adapter 已按活跃会话过滤；App 启动初期 activeSessionId 尚未建立时仍接受
        if (
          !this.state.activeSessionId ||
          e.sessionId === this.state.activeSessionId
        ) {
          const wasUnidentified = !this.state.activeSessionId;
          this.apply((s) =>
            reduceState(s, {
              type: "session-identify",
              id: e.sessionId,
              title: e.title,
            }),
          );
          // 启动初期 activeSessionId 尚为 null，start() 的 Mode 快照被跳过；
          // 首个 title 事件建立会话后补拉一次（全新会话日志无 mode 事件时，
          // adapter 以宿主默认预设兜底，见 emitSessionModeSnapshot）
          if (wasUnidentified) this.restoreSessionState();
        }
        break;
      case "stream":
        // 单活跃会话：非当前活跃会话的流式事件不进入 buffer（adapter 已过滤，
        // 此处 App 侧兜底，供直接 push 事件的集成断言使用）
        if (
          this.state.activeSessionId &&
          e.sessionId !== this.state.activeSessionId
        ) {
          break;
        }
        this.beginTurnIfNeeded();
        // 符号统一（/symbol-unify 开关）：on=经 symbol-normalizer 服务做展示层替换；
        // off 或服务未挂载=原文透传（审查 / notice / 模型反馈均在插件侧，经 onReview 订阅）
        const symbols = this.state.symbolUnify ? this.symbols() : undefined;
        const streamText =
          symbols !== undefined ? symbols.normalize(e.text).text : e.text;
        this.apply((s) =>
          reduceState(s, {
            type: "append",
            text: streamText,
            time: Date.now(),
          }),
        );
        break;
      case "thinking":
        if (
          this.state.activeSessionId &&
          e.sessionId !== this.state.activeSessionId
        ) {
          break;
        }
        this.beginTurnIfNeeded();
        this.apply((s) =>
          reduceState(s, {
            type: "thinking",
            text: e.text,
            time: Date.now(),
          }),
        );
        break;
      case "agent-status":
        if (
          this.state.activeSessionId &&
          e.sessionId !== this.state.activeSessionId
        ) {
          break;
        }
        this.apply((s) =>
          reduceState(s, { type: "agent-status", status: e.status }),
        );
        break;
      case "approval":
        this.apply((s) =>
          reduceState(s, {
            type: "approval",
            approval: { id: e.id, prompt: e.prompt },
            // 倒计时来源（BACKLOG 3.2.5）：与 adapter 默认超时同口径
            deadline: Date.now() + this.approvalTimeoutMs(),
          }),
        );
        // 需交互（审批）→ 立即响铃并起催促计时（BACKLOG 3.4.1 / 3.4.3）
        this.beginInteractiveBell();
        break;
      case "approval-closed": {
        // 3.3.2：宿主侧裁定（超时 / abort）已生效 → 面板必须同步关闭，否则用户看到的
        // 是「面板还开着，再按 y 却毫无反应」（settle 后 pending 已删，approve 静默丢失）
        if (this.state.approval?.id !== e.id) break;
        this.apply((s) => reduceState(s, { type: "approval", approval: null }));
        this.apply((s) =>
          reduceState(s, {
            type: "notice",
            text:
              e.reason === "timeout"
                ? "审批已超时（按默认拒绝处理）"
                : "审批已取消（连接中断）",
            tone: "warn",
          }),
        );
        this.deliverLocal({
          kind: "notice",
          text:
            e.reason === "timeout"
              ? "审批已超时（按默认拒绝处理）"
              : "审批已取消（连接中断）",
          tone: "warn",
        });
        break;
      }
      case "question":
        // DSH 提问：整批题一次打开（一次 ask() 一批；面板内逐题导航，提交整批）
        // 3.2.10：带上活动区最近一条非思考正文（通常是提问前的题干说明），面板期间展示
        // 宿主 question 优先（决策 D58）：覆盖本地审阅面板时暂存编辑草稿并提示。
        if (
          this.state.question?.id === MEMORY_REVIEW_PANEL_ID &&
          e.id !== MEMORY_REVIEW_PANEL_ID
        ) {
          for (const item of this.state.question.items) {
            if (item.custom !== undefined && item.custom.trim() !== "") {
              this.memoryReviewDrafts.set(item.id, item.custom);
            }
          }
          this.notice(
            "审阅面板被宿主提问覆盖（编辑草稿已暂存，/memory review 恢复）",
            "warn",
          );
        }
        this.apply((s) =>
          reduceState(s, {
            type: "question-open",
            id: e.id,
            questions: e.questions,
            source: recentQuestionSource(s.buffer),
          }),
        );
        // 需交互（问答）→ 立即响铃并起催促计时（BACKLOG 3.4.1 / 3.4.3）
        this.beginInteractiveBell();
        break;
      case "notice":
        // 命令通知(结果/提示/错误)只进 UI 缓冲，绝不进模型历史；
        // error 标记(如未知 slash 命令 fail-close)→ 输入栏失败色(红)；
        // tone 标记（turn/end finish reason 等）→ 渲染层按红/黄/灰着色
        this.apply((s) =>
          reduceState(s, {
            type: "notice",
            text: e.text,
            error: e.error,
            tone: e.tone,
          }),
        );
        break;
      case "turn-start":
        // #3：把宿主回合号回填到本回合的分隔线（分隔线已在本地 turn-begin 落行、暂时无号）
        if (typeof e.turn === "number") {
          const turn = e.turn;
          this.apply((s) => reduceState(s, { type: "turn-number", turn }));
        }
        break;
      case "turn-end":
        // turn 结束：不再画分隔线(下个回合开始时画)。
        // P2#33 声音提醒：任务结束 bell + 启动「等待用户输入超阈值」计时（输入即清）
        this.onTurnEnded();
        this.turnOpen = false;
        // P1：把 adapter 归一化的收尾原因转给 reducer——它给该回合的用户块打终态符号
        // （completed→绿 ✓ / aborted→灰 ■ / error→红 ✗ / 其余保持未定 → `?`）；漏传则
        // 真实事件路径下用户块永远不会显示终态
        this.apply((s) =>
          reduceState(s, { type: "turn-end", reason: e.reason }),
        );
        this.warnStrippedChars();
        break;
      case "tool-call":
      case "model-selection":
      case "tool-result":
      case "usage":
      case "compaction":
      case "retry":
      case "goal-change":
      case "goal-activation":
      case "todo-write":
      case "agents-changed":
      case "mode":
      case "step":
      case "subagent":
      case "compaction-summary":
      case "approval-policy":
      case "workflow":
      case "command":
      case "code-dispatch":
      case "hook":
      case "schedule":
      case "compaction-prune":
      case "feedback":
      case "retry-started":
      case "command-panel-data":
        // 阶段 1 pass-through：事件结构 = StateAction 同型，入 reducer 落 buffer 行；
        // 阶段 2 按事件落 toast / 状态栏槽位；P2 B 阶段渲染前同此处理
        // 条目 7 批 A：这条分支写下的可见行（retry / subagent / hook / feedback /
        // 压缩提示 / 重试中 …）过去只进缓冲、不投块 → 流水线看不到，这里补投块。
        // **adapter 已直接交付的事件不桥接**（重复投递会在回合区出现两行）：
        // `tool-call` / `tool-result`（批与结果）、`step`（step-start）、
        // `compaction-prune`（shadow）—— 见 adapter/dsh.ts 的 deliver 调用点。
        const tailBefore = this.state.buffer.length;
        this.apply((s) => reduceState(s, e));
        const bridged =
          e.type !== "step" &&
          e.type !== "compaction-prune" &&
          e.type !== "tool-call" &&
          e.type !== "tool-result";
        if (bridged) this.deliverBufferTail(tailBefore);
        // 模型/模式类状态变化 → 刷新会话状态快照（宿主日志仍是主来源，快照作兜底）
        if (
          e.type === "model-selection" ||
          e.type === "mode" ||
          e.type === "approval-policy"
        ) {
          this.scheduleSessionStateSave();
        }
        break;
      case "subagent-activity":
        // TUI#10：子代理生命周期变化 → /agents 面板打开时即时重拉（2s 定时仍作兜底；
        // 非 agents 面板不受影响，panelRefreshTick 自带 kind 守卫）
        if (this.state.commandPanel?.kind === "agents") this.panelRefreshTick();
        // TUI#39：同时即时刷新状态列 Agents 块（5s 定时之外的「启停即刻可见」通道）
        this.refreshAgentsQuiet();
        break;
      case "rule-injection":
        // BACKLOG TUI#49：rule-engine 注入消息（正文 `[RULE]` 前缀）按用户块实时显示；
        // 历史恢复路径由 adapter 折叠为用户消息，无需 App 额外处理。id 去重防双通道重复
        if (e.id !== "" && this.renderedRuleInjections.has(e.id)) break;
        if (e.id !== "") {
          if (this.renderedRuleInjections.size > 200)
            this.renderedRuleInjections.clear();
          this.renderedRuleInjections.add(e.id);
        }
        this.apply((s) => reduceState(s, { type: "user-line", text: e.text }));
        // 双写：流水线用户节（回合中 → 当前上下文；启动注入（尚无回合）→ 归回合 1）
        if (this.sections !== null) {
          const scope = this.sections.lastScope;
          this.deliverLocal({
            kind: "user",
            turn: scope.turn > 0 ? scope.turn : (this.pipelineLastTurn ?? 1),
            step: scope.step,
            text: e.text,
            seq: lastUserLineSeq(this.state.buffer),
          });
        }
        this.paint();
        break;
      case "inbox-claim":
        // TUI#43：steer 在**本回合的 step 边界**被核心认领 → 该条从排队块转入历史流。
        // next-turn 的认领仍走回合开始路径（beginTurnIfNeeded → queued-claim），
        // 这里只处理 steer，避免同一条被认领两次
        if (e.target === "next-step") {
          const claimed = this.state.queued.find((q) => q.kind === "steer");
          this.apply((s) => reduceState(s, { type: "queued-claim-steer" }));
          // steer 认领转入历史流 → 当前步用户节（与旧路径同组；`queued: "steer"`
          // 让节带 steer 标记 → 第 3 步在它与上一条输入之间留空行）
          if (claimed !== undefined) {
            const scope = this.sections?.lastScope;
            if (scope !== undefined) {
              const turn =
                scope.turn > 0 ? scope.turn : (this.pipelineLastTurn ?? 1);
              // 先给**上一条**用户输入置「被续接」（永久 `←`）——必须在投新块之前，
              // 否则「最后一条用户条目」已变成刚认领的这条（批 B1：符号不再回查 buffer）
              this.deliverLocal({ kind: "user-flag", steerContinued: true });
              this.deliverLocal({
                kind: "user",
                turn,
                step: scope.step,
                text: claimed.text,
                queued: "steer",
                seq: lastUserLineSeq(this.state.buffer),
              });
            }
          }
          this.paint();
        }
        break;
      case "ui-flags": {
        // 切换会话后回填 TUI 本地开关（宿主日志不记录 verbose / symbol-unify）
        if (
          this.state.activeSessionId &&
          e.sessionId !== this.state.activeSessionId
        ) {
          break;
        }
        if (e.collapse !== undefined) {
          this.apply((s) =>
            reduceState(s, { type: "activity-compact", on: e.collapse! }),
          );
        }
        if (e.verbose !== undefined) {
          this.apply((s) =>
            reduceState(s, { type: "activity-verbose", level: e.verbose! }),
          );
        }
        if (e.symbolUnify !== undefined) {
          this.apply((s) =>
            reduceState(s, { type: "symbol-unify", on: e.symbolUnify! }),
          );
        }
        if (e.statusColumn !== undefined) {
          this.apply((s) =>
            reduceState(s, { type: "status-column", visible: e.statusColumn! }),
          );
        }
        // #9：恢复下半区（Turn/Tool）显隐
        if (e.lowerPanes !== undefined) {
          this.apply((s) =>
            reduceState(s, { type: "lower-panes", visible: e.lowerPanes! }),
          );
        }
        break;
      }
      case "agent-preset":
      case "jobs-changed": {
        // 单活跃会话：非当前活跃会话的 agent-preset / jobs 事件不进入状态
        // （adapter 已按活跃会话过滤；此处 App 侧兜底，供直接 push 事件的集成断言使用）
        if (
          this.state.activeSessionId &&
          e.sessionId !== this.state.activeSessionId
        ) {
          break;
        }
        this.apply((s) => reduceState(s, e));
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
    this.paint();
  }

  /**
   * 回合开始：先画分隔线(仅首个回合空历史时跳过)；submit 与首条思考/正文均需走这里。
   * 新回合开始 = 核心认领最早一条排队消息（每回合认领一条）→ 该条转入历史流。
   *
   * @param userInput 本次回合是否由用户输入开启（提交）。活动区内容只在
   *   「用户输入开启的回合」整体清空（含排队消息被认领）；核心自发的回合
   *   （goal 轮次/定时唤醒等）保留上一轮内容继续往上堆——活动区只在下一次
   *   输入后清空，且清空时思考/工具/notice 一起清，不做单类清除。
   */
  private beginTurnIfNeeded(userInput = false): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    const clearActivity = userInput || this.state.queued.length > 0;
    // #3：回合分隔线要显示时间（`hh:mm:ss`）；回合号由随后的宿主 `turn/start` 回填
    const beginTime = Date.now();
    // 六步流水线：分隔线时间的真源同步交付（首回合分隔线由 frame 层预置）
    // 排队项在回合开始被认领（followup）→ 转入历史流；流水线同步交付用户节
    const claimed = this.state.queued.find((q) => q.kind === "followup");
    let predictedTurn = 0;
    if (this.sections !== null) {
      // 回合号本地预测：宿主 turn/start 稍后回填（旧路径改写缓冲行；节缓存不可变），
      // 这里按上一已知回合 +1 预测（首回合 1），分隔线时间随预测号登记
      predictedTurn = (this.pipelineLastTurn ?? 0) + 1;
      // 画线判据与旧路径 appendTurnSeparator 镜像：活动区清理后 buffer 非空且末行
      // 不是回合分隔线才画——首回合空历史不画（frame 层不预置重复线）
      const visible = clearActivity
        ? this.state.buffer.filter(
            (l) =>
              l.kind !== "thinking" &&
              l.kind !== "tool" &&
              l.kind !== "notice" &&
              !(l.kind === "assistant" && !l.final),
          )
        : this.state.buffer;
      const last = visible[visible.length - 1];
      const drawsSeparator =
        visible.length > 0 &&
        !(last?.kind === "separator" && last.text === TURN_SEPARATOR);
      if (drawsSeparator) {
        this.ingestDelivery({
          kind: "turn-start",
          turn: predictedTurn,
          time: beginTime,
        });
      } else {
        // 不画线（首回合空历史 / 末行已是分隔线）：回合号基线仍要推进，
        // 否则下一回合的本地预测会重复同一号
        this.pipelineLastTurn = predictedTurn;
      }
    }
    this.apply((s) =>
      reduceState(s, {
        type: "turn-begin",
        clearActivity,
        time: beginTime,
      }),
    );
    this.apply((s) => reduceState(s, { type: "queued-claim" }));
    // 认领交付放在 queued-claim 落行之后：行号取自本行（先交付会取到旧行的 seq）
    if (claimed !== undefined && this.sections !== null) {
      this.deliverLocal({
        kind: "user",
        turn: predictedTurn,
        step: 0,
        text: claimed.text,
        seq: lastUserLineSeq(this.state.buffer),
      });
    }
  }

  /** turn 结束后警告：本回合剔除的非打印控制字符（渲染保护兜底） */
  private warnStrippedChars(): void {
    const n = this.state.strippedChars;
    if (n <= 0) return;
    this.apply((s) =>
      reduceState(s, {
        type: "notice",
        text: `已过滤 ${n} 个非打印控制字符（渲染保护）`,
        tone: "warn",
      }),
    );
    this.deliverLocal({
      kind: "notice",
      text: `已过滤 ${n} 个非打印控制字符（渲染保护）`,
      tone: "warn",
    });
    this.apply((s) => reduceState(s, { type: "clear-stripped" }));
    this.paint();
  }

  /**
   * 符号服务懒读：首次可用时解析并订阅审查事件（notice 展示）。
   * 容忍插件装载顺序（symbol-normalizer 可能在 TUI 之后 provide）；未挂载返回 undefined。
   * 审查（冷却 / 文案生成 / 模型反馈）全在插件侧，TUI 只负责展示归一与 notice。
   */
  private symbols(): SymbolNormalizerLike | undefined {
    if (this.symbolService !== null) return this.symbolService;
    let service: SymbolNormalizerLike | undefined;
    try {
      service = this.deps.getSymbols?.();
    } catch {
      service = undefined;
    }
    if (service === undefined) return undefined;
    this.symbolService = service;
    try {
      this.symbolUnsubscribe = service.onReview((event) => {
        // /symbol-unify off 时不提示；会话过滤与其它事件同口径
        if (!this.state.symbolUnify) return;
        if (
          this.state.activeSessionId &&
          event.sessionId !== this.state.activeSessionId
        ) {
          return;
        }
        this.notice(event.notice, "warn");
      });
    } catch {
      this.symbolUnsubscribe = null;
    }
    return service;
  }

  /**
   * 外部告警行入口（stderr 桥 / 插件 notice 总线）：进活动区、可回溯（tone 缺省 log）。
   * 接线见 main.ts（桥）与 ruleEngine()（总线）。
   */
  appendExternalLog(line: string, tone?: NoticeTone): void {
    if (this.bootLogPending !== null) {
      this.bootLogPending.push({ text: line, tone });
      return;
    }
    this.notice(line, tone ?? "log");
  }

  /**
   * rule-engine 服务懒读：首次可用时订阅告警总线（`onNotice` → 活动区）。
   * 容忍插件装载顺序；未挂载 / 未实现 onNotice → undefined（插件侧 stderr 兜底）。
   */
  private ruleEngine(): RuleEngineLike | undefined {
    if (this.ruleEngineService !== null) return this.ruleEngineService;
    let service: RuleEngineLike | undefined;
    try {
      service = this.deps.getRuleEngine?.();
    } catch {
      service = undefined;
    }
    if (service === undefined) return undefined;
    this.ruleEngineService = service;
    try {
      if (typeof service.onNotice === "function") {
        this.ruleEngineUnsubscribe = service.onNotice((event) => {
          this.appendExternalLog(event.text, event.tone);
        });
      } else {
        this.ruleEngineUnsubscribe = null;
      }
    } catch {
      this.ruleEngineUnsubscribe = null;
    }
    return service;
  }

  private handleKey(k: KeyEvent): void {
    // BACKLOG 3.4.3：任意用户输入（含无效键，人在终端前即算操作）即停止需交互催促响铃，
    // 且同一次交互内不再重启
    this.clearInteractiveBell();
    if (this.disposed) return;
    const { name, ctrl } = k;

    // 审批模式：y/n 应答 + ↑/↓ 滚动描述窗（长草稿查看，BACKLOG 3.2.1）；
    // 其余按键（含 Esc、Ctrl+D、Ctrl+L）一律吞掉——不打断运行、不关闭弹窗、
    // 不改输入模式（“审批模式不变”契约；白名单与无效键提示见 BACKLOG 3.3.1）
    if (this.state.approval) {
      // 用户在面板内有过任何操作 → 停止自动超时（BACKLOG 3.3.5：与问答面板「人在场就不催」
      // 一致；此后不再自动裁定，倒计时一并隐藏）。在按键分发前统一处理，含无效键。
      this.deps.adapter.stopApprovalTimeout?.(this.state.approval!.id);
      if (this.state.approvalDeadline !== null) {
        this.apply((s) => reduceState(s, { type: "approval-no-timeout" }));
      }
      // 审批按键白名单（BACKLOG 3.2.4 / 3.2.6 / 3.3.1）：y/n 与数字键直答、Enter 提交
      // 焦点项、←/→ 切换焦点、↑/↓ 滚草稿、Esc 取消；白名单外按键不落输入栏，改在提示区
      // 给出「无效键」提示（提示由 state.approvalHint 承载，任一有效键即清空）。
      const finishApproval = (allow: boolean): void => {
        this.deps.adapter.approve(this.state.approval!.id, allow);
        this.apply((s) => reduceState(s, { type: "approval", approval: null }));
        this.paint();
      };
      const moveApprovalFocus = (): void => {
        const focus =
          this.state.approvalFocus === "approve" ? "reject" : "approve";
        this.apply((s) => reduceState(s, { type: "approval-focus", focus }));
        this.paint();
      };
      if (name === "y" || name === "1") return finishApproval(true);
      if (name === "n" || name === "2") return finishApproval(false);
      if (name === "enter")
        return finishApproval(this.state.approvalFocus === "approve");
      if (name === "left" || name === "right") return moveApprovalFocus();
      if (name === "escape") {
        this.deps.adapter.cancelApproval(this.state.approval!.id);
        this.apply((s) => reduceState(s, { type: "approval", approval: null }));
        this.paint();
        return;
      }
      if (name === "tab") {
        // Tab：草稿 <-> 选项焦点窗（BACKLOG 3.3.4，与问答面板同构）
        this.apply((s) => reduceState(s, { type: "approval-tab" }));
        this.paint();
        return;
      }
      if (name === "up" || name === "down") {
        // ↑/↓ 语义随焦点窗（3.3.4）：描述窗滚草稿、选项窗移动「批准 / 拒绝」
        if (this.state.approvalWindow === "desc") {
          this.apply((s) =>
            reduceState(s, {
              type: "approval-scroll",
              delta: name === "down" ? 1 : -1,
              max: this.approvalScrollMax(),
            }),
          );
        } else {
          this.apply((s) =>
            reduceState(s, {
              type: "approval-focus",
              focus:
                this.state.approvalFocus === "approve" ? "reject" : "approve",
            }),
          );
        }
        this.paint();
        return;
      }
      this.apply((s) =>
        reduceState(s, {
          type: "approval-hint",
          text: "[无效键] 审批仅响应 ←/→ · 1/2 · y/n · Enter · Esc",
        }),
      );
      this.paint();
      return;
    }

    // 问答面板：↑/↓ 移动选项高亮，←/→ 切换题目（第 n/m 题），Tab 选项<->自定义切换，
    // 空格标记/取消标记选项，Enter 提交整批答案，Esc 仅取消问答（reject ask，不打断 turn）；
    // 自定义输入焦点时可打印字符/退格编辑文本；其余按键吞掉不落入输入栏。
    if (this.state.question) {
      this.handleQuestionKey(k);
      return;
    }

    // /model 交互面板：↑/↓ 移动焦点箭头（位置指示），空格把焦点行写入
    // 选中（星号，Enter 提交它，不提交；真实键盘空格为普通字符 " "）；
    // model/思考等级列表跟随星号（选中），不随 > 焦点切换，
    // ←/→ 左右切换三列焦点区（clamp 不循环），Tab 循环切换，Enter 提交各列选中值
    // Esc 取消；其余按键忽略
    if (this.state.picker) {
      if (name === "up" || name === "down") {
        this.apply((s) =>
          reduceState(s, {
            type: "picker-move",
            delta: name === "down" ? 1 : -1,
          }),
        );
        this.paint();
        return;
      }
      if (name === " " || name === "space") {
        this.apply((s) => reduceState(s, { type: "picker-select" }));
        this.paint();
        // provider/model 区星号移动后重载思考等级列表（thinking 区选择不变列表）
        const phase = this.state.picker?.phase;
        if (phase === 0 || phase === 1) void this.reloadPickerEfforts();
        return;
      }
      if (name === "tab") {
        this.apply((s) => reduceState(s, { type: "picker-tab" }));
        this.paint();
        return;
      }
      if (name === "left" || name === "right") {
        this.apply((s) =>
          reduceState(s, {
            type: "picker-phase",
            delta: name === "right" ? 1 : -1,
          }),
        );
        this.paint();
        return;
      }
      if (name === "enter") {
        void this.confirmModelPicker();
        return;
      }
      if (name === "escape") {
        // 关闭面板（并重置输入模式为 normal；提交后的自动回退见 submit）
        this.apply((s) => reduceState(s, { type: "picker-close" }));
        this.apply((s) =>
          reduceState(s, { type: "input-mode", mode: "normal" }),
        );
        this.paint();
        return;
      }
      return;
    }

    // 通用状态选项面板（/policy /permission）：↑/↓ 移动焦点、空格预选
    // （星号，再按取消）、Enter 提交预选（无预选回退焦点）并关闭、Esc 取消
    if (this.state.statusPanel) {
      if (name === "up" || name === "down") {
        this.apply((s) =>
          reduceState(s, {
            type: "status-panel-move",
            delta: name === "down" ? 1 : -1,
          }),
        );
        this.paint();
        return;
      }
      if (name === " " || name === "space") {
        this.apply((s) => reduceState(s, { type: "status-panel-select" }));
        this.paint();
        return;
      }
      if (name === "enter") {
        void this.commitStatusPanel();
        return;
      }
      if (name === "escape") {
        this.apply((s) => reduceState(s, { type: "status-panel-close" }));
        this.paint();
        return;
      }
      return;
    }

    // /jobs 任务面板：↑/↓ 移动高亮、PgUp/PgDn 整页（页高=活动区可视行数，与共享面板
    // 同 frameGeometry 口径）、Enter 取消高亮任务、Esc 关闭；其余按键吞掉
    if (this.state.jobsPanel) {
      if (name === "up") {
        const focus = this.state.jobsPanel.index;
        this.apply((st) =>
          reduceState(st, { type: "jobs-panel-move", focus, delta: -1 }),
        );
      } else if (name === "down") {
        const focus = this.state.jobsPanel.index;
        this.apply((st) =>
          reduceState(st, { type: "jobs-panel-move", focus, delta: 1 }),
        );
      } else if (name === "pageup" || name === "pagedown") {
        // 翻页页高 = 活动区可视行数（与 shared commandPanel 同一 frameGeometry 口径）
        const page = frameGeometry(
          this.state,
          this.deps.renderer.getSize(),
        ).activityH;
        const delta = name === "pageup" ? -1 : 1;
        this.apply((st) =>
          reduceState(st, { type: "jobs-panel-page", delta, page }),
        );
      } else if (name === "enter") {
        const job = this.state.jobs[this.state.jobsPanel.index];
        if (job) void this.killJob(job.id);
      } else if (name === "escape")
        this.apply((st) => reduceState(st, { type: "jobs-panel-close" }));
      this.paint();
      return;
    }

    // 共享列表面板（/skills 等）：↑/↓ 移动、PgUp/PgDn 整页、Enter 主操作、Esc 关闭；其余吞掉
    if (this.state.commandPanel) {
      const panel = this.state.commandPanel;
      // 翻页页高 = 活动区可视行数（与面板窗口同口径，见 COMMANDS-SPEC.md §4 接线点 5）
      const page = frameGeometry(
        this.state,
        this.deps.renderer.getSize(),
      ).activityH;
      if (name === "up") {
        this.apply((st) =>
          reduceState(st, { type: "command-panel-move", delta: -1 }),
        );
      } else if (name === "down") {
        this.apply((st) =>
          reduceState(st, { type: "command-panel-move", delta: 1 }),
        );
      } else if (name === "pageup") {
        this.apply((st) =>
          reduceState(st, { type: "command-panel-page", delta: -1, page }),
        );
      } else if (name === "pagedown") {
        this.apply((st) =>
          reduceState(st, { type: "command-panel-page", delta: 1, page }),
        );
      } else if (name === "enter") {
        const row = panel.rows[panel.index];
        if (row === undefined) {
          // 空态/占位：无行可操作，吞掉
        } else if (panel.kind === "guard") {
          // 守卫行恒无 payload：Enter 统一展示策略快照（policy()）
          void this.showGuardPolicy();
        } else if (!row.payload) {
          // 无可中断 id 的条目（agents 的 diagnostic / 一次性等）：灰显 + 说明，不发服务调用；
          // 与其它 Enter 行为一致先关面板——否则说明 notice 会被面板占用的活动区遮住
          this.apply((s) => reduceState(s, { type: "command-panel-close" }));
          this.notice(
            row.blockedReason ??
              (panel.kind === "agents"
                ? "该条目不可中断（无可用会话 id）"
                : "该条目无详情载荷"),
            "info",
          );
        } else if (panel.kind === "agents") {
          void this.interruptAgent(row.payload);
        } else if (panel.kind === "workflows") {
          // 只读运行列表：Enter 无操作（吞键，面板保持）
        } else {
          void this.showPanelDetail(panel.kind, row.payload);
        }
      } else if (name === "r" && panel.kind === "agents") {
        // C2：/agents 手动刷新（无宿主事件面时的手动保鲜路径）
        void this.deps.adapter
          .refreshAgents?.()
          .catch(() => this.notice("subagents 服务不可用", "warn"));
      } else if (name === "escape") {
        this.apply((st) => reduceState(st, { type: "command-panel-close" }));
      }
      this.paint();
      return;
    }

    // /history 历史会话面板：list 阶段 ↑/↓ 移动、Enter 查看、Esc 关闭；
    // view 阶段 ↑/↓/PgUp/PgDn 滚动、Esc 返回列表；loading/error 阶段吞键（error 可 Esc 关闭）
    if (this.state.history) {
      const h = this.state.history;
      if (h.phase === "list") {
        if (name === "up")
          this.apply((st) =>
            reduceState(st, { type: "history-move", delta: -1 }),
          );
        else if (name === "down")
          this.apply((st) =>
            reduceState(st, { type: "history-move", delta: 1 }),
          );
        else if (name === "enter") {
          const rec = historyVisibleRecords(this.state)[h.index];
          if (!rec) return;
          if (rec.live) {
            this.notice("live 会话不可续（仅 persisted 会话可切换）", "warn");
            return;
          }
          void this.resumeToSession(rec.id);
          return;
        } else if (name === "tab") {
          // [Tab]：切换列表范围（当前目录 ⇄ 全部目录），默认当前目录
          this.apply((st) => reduceState(st, { type: "history-scope-toggle" }));
        } else if (name === " " || name === "space") {
          // Space：批量标记/取消（不可删项以 notice 说明原因）
          this.toggleMarkRecord();
          return;
        } else if (name === "a") {
          // a：全选当前范围可删项（批量删除入口的快捷全选）
          this.markAllRecords();
          return;
        } else if (name === "c") {
          // c：清空批量标记
          this.clearMarkedRecords();
          return;
        } else if (name === "d" || name === "delete" || name === "backspace") {
          this.confirmDeleteRecord();
          return;
        } else if (name === "x") {
          this.confirmClean();
          return;
        } else if (name === "escape")
          this.apply((st) => reduceState(st, { type: "history-close" }));
      } else if (h.phase === "view") {
        if (name === "up")
          this.apply((st) =>
            reduceState(st, { type: "history-scroll", delta: -1 }),
          );
        else if (name === "down")
          this.apply((st) =>
            reduceState(st, { type: "history-scroll", delta: 1 }),
          );
        else if (name === "pageup")
          this.apply((st) =>
            reduceState(st, { type: "history-scroll", delta: -10 }),
          );
        else if (name === "pagedown")
          this.apply((st) =>
            reduceState(st, { type: "history-scroll", delta: 10 }),
          );
        else if (name === "escape")
          // 返回列表（列表数据仍在内存）
          this.apply((st) => reduceState(st, { type: "history-back" }));
      } else if (h.phase === "confirm-delete" || h.phase === "confirm-clean") {
        // 二次确认：y/Enter 执行、n/Esc 取消（其余键吞掉，避免误触）
        if (name === "y" || name === "enter") void this.runPendingHistoryOp();
        else if (name === "n" || name === "escape")
          this.apply((st) =>
            reduceState(st, { type: "history-confirm-cancel" }),
          );
      } else if (h.phase === "deleting" || h.phase === "cleaning") {
        // 进行中：吞键；完成后由 history-delete-done / history-clean-done 回列表
      } else if (h.phase === "error" && name === "escape") {
        this.apply((st) => reduceState(st, { type: "history-close" }));
      }
      this.paint();
      return;
    }

    // Ctrl+D：仅 idle 且输入区为空时**请求退出确认**（输入非空时按无操作忽略）；
    // 确认走 App.dispose——单字节误触（如终端/复用器注入的 0x04）不再直接结束会话
    if (ctrl && name === "d") {
      if (canExitOnCtrlD(this.state)) {
        this.requestExitConfirm();
      }
      return;
    }

    // Ctrl+S：切换垂直状态列显隐（P7）。隐藏后历史区变宽，需要整帧重排；
    // 显隐状态随会话持久化（tui-state.json）。
    if (ctrl && name === "s") {
      this.apply((s) => reduceState(s, { type: "status-column" }));
      this.scheduleSessionStateSave();
      this.paint();
      return;
    }

    // Ctrl+T：切换下半区（Turn 流 + Tool 面板区）显隐（#9）。隐藏后对话区变高，
    // 需要整帧重排；显隐状态随会话持久化（tui-state.json）。
    if (ctrl && name === "t") {
      this.apply((s) => reduceState(s, { type: "lower-panes" }));
      this.scheduleSessionStateSave();
      this.paint();
      return;
    }

    // Ctrl+P / Ctrl+N：输入历史回溯（BACKLOG TUI#34；readline 惯例）。
    // 2026-10-10 裁定（用户）：**↑/↓ 专用于历史区翻页**（含到顶加载更旧回合），
    // 输入历史改用 Ctrl+P / Ctrl+N —— 原先 ↑ 在「空输入 + 历史非空」时也会接管，
    // 按 ↑ 看到的是输入框在旧输入之间循环、历史区纹丝不动。
    if (ctrl && (name === "p" || name === "n")) {
      if (this.state.focusedPanel !== null) return; // 面板焦点下不接管（面板自有键位）
      this.apply((s) =>
        reduceState(s, {
          type: "input-history",
          action: name === "p" ? "prev" : "next",
        }),
      );
      this.paint();
      return;
    }

    // Ctrl+L：强制整帧重绘（绕过 delta 优化）。放在 switch 前，避免吞掉普通 'l' 输入。
    if (ctrl && name === "l") {
      this.refresh();
      return;
    }

    // Ctrl+J：输入区插入换行符（Enter 仍为发送；renderer 将裸 LF 0x0a 解码为 ctrl+j）
    if (ctrl && name === "j") {
      this.insertChar("\n");
      this.paint();
      return;
    }

    // Ctrl+C：清空输入区（不发送）；750ms 双击窗口内再次 Ctrl+C **请求退出确认**
    // （输入为空时首次只计数不清空，第二次请求；输入非空时首次清空并计入）
    if (ctrl && name === "c") {
      const now = Date.now();
      if (now - this.lastCtrlCAt <= CTRL_C_DOUBLE_MS) {
        this.requestExitConfirm();
        return;
      }
      this.lastCtrlCAt = now;
      if (this.state.inputText !== "") {
        this.apply((s) =>
          reduceState(s, { type: "input", text: "", cursor: 0 }),
        );
        this.paint();
      }
      return;
    }

    switch (name) {
      case "escape":
        // 补全候选打开时 Esc 只收起候选（不打断运行、不动焦点）
        if (this.state.completion) {
          this.apply((s) => reduceState(s, { type: "completion-close" }));
          this.paint();
          break;
        }
        // Esc：排队消息先退回输入框（核心 cancel 会清空自己的 next-turn 队列，
        // 留在本机不丢用户输入）；再打断运行（picker 面板已在上方分支关闭）。
        // idle + 空输入：退出顶部面板焦点循环（有焦点 → 回到无焦点）
        const restored = this.restoreQueued();
        if (this.state.agentStatus !== "idle") {
          this.deps.adapter.interrupt();
        } else if (
          !restored &&
          this.state.inputText === "" &&
          this.state.focusedPanel
        ) {
          this.apply((s) => ({ ...s, focusedPanel: null }));
        }
        break;
      case "tab":
        // 补全候选打开时 Tab 接受默认选中的候选（补全不提交）
        if (this.state.completion) {
          this.acceptCompletion();
          break;
        }
        // Tab：仅输入区为空时循环切换顶部面板焦点（编辑输入时保留 Tab 不打断）
        if (this.state.inputText === "") {
          this.apply((s) => reduceState(s, { type: "focus-panel-cycle" }));
        }
        break;
      case "up":
      case "down": {
        // 补全候选打开时 ↑/↓ 只在候选间移动（不滚动面板）
        if (this.state.completion) {
          this.apply((s) =>
            reduceState(s, {
              type: "completion-move",
              delta: name === "down" ? 1 : -1,
              // 超出活动区可视行的候选已丢弃：焦点导航同样不超出可视范围
              max: this.completionVisibleRows(),
            }),
          );
          this.paint();
          break;
        }
        // 输入历史见 Ctrl+P / Ctrl+N（readline 惯例）：↑/↓ 不再接管输入历史 ——
        // 用户 2026-10-10 裁定，↑/↓ 专用于历史区翻页（含到顶加载更旧回合）
        // 焦点面板滚动：活动区/状态列保持现状（单行），对话区（history 焦点/
        // 无焦点默认）↑/↓ 每次半屏（方向内聚在 focusedLineScroll）
        const dir: 1 | -1 = name === "up" ? 1 : -1;
        const panel = this.state.focusedPanel;
        // 可滚动上限由渲染层按内容/窗口算好（上一帧回填或就地补算）：滚键据此收敛
        // 偏移，否则越界偏移（连续上滚越顶、End）会累积成"按了没反应"的假死
        const max = this.paneScrollMaxOf(panel);
        if (panel === "activity" || panel === "status") {
          this.apply((s) => reduceState(s, focusedLineScroll(panel, dir, max)));
        } else {
          // 位移基准 = 本帧可视行数（缺省回落到几何口径）
          const vh =
            this.paneMaxes().dialogueViewportH ||
            frameGeometry(this.state, this.deps.renderer.getSize()).viewportH;
          // 2026-10-10 用户裁定：裸 ↑/↓ = **一行**（默认滚动粒度）；Ctrl+↑/↓ = **半屏**
          // （快速翻页）。两者都走同一套「先扩窗、再按扩窗后的段表施加位移」，
          // 所以 1 行步进到窗口顶时同样只多物化、不多滚（见 scrollDialogueBy）
          this.scrollDialogueBy(dir * (ctrl ? dialogueHalfPage(vh) : 1));
        }
        break;
      }
      case "pageup":
      case "pagedown": {
        // 焦点面板翻页：活动区/状态列保持整页滚动（页 = 面板当前可视行数）；
        // 对话区（history 焦点/无焦点默认）PgUp/PgDn 跳上/下一条用户输入
        const dir: 1 | -1 = name === "pageup" ? 1 : -1;
        const panel = this.state.focusedPanel;
        if (panel === "activity" || panel === "status") {
          const page = frameGeometry(this.state, this.deps.renderer.getSize());
          this.apply((s) =>
            reduceState(
              s,
              focusedPageScroll(panel, dir, page, this.paneScrollMaxOf(panel)),
            ),
          );
        } else {
          // 跳转只在已物化范围内找目标（更早内容未物化，先按 ↑ 扩窗再翻页）
          const r = this.paneMaxes();
          const target = userRowJump(
            r.dialogueUserRows,
            r.dialogueTopIdx,
            r.dialogueViewportH,
            r.dialogueTotal,
            dir,
          );
          if (target === undefined) {
            // PgDn 无下一条 → 回到底部跟随最新
            if (dir === -1)
              this.apply((s) => reduceState(s, { type: "scroll-to-bottom" }));
          } else {
            this.apply((s) =>
              reduceState(s, {
                type: "dialogue-scroll",
                top: positionAt(
                  createLineTable(r.dialogueCounts),
                  r.dialogueKeys,
                  target,
                ),
                offset: Math.max(0, r.dialogueMaxScroll - target),
              }),
            );
          }
        }
        break;
      }
      case "home":
        // 回到底部（最新）：跟随底部 + 窗口复位默认组数
        this.apply((s) => reduceState(s, { type: "scroll-to-bottom" }));
        break;
      case "end":
        // 跳到最旧：窗口一次扩到全部回合组，锚点钉在首行（line 0）
        this.apply((s) => reduceState(s, { type: "scroll-to-oldest" }));
        break;
      case "left":
        this.apply((s) => reduceState(s, { type: "move-cursor", delta: -1 }));
        break;
      case "right":
        this.apply((s) => reduceState(s, { type: "move-cursor", delta: 1 }));
        break;
      case "backspace":
        // 输入为空时 Backspace 回退模式（$ / 切了模式但没输入，用 Backspace 回 >）
        if (this.state.inputText === "" && this.state.inputMode !== "normal") {
          this.apply((s) =>
            reduceState(s, { type: "input-mode", mode: "normal" }),
          );
        } else {
          this.apply((s) => this.backspace(s));
        }
        break;
      case "enter":
        // Alt+Enter（解码层提供 meta:true）打断并发送；普通 Enter 排队/发送
        this.submit(k.meta);
        break;
      case "paste":
        if (k.text) {
          const t = k.text;
          this.apply((s) =>
            reduceState(s, {
              type: "input",
              text:
                s.inputText.slice(0, s.inputCursor) +
                t +
                s.inputText.slice(s.inputCursor),
              cursor: s.inputCursor + t.length,
            }),
          );
        }
        break;
      default:
        // 模式键：输入框为空时按 $ / / / < 切换模式并吞键（同符号幂等；提交后自动回退 >；! 为普通字符）
        if (
          name.length === 1 &&
          !ctrl &&
          this.state.inputText === "" &&
          (name === "$" || name === "/" || name === "<")
        ) {
          const mode: InputMode =
            name === "$" ? "shell" : name === "/" ? "slash" : "steer";
          if (this.state.inputMode !== mode) {
            this.apply((s) => reduceState(s, { type: "input-mode", mode }));
          }
          break;
        }
        // 可打印字符：插入输入框（Esc/Ctrl+C 已在上方 Ctrl 分支处理，不落入此处）
        if (name.length === 1 && !ctrl) this.insertChar(name);
        break;
    }
    this.paint();
  }

  /** 问答面板按键路由（approval 之后 picker 之前，见 handleKey）：
   * 路由决策为纯函数 questionKeyDecision，副作用（adapter 调用 / paint）在此执行 */
  /** 问答描述窗滚动上界（BACKLOG 3.2.1）：按当前几何算折行后的最大首行偏移 */
  private questionDescScrollMax(): number {
    const panel = this.state.question;
    if (!panel) return 0;
    const geom = frameGeometry(this.state, this.deps.renderer.getSize());
    return maxDescScrollFor(
      panel,
      geom.activityH,
      geom.activityTextW,
      this.state.themeId,
    );
  }

  /** 审批描述窗滚动上界（长草稿可滚动，BACKLOG 3.2.1） */
  private approvalScrollMax(): number {
    const approval = this.state.approval;
    if (!approval) return 0;
    const geom = frameGeometry(this.state, this.deps.renderer.getSize());
    return maxApprovalScroll(
      approval,
      geom.activityH,
      geom.activityTextW,
      this.state.themeId,
    );
  }

  /** 审批超时（ms）：优先取 adapter 实际生效值（保证倒计时与裁定同源，BACKLOG 3.3.2） */
  private approvalTimeoutMs(): number {
    const fromAdapter = this.deps.adapter.approvalTimeoutMs?.();
    return typeof fromAdapter === "number" && fromAdapter > 0
      ? fromAdapter
      : APPROVAL_TIMEOUT_FALLBACK_MS;
  }

  private handleQuestionKey(k: KeyEvent): void {
    const panel = this.state.question;
    if (!panel) return;
    const d = questionKeyDecision(panel, k.name, k.ctrl);
    switch (d.kind) {
      case "cancel":
        // Esc：cancelQuestion 内部完成关面板 + adapter.cancelQuestion + paint
        this.cancelQuestion();
        return;
      case "submit":
        this.submitQuestion(); // 内部已含 paint
        this.paint(); // 保持原实现的二次 paint 时机
        return;
      case "nav":
        this.apply((s) =>
          reduceState(s, { type: "question-nav", delta: d.delta }),
        );
        break;
      case "move":
        this.apply((s) =>
          reduceState(s, { type: "question-move", delta: d.delta }),
        );
        break;
      case "custom-edit":
        this.apply((s) =>
          reduceState(s, {
            type: "question-custom",
            text: d.text,
            caret: d.caret,
          }),
        );
        break;
      case "custom-caret":
        this.apply((s) =>
          reduceState(s, { type: "custom-caret", delta: d.delta }),
        );
        break;
      case "select":
        this.apply((s) => reduceState(s, { type: "question-select" }));
        break;
      case "digit": {
        // 数字键直接标记第 n 项（BACKLOG 3.2.6）：越界吞掉；只标记不提交（提交仍由 Enter）
        const item = panel.items[panel.itemIndex];
        const total = item?.options.length ?? 0;
        if (d.n < 1 || d.n > total) return;
        const cur = item?.optionIndex ?? 0;
        if (cur !== d.n - 1) {
          this.apply((s) =>
            reduceState(s, { type: "question-move", delta: d.n - 1 - cur }),
          );
        }
        this.apply((s) => reduceState(s, { type: "question-select" }));
        break;
      }
      case "focus":
        // Tab：描述窗 <-> 选项窗切换（BACKLOG 3.2.1）
        this.apply((s) => reduceState(s, { type: "question-focus" }));
        break;
      case "desc-scroll":
        // 描述窗逐行滚动：上界按当前几何算定（state 层不知道折行宽度）
        this.apply((s) =>
          reduceState(s, {
            type: "question-desc-scroll",
            delta: d.delta,
            max: this.questionDescScrollMax(),
          }),
        );
        break;
      case "none":
        // 其余按键吞掉（不落入主输入栏）
        return;
    }
    this.paint();
  }

  /** 退出确认（BACKLOG「tmux 断连后 dsh 退出」）：以合成问答面板请求确认——默认高亮
   *  「取消/留在 TUI」，Esc 取消，Enter 确认高亮项；仅在确认「退出 dsh」后 `dispose()`。
   *  复用问答面板机制（零新增按键路由），不调用 adapter（合成面板无宿主 ask）。
   *  已打开时幂等（不叠面板）；已 dispose 时无操作。 */
  private requestExitConfirm(): void {
    if (this.disposed || this.exitConfirmOpen) return;
    this.exitConfirmOpen = true;
    // 第三项仅在「有人接住退出码 75」时提供（启动器经 DSH_RESTART_FILE 声明；BACKLOG #51）
    const options = [
      { label: "取消", description: "留在 TUI（默认）" },
      { label: "退出 dsh", description: "关闭会话并退出" },
    ];
    if (this.restartAvailable()) {
      options.push({
        label: EXIT_CONFIRM_RESTART_LABEL,
        description: "保留会话，由启动器重启 dsh",
      });
    }
    this.apply((s) =>
      reduceState(s, {
        type: "question-open",
        id: EXIT_CONFIRM_PANEL_ID,
        questions: [
          {
            id: EXIT_CONFIRM_PANEL_ID,
            question: "确认退出 dsh？",
            header: "退出",
            options,
          },
        ],
      }),
    );
    this.paint();
  }

  /** 重启可用性：启动器已给出交接文件路径（空串/缺省 = 直接启动，不提供重启项） */
  private restartAvailable(): boolean {
    const path = this.deps.restartHandoffPath;
    return typeof path === "string" && path !== "";
  }

  /** 写重启交接文件：当前活跃会话 id 单行（`0600`）。写失败只告警——退出码 75 不变，
   *  启动器读不到 id 会自动退回 `-c`（见 DESIGN 契约）。无活跃会话时不写文件。 */
  private writeRestartHandoff(): void {
    const path = this.deps.restartHandoffPath;
    if (typeof path !== "string" || path === "") return;
    const sessionId =
      this.state.activeSessionId ?? this.deps.adapter.sessionId ?? "";
    if (sessionId === "") return;
    try {
      writeFileSync(path, `${sessionId}\n`, { mode: 0o600 });
    } catch (err) {
      process.stderr.write(
        `[tui] warn: 重启交接文件写入失败（${String(err)}），启动器将退回 -c\n`,
      );
    }
  }

  /** 请求重启（单一来源）：写交接文件 → 置退出码（renderer.close 尊重既有 exitCode）→
   *  跳过空会话清理收尾。退出确认面板第三项与 `/restart` 共用（BACKLOG TUI「/restart 命令」）。 */
  private requestRestart(): void {
    this.writeRestartHandoff();
    process.exitCode = DSH_RESTART_EXIT_CODE;
    this.restartPending = true;
    this.dispose();
  }

  /** `/restart`：显式命令直接执行（不弹确认面板，与 `/quit` 同口径）。无启动器声明
   *  （`DSH_RESTART_FILE` 未设，见 DESIGN「退出确认 ·「重启」方案」）时只提示、不退出——
   *  没有接收方的退出码 75 会退化成「静默普通退出」。 */
  private handleRestartCommand(): void {
    if (!this.restartAvailable()) {
      this.notice(
        "重启不可用：需由启动器启动（未设置 DSH_RESTART_FILE）",
        "warn",
      );
      return;
    }
    this.requestRestart();
  }

  /** 合成退出确认面板的收尾：确认「退出 dsh」才走原 dispose，否则仅关面板 */
  private finishExitConfirm(panel: QuestionPanelState): void {
    this.exitConfirmOpen = false;
    const answer = buildQuestionAnswers(panel);
    this.apply((s) => reduceState(s, { type: "question-close" }));
    const picked = answer.answers[0]?.selected[0];
    if (picked === EXIT_CONFIRM_RESTART_LABEL) {
      this.requestRestart();
      return;
    }
    if (picked !== "退出 dsh") {
      this.paint();
      return;
    }
    this.dispose();
  }

  /** 提交问答：整批 answer 交给 adapter（answerQuestion → resolve ask）并关闭面板 */
  private submitQuestion(): void {
    const panel = this.state.question;
    if (!panel) return;
    if (panel.id === EXIT_CONFIRM_PANEL_ID) {
      this.finishExitConfirm(panel);
      return;
    }
    if (panel.id === MEMORY_REVIEW_PANEL_ID) {
      // 审阅面板本地结算（不经宿主应答链；逐条调 candidates.*，reviewer 写死 user）。
      this.finishMemoryReview(panel);
      return;
    }
    const answer = buildQuestionAnswers(panel);
    this.apply((s) => reduceState(s, { type: "question-close" }));
    this.deps.adapter.answerQuestion(panel.id, answer);
    this.paint();
  }

  /** 取消问答：reject ask（不打断 turn），关闭面板 */
  private cancelQuestion(): void {
    const panel = this.state.question;
    if (!panel) return;
    if (panel.id === EXIT_CONFIRM_PANEL_ID) {
      this.exitConfirmOpen = false;
      this.apply((s) => reduceState(s, { type: "question-close" }));
      this.paint();
      return;
    }
    if (panel.id === MEMORY_REVIEW_PANEL_ID) {
      // 本地面板取消 = 只关闭（未答条目留在待审队列，重开即恢复）。
      this.apply((s) => reduceState(s, { type: "question-close" }));
      this.paint();
      return;
    }
    this.apply((s) => reduceState(s, { type: "question-close" }));
    this.deps.adapter.cancelQuestion(panel.id);
    this.paint();
  }

  /** 启动自检 kickoff 调度（BACKLOG TUI「启动后自动触发首轮工具调用」）：门控（开关 /
   *  模型 / 会话未解锁）已在 main.ts 判过，这里只管时机——新会话**同步发**（首帧已在上方
   *  paintNow 出帧）：`createNewSession()` 决议后的续跑是微任务，而 rule-engine 的会话注入在
   *  `session/created` 时只排入宏任务（见其 `inject.ts` 红线）→ 同步发送必先入 next-step 队列
   *  （BACKLOG「`[AUTO]` 注入时序」；勿在会话创建与 `app.start()` 之间引入 await，否则退化）；
   *  恢复会话先挂起，等 restoreStartupHistory 折叠落定后由 flushKickoffPending 发。 */
  private startBootstrapKickoff(): void {
    const text = this.deps.bootstrapKickoffText;
    if (typeof text !== "string" || text.trim() === "") return;
    if (typeof this.deps.adapter.sendBootstrapKickoff !== "function") return;
    if (this.deps.adapter.resumedAtLaunch === true) {
      this.kickoffPending = text;
      return;
    }
    this.submitBootstrapKickoff(text);
  }

  /** 启动历史折叠已落定（或不会发生）→ 补发挂起的 kickoff，随后补发挂起的启动期告警行
   *  （顺序固定：kickoff 先——它开新回合会清活动区，先补发告警会被清掉）；无挂起则无操作。 */
  private flushKickoffPending(): void {
    const text = this.kickoffPending;
    this.kickoffPending = null;
    if (text !== null) this.submitBootstrapKickoff(text);
    const logs = this.bootLogPending;
    this.bootLogPending = null;
    if (logs !== null) {
      for (const l of logs) this.notice(l.text, l.tone ?? "log");
    }
  }

  /** 发出启动自检消息：与用户提交同路径回显（状态置运行 + 回合开始 + 用户行），消息本体
   *  由 adapter 构造（正文 `[AUTO]` 开头，`source.kind:"tool-bootstrap"` 不进模式分类）。 */
  private submitBootstrapKickoff(text: string): void {
    if (this.disposed) return;
    const send = this.deps.adapter.sendBootstrapKickoff;
    if (typeof send !== "function") return;
    this.apply((s) =>
      reduceState(s, { type: "input-status", status: "running" }),
    );
    this.beginTurnIfNeeded(true);
    this.apply((s) => reduceState(s, { type: "user-line", text }));
    // 启动关键路径：这里是 App.start() 的同步调用链（非宏任务），宿主抛错不得冒出启动
    // （会经 main() 让插件 apply 失败）——捕获后退化为一条 warn notice。
    try {
      send.call(this.deps.adapter);
    } catch (err) {
      this.notice(
        `启动自检发送失败：${err instanceof Error ? err.message : String(err)}`,
        "warn",
      );
    }
  }

  /** 发送用户文本（状态置运行 + 本地回显 + adapter 分发）：普通提交、`<` steer 与 /init 共用。
   *  echoText 为缓冲回显文本（默认同发送文本）；/init 回显命令名、发送初始化指令。
   *  target=`next-step` = 官方 steer（BACKLOG TUI#36：投递到最近 step 边界，仍属当前回合）。 */
  private sendUserText(
    sendText: string,
    echoText: string = sendText,
    target?: "next-step",
  ): void {
    this.apply((s) =>
      reduceState(s, { type: "input-status", status: "running" }),
    );
    // 真实 DSH 不回显 user/message,由 app 在发送前本地追加用户行。
    // 回合开始时先画分隔线(上一轮内容 → 新回合内容)；用户输入开启 → 清空活动区
    this.beginTurnIfNeeded(true);
    this.apply((s) => reduceState(s, { type: "user-line", text: echoText }));
    // 双写：流水线用户节。回合刚开 → 预测新回合（step 0）；回合仍开（打断后立即
    // 重发）→ 归当前回合当前步，与旧路径同组
    if (this.sections !== null) {
      const scope = this.sections.lastScope;
      const sameTurn =
        this.turnOpen && scope.turn === (this.pipelineLastTurn ?? 1);
      this.deliverLocal({
        kind: "user",
        turn: sameTurn ? scope.turn : (this.pipelineLastTurn ?? 1),
        step: sameTurn ? scope.step : 0,
        text: echoText,
        // 回显行号 → 流水线用户行符号与 buffer 单源
        seq: lastUserLineSeq(this.state.buffer),
      });
    }
    this.deps.adapter.sendMessage(
      sendText,
      this.state.activeSessionId ?? undefined,
      target,
    );
  }

  /** /init：当前目录无 AGENTS.md 时注入初始化指令（模型阅读目录并生成）；
   *  已存在则提示并直接结束（不发送任何消息） */
  private runInit(): void {
    // BACKLOG TUI#45：状态栏 cwd 是显示用缩写（`~/…`，status.ts shortenHome），
    // 与 `$` shell 同口径走 resolveShellCwd（`~` 展开 + 目录存在校验，失败回落进程 cwd）
    const dir = resolveShellCwd(this.state.systemStatus.cwd) ?? process.cwd();
    if (existsSync(join(dir, "AGENTS.md"))) {
      this.notice("AGENTS.md 已存在，跳过初始化", "info");
      return;
    }
    this.sendUserText(INIT_PROMPT, "/init");
  }

  /** agent 是否正在跑（排队判据）：agent 状态权威 + 本地刚提交的过渡态 +
   *  P8「压缩上下文期间也算活跃」（否则压缩期间提交会绕过排队直接发送） */
  private agentBusy(): boolean {
    return (
      this.state.agentStatus !== "idle" ||
      this.state.inputStatus === "running" ||
      isCompacting(this.state)
    );
  }

  /**
   * 排队消息退回输入框（Esc / Alt+Enter 时用）：按提交顺序排在已有输入之前
   * （核心打断时会清空自己的 next-turn 队列，本机登记的先留底，避免静默丢输入）。
   */
  private restoreQueued(): boolean {
    if (this.state.queued.length === 0) return false;
    // TUI#43：队列项带类型（followup / steer）→ 退回输入框只取文本，按**提交顺序**拼接
    // （渲染时的 steer 优先排序不影响这里，避免打乱用户实际输入顺序）
    const text = this.state.queued.map((q) => q.text).join("\n");
    const cur = this.state.inputText;
    const next = cur === "" ? text : text + "\n" + cur;
    this.apply((s) =>
      reduceState(s, { type: "input", text: next, cursor: next.length }),
    );
    this.apply((s) => reduceState(s, { type: "queued-clear" }));
    return true;
  }

  private submit(interrupt = false): void {
    // 空输入且无排队：no-op（Alt+Enter 空输入也不打断，保持既有语义）
    if (this.state.inputText.trim() === "" && this.state.queued.length === 0)
      return;
    // Alt+Enter：先打断当前 agent，再发送（普通 Enter 走排队/直发分流）。
    // 已排队内容按时间顺序并入本次提交文本（restoreQueued 前置），避免
    // 「新文本先发、排队内容后发」的顺序颠倒
    if (interrupt) {
      this.restoreQueued();
      this.deps.adapter.interrupt();
    }
    const text = this.state.inputText.trim();
    if (!text) return;
    // 输入历史（BACKLOG TUI#34）：普通输入与 `/` 命令共用一份；空串/相邻重复不入栈。
    // 入栈即退出翻看态（游标归零、草稿清空，见 reduceInputHistory 的 push 分支）。
    this.apply((s) =>
      reduceState(s, { type: "input-history", action: "push" }),
    );
    const mode = this.state.inputMode;
    // slash 模式：自动补 "/" 前缀走既有路由（规则：文本中不需要再在开头加 /）
    const slashLine =
      mode === "slash" && !text.startsWith("/") ? "/" + text : text;
    if (slashLine.startsWith("/")) {
      this.handleSlash(slashLine);
      this.apply((s) => reduceState(s, { type: "input", text: "", cursor: 0 }));
      this.apply((s) => reduceState(s, { type: "input-mode", mode: "normal" }));
      return;
    }
    // steer 模式（BACKLOG TUI#36）：投递到宿主最近 step 边界（官方 agent.steer =
    // send(m,'next-step',true)；运行中下一 step 认领，空闲时立即起一轮）。语义上仍属**当前
    // 回合**，故与直发同路径（立即回显用户块、开回合分隔），**不登记排队块**
    // （排队语义 = 等下一回合）。宿主 agent 无 steer（旧宿主）→ 降级 followup 并明确提示
    if (mode === "steer") {
      // canSteer 缺省（mock/旧 adapter 未实现）视为「不确定」→ 仍按 steer 投递，
      // 由 adapter 侧按宿主结构面决定 steer/followup（dsh adapter 有 steer 才用）
      const canSteer = this.deps.adapter.canSteer?.() !== false;
      const target = canSteer ? "next-step" : undefined;
      if (this.agentBusy()) {
        // 本回合在跑 → 进排队块（TUI#43）：独立成行、steer 右缘竖线黄，等下一次 step 认领后
        // 由 `inbox-claim` 转入历史流；宿主无 steer 时按 followup 类型排队（等下一回合）
        this.apply((s) =>
          reduceState(s, {
            type: "queued-push",
            text,
            kind: canSteer ? "steer" : "followup",
          }),
        );
        this.deps.adapter.sendMessage(
          text,
          this.state.activeSessionId ?? undefined,
          target,
        );
      } else {
        // 空闲：没有可插队的 step（steer 会直接起一轮）→ 直达回显，不留排队闪影
        this.sendUserText(text, text, target);
      }
      // 降级提示放在发送**之后**：发送路径可能开回合（turn-begin 清活动区），先提示会被清掉
      if (!canSteer) {
        this.apply((s) =>
          reduceState(s, {
            type: "notice",
            text: "宿主不支持 steer，已按普通消息发送",
            tone: "warn",
          }),
        );
        this.deliverLocal({
          kind: "notice",
          text: "宿主不支持 steer，已按普通消息发送",
          tone: "warn",
        });
      }
      this.apply((s) => reduceState(s, { type: "input", text: "", cursor: 0 }));
      this.apply((s) => reduceState(s, { type: "input-mode", mode: "normal" }));
      return;
    }
    // shell 模式（BACKLOG TUI#37）：提交内容按**本地命令**执行（不经模型、不进会话与模型
    // 上下文、不占审批链）；命令回显与输出进活动区本地行。异步执行、不阻塞输入。
    if (mode === "shell") {
      void this.runLocalShell(text);
      this.apply((s) => reduceState(s, { type: "input", text: "", cursor: 0 }));
      this.apply((s) => reduceState(s, { type: "input-mode", mode: "normal" }));
      return;
    }
    // agent 运行中：发送路径**与官方一致**（立即 followup 交给核心 next-turn 队列，
    // 逐条、不合并），本机只登记显示——排队块钉在历史区右下角（灰竖线），核心
    // 开始新回合认领最早一条时该条转入历史流（见 beginTurnIfNeeded/queued-claim）。
    // Alt+Enter（interrupt）打断后已经空闲 → 直发（排队内容已并回输入框）
    if (!interrupt && this.agentBusy()) {
      this.apply((s) => reduceState(s, { type: "queued-push", text }));
      this.deps.adapter.sendMessage(
        text,
        this.state.activeSessionId ?? undefined,
      );
    } else {
      this.sendUserText(text);
    }
    this.apply((s) => reduceState(s, { type: "input", text: "", cursor: 0 }));
    // 任何提交后自动回退普通模式（提示符回 >）
    this.apply((s) => reduceState(s, { type: "input-mode", mode: "normal" }));
  }

  /**
   * `$` 模式本地命令执行（BACKLOG TUI#37）：
   *  1. 命令回显先行入活动区（用户即时看到「已提交了什么」，也是审计线索）；
   *  2. 异步执行——不阻塞输入与渲染；完成后追加 stdout/stderr 与退出摘要行；
   *  3. 结果**只进 buffer**（kind="shell"）：不经 adapter、不进会话事件流与模型上下文。
   * 执行前经 security-guard 复查一次（命中即不执行、回执进输出区；guard 不可用 fail-open，
   * 见 `shellGuard` 与 local-shell.ts 的 makeShellGuardChecker）。
   * 执行器已把 spawn 失败归一为结果（不抛）；disposed 后丢弃迟到结果。
   */
  private async runLocalShell(command: string): Promise<void> {
    const cwd = currentProjectCwd(this.state) ?? process.cwd();
    this.apply((s) =>
      reduceState(s, {
        type: "shell-lines",
        lines: [{ text: `$ ${command}`, tone: "info" }],
      }),
    );
    // 双写：命令回显行（流水线 shell 节）
    this.deliverLocal({ kind: "shell", text: `$ ${command}` });
    this.paint();
    // 执行前复查一次（BACKLOG「TUI `$` 模式执行面不经 guard」）：命中即**不执行**，回执
    // （含来源标注与规则 id）进输出区；guard 不可用 → 复查器内每种失效模式告警一次 + 留痕后
    // fail-open 照常执行。
    const check = this.shellGuard?.(command) ?? null;
    const receipt = check?.receipt ?? null;
    if (receipt !== null) {
      const blocked = shellGuardBlockedLines(command, receipt).slice(1);
      this.apply((s) =>
        reduceState(s, {
          type: "shell-lines",
          lines: blocked,
        }),
      );
      // 双写：guard 拦截回执
      this.deliverLocal({
        kind: "shell",
        text: blocked.map((l) => l.text).join("\n"),
      });
      this.paint();
      return;
    }
    // 复查被跳过（guard 未挂载 / 抛错）→ fail-open 照常执行，但输出区**留痕**（不静默；
    // 与 metric-loop / task-engine 的 guardSkipped 同口径）。未接线（checker=null）不留痕。
    if (check?.skipped === true) {
      this.apply((s) =>
        reduceState(s, {
          type: "shell-lines",
          lines: [SHELL_GUARD_SKIPPED_LINE],
        }),
      );
      // 双写：guard 跳过留痕
      this.deliverLocal({ kind: "shell", text: SHELL_GUARD_SKIPPED_LINE.text });
      this.paint();
    }
    const started = Date.now();
    const result = await this.shellRunner(command, { cwd });
    if (this.disposed) return;
    // 跳过 shellResultLines 的命令回显行（首行已在提交时入 buffer）
    const resultLines = shellResultLines(
      command,
      result,
      Date.now() - started,
    ).slice(1);
    this.apply((s) =>
      reduceState(s, {
        type: "shell-lines",
        lines: resultLines,
      }),
    );
    // 双写：本地 shell 回执进活动区（流水线 shell 节；命令回显行已先行交付）
    this.deliverLocal({
      kind: "shell",
      text: resultLines.map((l) => l.text).join("\n"),
    });
    this.paint();
  }

  /**
   * Slash 命令路由：
   *  - 渲染相关命令(/help /clearscreen /cls /quit)→ 本地小命令表
   *  - 其他 /name → adapter.runCommand → commands 注册表调用(官方机制)
   *  - 未命中注册表 → adapter 侧 notice 提示(fail-close，绝不经 sendMessage)
   */
  private handleSlash(line: string): void {
    const name = parseSlashCommand(line);
    if (!name) {
      this.apply((s) =>
        reduceState(s, {
          type: "notice",
          text: "无效命令: " + line,
          tone: "error",
        }),
      );
      this.deliverLocal({
        kind: "notice",
        text: "无效命令: " + line,
        tone: "error",
      });
      // 本地可检测的无效 slash 命令 → 失败色(红)
      this.apply((s) =>
        reduceState(s, { type: "input-status", status: "failure" }),
      );
      return;
    }
    // 已识别 slash 命令（本地成功或注册表 dispatch）→ 成功色(绿)
    this.apply((s) =>
      reduceState(s, { type: "input-status", status: "success" }),
    );
    switch (routeSlashCommand(name)) {
      case "help":
        this.apply((s) =>
          reduceState(s, {
            type: "notice",
            text: "",
            lines: this.helpLines(),
          }),
        );
        return;
      case "clearscreen":
        this.apply((s) => reduceState(s, { type: "clear-buffer" }));
        return;
      case "quit":
        // 走 App.dispose：释放 adapter 与当前活跃 handle（含 resume 后由 adapter
        // 持有的新 handle），再恢复终端退出
        this.dispose();
        return;
      case "restart":
        // /restart：与退出确认面板第三项同路径（写交接文件 → 退出码 75 → 收尾）
        this.handleRestartCommand();
        return;
      case "model":
        void this.handleModelCommand(line);
        return;
      case "provider":
      case "effort":
        // 直达别名：打开 /model 面板并把焦点列预置到 provider / effort
        void this.handleModelFocus(name, line);
        return;
      case "theme":
        this.handleThemeCommand(line);
        return;
      case "collapse":
        this.handleCollapseCommand(line);
        return;
      case "verbose":
        // BACKLOG #8：/verbose 改为活动区**输出内容**档位（think / tool / step）
        this.handleVerboseLevelCommand(line);
        return;
      case "symbol-unify":
        this.handleSymbolUnifyCommand(line);
        return;
      case "session":
        // 会话列表 + 切换：见 openHistory / resumeToSession；
        // 子命令 clean：打开面板并直达「清理当前项目空会话」二次确认
        if (line.slice("/session".length).trim().toLowerCase() === "clean") {
          void this.openHistoryClean();
        } else {
          void this.openHistory();
        }
        return;
      case "continue":
        // TUI#1：加载当前目录下最近退出的会话（复用 /session 的加载路径）
        void this.continueRecentSession();
        return;
      case "policy":
        this.handlePolicyCommand(line);
        return;
      case "permission":
        this.handlePermissionCommand(line);
        return;
      case "jobs":
        this.handleJobsCommand();
        return;
      case "init":
        this.runInit();
        return;
      case "stats":
        this.handleStatsCommand();
        return;
      case "rename":
        this.handleRenameCommand(line);
        return;
      case "skills":
        this.handleSkillsCommand(line);
        return;
      case "agents":
        // agents 无 filter：直接开面板并拉列表
        this.openListPanel({
          kind: "agents",
          label: "subagents",
          refresh: this.deps.adapter.refreshAgents,
          filter: "",
        });
        return;
      case "tools":
        this.handleToolsCommand(line);
        return;
      case "settings":
        this.handleSettingsCommand();
        return;
      case "new":
        this.startNewSession();
        return;
      case "fork":
        this.handleForkCommand();
        return;
      case "task":
        this.handleTaskCommand();
        return;
      case "guard":
        this.handleGuardCommand();
        return;
      case "memory":
        this.handleMemoryCommand(line);
        return;
      case "loop":
        this.handleLoopCommand();
        return;
      case "contract":
        this.handleContractCommand();
        return;
      case "workflows":
        this.handleWorkflowsCommand();
        return;
      case "council":
        this.handleCouncilCommand(line);
        return;
      case "search":
        this.handleSearchCommand(line);
        return;
      case "copy":
        this.copyLastReply();
        return;
      case "registry":
        // 非本地命令 → 注册表调用
        this.deps.adapter.runCommand(
          line,
          this.state.activeSessionId ?? undefined,
        );
    }
  }

  /** /model 命令：无参进入交互选择；带参切换当前会话模型（保留当前 reasoningEffort） */
  private async handleModelCommand(line: string): Promise<void> {
    const spec = modelCommandSpec(line);
    try {
      if (!spec) {
        const catalog = await this.deps.adapter.modelCatalog();
        this.openModelPicker(catalog);
        return;
      }
      const catalog = await this.deps.adapter.modelCatalog();
      const resolved = resolveModelSpec(catalog, spec);
      if ("error" in resolved) {
        this.notice(resolved.error, "error");
        return;
      }
      await this.applyModelSelection(resolved.selection);
    } catch (err) {
      this.notice("model command failed: " + String(err), "error");
    }
  }

  /** /provider | /effort | /thinking：无参打开 /model 面板并预置焦点列
   *  （0=provider、2=effort），不做隐式切换；带参提示 usage，避免把
   *  `/effort high` 误当模型名去切模型。 */
  private async handleModelFocus(name: string, line: string): Promise<void> {
    if (slashCommandArg(line) !== "") {
      this.notice(`usage: /${name} (no argument; opens the picker)`, "info");
      return;
    }
    try {
      const catalog = await this.deps.adapter.modelCatalog();
      this.openModelPicker(catalog, name === "provider" ? 0 : 2);
    } catch (err) {
      this.notice("model command failed: " + String(err), "error");
    }
  }

  /** /theme 命令：无参/toggle 在 dark|light 间切换；带参显式设置；非法参数提示 usage */
  private handleThemeCommand(line: string): void {
    const cur = this.state.themeId;
    const decision = themeCommandDecision(line, cur);
    if (decision.kind === "usage") {
      this.notice("usage: /theme [light|dark|toggle]", "info");
      return;
    }
    const next = decision.theme;
    if (next !== cur) {
      this.apply((s) => reduceState(s, { type: "set-theme", themeId: next }));
      this.deps.renderer.setTheme(next);
      this.paint();
    }
    this.notice(
      `theme: ${next} (${this.deps.renderer.getTheme?.(next)?.name ?? next})`,
      "success",
    );
  }

  /**
   * /collapse on|off：活动区详略切换（SPEC §6.8 两态）。
   * on = 紧凑（状态 2：每条目 1 行 + 行尾省略号）；off = 每条目完整折行（状态 1，缺省）。
   * 无参数/非法参数 → 只提示用法与当前状态，不切换。
   */
  private handleCollapseCommand(line: string): void {
    const arg = line.slice("/collapse".length).trim().toLowerCase();
    const curCompact = this.state.activityCompact; // true = 紧凑
    let nextCompact: boolean;
    if (arg === "on" || arg === "true") nextCompact = true;
    else if (arg === "off" || arg === "false") nextCompact = false;
    else {
      this.notice(
        `usage: /collapse on|off（当前：${curCompact ? "on(紧凑)" : "off(完整折行)"}）`,
        "info",
      );
      return;
    }
    if (nextCompact !== curCompact) {
      this.apply((s) =>
        reduceState(s, { type: "activity-compact", on: nextCompact }),
      );
      this.paint();
      this.scheduleSessionStateSave();
    }
    this.notice(
      `活动区：${nextCompact ? "collapse on（紧凑：每条目 1 行 + 省略号）" : "collapse off（完整折行）"}`,
      "success",
    );
  }

  /**
   * `/verbose think|tool|step`：活动区**输出内容**档位（BACKLOG #8；只作用于活动区）。
   * think = 思考 + 正文 + 工具调用（全量，缺省）；tool = 正文 + 工具调用（去思考）；
   * step = 正文 + 工具调用的**调用行**（去结果行 / 辅助行；step 头与 notice 保留）。
   * 无参数 / 非法参数 → 只提示用法与当前档位，不切换（沿用既有口径）。
   */
  private handleVerboseLevelCommand(line: string): void {
    const arg = line.slice("/verbose".length).trim().toLowerCase();
    const cur = this.state.activityVerbose;
    if (arg !== "think" && arg !== "tool" && arg !== "step") {
      this.notice(`usage: /verbose think|tool|step（当前：${cur}）`, "info");
      return;
    }
    const next: ActivityLevel = arg;
    if (next !== cur) {
      this.apply((s) =>
        reduceState(s, { type: "activity-verbose", level: next }),
      );
      this.paint();
      this.scheduleSessionStateSave();
    }
    this.notice(`verbose → ${next}`, "success");
  }

  /** `/symbol-unify on|off`：模型输出符号统一开关（变体替换为推荐 + 未推荐提醒）。 */
  private handleSymbolUnifyCommand(line: string): void {
    const arg = line.slice("/symbol-unify".length).trim().toLowerCase();
    const cur = this.state.symbolUnify;
    let next: boolean;
    if (arg === "on" || arg === "true") next = true;
    else if (arg === "off" || arg === "false") next = false;
    else {
      this.notice(
        `usage: /symbol-unify on|off（当前：${cur ? "on(替换+提醒)" : "off(原样)"}）`,
        "info",
      );
      return;
    }
    if (next !== cur) {
      this.apply((s) => reduceState(s, { type: "symbol-unify", on: next }));
      this.paint();
      this.scheduleSessionStateSave();
    }
    this.notice(
      `模型输出符号统一：${next ? "on（变体替换为推荐符号并提醒）" : "off（原样，不替换不提醒）"}`,
      "success",
    );
  }

  /** 单条会话不可删除原因（可删返回 undefined）；标记/单删共用的护栏文案 */
  private deleteBlockReason(rec: SessionInfo): string | undefined {
    if (rec.current === true) return "当前活跃会话不可删除";
    if (rec.live) return "live 会话不可删除（仅可删除已持久化的非活跃会话）";
    if (rec.persisted !== true) return "该会话未持久化，没有可删除的文件";
    return undefined;
  }

  /** 面板 d/Delete：无标记 → 单条删除；有标记 → 批量删除（判据在 reducer 逐个复核） */
  private confirmDeleteRecord(): void {
    const h = this.state.history;
    if (!h) return;
    if (!this.deps.adapter.deleteSession) {
      this.historyNotice("会话删除不可用（宿主未挂载 sessionQuery）", "warn");
      return;
    }
    if ((h.marked?.length ?? 0) > 0) {
      this.apply((st) => reduceState(st, { type: "history-confirm-delete" }));
      this.paint();
      return;
    }
    const rec = historyVisibleRecords(this.state)[h.index];
    if (!rec) return;
    const reason = this.deleteBlockReason(rec);
    if (reason) {
      this.historyNotice(reason, "warn");
      return;
    }
    this.apply((st) => reduceState(st, { type: "history-confirm-delete" }));
    this.paint();
  }

  /** Space：切换高亮行标记（不可删项提示原因；标记由 reducer 置 + 高亮下移一行） */
  private toggleMarkRecord(): void {
    const h = this.state.history;
    const rec = h ? historyVisibleRecords(this.state)[h.index] : undefined;
    if (!h || !rec) return;
    const reason = this.deleteBlockReason(rec);
    if (reason) {
      this.historyNotice(reason, "warn");
      return;
    }
    this.apply((st) => reduceState(st, { type: "history-mark-toggle" }));
    this.paint();
  }

  /** a：全选当前列表范围的可删项（当前活跃 / live / 未持久化天然排除） */
  private markAllRecords(): void {
    const h = this.state.history;
    if (!h) return;
    if (markableSessionIds(this.state).length === 0) {
      this.historyNotice(
        this.state.history?.scope === "all"
          ? "全部目录没有可标记的会话"
          : "当前项目没有可标记的会话",
        "info",
      );
      return;
    }
    this.apply((st) => reduceState(st, { type: "history-mark-all" }));
    this.paint();
  }

  /** c：清空批量删除标记 */
  private clearMarkedRecords(): void {
    const h = this.state.history;
    if (!h) return;
    if ((h.marked?.length ?? 0) === 0) {
      this.historyNotice("当前没有批量删除标记", "info");
      return;
    }
    this.apply((st) => reduceState(st, { type: "history-mark-clear" }));
    this.paint();
  }

  /** 面板 x：进入清理空会话二次确认（范围=当前列表范围；无可清理项时以 notice 说明） */
  private confirmClean(): void {
    if (!this.deps.adapter.deleteSession) {
      this.historyNotice("会话删除不可用（宿主未挂载 sessionQuery）", "warn");
      return;
    }
    const ids = cleanableSessionIds(this.state);
    if (ids.length === 0) {
      this.historyNotice(
        this.state.history?.scope === "all"
          ? "全部目录没有可清理的空会话"
          : "当前项目没有可清理的空会话",
        "info",
      );
      return;
    }
    this.apply((st) => reduceState(st, { type: "history-confirm-clean" }));
    this.paint();
  }

  /** 确认后执行删除/清理（y/Enter）：调 adapter.deleteSession，成功后重拉列表并提示 */
  private async runPendingHistoryOp(): Promise<void> {
    const h = this.state.history;
    const adapter = this.deps.adapter;
    const del = adapter.deleteSession;
    if (!h || !del) return;
    if (h.phase === "confirm-delete") {
      // 目标集：单条（pendingDelete）或批量（pendingDeleteIds，优先级高）
      const ids =
        h.pendingDeleteIds ?? (h.pendingDelete ? [h.pendingDelete] : []);
      if (ids.length === 0) return;
      const isBatch = h.pendingDeleteIds !== undefined;
      // 先取标题再删记录：historyRecordLabel 依赖面板记录，删后只剩短 id
      const labels = ids.map((id) => this.historyRecordLabel(id));
      this.apply((st) => reduceState(st, { type: "history-delete" }));
      this.paint();
      const removed: string[] = [];
      let failed = 0;
      let reason: string | undefined;
      for (const id of ids) {
        try {
          // SAFETY: adapter 方法未约定自带绑定（实现可为原型方法），
          // 按接收者调用保留 this（同 setApprovalPolicy 的 .call(adapter) 约定）
          const res = await del.call(adapter, id);
          if (res.ok) removed.push(id);
          else {
            failed += 1;
            reason ??= res.reason;
          }
        } catch (err) {
          failed += 1;
          reason ??= String(err);
        }
      }
      this.apply((st) =>
        reduceState(st, { type: "history-delete-done", ids: removed }),
      );
      this.paint();
      if (removed.length === 0) {
        this.historyNotice(`删除失败：${reason ?? "未知原因"}`, "error");
        return;
      }
      if (isBatch) {
        this.historyNotice(
          failed > 0
            ? `已删除 ${removed.length} 个会话（${failed} 个失败）`
            : `已删除 ${removed.length} 个会话`,
          failed > 0 ? "warn" : "success",
        );
      } else {
        this.historyNotice(`已删除会话「${labels[0] ?? ""}」`, "success");
      }
      await this.refreshHistoryList();
      return;
    }
    if (h.phase === "confirm-clean") {
      const ids = h.pendingClean ?? [];
      if (ids.length === 0) return;
      this.apply((st) => reduceState(st, { type: "history-clean" }));
      this.paint();
      const removed: string[] = [];
      let failed = 0;
      // 串行删除：会话数通常个位数，避免并发 IO 与错误归属混乱
      for (const id of ids) {
        try {
          const res = await del.call(adapter, id);
          if (res.ok) removed.push(id);
          else failed += 1;
        } catch {
          failed += 1;
        }
      }
      this.apply((st) =>
        reduceState(st, { type: "history-clean-done", ids: removed }),
      );
      this.paint();
      if (removed.length === 0) {
        this.historyNotice("清理失败：没有会话被删除", "error");
        return;
      }
      this.historyNotice(
        failed > 0
          ? `已清理 ${removed.length} 个空会话（${failed} 个失败）`
          : `已清理 ${removed.length} 个空会话`,
        failed > 0 ? "warn" : "success",
      );
      // 批量清理只重拉一次（无论删了几条）
      await this.refreshHistoryList();
    }
  }

  /** 删除/清理成功后重拉会话列表刷新面板（保留高亮位置并 clamp；失败保留本地结果） */
  private async refreshHistoryList(): Promise<void> {
    const adapter = this.deps.adapter;
    const list = adapter.listSessions;
    if (!list) return;
    try {
      const records = await list.call(adapter);
      this.apply((st) => reduceState(st, { type: "history-refresh", records }));
      this.paint();
    } catch {
      // 拉取失败不报错：删除已生效、本地列表已收敛，保持面板可用
    }
  }

  /** /session clean：打开面板并直接进入空会话清理确认 */
  private async openHistoryClean(): Promise<void> {
    await this.openHistory();
    if (this.state.history?.phase !== "list") return;
    this.confirmClean();
  }

  /** 面板内提示 + 缓冲 notice：面板占满活动区时 notice 不可见（notice 归活动区），
   *  故删除/清理结果与护栏文案需在面板内呈现；notice 仍留痕于对话区（关面板后可见） */
  private historyNotice(text: string, tone?: NoticeTone): void {
    this.apply((st) => reduceState(st, { type: "history-result", text }));
    this.notice(text, tone);
  }

  /** 会话展示名：列表标题优先，缺失用短 id（notice 文案用） */
  private historyRecordLabel(id: string): string {
    const rec = this.state.history?.records.find((r) => r.id === id);
    const title = rec?.title?.trim();
    return title ? title : id.slice(0, 8);
  }

  /** /continue（TUI#1/#23）：恢复当前目录下**最新的会话**——候选含当前会话
   *  （仅当它已有用户消息）；若当前会话就是最新 → 提示不切换。刚起的新会话
   *  仍回退到最近退出的会话；选择规则见 `pickContinueTarget`，加载走 /session 的
   *  `resumeToSession`。 */
  private async continueRecentSession(): Promise<void> {
    const list = this.deps.adapter.listSessions;
    if (!list || !this.deps.adapter.resumeTo) {
      this.notice("历史会话服务不可用（宿主未挂载 sessionQuery）", "warn");
      return;
    }
    let target: ContinueTarget | undefined;
    try {
      const records = await list.call(this.deps.adapter);
      // cwd 口径与 /session project 范围一致：活跃会话记录优先（创建时 meta.cwd
      // 可能与进程 cwd 不同），回退状态区 cwd、再回退进程 cwd
      const cwd =
        records.find((r) => r.current === true)?.cwd ??
        currentProjectCwd(this.state) ??
        process.cwd();
      target = pickContinueTarget(records, cwd);
    } catch (err) {
      this.notice("会话列表读取失败：" + String(err), "warn");
      return;
    }
    if (!target) {
      this.notice("当前目录下没有可恢复的会话", "info");
      return;
    }
    if (target.kind === "current") {
      this.notice("当前会话已是最新，无需恢复", "info");
      return;
    }
    // 复用 /session 切换路径（resuming 态一闪而过；成功后 history-resume-ok 自动关面板）
    this.apply((s) => reduceState(s, { type: "history-open" }));
    await this.resumeToSession(target.record.id);
  }

  /** /session：打开历史会话面板（宿主未挂载会话查询服务时提示不可用） */
  private async openHistory(): Promise<void> {
    const list = this.deps.adapter.listSessions;
    if (!list) {
      this.notice("历史会话服务不可用（宿主未挂载 sessionQuery）", "warn");
      return;
    }
    this.apply((s) => reduceState(s, { type: "history-open" }));
    this.paint();
    try {
      const records = await list.call(this.deps.adapter);
      this.apply((s) => reduceState(s, { type: "history-list", records }));
    } catch (err) {
      this.apply((s) =>
        reduceState(s, { type: "history-list-error", error: String(err) }),
      );
    }
    this.paint();
  }

  /** 历史面板 list→view：读取高亮会话的只读表面（损坏会话进入 error 阶段） */
  private async openHistoryView(): Promise<void> {
    const read = this.deps.adapter.readSessionSurface;
    if (!read) return;
    this.apply((s) => reduceState(s, { type: "history-open-view" }));
    this.paint();
    const panel = this.state.history;
    const rec = panel
      ? historyVisibleRecords(this.state)[panel.index]
      : undefined;
    if (!panel || !rec) return;
    try {
      const view = await read.call(this.deps.adapter, rec.id);
      this.apply((s) =>
        reduceState(s, {
          type: "history-view",
          id: rec.id,
          messages: view.messages,
        }),
      );
    } catch (err) {
      this.apply((s) =>
        reduceState(s, { type: "history-view-error", error: String(err) }),
      );
    }
    this.paint();
  }

  /** 切换到持久化会话：agents.resume → 读 surface 展示上下文 → 生成标题并关面板 */
  private async resumeToSession(id: string): Promise<void> {
    void this.openHistoryView; // 保留只读查看方法引用（list Enter 现走切换，需要时可恢复引出）
    const resumeTo = this.deps.adapter.resumeTo;
    if (!resumeTo) {
      // 无持久化能力：面板已上移到活动区（占满该区），关面板让 notice 可见
      this.apply((s) => reduceState(s, { type: "history-close" }));
      this.notice("会话切换不可用（宿主未配置会话持久化）", "warn");
      return;
    }
    // 切走前先把当前会话的 TUI 侧状态落盘（快照按会话隔离）
    this.flushSessionStateSave();
    this.apply((s) => reduceState(s, { type: "history-resume", id }));
    this.paint();
    try {
      await resumeTo.call(this.deps.adapter, id);
      const read = this.deps.adapter.readSessionSurface;
      let view: SessionSurfaceView;
      if (read) {
        // 切换后刚 resume 的会话在内存 store 可能尚未完全入列：读空则轻量轮询
        view = await read.call(this.deps.adapter, id);
        for (
          let i = 0;
          i < 4 && view.messages.length === 0 && !this.disposed;
          i++
        ) {
          await new Promise((r) => setTimeout(r, 250));
          if (this.disposed) return;
          view = await read.call(this.deps.adapter, id);
        }
      } else {
        view = { sessionId: id, messages: [] as HistoryMessage[] };
      }
      if (this.disposed) return;
      // stale guard：面板已关闭/目标已换 → 丢弃结果
      const cur = this.state.history;
      if (!cur || cur.phase !== "resuming" || cur.pendingResume !== id) return;
      const firstUser = view.messages.find((m) => m.role === "user");
      // 标题：官方 session/title 事件优先（dsh-session-title 落盘日志），
      // 缺失时本地兜底（surface 首条用户消息前 30 字符 / （新会话））
      const official = this.deps.adapter.sessionTitle
        ? await this.deps.adapter.sessionTitle(id).catch(() => undefined)
        : undefined;
      const title = official ?? deriveTitle(firstUser?.text);
      const rows = surfaceToBuffer(view.messages);
      this.apply((s) =>
        reduceState(s, {
          type: "history-resume-ok",
          id,
          title,
          rows,
        }),
      );
      // 六步流水线：切换后的历史行重放成节缓存。此前缺失 → 下一次交付按「会话已换」
      // 重建空节缓存，恢复出的历史在回合区不见（仅 /session 切换路径，启动恢复有重放）
      this.replaySectionsFromRows(rows);
      this.notice(`已切换到会话「${title}」`, "success");
      // 排队块属于切换前会话（核心队列里那条仍在原会话）：显示登记清空
      this.apply((s) => reduceState(s, { type: "queued-clear" }));
      // 新会话 Mode 初始值（log-only 事件不随 resume 回放，主动折叠一次）
      this.restoreSessionState();
    } catch (err) {
      if (this.disposed) return;
      this.apply((s) =>
        reduceState(s, {
          type: "history-resume-error",
          id,
          error: String(err),
        }),
      );
    }
    this.paint();
  }

  /** /copy：最后一条模型回复经 OSC52 写入系统剪贴板（ANSI 已剥离，纯文本） */
  private copyLastReply(): void {
    const text = lastAssistantText(this.state.buffer);
    if (!text) {
      this.notice("没有可复制的模型回复", "warn");
      return;
    }
    process.stdout.write(buildOsc52(text));
    this.notice("已复制最后一条回复到剪贴板", "success");
  }

  /** 无参 /model：进入交互选择模式（当前模型行始终显示，不在候选目录中也补行）；
   *  phase 为焦点列（/model 缺省 model 列；/provider、/effort 别名显式传入） */
  private openModelPicker(catalog: ModelCatalog, phase: 0 | 1 | 2 = 1): void {
    const init = buildPickerInit(catalog);
    if (!init.ok) {
      this.notice(
        "no available models (llm service missing or no adapter registered)",
        "warn",
      );
      return;
    }
    this.apply((s) =>
      reduceState(s, {
        type: "picker-open",
        picker: { ...init.picker, phase },
      }),
    );
    this.paint();
    void this.reloadPickerEfforts();
  }

  /** 按选中（星号）model 异步加载思考等级，落定后再下发（面板可能已关闭/换选） */
  private async reloadPickerEfforts(): Promise<void> {
    const picker = this.state.picker;
    if (!picker) return;
    // 思考等级列表跟随选中（星号）模型，不随 > 焦点变化；未选中回退焦点行
    const model = picker.selectedModel ?? picker.models[picker.modelIndex];
    const provider =
      picker.selectedProvider ?? picker.providers[picker.providerIndex];
    if (!model) return;
    try {
      const meta = await this.deps.adapter.modelReasoning?.(
        provider ?? "",
        model,
      );
      if (this.disposed) return;
      const cur = this.state.picker;
      if (!cur) return;
      const prevModel = cur.selectedModel ?? cur.models[cur.modelIndex];
      const prevProvider =
        cur.selectedProvider ?? cur.providers[cur.providerIndex];
      if (prevModel !== model || prevProvider !== provider) {
        return; // 已切换选中模型/provider 或面板关闭，丢弃旧结果
      }
      // 当前生效模型自带等级时，预设为列表中同一等级；未显式选择时按 provider
      // 默认等级（defaultEffort）预设，保证面板高亮与实际生效 effort 一致
      const expectedIndex = pickerEffortIndex(
        cur,
        model,
        provider,
        meta?.efforts,
        meta?.defaultEffort,
      );
      this.apply((s) =>
        reduceState(s, {
          type: "picker-efforts",
          efforts: meta?.efforts ?? [],
          effortIndex: expectedIndex,
        }),
      );
      this.paint();
    } catch {
      // 加载失败保持空列表（面板显示"unsupported"）
    }
  }

  /** 选择面板确认：应用各列选中值（星号所指，回退焦点/当前）后退出 */
  private async confirmModelPicker(): Promise<void> {
    const picker = this.state.picker;
    if (!picker) return;
    const selection = resolvePickerSelection(picker);
    this.apply((s) => reduceState(s, { type: "picker-close" }));
    if (!selection) return;
    try {
      await this.applyModelSelection(selection);
    } catch (err) {
      this.notice("model command failed: " + String(err), "error");
    }
  }

  /** 切换当前会话模型（只改会话内引用，不写宿主设置）；/model 带参与交互选择共用 */
  private async applyModelSelection(selection: ModelSelection): Promise<void> {
    const catalog = await this.deps.adapter.modelCatalog();
    const plan = planModelSwitch(selection, catalog.current);
    if (plan.same) {
      const label = modelLabel(selection);
      this.notice(`already on current model ${label}`, "info");
      return;
    }
    const saved = await this.deps.adapter.setSessionModel(plan.selection);
    const label = modelLabel(saved);
    const thinking = await this.resolveThinking(
      saved.provider,
      saved.model,
      saved.reasoningEffort,
    );
    if (this.disposed) return;
    this.apply((s) =>
      reduceState(s, {
        type: "status",
        status: { model: label, modelThinking: thinking },
      }),
    );
    // 记入会话状态（modelBySession 同时是快照的模型来源；切回本会话时按它恢复）
    this.apply((s) =>
      reduceState(s, {
        type: "model-selection",
        sessionId:
          this.state.activeSessionId ?? this.deps.adapter.sessionId ?? "",
        provider: saved.provider,
        model: saved.model,
        ...(saved.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: saved.reasoningEffort }),
      }),
    );
    this.scheduleSessionStateSave();
    this.notice(`current model -> ${label}`, "success");
  }

  /**
   * /policy：审批策略两态切换（ask/never）。
   * 无参 → 取当前已知策略（policyBySession 事件回读）切换；未知按宿主默认 ask 为基准。
   * `/policy ask|never` → 显式设置。宿主未挂载 ctx.approval / adapter 缺失 → notice 不可用。
   */
  private handlePolicyCommand(line: string): void {
    const arg = line.slice("/policy".length).trim().toLowerCase();
    const applySet = (policy: "ask" | "never"): void => {
      const adapter = this.deps.adapter;
      const setPolicy = adapter.setApprovalPolicy;
      if (!setPolicy) {
        this.notice("审批策略服务不可用", "warn");
        return;
      }
      // SAFETY: adapter 方法体内依赖 this（approve/interrupt 等同构），必须接收者
      // 绑定调用——setPolicy.call(adapter) 保留实例作 this，避免丢绑定恒 rejected
      void setPolicy
        .call(adapter, policy)
        .then(() => {
          this.notice(
            policy === "ask"
              ? "审批策略：ask（每次工具调用询问）"
              : "审批策略：never（工具调用自动放行）",
            "success",
          );
        })
        .catch(() => {
          this.notice("审批策略服务不可用", "warn");
        });
    };
    if (arg === "ask" || arg === "never") {
      applySet(arg);
      return;
    }
    if (arg !== "") {
      this.notice("用法：/policy [ask|never]", "info");
      return;
    }
    // 无参 → 打开状态选项面板（空格预选、Enter 提交并关闭）；当前策略来自事件回读
    const sid = this.state.activeSessionId;
    const current = sid ? this.state.policyBySession[sid] : undefined;
    this.openStatusPanel({
      kind: "policy",
      title: "/policy 审批策略",
      // 展示名沿用旧 Mode 块口径（ask/auto；never 提交值不变，展示用 auto）
      options: [
        { id: "ask", label: "ask", desc: "（每次工具调用询问）" },
        { id: "never", label: "auto", desc: "（工具调用自动放行）" },
      ],
      index: 0,
      selected: current ?? null,
    });
  }

  /**
   * /permission：权限预设（sandbox mode + 审批策略捆绑）。
   * 无参 → 从 ctx.permissionPresets 读当前预设 + 可用列表（含描述）提示；
   * 带参 <name> → 转发宿主 /permission（宿主校验预设名 + approval.setPolicy 写路径）。
   * 宿主未挂载 ctx.permissionPresets → notice 不可用（fail-safe，不崩溃）。
   */
  private handlePermissionCommand(line: string): void {
    const arg = line.slice("/permission".length).trim();
    if (arg !== "") {
      this.deps.adapter.runCommand(
        "/permission " + arg,
        this.state.activeSessionId ?? undefined,
      );
      return;
    }
    const cat = this.deps.adapter.permissionCatalog;
    if (!cat) {
      this.notice("权限预设服务不可用", "warn");
      return;
    }
    void cat()
      .then((info) => {
        if (this.disposed || !info) {
          if (!info) this.notice("权限预设服务不可用", "warn");
          return;
        }
        // 同步目录进 state（P7 移除状态列 Mode 块后无渲染消费方，保留槽位）
        this.apply((s) =>
          reduceState(s, { type: "permission-catalog", names: info.names }),
        );
        this.paint();
        // 打开状态选项面板：选项 = 可用预设（空格预选、Enter 提交转发宿主）
        this.openStatusPanel({
          kind: "permission",
          title: "/permission 权限预设",
          options: info.entries.map((e) => ({
            id: e.name,
            label: e.name,
            ...(e.description ? { desc: e.description } : {}),
          })),
          index: 0,
          selected: info.current === "" ? null : info.current,
        });
      })
      .catch(() => {
        this.notice("权限预设服务不可用", "warn");
      });
  }

  /**
   * /policy：审批策略 ask / never。
   */

  /** 打开通用状态选项面板（/policy /permission 无参路径） */
  private openStatusPanel(panel: StatusPanelState): void {
    if (this.disposed) return;
    this.apply((s) => reduceState(s, { type: "status-panel-open", panel }));
    this.paint();
  }

  /** 提交状态面板：取预选（无预选回退焦点行）→ 按命令写路径应用 → 关闭面板 */
  private async commitStatusPanel(): Promise<void> {
    const panel = this.state.statusPanel;
    if (!panel) return;
    const id = panel.selected ?? panel.options[panel.index]?.id ?? null;
    // 先关面板再应用（“提交修改后直接关闭”）
    this.apply((s) => reduceState(s, { type: "status-panel-close" }));
    this.paint();
    if (!id) return;
    const adapter = this.deps.adapter;
    if (panel.kind === "policy") {
      const setPolicy = adapter.setApprovalPolicy;
      if (!setPolicy) {
        this.notice("审批策略服务不可用", "warn");
        return;
      }
      // SAFETY: 接收者绑定调用（见 handlePolicyCommand 注释）
      try {
        await setPolicy.call(adapter, id as "ask" | "never");
        this.notice(
          id === "ask"
            ? "审批策略：ask（每次工具调用询问）"
            : "审批策略：never（工具调用自动放行）",
          "success",
        );
      } catch {
        this.notice("审批策略服务不可用", "warn");
      }
      return;
    }
    if (panel.kind === "permission") {
      // 权限预设：转发宿主 /permission（宿主校验预设名 + 写路径）
      adapter.runCommand(
        "/permission " + id,
        this.state.activeSessionId ?? undefined,
      );
      return;
    }
  }

  /** /stats（别名 /usage、`/context`）：token 用量**双口径**——「最近一次调用」（`state.usage`，
   *  状态栏 ctx 段同源）与「本会话累计」（`state.usageTotals`，逐次 usage 事件求和、会话切换清零）。
   *  contextWindow 缺失或为 0 → 只显绝对量（不除零）。 */
  private handleStatsCommand(): void {
    const usage = this.state.usage;
    const totals = this.state.usageTotals;
    const totalsLine = `本会话累计：输入 ${totals.input} · 输出 ${totals.output} · 缓存读 ${totals.cacheRead}`;
    // usage 缺失（新会话 / 刚切换会话）：最近一次调用不可知 → `—` / `n/a` 占位，
    // 双口径恒四行（BACKLOG TUI#12：不再回落「暂无数据」单行提示）
    if (!usage) {
      this.notice(
        ["最近一次调用：—", totalsLine, "上下文：—", "缓存命中率：n/a"].join(
          "\n",
        ),
        "info",
      );
      return;
    }
    const { input, output, cacheRead, contextWindow } = usage;
    // 上下文口径与状态栏 ctx 段一致：input + cacheRead（均为最近一次调用）
    const context = input + cacheRead;
    const lines = [
      `最近一次调用：输入 ${input} · 输出 ${output} · 缓存读 ${cacheRead}`,
      totalsLine,
      contextWindow !== undefined && contextWindow > 0
        ? `上下文：${context} / ${contextWindow}（${Math.round((context / contextWindow) * 100)}%）`
        : `上下文：${context}`,
      `缓存命中率：${context > 0 ? `${Math.round((cacheRead / context) * 100)}%` : "n/a"}（最近一次）`,
    ];
    this.notice(lines.join("\n"), "info");
  }

  /** /rename <title>：经 adapter 调宿主 sessionTitle.rename(live Session, title)。
   *  非法标题本地拒绝（不发服务调用）；服务缺失/失败 → warn；
   *  标题栏由既有 session/title 事件链路刷新，不手工改 state。 */
  private handleRenameCommand(line: string): void {
    const decision = renameCommandDecision(line);
    if (decision.kind === "usage") {
      this.notice("用法：/rename <标题>", "info");
      return;
    }
    if (decision.kind === "invalid") {
      this.notice(decision.reason, "error");
      return;
    }
    const adapter = this.deps.adapter;
    const rename = adapter.renameSession;
    if (!rename) {
      this.notice("sessionTitle 服务不可用", "warn");
      return;
    }
    void rename.call(adapter, decision.title).then(
      () => this.notice(`已重命名为「${decision.title}」`, "success"),
      () => this.notice("sessionTitle 服务不可用", "warn"),
    );
  }

  /** /skills [filter]：共享列表面板（kind=skills），filter 在归一化阶段过滤 */
  private handleSkillsCommand(line: string): void {
    this.openListPanel({
      kind: "skills",
      label: "skills",
      refresh: this.deps.adapter.refreshSkills,
      filter: slashCommandArg(line),
    });
  }

  /** /tools [filter]：共享列表面板（kind=tools），filter 在归一化阶段过滤 */
  private handleToolsCommand(line: string): void {
    this.openListPanel({
      kind: "tools",
      label: "tools",
      refresh: this.deps.adapter.refreshTools,
      filter: slashCommandArg(line),
    });
  }

  /** /settings：只读展示全部设置（settings.describe() → `ns：value` 多行，secret 脱敏）；
   *  服务缺失/读取失败 → warn；本命令不做写回（真实配置 + 乐观锁另立规格）。 */
  private handleSettingsCommand(): void {
    const adapter = this.deps.adapter;
    const read = adapter.readSettings;
    if (!read) {
      this.notice("settings 服务不可用", "warn");
      return;
    }
    void read.call(adapter).then(
      (text) =>
        this.notice(text && text.trim() !== "" ? text : "（无设置项）", "info"),
      () => this.notice("settings 服务不可用", "warn"),
    );
  }

  /** `/new`：不重启进程新建会话——释放当前 agent handle → `agents.create` 全新会话
   *  （同一 setup / agentOptions / meta）→ 切到新会话（缓冲与滚动按空会话重置，
   *  模型/Mode/开关由 restoreSessionState 回默认值）。旧会话已持久化在磁盘上，
   *  可经 `/session` 列表切回。宿主未暴露 agents.create → warn 不动作。 */
  private startNewSession(): void {
    const adapter = this.deps.adapter;
    const create = adapter.newSession;
    if (!create) {
      this.notice("新建会话不可用（宿主未配置会话创建）", "warn");
      return;
    }
    // 切走前先把当前会话的 TUI 侧状态落盘（快照按会话隔离）
    this.flushSessionStateSave();
    void create.call(adapter).then(
      ({ id }) => {
        if (this.disposed) return;
        this.turnOpen = false; // 新会话没有在跑的回合（旧 handle 已释放）
        this.apply((s) =>
          reduceState(s, { type: "session-switch", id, title: "" }),
        );
        this.apply((s) => reduceState(s, { type: "queued-clear" }));
        this.restoreSessionState();
        this.notice(`已新建会话 ${id}（原会话可用 /session 切回）`, "success");
        this.paint();
        // 启动自检补发（BACKLOG TUI#57）：与启动路径同款时序——切换后同步发送（首帧已在上方
        // paint；`create().then` 是微任务，先于任何待跑宏任务入队；竞速理由见 startBootstrapKickoff）。
        // 门控惰性求值——按当前有效模型判定，全新会话必未解锁。
        const kickoff = this.deps.bootstrapKickoffForNewSession?.();
        if (typeof kickoff === "string" && kickoff.trim() !== "") {
          this.submitBootstrapKickoff(kickoff);
        }
      },
      (err: unknown) =>
        this.notice(
          `新建会话失败：${err instanceof Error ? err.message : "未知错误"}`,
          "warn",
        ),
    );
  }

  /** /fork：`sessions.fork(当前会话)` 分叉新会话（后两参省略 = 源会话最后事件 + store id 策略）。
   *  成功 → success（新会话 id）；新会话与当前不同 → 提示用 /session 查看；
   *  错误码 5 个（adapter 已映射中文）→ warn；服务缺失 → warn。 */
  private handleForkCommand(): void {
    const adapter = this.deps.adapter;
    const fork = adapter.forkCurrentSession;
    if (!fork) {
      this.notice("sessions 服务不可用", "warn");
      return;
    }
    void fork.call(adapter).then(
      (child) => {
        const tip =
          child.id !== this.state.activeSessionId
            ? "，可用 /session 查看或切换"
            : "";
        this.notice(`已分叉新会话 ${child.id}${tip}`, "success");
      },
      (err: unknown) =>
        this.notice(
          `分叉失败：${err instanceof Error ? err.message : "未知错误"}`,
          "warn",
        ),
    );
  }

  /** /search：网页搜索面板（kind=search，列表）。经 adapter.search（ctx.web 统一多
   *  provider 搜索 seam）拉取并归一化行（title ?? host、detail=url·snippet、payload=url，
   *  Enter 展示来源地址）；宿主未挂载 web.search → warn 不空开面板。 */
  private handleSearchCommand(line: string): void {
    const query = slashCommandArg(line).trim();
    if (query === "") {
      this.notice("usage: /search <query>", "warn");
      return;
    }
    const search = this.deps.adapter.search;
    if (!search) {
      this.notice("web 服务不可用", "warn");
      return;
    }
    this.openListPanel({
      kind: "search",
      label: "web",
      refresh: (q?: string) => {
        const fn = this.deps.adapter.search;
        if (!fn) return Promise.reject(new Error("web 未挂载"));
        return fn.call(this.deps.adapter, q ?? "", 10);
      },
      filter: query,
    });
  }

  /** /council：二次意见（notice 型）——并行拉起 N（默认 2，可带参）个评审子代理对
   *  当前对话目标各自给独立意见，adapter.council 汇总后 info 展示；宿主未暴露
   *  subagents.start → warn 不假启动。 */
  private handleCouncilCommand(line: string): void {
    const adapter = this.deps.adapter;
    const council = adapter.council;
    if (!council) {
      this.notice("council 不可用（宿主无子代理启动面）", "warn");
      return;
    }
    // 带参数 count（1-4），无参默认 2
    const arg = slashCommandArg(line);
    const count = /^[1-4]$/.test(arg) ? Number(arg) : 2;
    // 当前目标：有 goal 快照取 objective，否则回落到最近用户输入（无则空串占位）
    const snapshot = activeGoalSnapshot(
      this.state,
      this.state.activeSessionId ?? undefined,
    );
    const lastUser = [...this.state.buffer]
      .reverse()
      .find((l) => l.kind === "user");
    const target = snapshot
      ? snapshot.objective
      : (lastUser?.text ?? "（无具体目标，请评审当前任务）");
    void council
      .call(adapter, target, count)
      .then((text) => this.notice(text, "info"))
      .catch(() => this.notice("council 不可用（宿主无子代理启动面）", "warn"));
  }

  /** /workflows：工作流运行面板（kind=workflows，只读列表）。adapter 维护的
   *  tool-workflow 运行集合为数据源（事件增量推送）；宿主未挂载 workflowEngine → warn。 */
  private handleWorkflowsCommand(): void {
    this.openListPanel({
      kind: "workflows",
      label: "workflowEngine",
      refresh: this.deps.adapter.refreshWorkflows,
      filter: "",
    });
  }

  /** /contract：契约概览（notice 型）——取当前会话 goal 快照的 objective，经
   *  adapter.contractSummary（goal-contract 只读面优先、内置同构回读兜底）解析
   *  Done-when 段为条款摘要；无目标或解析失败 → warn。 */
  private handleContractCommand(): void {
    const snapshot = activeGoalSnapshot(
      this.state,
      this.state.activeSessionId ?? undefined,
    );
    if (!snapshot) {
      this.notice("当前无活动目标/契约（无 goal 快照）", "warn");
      return;
    }
    const summary = this.deps.adapter.contractSummary;
    if (!summary) {
      this.notice("契约解析不可用", "warn");
      return;
    }
    const result = summary.call(this.deps.adapter, snapshot.objective);
    this.notice(contractSummaryText(result, 40), result.ok ? "info" : "warn");
  }

  /** /loop：共享列表面板（kind=loop），经 adapter.refreshLoops 拉取活动/历史循环。
   *  前置：metric-loop 只读查询面已挂 ctx（C5 完成）。 */
  private handleLoopCommand(): void {
    this.openListPanel({
      kind: "loop",
      label: "metricLoop",
      refresh: this.deps.adapter.refreshLoops,
      filter: "",
    });
  }

  /** /memory：子命令分发——缺省概要；`review [tier]` 审阅面板；`search <query>
   *  [--all-projects]`；`add <tier> [--kind <k>] <content>`（origin: user 免审直达）。 */
  private handleMemoryCommand(line?: string): void {
    // dispatch 传入的 line 含 "/memory" 前缀（同 /session 的 slice 口径），先剥掉。
    const raw = (line ?? "").replace(/^\/memory/, "").trim();
    const sub = raw === "" ? "" : (raw.split(/\s+/)[0] ?? "");
    const rest = raw === "" ? "" : raw.slice(sub.length).trim();
    if (sub === "") {
      this.showMemorySummary();
      return;
    }
    if (sub === "review") {
      void this.openMemoryReview(rest === "" ? undefined : rest);
      return;
    }
    if (sub === "search") {
      this.handleMemorySearchCommand(rest);
      return;
    }
    if (sub === "add") {
      this.handleMemoryAddCommand(rest);
      return;
    }
    this.notice(
      "usage: /memory [review [session|project|user] | search <query> [--all-projects] | add <session|project|user> [--kind <k>] <content>]",
      "warn",
    );
  }

  /** 概要（notice 型）——就绪 → info 展示；未就绪 → info 说明；缺失/失败 → warn。 */
  private showMemorySummary(): void {
    const adapter = this.deps.adapter;
    const summary = adapter.memorySummary;
    if (!summary) {
      this.notice("knowledge 服务不可用", "warn");
      return;
    }
    void summary.call(adapter).then(
      (text) =>
        this.notice(
          text && text.trim() !== "" ? text : "知识库尚未就绪",
          "info",
        ),
      () => this.notice("knowledge 服务不可用", "warn"),
    );
  }

  /** `/memory search <query> [--all-projects]`：跨全域检索，notice 呈现。
   *  `--all-projects` 是**标注非开关**（设计 §7：跨项目读 = bundle 启动期配置的
   *  crossProjectRoots，配置后已自动参与检索；动态开口记观察项）。 */
  private handleMemorySearchCommand(rest: string): void {
    const allProjects = rest.includes("--all-projects");
    const query = rest.replace("--all-projects", "").trim();
    if (query === "") {
      this.notice("usage: /memory search <query> [--all-projects]", "warn");
      return;
    }
    const search = this.deps.adapter.memorySearch;
    if (!search) {
      this.notice("knowledge 服务不可用", "warn");
      return;
    }
    void search.call(this.deps.adapter, { query, limit: 10 }).then(
      (hits) => {
        if (!hits || hits.length === 0) {
          this.notice("无命中", "info");
          return;
        }
        const lines = hits.map((hit) => {
          const row = hit as {
            kind?: string;
            title?: string;
            content?: string;
            tier?: string;
            project?: string;
            doc?: { ref: string; lineStart: number; lineEnd: number };
          };
          const scope = row.tier ?? "?";
          const kind = row.kind ?? "?";
          const head =
            row.title && row.title !== ""
              ? row.title
              : (row.content ?? "").slice(0, 60);
          const where =
            row.doc !== undefined
              ? ` → ${row.doc.ref}:${row.doc.lineStart}-${row.doc.lineEnd}`
              : "";
          return `· [${scope}/${kind}] ${head}${where}（${row.project ?? "-"}）`;
        });
        const tag = allProjects
          ? "--all-projects：检索范围 = 已配置的跨项目库（未配置则仅本域）\n"
          : "";
        this.notice(tag + lines.join("\n"), "info");
      },
      () => this.notice("检索失败", "warn"),
    );
  }

  /** `/memory add <tier> [--kind <k>] <content>`：用户明确指令直达（免审，
   *  origin: user——设计 §6「用户直接动作」；数据面仍过该层闸门）。
   *  U 层禁兜底（allowFallback false）→ user 必须显式 --kind。 */
  private handleMemoryAddCommand(rest: string): void {
    const tokens = rest.split(/\s+/).filter((token) => token !== "");
    const tier = tokens[0];
    if (tier !== "session" && tier !== "project" && tier !== "user") {
      this.notice(
        "usage: /memory add <session|project|user> [--kind <k>] <content>",
        "warn",
      );
      return;
    }
    const kindFlag = tokens.indexOf("--kind");
    let kind: string | undefined;
    if (kindFlag >= 0) {
      kind = tokens[kindFlag + 1];
      tokens.splice(kindFlag, 2);
    }
    const content = tokens.slice(1).join(" ").trim();
    if (content === "") {
      this.notice("usage: /memory add <tier> [--kind <k>] <content>", "warn");
      return;
    }
    if (tier === "user" && kind === undefined) {
      this.notice(
        "user 层必须显式 --kind（禁兜底分类，设计 §5）；已注册分类见 /memory review 或 profile",
        "warn",
      );
      return;
    }
    const add = this.deps.adapter.memoryAdd;
    if (!add) {
      this.notice("knowledge 服务不可用", "warn");
      return;
    }
    void add.call(this.deps.adapter, { content, kind, tier }).then(
      (result) => {
        if (result.ok) {
          this.notice(
            `已记录（${tier}${kind === undefined ? "" : ` · ${kind}`}），origin: user 免审直达`,
            "info",
          );
        } else {
          this.notice(
            `写入被拒${result.skipped === undefined ? "" : `（${result.skipped}）`}`,
            "warn",
          );
        }
      },
      () => this.notice("写入失败", "warn"),
    );
  }

  /** `/memory review [tier]`：审阅面板（合成 id，本地结算）。三库 pending 合并按
   *  created_at 升序；一候选一题（批准/拒绝，冲突候选走裁定四选项）；edit = 自定义
   *  兜底项文本。守卫：结算 in-flight 禁重开；宿主提问挂起时禁打开（宿主优先）。 */
  private openMemoryReview(tier?: string): void {
    if (this.memoryReviewSettling) {
      this.notice("上一批审阅仍在结算，请稍候", "warn");
      return;
    }
    const pending = this.state.question;
    if (pending !== null && pending.id !== MEMORY_REVIEW_PANEL_ID) {
      this.notice("先处理当前提问，再打开审阅面板", "warn");
      return;
    }
    const candidates = this.deps.adapter.memoryCandidates;
    if (!candidates) {
      this.notice("knowledge 服务不可用", "warn");
      return;
    }
    const tiers: Array<"session" | "project" | "user"> =
      tier === "session" || tier === "project" || tier === "user"
        ? [tier]
        : ["session", "project", "user"];
    void Promise.all(
      tiers.map((t) => candidates.call(this.deps.adapter, t)),
    ).then(
      (lists) => {
        const rows = lists.flat().sort((a, b) => a.createdAt - b.createdAt);
        if (rows.length === 0) {
          this.notice("无待审候选", "info");
          return;
        }
        this.memoryReviewRows = new Map(
          rows.map((row) => [
            `${MEMORY_REVIEW_PANEL_ID}:${row.targetTier}:${row.id}`,
            row,
          ]),
        );
        const questions = rows.map((row) => {
          const conflict = row.conflictWith !== null;
          const options = conflict
            ? [
                { label: "keep-old", description: "保留既有结论（候选丢弃）" },
                { label: "accept-new", description: "以候选结论替换既有行" },
                { label: "merge", description: "合并两边（选后输入合并文本）" },
                { label: "edit", description: "改写（选后输入新内容）" },
              ]
            : [
                { label: "批准", description: "转换落上层并回指标记" },
                { label: "拒绝", description: "终态留痕（同源不再提审）" },
              ];
          const detailLines = [
            row.content,
            `来源：${row.sources.length > 0 ? row.sources.join(", ") : "-"}`,
            `项目票：${row.projects.length > 0 ? row.projects.join(", ") : "-"}`,
            row.summarized === false
              ? "（未概括：无 LLM caller 时 approve 会被拒，保持待审）"
              : "",
            conflict
              ? `冲突：与 ${row.conflictWith?.kind}:${row.conflictWith?.id} 矛盾，须用户裁定`
              : "",
          ].filter((line) => line !== "");
          return {
            id: `${MEMORY_REVIEW_PANEL_ID}:${row.targetTier}:${row.id}`,
            question: `[${row.targetTier}] ${row.kind} · ${row.title ?? "(无标题)"}${
              conflict ? "（冲突裁定）" : ""
            }${row.targetTier === "user" ? "（需用户本人）" : ""}`,
            header: "memory review",
            detail: detailLines.join("\n\n"),
            options,
            // 编辑草稿恢复（宿主提问覆盖时暂存的 custom 文本）。
            ...(this.memoryReviewDrafts.get(
              `${MEMORY_REVIEW_PANEL_ID}:${row.targetTier}:${row.id}`,
            ) === undefined
              ? {}
              : {
                  custom: this.memoryReviewDrafts.get(
                    `${MEMORY_REVIEW_PANEL_ID}:${row.targetTier}:${row.id}`,
                  ),
                }),
          };
        });
        this.apply((s) =>
          reduceState(s, {
            type: "question-open",
            id: MEMORY_REVIEW_PANEL_ID,
            questions,
          }),
        );
        this.paint();
      },
      () => this.notice("审阅队列读取失败", "warn"),
    );
  }

  /** 审阅面板结算（决策 D56 修订）：未答条目**跳过**（绕开默认回退，防没碰过的候选
   *  被批量批准）；冲突候选走裁定四选项；单条失败出回执不阻塞；完成后自动重拉快照。 */
  private finishMemoryReview(panel: QuestionPanelState): void {
    if (this.memoryReviewSettling) return;
    this.memoryReviewSettling = true;
    this.apply((s) => reduceState(s, { type: "question-close" }));
    this.paint();
    const adapter = this.deps.adapter;
    const settle = async (): Promise<void> => {
      let ok = 0;
      let failed = 0;
      let skipped = 0;
      for (const item of panel.items) {
        const row = this.memoryReviewRows.get(item.id);
        const custom = item.custom?.trim();
        const selected = item.selected ?? [];
        // 未答（无选择无改写）→ 跳过（D56-a：不用默认回退批准）。
        if (selected.length === 0 && (custom === undefined || custom === "")) {
          skipped += 1;
          continue;
        }
        if (row === undefined) {
          failed += 1;
          this.notice("候选已变化，跳过（面板为快照）", "warn");
          continue;
        }
        const tier = row.targetTier;
        if (row.conflictWith !== null) {
          // 冲突候选 → 裁定四选项（user-only；merge/edit 须带文本）。
          const decision = selected[0] ?? "keep-old";
          if (
            (decision === "merge" || decision === "edit") &&
            (custom === undefined || custom === "")
          ) {
            failed += 1;
            this.notice(
              `${row.title ?? row.kind}：merge/edit 需输入文本`,
              "warn",
            );
            continue;
          }
          const result = await adapter.memoryResolveConflict?.({
            tier,
            id: row.id,
            decision,
            content: custom,
          });
          if (result?.ok === true) ok += 1;
          else {
            failed += 1;
            this.notice(`裁定被拒（${result?.reason ?? "unknown"}）`, "warn");
          }
          continue;
        }
        if (selected.includes("批准")) {
          // 有改写文本 → 先 edit 再 approve（approve 会过概括闸）。
          if (custom !== undefined && custom !== "") {
            const edited = await adapter.memoryEdit?.({
              tier,
              id: row.id,
              content: custom,
            });
            if (edited?.ok !== true) {
              failed += 1;
              this.notice(`改写失败（${edited?.reason ?? "unknown"}）`, "warn");
              continue;
            }
          }
          const result = await adapter.memoryApprove?.({ tier, id: row.id });
          if (result?.ok === true) ok += 1;
          else {
            failed += 1;
            this.notice(
              result?.reason === "llm-unavailable"
                ? "未概括且无 LLM caller：保持待审（内容已改写，待下次巩固重概括）"
                : `批准被拒（${result?.reason ?? "unknown"}）`,
              "warn",
            );
          }
          continue;
        }
        if (selected.includes("拒绝")) {
          const result = await adapter.memoryReject?.({
            tier,
            id: row.id,
            reason: "panel-rejected",
          });
          if (result?.ok === true) ok += 1;
          else {
            failed += 1;
            this.notice(`驳回被拒（${result?.reason ?? "unknown"}）`, "warn");
          }
          continue;
        }
        skipped += 1;
      }
      // 自动重拉快照（决策修订 D：失败条目与幸存条目天然回到清单）。
      const candidates = adapter.memoryCandidates;
      let remaining = -1;
      if (candidates) {
        try {
          const lists = await Promise.all(
            (["session", "project", "user"] as const).map((t) =>
              candidates.call(adapter, t),
            ),
          );
          const rows = lists.flat();
          remaining = rows.length;
          this.memoryReviewRows = new Map(
            rows.map((row) => [
              `${MEMORY_REVIEW_PANEL_ID}:${row.targetTier}:${row.id}`,
              row,
            ]),
          );
        } catch {
          remaining = -1;
        }
      }
      this.notice(
        `审阅完成：成功 ${ok} / 失败 ${failed} / 跳过 ${skipped}` +
          (remaining > 0
            ? `；仍有 ${remaining} 条待审（/memory review 重开）`
            : ""),
        failed > 0 ? "warn" : "info",
      );
      this.memoryReviewSettling = false;
    };
    void settle();
  }

  /** /guard：共享列表面板（kind=guard），经 adapter.refreshGuard 拉取拦截/放行记录；
   *  前置：security-guard 只读查询面已挂 ctx（C3 补全）。 */
  private handleGuardCommand(): void {
    this.openListPanel({
      kind: "guard",
      label: "guard",
      refresh: this.deps.adapter.refreshGuard,
      filter: "",
    });
  }

  /** /task：共享列表面板（kind=task），经 adapter.refreshTasks 拉取任务树；
   *  前置：task-engine 只读查询面已挂 ctx（C1 补全）。 */
  private handleTaskCommand(): void {
    this.openListPanel({
      kind: "task",
      label: "taskEngine",
      refresh: this.deps.adapter.refreshTasks,
      filter: "",
    });
  }

  /** 通用列表面板命令（/skills、/agents、/tools）：服务缺失 → warn 且不空开面板
   *  （面板占活动区、会盖住瞬态输出）；无参重复调用同 kind = 关闭（交互路径需先 Esc，
   *  面板态按键被吞、与 /jobs 一致）；打开时互斥关闭 history / picker / jobsPanel；
   *  随后经 refresh 拉数据（filter 为空时传 undefined）。 */
  private openListPanel(opts: {
    kind: CommandPanelKind;
    /** 服务名（notice 文案：`<label> 服务不可用`） */
    label: string;
    refresh?: (filter?: string) => Promise<void>;
    /** 命令参数（skills/tools 作 filter；agents 传 ""） */
    filter: string;
  }): void {
    const { kind, label, refresh, filter } = opts;
    if (!refresh) {
      this.notice(`${label} 服务不可用`, "warn");
      return;
    }
    if (this.state.commandPanel?.kind === kind && filter === "") {
      this.apply((s) => reduceState(s, { type: "command-panel-close" }));
      this.paint();
      return;
    }
    // 互斥：打开时关闭 history / picker / jobsPanel（其余 kind 由 open 覆盖）
    this.apply((s) => {
      let next = s;
      if (next.history) next = reduceState(next, { type: "history-close" });
      if (next.picker) next = reduceState(next, { type: "picker-close" });
      if (next.jobsPanel)
        next = reduceState(next, { type: "jobs-panel-close" });
      return reduceState(next, { type: "command-panel-open", kind });
    });
    this.paint();
    void refresh
      .call(this.deps.adapter, filter === "" ? undefined : filter)
      .catch(() => {
        // 拉取失败（如 /search 全部 provider 失败、服务缺失返回 reject）：
        // 先关面板再 notice——面板占满活动区会遮住瞬态 notice；也不留空面板。
        this.stopPanelRefresh();
        this.apply((s) =>
          s.commandPanel ? reduceState(s, { type: "command-panel-close" }) : s,
        );
        this.paint();
        this.notice(`${label} 服务不可用`, "warn");
      });
    // C2/#16：面板打开期间定时刷新（/agents 无事件面、/workflows 增量仅维护集合；
    // Esc/Enter/重复 kind 关闭时 tick 自检停表）
    if (kind === "agents" || kind === "workflows") {
      this.startPanelRefresh({ kind, refresh, label });
    }
  }

  /** 面板 Enter（详情型 kind：skills / tools）：读取正文并以 info notice 展示；
   *  服务缺失/失败 → warn。面板占满活动区会遮住瞬态 notice（与 /jobs 一致），
   *  故先关面板再提示详情。 */
  private async showPanelDetail(
    kind: "skills" | "tools" | "task" | "loop" | "search",
    name: string,
  ): Promise<void> {
    const adapter = this.deps.adapter;
    const label =
      kind === "task" ? "taskEngine" : kind === "loop" ? "metricLoop" : kind;
    if (kind === "search") {
      // 搜索行 payload = url：Enter 展示来源地址（无详情服务调用）
      this.apply((s) => reduceState(s, { type: "command-panel-close" }));
      this.notice(name, "info");
      return;
    }
    const detail =
      kind === "skills"
        ? adapter.skillDetail
        : kind === "tools"
          ? adapter.toolDetail
          : kind === "task"
            ? adapter.taskDetail
            : adapter.loopDetail;
    if (!detail) {
      this.notice(`${label} 服务不可用`, "warn");
      return;
    }
    this.apply((s) => reduceState(s, { type: "command-panel-close" }));
    try {
      const text = await detail.call(adapter, name);
      this.notice(
        text && text.trim() !== "" ? text : `${name}（无详情）`,
        "info",
      );
    } catch {
      this.notice(`${label} 服务不可用`, "warn");
    }
  }

  /** 面板 Enter（kind=guard）：展示策略快照（policy() → 4 行摘要）；先关面板再 notice
   *  （面板占满活动区会遮住瞬态输出）；服务缺失 → warn。 */
  private async showGuardPolicy(): Promise<void> {
    const adapter = this.deps.adapter;
    const policy = adapter.guardPolicy;
    if (!policy) {
      this.notice("guard 服务不可用", "warn");
      return;
    }
    this.apply((s) => reduceState(s, { type: "command-panel-close" }));
    try {
      const text = await policy.call(adapter);
      this.notice(text && text.trim() !== "" ? text : "（无策略快照）", "info");
    } catch {
      this.notice("guard 服务不可用", "warn");
    }
  }

  /** 面板 Enter（kind=agents）：直接中断选中子代理（面板内高亮即选择，照 /jobs 先例，
   *  不引入二次确认）；服务缺失 → warn，调用失败 → error。 */
  private async interruptAgent(childSessionId: string): Promise<void> {
    const adapter = this.deps.adapter;
    const interrupt = adapter.interruptAgent;
    if (!interrupt) {
      this.notice("subagents 服务不可用", "warn");
      return;
    }
    this.apply((s) => reduceState(s, { type: "command-panel-close" }));
    try {
      await interrupt.call(adapter, childSessionId);
      this.notice(`已请求中断子代理 ${childSessionId}`, "success");
    } catch (err) {
      // 带出宿主/适配器给出的原因（如 authority 不匹配的 UNAUTHORIZED），不再只给笼统文案
      this.notice(
        `中断失败：${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  /** /jobs：打开后台任务面板（复用既有面板模式），随后经 refreshJobs 拉取全量快照 */
  private handleJobsCommand(): void {
    const refresh = this.deps.adapter.refreshJobs;
    if (!refresh) {
      // 宿主未挂载 ctx.jobs：不开空面板（面板后置活动区、会盖住 hint），仅提示
      this.notice("jobs 服务不可用", "warn");
      return;
    }
    this.apply((s) => {
      let next = s;
      if (next.jobsPanel) {
        next = reduceState(next, { type: "jobs-panel-close" });
      } else {
        if (next.history) next = reduceState(next, { type: "history-close" });
        if (next.picker) next = reduceState(next, { type: "picker-close" });
        next = reduceState(next, { type: "jobs-panel-open" });
      }
      return next;
    });
    this.paint();
    void refresh.call(this.deps.adapter).catch(() => {
      this.notice("jobs 服务不可用", "warn");
    });
  }

  /** 取消后台任务（/jobs 面板 Enter；宿主缺失 → notice，面板保持） */
  private async killJob(id: string): Promise<void> {
    const adapter = this.deps.adapter;
    const kill = adapter.killJob;
    if (!kill) {
      this.notice("jobs 服务不可用", "warn");
      return;
    }
    try {
      await kill.call(adapter, id);
      this.notice("job " + id + " 取消请求已发送", "success");
    } catch {
      this.notice("jobs 服务不可用", "warn");
    }
  }

  /** 追加一条命令通知并重绘（/model 结果/错误统一入口） */
  private notice(text: string, tone?: NoticeTone): void {
    if (this.disposed) return;
    this.apply((s) =>
      reduceState(s, { type: "notice", text, ...(tone ? { tone } : {}) }),
    );
    // 双写：流水线通知节（scope 由接收层取 lastScope；启动早期 → 回合 1）
    this.deliverLocal({
      kind: "notice",
      text,
      ...(tone === undefined ? {} : { tone }),
    });
    this.paint();
  }

  /** /help 双列表格：命令列定宽对齐、描述列固定起点。折行交给渲染层按
   *  hanging 悬挂缩进（续行停靠描述列、不穿回第一列；resize 后重排仍对齐）。 */
  private helpLines(): { text: string; hanging?: number; noCompact: true }[] {
    const commands: { cmd: string; desc: string }[] = [
      { cmd: "/help", desc: "显示本帮助" },
      {
        cmd: "/clearscreen (/cls)",
        desc: "清空缓冲(只清显示，不动上下文)",
      },
      { cmd: "/quit", desc: "退出" },
      {
        cmd: "/restart",
        desc: "重启 dsh（保留会话；需由启动器启动，未设置 DSH_RESTART_FILE 时只提示）",
      },
      {
        cmd: "/theme [dark|light|toggle]",
        desc: "切换主题(默认 dark=fffdark, light=ffflight)",
      },
      {
        cmd: "/collapse on|off",
        desc: "活动区详略：on=紧凑（每条目 1 行 + 行尾省略号）/ off=完整折行",
      },
      {
        cmd: "/verbose think|tool|step",
        desc: "活动区输出内容：think=思考+正文+工具 / tool=正文+工具 / step=正文+工具调用行",
      },
      {
        cmd: "/symbol-unify on|off",
        desc: "模型输出符号统一：on=变体替换为推荐符号并提醒 / off=原样（不替换不提醒）",
      },
      {
        cmd: "/session",
        desc: "会话列表：Enter 切换到已持久化会话（live 会话不可续）",
      },
      {
        cmd: "/continue",
        desc: "加载当前目录下最近退出的会话（等价 /session + 自动选中；无匹配给提示）",
      },
      {
        cmd: "/goal",
        desc: "当前会话 goal：全形态交宿主 dsh-command-goal（无参看状态与可用命令，<目标> 新建，edit/pause/resume/clear 管理）；goal/todo 详情同时常驻左侧状态列",
      },
      { cmd: "/copy", desc: "复制最后一条模型回复到剪贴板(OSC52)" },
      {
        cmd: "/model [provider/]model",
        desc: "切换当前会话模型；无参打开交互选择面板",
      },
      {
        cmd: "/provider、/effort (/thinking)",
        desc: "无参直达 /model 面板并定位到 provider / effort 列",
      },
      {
        cmd: "/policy [ask|never]",
        desc: "审批策略：无参打开选项面板，带参直接设置",
      },
      {
        cmd: "/permission [预设名]",
        desc: "权限预设（sandbox+审批捆绑；无参列当前与可用，带参切换）",
      },
      {
        cmd: "/jobs",
        desc: "后台任务面板（只读列表；↑/↓ 选择、PgUp/PgDn 翻页、Enter 取消、Esc 关闭）",
      },
      {
        cmd: "/init",
        desc: "初始化 AGENTS.md（当前目录缺失时由模型阅读目录生成；已存在则提示退出）",
      },
      {
        cmd: "/stats (/usage /context)",
        desc: "本回合 token 用量与上下文占比（最近一次模型调用）",
      },
      { cmd: "/rename <标题>", desc: "重命名当前会话标题" },
      {
        cmd: "/skills [过滤]",
        desc: "技能目录面板（↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      },
      {
        cmd: "/agents",
        desc: "子代理面板（↑/↓ 选择、PgUp/PgDn 翻页、r 刷新、Enter 直接中断选中项、Esc 关闭）",
      },
      {
        cmd: "/tools [过滤]",
        desc: "工具目录面板（↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      },
      {
        cmd: "/settings",
        desc: "只读展示配置（ns：value，secret 脱敏）",
      },
      {
        cmd: "/fork",
        desc: "分叉当前会话为新会话（成功提示 + 必要时提示用 /session 查看）",
      },
      {
        cmd: "/task",
        desc: "任务面板（TaskEngine 只读：↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      },
      {
        cmd: "/guard",
        desc: "守卫面板（拦截/放行记录：↑/↓ 选择、PgUp/PgDn 翻页、Enter 看策略、Esc 关闭）",
      },
      {
        cmd: "/memory",
        desc: "知识库（缺省概要；review [tier] 审阅面板；search <query> [--all-projects]；add <tier> [--kind k] <内容>）",
      },
      {
        cmd: "/loop",
        desc: "循环面板（活动/历史循环：↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      },
      {
        cmd: "/contract",
        desc: "契约概览（当前目标 + Done-when 条款摘要；无 goal 给出提示）",
      },
      {
        cmd: "/workflows",
        desc: "工作流运行面板（只读：↑/↓ 选择、PgUp/PgDn 翻页、Esc 关闭）",
      },
      {
        cmd: "/council [N]",
        desc: "二次意见（并行 N 个评审子代理，对当前目标独立评审；默认 2）",
      },
      {
        cmd: "/search <query>",
        desc: "网页搜索（多 provider 聚合；Enter 查看来源 URL、Esc 关闭）",
      },
    ];
    return [
      { text: "本地命令：", noCompact: true },
      // 条目按命令名字母序展示（口径：整体字母序、不保留手写分组）
      ...helpTableLines(sortHelpRows(commands)),
      {
        text: "其他 /name 通过 commands 注册表执行(未命中则提示未知命令)。",
        noCompact: true,
      },
    ];
  }

  /** 接受补全候选（Tab）：候选名写入输入框并补尾随空格（便于接参数），
   *  列表随输入重算自动收起（`/name ` 已非命令 token）。 */
  /** 补全面板可显示的候选行数（活动区可视行 - 标题行；与 CommandCompletion 渲染同口径） */
  private completionVisibleRows(): number {
    const activityH = frameGeometry(
      this.state,
      this.deps.renderer.getSize(),
    ).activityH;
    return Math.max(1, activityH - 1);
  }
  private acceptCompletion(): void {
    const c = this.state.completion;
    // 可见候选内取焦点项（可视行之外的候选已被渲染丢弃，不需也不应被接受）
    const visible = Math.min(
      c?.items.length ?? 0,
      this.completionVisibleRows(),
    );
    const item = c?.items[Math.min(c.index, Math.max(0, visible - 1))];
    if (!item) return;
    const text =
      (this.state.inputMode === "slash" ? "" : "/") + item.name + " ";
    this.apply((s) =>
      reduceState(s, { type: "input", text, cursor: text.length }),
    );
    this.paint();
  }

  private insertChar(c: string): void {
    const cur = this.state.inputCursor;
    const text =
      this.state.inputText.slice(0, cur) + c + this.state.inputText.slice(cur);
    this.apply((s) =>
      reduceState(s, { type: "input", text, cursor: cur + c.length }),
    );
  }

  private backspace(s: AppState): AppState {
    const cur = Math.max(0, s.inputCursor - 1);
    const text = s.inputText.slice(0, cur) + s.inputText.slice(s.inputCursor);
    return reduceState(s, { type: "input", text, cursor: cur });
  }

  /** 强制整帧重绘（Ctrl+L）：绕过 delta，走 renderer.refresh */
  private refresh(): void {
    if (this.disposed) return;
    const size = this.deps.renderer.getSize();
    const out: FrameBuildOutput = {};
    const frame = buildFrame(this.state, size, this.paneScrollMax, out);
    this.paneScrollMaxState = this.state;
    this.syncDialoguePos();
    this.deps.renderer.refresh(frame, out.sections, out.focus);
  }

  /**
   * 标脏 + 同 tick 合帧：同一 tick 内多次调用只产生一次 renderer.render。
   *
   * 事件 burst（如 assistant/attempt 展开出的逐 delta 流式事件）与定时器
   * （状态栏 ticker / 思考打字机 / 面板刷新）都走这里：标脏后排队一个 microtask，
   * 本 tick 内后续标脏复用同一次冲刷。microtask 仍在同一事件循环 tick 内执行，
   * 用户可见时序不变（按键回显、审批弹窗不会跨 tick 延迟）。
   * 需要「立即拿到帧」的路径（启动首帧、测试断言）用 paintNow()。
   */
  private paint(): void {
    if (this.disposed) return;
    this.paintDirty = true;
    if (this.paintScheduled) return;
    this.paintScheduled = true;
    queueMicrotask(() => this.flushPaint());
  }

  /**
   * 冲刷待绘制帧（microtask 与显式调用共用）。
   * 帧率上限（跨回合）：距上一帧不足 frameIntervalMs 时**不清脏**、改排一个「窗口末」
   * 定时器——窗口内所有跨宏任务的标脏被合并到该时点统一出一帧，把渲染压到目标频率
   * （真实接线 10Hz）。0=不限帧：与既有语义一致，microtask 即冲刷。
   * 无脏帧时不动；渲染期间再次标脏则排下一帧。
   */
  flushPaint(): void {
    this.paintScheduled = false;
    if (this.disposed || !this.paintDirty) return;
    if (this.frameIntervalMs > 0) {
      const wait = this.lastFrameAt + this.frameIntervalMs - Date.now();
      if (wait > 0) {
        // 窗口内：保留脏标记，只挂一个定时器（重复 flush 不重复挂）
        if (this.frameTimer === null)
          this.frameTimer = setTimeout(() => {
            this.frameTimer = null;
            this.flushPaint();
          }, wait);
        return;
      }
    }
    this.paintDirty = false;
    this.renderFrame();
    this.lastFrameAt = Date.now();
    if (this.paintDirty && !this.paintScheduled) {
      this.paintScheduled = true;
      queueMicrotask(() => this.flushPaint());
    }
  }

  /** 同步出帧（丢弃待处理合帧与窗口定时器，立即渲染当前状态）；供启动首帧、测试与需立即出帧的路径 */
  paintNow(): void {
    if (this.disposed) return;
    this.paintDirty = false;
    this.clearFrameTimer();
    this.renderFrame();
    this.lastFrameAt = Date.now();
  }

  /** 清除「窗口末出帧」定时器（paintNow 抢占 / dispose 时调用） */
  private clearFrameTimer(): void {
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
  }

  /** 实际出帧：取当前终端尺寸 → 全量排版 → 渲染（区间 diff 与按段切分在渲染层） */
  private renderFrame(): void {
    const size = this.deps.renderer.getSize();
    // 出帧顺带回填两 pane 的可滚动上限与帧段表（零额外排版开销）
    const out: FrameBuildOutput = {};
    const frame = buildFrame(this.state, size, this.paneScrollMax, out);
    this.paneScrollMaxState = this.state;
    this.syncDialoguePos();
    // 帧前按需实测：本次排版登记了「呈现不确定」字符 → 先实测再出帧（探测字节写在原点，
    // 由随后的整帧重绘覆盖），见 probeThenRender
    if (!this.widthProbeInFlight && !this.widthProbeUnavailable) {
      const batch = takePendingWidthProbes();
      if (
        batch.length > 0 &&
        typeof this.deps.renderer.probeSymbolWidths === "function"
      ) {
        this.probeThenRender(batch);
        return; // 本帧由 probeThenRender 的整帧重绘产出（已按实测宽度排版）
      }
    }
    this.deps.renderer.render(frame, out.sections, out.focus);
  }

  private apply(fn: (s: AppState) => AppState): void {
    const prev = this.state;
    this.state = fn(prev);
    // 需交互面板关闭（提交 / 取消 / 超时）→ 停止催促响铃（BACKLOG 3.4.3）；
    // 统一在此判定，覆盖按键路径与事件面路径的全部关闭点
    if (
      (prev.approval !== null || prev.question !== null) &&
      this.state.approval === null &&
      this.state.question === null
    ) {
      this.clearInteractiveBell();
    }
  }
}
