// src/app/index.ts — App 组装层：renderer + 状态 + adapter 事件流
//
// 只依赖 renderer 公共 API 与 adapter 接口契约，不感知 adapter 实现。
// 处理按键、接收事件、重绘。

import type { Renderer, KeyEvent } from "../renderer/index.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AppState,
  InputMode,
  StateAction,
  StatusPanelState,
} from "./state.ts";
import {
  cleanableSessionIds,
  historyVisibleRecords,
  initialState,
  isCompacting,
  markableSessionIds,
  reduceState,
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
  SessionSurfaceView,
} from "./adapter/dsh.ts";
import type { NoticeTone } from "./adapter/types.ts";
import {
  DEFAULT_RECOMMENDED,
  normalizeSymbols,
  resolveSymbolRules,
  type NormalizeResult,
  type ResolvedSymbolRules,
  type SymbolRemap,
  type SymbolRulesConfig,
} from "./symbols.ts";
import { setWidthOverrides } from "./layout/markdown.ts";
import {
  parseSlashCommand,
  SESSION_UI_STATE_VERSION,
  type CommandPanelKind,
  type SessionUiState,
  contractSummaryText,
} from "./adapter/dsh.ts";
import { activeGoalSnapshot } from "./state.ts";
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
  dialogueWindow,
  turnGroupStarts,
  type FrameScrollReport,
  type FrameBuildOutput,
  dialogueHalfPage,
  frameGeometry,
  modelLabel,
  userInputJump,
  type FrameGeometry,
  helpTableLines,
  runPhase,
} from "./layout.ts";
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
/** 退出时清理空会话的最长等待(ms)：防会话服务挂起把退出卡死。
 *  正常清理毫秒级即可完成，超时仅放弃清理并继续退出。 */
const EXIT_CLEAN_TIMEOUT_MS = 5000;
/** 运行中闪烁时间驱动的 tick 周期(ms)：running 期间周期性推进虚拟状态
 *  （无数据时虚拟速度衰减回落、虚拟总 token 持续积分，闪烁频率渐降到最低而不断） */
const VIRT_TICK_MS = 250;
/** 会话状态快照落盘合并窗口(ms)：/model、/verbose、模式事件等连续变更只写一次文件 */
const SESSION_STATE_SAVE_MS = 400;

/**
 * 焦点面板单行滚动 action 映射：history/activity 偏移语义=距底部（上滚=+），
 * status 偏移语义=距顶部（上滚=-），方向不可混用。
 */
export function focusedLineScroll(
  panel: AppState["focusedPanel"],
  dir: 1 | -1, // 1=上, -1=下
  max?: PaneScrollMax,
): StateAction {
  switch (panel) {
    case "activity":
      return {
        type: "activity-scroll",
        delta: dir,
        ...(max ? { max: max.activity } : {}),
      };
    case "status":
      return { type: "status-column-scroll", delta: -dir };
    default:
      return {
        type: "scroll",
        delta: dir,
        ...(max ? { max: max.dialogue } : {}),
      };
  }
}

/** 焦点面板整页滚动 action 映射（页 = 该面板当前可视行数） */
export function focusedPageScroll(
  panel: AppState["focusedPanel"],
  dir: 1 | -1, // 1=上一页, -1=下一页
  page: FrameGeometry,
  max?: PaneScrollMax,
): StateAction {
  switch (panel) {
    case "activity":
      return {
        type: "activity-scroll",
        delta: dir * page.activityH,
        ...(max ? { max: max.activity } : {}),
      };
    case "status":
      return { type: "status-column-scroll", delta: -dir * page.contentTopH };
    default:
      return {
        type: "scroll",
        delta: dir * page.viewportH,
        ...(max ? { max: max.dialogue } : {}),
      };
  }
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
   *  打开期间定时 + 手动 `r` 双路保鲜（C2；评估结论见 IMPLEMENTATION.md） */
  agentsRefreshIntervalMs?: number;
  /** 声音提醒（P2#33）：任务运行结束 / 等待用户输入超阈值 → 终端 BEL（\x07）。
   *  可选；不传=默认开启。配置源 tui.config.json `notify`（见 config.ts）。 */
  notify?: {
    /** bell 总开关；缺省 true */
    enabled?: boolean;
    /** 等待用户输入超时(ms)；缺省 8000。最小 1000（由 config 归一化兜底） */
    idleThresholdMs?: number;
  };
  /** 模型输出符号规范化规则（tui.config.json `symbols`；不传用内置默认，见 symbols.ts） */
  symbols?: SymbolRulesConfig;
  /** 自动清理空会话（tui.config.json `session.autoCleanEmpty`；main.ts 接线缺省 true）。
   *  true 时 start() 异步扫描全部目录删除空会话（notice 汇报），且优雅退出时
   *  （/quit、Ctrl+D、双击 Ctrl+C、插件 unload）先打印提示并等待清理完成再关闭渲染器。 */
  autoCleanEmpty?: boolean;
}

export class App {
  private state: AppState;
  private unbindEvents: (() => void)[] = [];
  private disposed = false;
  /** 待绘制脏标记：同一 tick 内多次标脏合并为一次 render（见 paint/flushPaint） */
  private paintDirty = false;
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
  /** 声音提醒：待用户输入超阈值计时器（turn-end 启动，任意键输入清除） */
  private idleBellTimer: ReturnType<typeof setTimeout> | null = null;
  /** 声音提醒：bell 总开关（deps.notify?.enabled ?? true） */
  private bellEnabled = true;
  /** 声音提醒：等待输入阈值(ms)（deps.notify?.idleThresholdMs ?? 8000） */
  private idleBellMs = 8000;
  /** 符号规范化规则（内置默认 + 配置合并；见 symbols.ts） */
  private readonly symbolRules: ResolvedSymbolRules;
  /** 本回合符号报告累积（已替换/未推荐符号），turn-end 后清 */
  private symbolTurn: {
    replacedCount: number;
    remaps: SymbolRemap[];
    emojiRemaps: SymbolRemap[];
    unrecommended: string[];
  } | null = null;
  /** 同符号冷却表：symbol → { dueAtMs, remainingRuns }——反馈过一次后冷却期内不再反馈 */
  private symbolCooldown = new Map<
    string,
    { dueAtMs: number; remainingRuns: number }
  >();
  /** 启动自动清理空会话开关（deps.autoCleanEmpty ?? false） */
  private autoCleanEmpty = false;
  /** 上次 Ctrl+C 时间戳；双击窗口内再次按下则退出（含输入为空时计数） */
  private lastCtrlCAt = 0;
  /** 当前 turn 是否已画分隔线(回合开始画；turn-end 清) */
  private turnOpen = false;
  /** 两 pane 可滚动上限（renderFrame 出帧时回填；滚键据此收敛偏移，防越界假死） */
  private paneScrollMax: FrameScrollReport = {
    dialogueMaxScroll: 0,
    activityMaxScroll: 0,
    dialogueGeometry: { rows: 0, height: 0, spans: [], topIdx: 0 },
    dialogueTop: { seq: 0, row: 0 },
  };
  /** 会话状态快照待落盘定时器（见 scheduleSessionStateSave） */
  private sessionStateTimer: ReturnType<typeof setTimeout> | null = null;
  /** 待落盘的会话 id（切换会话/退出前 flush；null = 无待写） */
  private sessionStatePendingSid: string | null = null;
  /** paneScrollMax 对应的 state 引用（同一 state 不重复补算） */
  private paneScrollMaxState: AppState | null = null;
  /** 上一帧 buffer 的回合组数（用户停在历史里时按新增组数撑住窗口起点） */
  private groupCount: number | null = null;

  /** 当前 state 的可滚动上限：出帧回填过就直接用，否则就地补算一次（同一帧口径） */
  private paneMaxes(): FrameScrollReport {
    if (this.paneScrollMaxState !== this.state) {
      buildFrame(this.state, this.deps.renderer.getSize(), this.paneScrollMax);
      this.paneScrollMaxState = this.state;
    }
    return this.paneScrollMax;
  }

  /**
   * 出帧后同步派生缓存（语义锚点/几何/行偏移）：帧已按收敛后的锚点渲染，
   * 故直接写 state（不经 apply，不触发重绘），与 paneScrollMax 的缓存语义一致。
   * 只有锚点真正被收敛（窗口收缩、resize、buffer 裁剪）时 state 才会变化。
   */
  private syncScrollAnchor(): void {
    const r = this.paneScrollMax;
    const st = this.state;
    // 用户停在历史里（锚点非 null）时，尾部新增回合组会把窗口起点向前挤（窗口按
    // 「尾部 N 组」计）——按新增组数把窗口撑住，锚定内容不被挤出已物化范围
    const groups = turnGroupStarts(st.buffer).length;
    const grew = groups - (this.groupCount ?? groups);
    this.groupCount = groups;
    const keepWindow =
      st.scrollAnchor !== null && grew > 0
        ? Math.min(groups, st.windowGroups + grew)
        : st.windowGroups;
    const same =
      st.scrollAnchor !== null &&
      st.scrollAnchor.seq === r.dialogueTop.seq &&
      st.scrollAnchor.row === r.dialogueTop.row;
    const offset = Math.max(0, r.dialogueMaxScroll - r.dialogueGeometry.topIdx);
    if (
      same &&
      st.scrollOffset === offset &&
      st.dialogueGeometry === r.dialogueGeometry &&
      st.windowGroups === keepWindow
    )
      return;
    this.state = {
      ...st,
      // followBottom（锚点 null）保持 null：收敛值仅用于非跟随态
      scrollAnchor: st.scrollAnchor === null ? null : r.dialogueTop,
      scrollOffset: st.scrollAnchor === null ? 0 : offset,
      dialogueGeometry: r.dialogueGeometry,
      windowGroups: keepWindow,
    };
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
    // 符号规范化规则（tui.config.json symbols；缺省内置默认）
    this.symbolRules = resolveSymbolRules(deps.symbols);
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
    // 启动自动清理空会话（tui.config.json session.autoCleanEmpty；缺省关闭）
    this.autoCleanEmpty = deps.autoCleanEmpty === true;
    this.state = initialState(
      normalizeThemeId(this.deps.initialTheme ?? DEFAULT_THEME),
      {
        messageGutter: this.deps.messageGutter,
        footerHeight: this.deps.footerHeight,
        activityDivisor: this.deps.activityHeightDivisor,
        activityTopRow: this.deps.activityTopRow,
        activityPlacement: this.deps.activityPlacement,
        statusDivisor: this.deps.statusColumnDivisor,
        // 状态列 Mode 块的只读配置项（声音提醒）
        notifyEnabled: this.bellEnabled,
      },
    );
  }

  /** 预留日志注入点（当前无内部消费方，保持 API 兼容为 no-op） */
  setLogger(_fn: (msg: string) => void): void {}

  /**
   * 启动宽度探测：对推荐符号集做一次终端实测（`CSI 6n` 光标列差），把 EAW 歧义
   * （A 类）字符的真实列数写入宽度覆盖表——不同终端/字体对 A 类的解析不同
   * （1 或 2 列），静态表只能保守取值（见 `layout/eaw-table.ts`）。
   *
   * 时序：首帧渲染**前**发起（探测字符画在原点，首帧清屏覆盖它）；响应到达后若
   * 宽度确有变化则重绘一帧。终端不支持 CPR 时超时（500ms）后静默沿用静态表。
   * `TUI_WIDTH_PROBE=0` 可整体关闭（排查用）。
   */
  private probeWidths(): void {
    if (process.env.TUI_WIDTH_PROBE === "0") return;
    const probe = this.deps.renderer.probeSymbolWidths;
    if (typeof probe !== "function") return;
    void probe
      .call(this.deps.renderer, DEFAULT_RECOMMENDED)
      .then((widths) => {
        if (this.disposed || widths.size === 0) return;
        if (setWidthOverrides(widths)) this.paint(); // 宽度变了：重排重绘
      })
      .catch(() => {});
  }

  start(): void {
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
    // 首帧前发起终端宽度探测（异步、不阻塞首帧；首帧清屏覆盖探测残留）
    this.probeWidths();
    // 首帧前同步 renderer 主题（基底色/词槽位随 /theme 切换）
    this.deps.renderer.setTheme(this.state.themeId);
    this.paintNow();
    // 拉取权限/agent 预设目录写入 state（状态列 Mode 块可选值；缺默服务则保持降级）
    this.refreshCatalogs();
    // 拉取宿主命令注册表目录（输入补全候选；服务缺失时仅本地目录）
    this.refreshCommandCatalog();
    // 补 Mode 块初始值（log-only 事件启动不产生，从会话日志折叠一次）
    this.restoreSessionState();
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
    this.syncScrollAnchor();
    this.deps.renderer.render(frame, out.sections);
  }

  /**
   * 拉取权限/agent 预设目录写入 state（状态列 Mode 块 permission/preset 列出可选值；
   * 目录变化低频，start + /permission /preset 命令时刷新已足够）。目录服务缺失或
   * 读失败静默降级（state 保持 [] → Mode 块回退标准三档/当前值），不崩溃。
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
      verbose: this.state.activityVerbose,
      symbolUnify: this.state.symbolUnify,
      // P7：垂直状态列显隐（TUI 本地开关，随会话持久化）
      statusColumn: this.state.statusColumnVisible,
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
    this.stopPanelRefresh();
    this.clearIdleBellTimer();
    this.clearFrameTimer();
    // 退出时清理其他空会话（复用 session.autoCleanEmpty 开关）：开启时先打印提示并等待
    // 清理完成，再释放 adapter/关闭渲染器退出；关闭或无可清理服务时保持同步收尾。
    // 注意：仅优雅退出路径（/quit、Ctrl+D、双击 Ctrl+C、插件 unload）覆盖——信号强退
    // （SIGINT/SIGTERM）与崩溃路径由 renderer 直接 process.exit，无法可靠等待异步 IO。
    if (!this.autoCleanEmpty) {
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

  /** turn-end 钩子：任务运行结束 → bell；随后启动「等待用户输入超阈值」计时（默认 8s）。
   *  计时期间任意用户输入(handleKey)即取消；仅本次等待响一次。 */
  private onTurnEnded(): void {
    if (!this.bellEnabled || this.disposed) return;
    this.deps.renderer.bell?.();
    this.clearIdleBellTimer();
    this.idleBellTimer = setTimeout(() => {
      this.idleBellTimer = null;
      if (!this.bellEnabled || this.disposed) return;
      this.deps.renderer.bell?.();
    }, this.idleBellMs);
  }

  /** 清除「等待输入超阈值」计时（用户输入 / dispose / 新 turn 均取消） */
  private clearIdleBellTimer(): void {
    if (this.idleBellTimer) {
      clearTimeout(this.idleBellTimer);
      this.idleBellTimer = null;
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
        // 符号统一（/symbol-unify 开关）：on=变体替换为推荐符号并记提醒（展示层）；
        // off=原样透传（不替换不提醒）
        const unified = this.state.symbolUnify
          ? normalizeSymbols(e.text, this.symbolRules)
          : null;
        if (unified !== null) {
          if (unified.replacedCount > 0 || unified.unrecommended.length > 0) {
            this.accumulateSymbolTurn(unified);
          }
        }
        const streamText = unified !== null ? unified.text : e.text;
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
          }),
        );
        break;
      case "question":
        // DSH 提问：整批题一次打开（一次 ask() 一批；面板内逐题导航，提交整批）
        this.apply((s) =>
          reduceState(s, {
            type: "question-open",
            id: e.id,
            questions: e.questions,
          }),
        );
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
        this.flushSymbolTurn();
        break;
      case "tool-call":
      case "model-selection":
      case "tool-result":
      case "usage":
      case "compaction":
      case "retry":
      case "goal-change":
      case "todo-write":
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
        // 阶段 1 pass-through：仅入 reducer（事件结构 = StateAction 同型），不渲染；
        // 阶段 2 按事件落 buffer 工具行 / toast / 状态栏槽位；P2 B 阶段渲染前同此处理
        this.apply((s) => reduceState(s, e));
        // 模型/模式类状态变化 → 刷新会话状态快照（宿主日志仍是主来源，快照作兜底）
        if (
          e.type === "model-selection" ||
          e.type === "mode" ||
          e.type === "approval-policy"
        ) {
          this.scheduleSessionStateSave();
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
        if (e.verbose !== undefined) {
          this.apply((s) =>
            reduceState(s, { type: "activity-verbose", on: e.verbose! }),
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
    this.apply((s) => reduceState(s, { type: "turn-begin", clearActivity }));
    this.apply((s) => reduceState(s, { type: "queued-claim" }));
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
    this.apply((s) => reduceState(s, { type: "clear-stripped" }));
    this.paint();
  }

  /**
   * 同符号冷却：某符号反馈过一次后进入冷却，冷却期内不再反馈该符号，
   * 打破「助手讨论符号本身 → 每轮反复提醒」的循环。时间窗与 run 次数双维：
   * 任一维度未过期即视为仍冷却；都过期才解冻（可再次反馈）。展示层替换照常进行。
   */
  private isSymbolCooling(ch: string): boolean {
    const rec = this.symbolCooldown.get(ch);
    if (!rec) return false;
    const inTime = this.symbolRules.cooldownMs > 0 && Date.now() < rec.dueAtMs;
    const inRuns = this.symbolRules.cooldownRuns > 0 && rec.remainingRuns > 0;
    return inTime || inRuns;
  }

  /** 对已反馈（列入本次提醒）的符号登记或重置冷却。 */
  private enterSymbolCooldown(ch: string): void {
    if (
      this.symbolRules.cooldownMs <= 0 &&
      this.symbolRules.cooldownRuns <= 0
    ) {
      return;
    }
    const rec = this.symbolCooldown.get(ch) ?? {
      dueAtMs: 0,
      remainingRuns: 0,
    };
    rec.dueAtMs = Date.now() + Math.max(this.symbolRules.cooldownMs, 0);
    rec.remainingRuns = Math.max(this.symbolRules.cooldownRuns, 0);
    this.symbolCooldown.set(ch, rec);
  }

  /** 每 turn 推进冷却 run 计数；两个维度都过期后清出记录（解冻）。 */
  private tickSymbolCooldown(): void {
    if (this.symbolRules.cooldownRuns > 0) {
      for (const rec of this.symbolCooldown.values()) {
        if (rec.remainingRuns > 0) rec.remainingRuns -= 1;
      }
    }
    for (const [ch, rec] of this.symbolCooldown) {
      const inTime =
        this.symbolRules.cooldownMs > 0 && Date.now() < rec.dueAtMs;
      if (!inTime && rec.remainingRuns <= 0) {
        this.symbolCooldown.delete(ch);
      }
    }
  }

  /** 累积本回合符号报告（多次 stream 段汇总；替换明细 + 无替代符号去重）。 */
  private accumulateSymbolTurn(nr: NormalizeResult): void {
    const t = this.symbolTurn ?? {
      replacedCount: 0,
      remaps: [],
      emojiRemaps: [],
      unrecommended: [],
    };
    t.replacedCount += nr.replacedCount;
    t.remaps.push(...nr.remaps);
    t.emojiRemaps.push(...nr.emojiRemaps);
    for (const ch of nr.unrecommended) {
      if (!t.unrecommended.includes(ch)) t.unrecommended.push(ch);
    }
    this.symbolTurn = t;
  }

  /**
   * turn 结束收尾：本回合有「替换（归一）」或「未推荐（警示）」时——
   * notice 给人（合并一条）；warnModel 开启时生成一条合并反馈（替换+警示），
   * 随下一条用户消息提交给模型（不单独发空回合）。
   */
  private flushSymbolTurn(): void {
    this.tickSymbolCooldown(); // 每 turn 推进冷却 run 计数（解冻判定）
    const t = this.symbolTurn;
    this.symbolTurn = null;
    if (!this.state.symbolUnify) return; // 开关关闭：既不提示也不注入
    if (!t) return;
    // 冷却过滤：反馈过一次的符号在冷却期内不再反馈（展示层替换照常）；
    // 本轮真正列入提醒的符号在此登记冷却。三组（emoji 罗列/变体计数/警示）独立计数。
    const emojiSeen = new Set<string>();
    const emojiInstrs: string[] = [];
    for (const { from, to } of t.emojiRemaps) {
      if (emojiSeen.has(from)) continue;
      emojiSeen.add(from);
      if (this.isSymbolCooling(from)) continue; // emoji 罗列跳过冷却中的符号
      emojiInstrs.push(
        to === "" ? `请删除「${from}」` : `请将「${from}」改为「${to}」`,
      );
      this.enterSymbolCooldown(from);
    }
    const emojiFroms = new Set(t.emojiRemaps.map((r) => r.from));
    let variantCount = 0;
    const variantSeen = new Set<string>();
    for (const { from } of t.remaps) {
      if (emojiFroms.has(from) || variantSeen.has(from)) continue;
      variantSeen.add(from);
      if (this.isSymbolCooling(from)) continue; // 变体只统计未冷却的
      variantCount++;
      this.enterSymbolCooldown(from);
    }
    const warnList: string[] = [];
    for (const ch of t.unrecommended) {
      if (this.isSymbolCooling(ch)) continue; // 警示跳过冷却中的符号
      warnList.push(ch);
      this.enterSymbolCooldown(ch);
    }
    const hasEmoji = emojiInstrs.length > 0;
    const hasVariant = variantCount > 0;
    const hasWarn = warnList.length > 0;
    if (!hasEmoji && !hasVariant && !hasWarn) return; // 全部处于冷却：本轮静默
    // notice（人：替换只报计数、不罗列被替换符号；警示列未推荐符号——均只含未冷却的新内容）
    let noticeText = "";
    if (hasEmoji || hasVariant) {
      noticeText += `符号已替换 ${emojiInstrs.length + variantCount} 处为推荐符号`;
    }
    if (hasWarn) {
      noticeText +=
        (noticeText !== "" ? "；" : "") + `未推荐符号：${warnList.join("")}`;
    }
    this.notice(noticeText + "（建议用推荐符号或文字）", "warn");
    // 模型反馈（合并一条）：
    //   emoji 起源替换 = 先要求更换（罗列「X→Y」）；普通变体替换 = 只报计数；
    //   警示 = 复述规则 + 要求重新选择
    if (this.symbolRules.warnModel) {
      const parts: string[] = [];
      if (hasEmoji) {
        parts.push(
          `你使用了 emoji 符号，展示层已替换为推荐符号——请更换为推荐符号或文字：${emojiInstrs.join("；")}。`,
        );
      }
      if (hasVariant) {
        parts.push(
          `另有 ${variantCount} 处变体符号已按推荐替换（不逐一列示，请直接用推荐符号）。`,
        );
      }
      if (hasWarn) {
        parts.push(
          `你使用的符号「${warnList.join("」 「")}」无推荐替代，请按符号选择规则重新选择：` +
            `1）状态/方向/几何类符号用推荐符号（✓ ✗ △ → ← ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙ ▶ ◀ ▲ ▼ ▷ ◁ ▽ ⟸ ⟹ ⟺ • ◦ ○ ● ◯ ■ □ ◇ ◆ ⓘ 〜 …）或文字；` +
            `2）有推荐对应关系的变体符号必须使用推荐对应符；` +
            `3）避免 emoji、带颜色/填色符号及终端宽度不确定的字符。`,
        );
      }
      // turn-end 回调内同步 followup 宿主不接（实测不落盘）；推迟一个宏任务再发，
      // 待宿主完成 run 收尾进入等待态（实测送达模型并自动开新回合）
      const fb = `[符号规范] ${parts.join(" ")}`;
      const sid = this.state.activeSessionId ?? undefined;
      setTimeout(() => {
        if (this.disposed) return;
        this.deps.adapter.sendMessage(fb, sid);
      }, 0);
    }
    this.paint();
  }

  private handleKey(k: KeyEvent): void {
    // P2#33：任意用户输入即取消「等待输入超阈值」计时（仅在本等待内响一次）
    this.clearIdleBellTimer();
    if (this.disposed) return;
    const { name, ctrl } = k;

    // 审批模式：y/n + 滚动
    // 审批模式：仅 y/n 应答；其余按键（含 Esc、Ctrl+D、Ctrl+L）一律吞掉——
    // 不打断运行、不关闭弹窗、不改输入模式（“审批模式不变”契约）
    if (this.state.approval) {
      if (name === "y" || name === "n") {
        const allow = name === "y";
        this.deps.adapter.approve(this.state.approval.id, allow);
        this.apply((s) => reduceState(s, { type: "approval", approval: null }));
        this.paint();
      }
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

    // 通用状态选项面板（/policy /permission /preset）：↑/↓ 移动焦点、空格预选
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
          // 无可中断 id 的条目（如 agents 的 diagnostic）：灰显 + 说明，不发服务调用；
          // 与其它 Enter 行为一致先关面板——否则说明 notice 会被面板占用的活动区遮住
          this.apply((s) => reduceState(s, { type: "command-panel-close" }));
          this.notice(
            panel.kind === "agents"
              ? "该条目不可中断（无可用会话 id）"
              : "该条目无详情载荷",
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

    // Ctrl+D：仅 idle 且输入区为空时退出（输入非空时按无操作忽略）；
    // 走 App.dispose 释放 adapter 与当前活跃 handle
    if (ctrl && name === "d") {
      if (canExitOnCtrlD(this.state)) {
        this.dispose();
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

    // Ctrl+C：清空输入区（不发送）；750ms 双击窗口内再次 Ctrl+C 退出程序
    // （输入为空时首次只计数不退出，第二次退出；输入非空时首次清空并计入）
    if (ctrl && name === "c") {
      const now = Date.now();
      if (now - this.lastCtrlCAt <= CTRL_C_DOUBLE_MS) {
        this.dispose();
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
          const { viewportH } = frameGeometry(
            this.state,
            this.deps.renderer.getSize(),
          );
          // 语义锚点位移：几何（行分组表）取自本帧布局，位移换算成 (buffer 行, 行内行号)
          const geom = this.paneMaxes().dialogueGeometry;
          this.apply((s) =>
            reduceState(s, {
              type: "scroll",
              delta: dir * dialogueHalfPage(viewportH),
              geom,
            }),
          );
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
          const m = frameGeometry(this.state, this.deps.renderer.getSize());
          // 跳转只在物化窗口内找目标（更早内容未物化，先按 ↑ 扩窗再翻页）
          const win = dialogueWindow(
            this.state.buffer,
            this.state.windowGroups,
          );
          const jump = userInputJump(
            win.lines,
            m.dialogueW,
            this.state.messageGutter,
            this.state.themeId,
            m.viewportH,
            this.paneMaxes().dialogueGeometry.topIdx,
            win.start,
            dir,
            win.dropped > 0 ? 1 : 0,
          );
          if (jump)
            this.apply((s) =>
              reduceState(s, { type: "user-jump", anchor: jump }),
            );
          else if (dir === -1)
            // PgDn 无下一条 → 回到底部跟随最新
            this.apply((s) => reduceState(s, { type: "scroll-to-bottom" }));
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
        // 模式键：输入框为空时按 $ / / 切换模式并吞键（同符号幂等；提交后自动回退 >；! 为普通字符）
        if (
          name.length === 1 &&
          !ctrl &&
          this.state.inputText === "" &&
          (name === "$" || name === "/")
        ) {
          const mode: InputMode = name === "$" ? "shell" : "slash";
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
      case "custom":
        this.apply((s) =>
          reduceState(s, { type: "question-custom", text: d.text }),
        );
        break;
      case "select":
        this.apply((s) => reduceState(s, { type: "question-select" }));
        break;
      case "none":
        // Tab 等其余按键吞掉（不落入主输入栏，也不再切焦点）
        return;
    }
    this.paint();
  }

  /** 提交问答：整批 answer 交给 adapter（answerQuestion → resolve ask）并关闭面板 */
  private submitQuestion(): void {
    const panel = this.state.question;
    if (!panel) return;
    const answer = buildQuestionAnswers(panel);
    this.apply((s) => reduceState(s, { type: "question-close" }));
    this.deps.adapter.answerQuestion(panel.id, answer);
    this.paint();
  }

  /** 取消问答：reject ask（不打断 turn），关闭面板 */
  private cancelQuestion(): void {
    const panel = this.state.question;
    if (!panel) return;
    this.apply((s) => reduceState(s, { type: "question-close" }));
    this.deps.adapter.cancelQuestion(panel.id);
    this.paint();
  }

  /** 发送用户文本（状态置运行 + 本地回显 + adapter 分发）：普通提交与 /init 注入共用。
   *  echoText 为缓冲回显文本（默认同发送文本）；/init 回显命令名、发送初始化指令。 */
  private sendUserText(sendText: string, echoText: string = sendText): void {
    this.apply((s) =>
      reduceState(s, { type: "input-status", status: "running" }),
    );
    // 真实 DSH 不回显 user/message,由 app 在发送前本地追加用户行。
    // 回合开始时先画分隔线(上一轮内容 → 新回合内容)；用户输入开启 → 清空活动区
    this.beginTurnIfNeeded(true);
    this.apply((s) => reduceState(s, { type: "user-line", text: echoText }));
    this.deps.adapter.sendMessage(
      sendText,
      this.state.activeSessionId ?? undefined,
    );
  }

  /** /init：当前目录无 AGENTS.md 时注入初始化指令（模型阅读目录并生成）；
   *  已存在则提示并直接结束（不发送任何消息） */
  private runInit(): void {
    const cwd = this.state.systemStatus.cwd;
    const dir = cwd !== "" && cwd !== "—" ? cwd : process.cwd();
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
    const text = this.state.queued.join("\n");
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
            tone: "info",
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
      case "verbose":
        this.handleVerboseCommand(line);
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
      case "goal":
        // 无参：goal/todo 详情常驻左侧顶部状态列；带参数（<objective> / edit <objective> /
        // pause / resume / clear）→ 交宿主 dsh-command-goal 执行，结果经 notice 回报
        if (line.slice("/goal".length).trim() === "") {
          this.notice("goal/todo 详情见左侧信息栏", "info");
          return;
        }
        this.deps.adapter.runCommand(line);
        return;
      case "policy":
        this.handlePolicyCommand(line);
        return;
      case "permission":
        this.handlePermissionCommand(line);
        return;
      case "preset":
        this.handlePresetCommand(line);
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
        this.handleMemoryCommand();
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
   * /verbose on|off：活动区详略切换（SPEC §6.8 两态）。
   * on = 每条目完整折行（状态 1，缺省）；off = 紧凑（状态 2：每条目 1 行 + 行尾省略号）。
   * 无参数/非法参数 → 只提示用法与当前状态，不切换。
   */
  private handleVerboseCommand(line: string): void {
    const arg = line.slice("/verbose".length).trim().toLowerCase();
    const cur = this.state.activityVerbose;
    let next: boolean;
    if (arg === "on" || arg === "true") next = true;
    else if (arg === "off" || arg === "false") next = false;
    else {
      this.notice(
        `usage: /verbose on|off（当前：${cur ? "on(完整)" : "off(紧凑)"}）`,
        "info",
      );
      return;
    }
    if (next !== cur) {
      this.apply((s) => reduceState(s, { type: "activity-verbose", on: next }));
      this.paint();
      this.scheduleSessionStateSave();
    }
    this.notice(
      `活动区：${next ? "verbose on（完整折行）" : "verbose off（紧凑：每条目 1 行 + 省略号）"}`,
      "success",
    );
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
      this.apply((s) =>
        reduceState(s, {
          type: "history-resume-ok",
          id,
          title,
          rows: surfaceToBuffer(view.messages),
        }),
      );
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
      // 展示名与状态列 Mode 块一致（ask/auto；never 提交值不变，展示用 auto）
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
        // 同步目录进 state（状态列 Mode 块 permission 列出可选值）
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
   * /preset：agent 预设目录（可用预设 + 当前选中 + 未来默认）。
   * 无参 → 从 ctx.agentPresets 读目录提示；带参 <id> → selectAgentPreset（宿主缺失 fail-safe）。
   */
  private handlePresetCommand(line: string): void {
    const arg = line.slice("/preset".length).trim();
    const adapter = this.deps.adapter;
    const catalog = adapter.agentPresetCatalog;
    if (arg === "") {
      if (!catalog) {
        this.notice("agent 预设服务不可用", "warn");
        return;
      }
      void catalog()
        .then((info) => {
          if (this.disposed) return;
          if (!info) {
            this.notice("agent 预设服务不可用", "warn");
            return;
          }
          // 同步目录进 state（状态列 Mode 块 preset 列出可选值）
          this.apply((s) =>
            reduceState(s, {
              type: "agent-preset-catalog",
              ids: info.presets.map((pp) => pp.id),
            }),
          );
          this.paint();
          // 打开状态选项面板：选项 = agent 预设（空格预选、Enter 提交 selectAgentPreset）
          this.openStatusPanel({
            kind: "preset",
            title: "/preset agent 预设",
            options: info.presets.map((pp) => ({
              id: pp.id,
              label: pp.name,
              ...(pp.description ? { desc: pp.description } : {}),
            })),
            index: 0,
            selected: info.current === "" ? null : info.current,
          });
        })
        .catch(() => {
          this.notice("agent 预设服务不可用", "warn");
        });
      return;
    }
    const select = adapter.selectAgentPreset;
    if (!select) {
      this.notice("agent 预设服务不可用", "warn");
      return;
    }
    void select
      .call(adapter, arg)
      .then(() => {
        this.notice("agent 预设：已切换为 " + arg, "success");
      })
      .catch(() => {
        this.notice("agent 预设服务不可用：" + arg, "warn");
      });
  }

  /** 打开通用状态选项面板（/policy /permission /preset 无参路径） */
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
    // preset：selectAgentPreset（宿主缺失 fail-safe）
    const select = adapter.selectAgentPreset;
    if (!select) {
      this.notice("agent 预设服务不可用", "warn");
      return;
    }
    try {
      await select.call(adapter, id);
      this.notice("agent 预设：已切换为 " + id, "success");
    } catch {
      this.notice("agent 预设服务不可用：" + id, "warn");
    }
  }

  /** /stats（别名 /usage、`/context`）：显示最近一次模型调用的 token 用量。
   *  usage 语义为「最近一次模型调用」（非会话累计，见 state.usage 注释）；
   *  contextWindow 缺失或为 0 → 只显绝对量（不除零）。 */
  private handleStatsCommand(): void {
    const usage = this.state.usage;
    if (!usage) {
      this.notice("暂无 token 用量数据（本回合尚未发生模型调用）", "info");
      return;
    }
    const { input, output, cacheRead, contextWindow } = usage;
    // 上下文口径与状态栏 ctx 段一致：input + cacheRead
    const context = input + cacheRead;
    const lines = [
      `本回合 tokens：输入 ${input} · 输出 ${output} · 缓存读 ${cacheRead}`,
      contextWindow !== undefined && contextWindow > 0
        ? `上下文：${context} / ${contextWindow}（${Math.round((context / contextWindow) * 100)}%）`
        : `上下文：${context}`,
      `缓存命中率：${context > 0 ? `${Math.round((cacheRead / context) * 100)}%` : "n/a"}`,
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

  /** /memory：知识库概要（notice 型）——就绪 → info 展示（路径/chunk·source 计数）；
   *  未就绪 → info 说明；服务缺失/失败 → warn。 */
  private handleMemoryCommand(): void {
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
    } catch {
      this.notice("中断失败（子代理可能已结束或不可中断）", "error");
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
        cmd: "/theme [dark|light|toggle]",
        desc: "切换主题(默认 dark=fffdark, light=ffflight)",
      },
      {
        cmd: "/verbose on|off",
        desc: "活动区详略：on=完整折行 / off=紧凑（每条目 1 行 + 行尾省略号）",
      },
      {
        cmd: "/symbol-unify on|off",
        desc: "模型输出符号统一：on=变体替换为推荐符号并提醒 / off=原样（不替换不提醒）",
      },
      {
        cmd: "/session",
        desc: "会话列表：Enter 切换到 persisted 会话(live 不可续)",
      },
      {
        cmd: "/goal",
        desc: "无参：goal/todo 详情常驻左侧状态列（不打开面板）；带参：交宿主新建/编辑/暂停/恢复/清除当前 goal",
      },
      { cmd: "/copy", desc: "复制最后一条模型回复到剪贴板(OSC52)" },
      {
        cmd: "/model [provider/]model",
        desc: "switch current-session model; bare /model: interactive picker",
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
        cmd: "/preset [预设名]",
        desc: "agent 预设目录（无参列当前/可用/默认，带参切换）",
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
        desc: "分叉当前会话为新会话（success 提示 + 必要时提示用 /session 查看）",
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
        desc: "知识库概要（就绪/路径/chunk·source 计数；未就绪给说明）",
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
      ...helpTableLines(commands),
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
    this.syncScrollAnchor();
    this.deps.renderer.refresh(frame, out.sections);
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
    this.syncScrollAnchor();
    this.deps.renderer.render(frame, out.sections);
  }

  private apply(fn: (s: AppState) => AppState): void {
    this.state = fn(this.state);
  }
}
