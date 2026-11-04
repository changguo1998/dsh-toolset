// TUI/src/app/runtime/context.ts — App 的显式上下文对象与装配类型
//
// 2026-11-04 拆分自 TUI/src/app/index.ts: 原 App 的 59 个显式字段 + 构造器参数属性 deps
// 收进 AppContext, 构造器归一化逻辑收进 createAppContext; self 是装配后的扁平成员面,
// 由 app/index.ts 的 App 构造器回填 (装配前不会有任何方法调用).

import type { createFramePart } from "./frame.ts";
import type { createInteractionPart } from "./interaction.ts";
import type { createSessionPart } from "./session.ts";
import type { createPanelsPart } from "./panels.ts";
import type { createCommandsPart } from "./commands.ts";
import type { createCommandsModelPart } from "./commands-model.ts";
import type { createCommandsConfigPart } from "./commands-config.ts";
import type { createCommandsMemoryPart } from "./commands-memory.ts";
import type { createCommandsHostPart } from "./commands-host.ts";
import type { createWiringPart } from "./wiring.ts";
import type { createLifecyclePart } from "./lifecycle.ts";

import type { AppState } from "../state.ts";
import { initialState } from "../state.ts";
import type {
  SymbolNormalizerLike,
  RuleEngineLike,
  CommandPanelKind,
} from "../adapter/dsh.ts";
import type { NoticeTone } from "../adapter/types.ts";
import type { SectionsState } from "../layout/pipeline/sections.ts";
import type { LocalLogWriteOptions } from "../adapter/local-log.ts";
import type { ShellGuardChecker, ShellRunner } from "../local-shell.ts";
import { makeShellGuardChecker, runShellCommand } from "../local-shell.ts";
import type { FrameScrollReport } from "../layout.ts";
import { DEFAULT_THEME, normalizeThemeId } from "../../renderer/theme.ts";
import { StatusTicker } from "../status.ts";
import type { AppDeps } from "../app-deps.ts";

export type AppSelf = ReturnType<typeof createFramePart> &
  ReturnType<typeof createInteractionPart> &
  ReturnType<typeof createSessionPart> &
  ReturnType<typeof createPanelsPart> &
  ReturnType<typeof createCommandsPart> &
  ReturnType<typeof createCommandsModelPart> &
  ReturnType<typeof createCommandsConfigPart> &
  ReturnType<typeof createCommandsMemoryPart> &
  ReturnType<typeof createCommandsHostPart> &
  ReturnType<typeof createWiringPart> &
  ReturnType<typeof createLifecyclePart>;

export interface AppContext {
  deps: AppDeps;

  state: AppState;

  /** `$` 模式本地执行器（BACKLOG TUI#37；缺省真实 spawn，测试经 deps.runShell 注入假实现） */
  shellRunner: ShellRunner;

  /** 本地输出旁路日志写入参数（undefined = 未接线，不落盘） */
  localLog: LocalLogWriteOptions | undefined;

  /** `$` 模式执行前复查器（BACKLOG「TUI `$` 模式执行面不经 guard」）：缺省 = 未接线（不复查、
   *  不告警）；main.ts 传 getGuard（惰性 `ctx.get("guard")`）时由复查器兜 fail-open 与告警去重 */
  shellGuard: ShellGuardChecker | undefined;

  unbindEvents: (() => void)[];

  disposed: boolean;

  /** 启动自检 kickoff 正文（门控通过时由 main.ts 传入）：恢复会话先挂起，等启动历史折叠
   *  落定后再发（history-restore 会整表替换 buffer，早发会被替换掉）；null = 无待发内容 */
  kickoffPending: string | null;

  /** 启动期外部日志（stderr 桥 / 插件告警总线的早到行）：恢复会话时先挂起，等启动历史
   *  折叠落定后补发——`history-restore` 会整表替换 buffer，早发会被替换掉（BACKLOG TUI#9）。
   *  null = 非挂起态（未恢复会话或已落定）。 */
  bootLogPending: Array<{ text: string; tone?: NoticeTone }> | null;

  /** 退出确认面板已打开（合成问答面板 `EXIT_CONFIRM_PANEL_ID`）：确认「退出 dsh」才 dispose，
   *  取消/Esc 只关面板；防止单字节误触（BACKLOG「tmux 断连后 dsh 退出」）直接结束会话 */
  exitConfirmOpen: boolean;

  /** `/cleanquit` 的合成确认面板已打开（取消/Esc 只关面板，不删任何数据） */
  cleanQuitConfirmOpen: boolean;

  /** 本次退出要删除当前会话（退出确认面板「清理并退出」项、或 `/cleanquit` 确认后置位）：
   *  收尾时在 adapter.dispose() 之后、renderer.close() 之前删除当前会话目录 */
  cleanQuitPending: boolean;

  /** 退出确认面板选的是「重启 dsh（保留会话）」（BACKLOG #51）：退出收尾跳过空会话清理
   *  ——重启场景不该改动其它会话，且要继续用同一个会话；见 DESIGN「退出确认 ·「重启」方案」 */
  restartPending: boolean;

  /** 已实时渲染的 rule-engine 注入消息 id（BACKLOG TUI#49；双通道去重，容量上限同 adapter 口径） */
  renderedRuleInjections: Set<string>;

  /** 待绘制脏标记：同一 tick 内多次标脏合并为一次 render（见 paint/flushPaint） */
  paintDirty: boolean;

  /** 实测宽度表落盘目录（`profileDir`；"" = 不落盘，见 TUI/src/app/layout/width-symbols.ts） */
  profileDir: string;

  /** 宽度实测在途：同一时刻只发一批，在途期间不再登记新批（探测字节叠发会串台） */
  widthProbeInFlight: boolean;

  /**
   * 启动首帧闸门（BACKLOG「字符宽度探测的触发时机」裁定 ②）：首帧只出帧、不发起探测——
   * 否则屏幕先空等一次探测超时，紧接着的启动轮又并发跟发（两轮应答互相串台）。
   */
  probingSuspended: boolean;

  /** 终端不支持 CPR（**零应答**）→ 关闭后续实测，一律沿用静态表（有应答但整块作废不算） */
  widthProbeUnavailable: boolean;

  /** /detect-char-width 手动重测：探测回来后回一条结果提示（一次性） */
  widthReprobeNotice: boolean;

  /** 「呈现不确定」符号列表（码点，最近出现靠后）：落盘只存它，宽度只存内存 */
  widthSymbols: number[];

  /** 已排队待冲刷的合帧标志（与 paintDirty 成对；dispose 时清零使排队帧变 no-op） */
  paintScheduled: boolean;

  /** 跨回合最小帧间隔(ms)：0=不限帧（缺省，测试/演示保持立即出帧）；
   *  真实接线 main.ts 传 100（10Hz）。>0 时窗口内跨宏任务的标脏合并到窗口末统一出帧 */
  frameIntervalMs: number;

  /** 上一帧渲染时刻（帧率上限用；paintNow/定时器出帧都会刷新） */
  lastFrameAt: number;

  /** 窗口末出帧定时器（帧率上限用） */
  frameTimer: ReturnType<typeof setTimeout> | null;

  /** 提及候选请求：去抖计时器（连续输入合并为一次查询；null=无排队） */
  mentionTimer: ReturnType<typeof setTimeout> | null;

  /** 提及候选请求：在途取消句柄（新 token 到来即 abort 上一次；null=无在途） */
  mentionAbort: AbortController | null;

  statusTicker: StatusTicker | null;

  /** 已渲染的会话别名（TUI#48：值变化才重绘；undefined = 不显示别名段） */
  aliasCache: string | undefined;

  /** 别名读取失败是否已告警（每进程一次，避免刷屏） */
  aliasWarned: boolean;

  /** 别名读取连续失败次数（成功即清零；阈值见 `ALIAS_WARN_AFTER_FAILS`） */
  aliasFailStreak: number;

  /** 运行中闪烁时间驱动定时器（running 期间周期性发 virt-tick：无数据时虚拟速度
   *  衰减回落、虚拟总 token 持续积分——闪烁频率渐降到最低而不断） */
  virtTimer: ReturnType<typeof setInterval> | null;

  /** 审批倒计时重绘定时器（仅「有审批且有 deadline」时存活；见 syncApprovalTicker） */
  approvalTimer: ReturnType<typeof setInterval> | null;

  /** 面板定时刷新 timer（/agents、/workflows 共用；仅面板打开期间存活，tick 自检 kind） */
  panelRefreshTimer: ReturnType<typeof setInterval> | null;

  /** 当前定时刷新面板 kind 对应的 refresh + 服务名（stop 前检查） */
  panelRefreshCtx: {
    kind: CommandPanelKind;
    refresh: (() => Promise<void>) | undefined;
    label: string;
  } | null;

  /** 声音提醒（3.4.3）：需交互面板打开后的「无操作超阈值」计时器（超时转每秒催促） */
  pendingBellTimer: ReturnType<typeof setTimeout> | null;

  /** 声音提醒（3.4.3）：需交互催促的每秒重复计时器（有操作 / 面板关闭 / dispose 停止） */
  repeatBellTimer: ReturnType<typeof setInterval> | null;

  /** 声音提醒：bell 总开关（deps.notify?.enabled ?? true） */
  bellEnabled: boolean;

  /** 声音提醒：需交互「无操作」阈值(ms)（deps.notify?.idleThresholdMs ?? 8000） */
  idleBellMs: number;

  /** 符号服务（懒读；首次可用时解析并订阅审查事件） */
  symbolService: SymbolNormalizerLike | null;

  /** 审查事件订阅注销函数（dispose 时调用） */
  symbolUnsubscribe: (() => void) | null;

  /** rule-engine 服务（懒读；首次可用时订阅告警总线） */
  ruleEngineService: RuleEngineLike | null;

  /** 告警总线订阅注销函数（dispose 时调用） */
  ruleEngineUnsubscribe: (() => void) | null;

  /** 启动自动清理空会话开关（deps.autoCleanEmpty === true；未接线时关闭） */
  autoCleanEmpty: boolean;

  /** 上次 Ctrl+C 时间戳；双击窗口内再次按下则退出（含输入为空时计数） */
  lastCtrlCAt: number;

  /** 当前 turn 是否已画分隔线(回合开始画；turn-end 清) */
  turnOpen: boolean;

  /** 两 pane 可滚动上限（renderFrame 出帧时回填；滚键据此收敛偏移，防越界假死） */
  paneScrollMax: FrameScrollReport;

  /** 会话状态快照待落盘定时器（见 scheduleSessionStateSave） */
  sessionStateTimer: ReturnType<typeof setTimeout> | null;

  /** 待落盘的会话 id（切换会话/退出前 flush；null = 无待写） */
  sessionStatePendingSid: string | null;

  /** paneScrollMax 对应的 state 引用（同一 state 不重复补算） */
  paneScrollMaxState: AppState | null;

  /** 上一帧回合区可滚动上限（新内容增长时据此补偿 activityScroll；null = 尚无基准） */
  activityMax: number | null;

  /** 上一帧 buffer 的回合组数（用户停在历史里时按新增组数撑住窗口起点） */
  groupCount: number | null;

  /** 六步流水线节缓存（开关开启时持有；会话切换即重建） */
  sections: SectionsState | null;

  /** 节缓存归属的会话 id（切换会话时重建，避免跨会话串节） */
  sectionsSessionId: string | null;

  /** 流水线视角的当前回合号（turn-begin 交付用；宿主回合号经块交付已带到） */
  pipelineLastTurn: number | null;

  /** 缓冲尾巴的块身份游标（BACKLOG #22②）：同一 (turn, step) 内**跨调用连续**，scope 变化才归零 */
  bufferTailIndex: number;

  bufferTailScope: string | null;

  /**
   * 末尾是否停在「已投 turn-start、其后无内容」上（画线判据，条目 7 选项 1 起改读节模型）：
   * 等价旧口径的「缓冲末行已是回合分隔线」——下次 turn-begin 不重复画线。
   */
  pipelineSepPending: boolean;

  /**
   * 流水线是否收到过任何内容交付（画线判据的不清回合区分支：核心自发回合下，旧口径
   * 「缓冲非空」= 任何行都算内容，含 step 头 / 工具行 / notice）。
   */
  pipelineAnyContent: boolean;

  /** 生效模型缓存 key；值变化才重绘（避免每 5s 空重绘） */
  modelStatusKey: string | undefined;

  /** 装配后的扁平成员面 (见 app/index.ts 的 assembleApp); 构造器内回填 */
  self: AppSelf;
}

export function createAppContext(deps: AppDeps): AppContext {
  const ctx: AppContext = {
    deps,
    state: undefined as unknown as AppState,
    shellRunner: undefined as unknown as ShellRunner,
    localLog: undefined as unknown as LocalLogWriteOptions | undefined,
    shellGuard: undefined as unknown as ShellGuardChecker | undefined,
    unbindEvents: [],
    disposed: false,
    kickoffPending: null,
    bootLogPending: null,
    exitConfirmOpen: false,
    cleanQuitConfirmOpen: false,
    cleanQuitPending: false,
    restartPending: false,
    renderedRuleInjections: new Set<string>(),
    paintDirty: false,
    profileDir: "",
    widthProbeInFlight: false,
    probingSuspended: false,
    widthProbeUnavailable: false,
    widthReprobeNotice: false,
    widthSymbols: [],
    paintScheduled: false,
    frameIntervalMs: 0,
    lastFrameAt: 0,
    frameTimer: null,
    mentionTimer: null,
    mentionAbort: null,
    statusTicker: null,
    aliasCache: undefined as unknown as string | undefined,
    aliasWarned: false,
    aliasFailStreak: 0,
    virtTimer: null,
    approvalTimer: null,
    panelRefreshTimer: null,
    panelRefreshCtx: null,
    pendingBellTimer: null,
    repeatBellTimer: null,
    bellEnabled: true,
    idleBellMs: 8000,
    symbolService: null,
    symbolUnsubscribe: null,
    ruleEngineService: null,
    ruleEngineUnsubscribe: null,
    autoCleanEmpty: false,
    lastCtrlCAt: 0,
    turnOpen: false,
    paneScrollMax: {
      dialogueMaxScroll: 0,
      activityMaxScroll: 0,
      dialogueTotal: 0,
      dialogueCounts: [],
      dialogueKeys: [],
      dialogueTopIdx: 0,
      dialogueViewportH: 0,
      dialogueUserRows: [],
    },
    sessionStateTimer: null,
    sessionStatePendingSid: null,
    paneScrollMaxState: null,
    activityMax: null,
    groupCount: null,
    sections: null,
    sectionsSessionId: null,
    pipelineLastTurn: null,
    bufferTailIndex: 0,
    bufferTailScope: null,
    pipelineSepPending: false,
    pipelineAnyContent: false,
    modelStatusKey: undefined as unknown as string | undefined,
    self: undefined as unknown as AppSelf,
  };
  ctx.shellRunner = deps.runShell ?? runShellCommand;
  // 本地输出旁路日志（模型侧工具的数据源）：未接线 = 不落盘
  ctx.localLog = deps.localLog;
  // `$` 模式执行前 security-guard 复查（BACKLOG「TUI `$` 模式执行面不经 guard」）：
  // 未接线 getGuard → undefined（不复查、不告警）；告警出口走 deps.logger（真实接线 = stderr 桥），
  // 带 `warn: ` 前缀才会被判成 warn 色（见 stderr-bridge.ts externalLogTone / 既有别名告警同款）
  ctx.shellGuard =
    deps.getGuard === undefined
      ? undefined
      : makeShellGuardChecker(deps.getGuard, (msg) =>
          deps.logger?.("warn: " + msg),
        );
  // 声音提醒配置（P2#33）：不传 notify = 默认开启 + 8s 阈值
  ctx.bellEnabled = deps.notify?.enabled ?? true;
  // 阈值合法性：>0 有限数即可（1000ms 下限是 tui.config.json 用户配置层的职责，
  // 见 config.normalizeConfig；AppDeps 直接注入面（测试等）允许更小值便于可控验证）
  const th = deps.notify?.idleThresholdMs;
  if (typeof th === "number" && Number.isFinite(th) && th > 0) {
    ctx.idleBellMs = Math.max(1, Math.floor(th));
  }
  // 跨回合帧率上限：0=不限帧（缺省）；>0 时限帧到对应频率（见 flushPaint）
  const fi = deps.frameIntervalMs;
  if (typeof fi === "number" && Number.isFinite(fi) && fi > 0) {
    ctx.frameIntervalMs = Math.floor(fi);
  }
  // 启动自动清理空会话（tui.config.json session.autoCleanEmpty；main.ts 接线缺省 true，
  // 未接线时为关闭）
  ctx.autoCleanEmpty = deps.autoCleanEmpty === true;
  // 符号列表落盘目录（缺省 "" = 不落盘；见 TUI/src/app/layout/width-symbols.ts）
  ctx.profileDir = deps.profileDir ?? "";
  ctx.state = initialState(
    normalizeThemeId(ctx.deps.initialTheme ?? DEFAULT_THEME),
    {
      messageGutter: ctx.deps.messageGutter,
      footerHeight: ctx.deps.footerHeight,
      activityDivisor: ctx.deps.activityHeightDivisor,
      activityTopRow: ctx.deps.activityTopRow,
      activityPlacement: ctx.deps.activityPlacement,
      statusDivisor: ctx.deps.statusColumnDivisor,
      // 标题栏状态符号组的只读配置项（声音提醒）
      notifyEnabled: ctx.bellEnabled,
    },
  );
  return ctx;
}
