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
  reduceState,
} from "./state.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelCatalog,
  ModelSelection,
  ModelReasoning,
  HistoryMessage,
  SessionSurfaceView,
} from "./adapter/dsh.ts";
import type { NoticeTone } from "./adapter/types.ts";
import { parseSlashCommand, type CommandPanelKind } from "./adapter/dsh.ts";
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
  dialogueHalfPage,
  dialogueScrollMetrics,
  inputPanelHeights,
  modelLabel,
  userInputJump,
  type PanelHeights,
} from "./layout.ts";
import {
  DEFAULT_THEME,
  normalizeThemeId,
  THEMES,
  type ThemeId,
} from "../renderer/theme.ts";
import { StatusTicker, type StatusQueries } from "./status.ts";

// 仅真实链路生效的思考打字机节奏：tick 固定 50ms，每 tick 放出的字符数
// 由 streamCharsPerSecond(字符/秒)折算并按分数累计，低速下也能正确逐字输出；
// 切分按码点进行，避免把 emoji/CJK 代理对拆断；对象仅为 thinking(reasoning)。
// 正文回复即时显示；正文到达后剩余思考自动加速到 SLOW_STREAM_ARRIVED_CPS 放完，
// 尽快进入正文。mock demo 不经过该队列。
const SLOW_TICK_MS = 50;
/** streamCharsPerSecond 缺省/非法时的兜底流速(字符/秒) */
const SLOW_DEFAULT_CPS = 120;
/** Ctrl+C 双击退出窗口(毫秒)：窗口内第二次 Ctrl+C 退出程序 */
const CTRL_C_DOUBLE_MS = 750;
/** 收到正文回复(stream)后：剩余思考的加速流速(尽快进入正题) */
const SLOW_STREAM_ARRIVED_CPS = 200;

/**
 * 焦点面板单行滚动 action 映射：history/activity 偏移语义=距底部（上滚=+），
 * status 偏移语义=距顶部（上滚=-），方向不可混用。
 */
export function focusedLineScroll(
  panel: AppState["focusedPanel"],
  dir: 1 | -1, // 1=上, -1=下
): StateAction {
  switch (panel) {
    case "activity":
      return { type: "activity-scroll", delta: dir };
    case "status":
      return { type: "status-column-scroll", delta: -dir };
    default:
      return { type: "scroll", delta: dir };
  }
}

/** 焦点面板整页滚动 action 映射（页 = 该面板当前可视行数） */
export function focusedPageScroll(
  panel: AppState["focusedPanel"],
  dir: 1 | -1, // 1=上一页, -1=下一页
  page: PanelHeights,
): StateAction {
  switch (panel) {
    case "activity":
      return { type: "activity-scroll", delta: dir * page.activityH };
    case "status":
      return { type: "status-column-scroll", delta: -dir * page.topHeight };
    default:
      return { type: "scroll", delta: dir * page.dialogueH };
  }
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
  /** 真实链路：流式正文放缓显示(打字机节奏)；mock demo 默认关闭保持原速 */
  slowStream?: boolean;
  /** 打字机流速(字符/秒，合法性由 main 归一化；兜底 SLOW_DEFAULT_CPS) */
  streamCharsPerSecond?: number;
  /** 用户块左缘/回复右缘对称留空(列数，默认 4，经 initialState 落到 state) */
  messageGutter?: number;
  /** 交互区绝对行数（tui.config.json layout.footerHeight；缺省自动 1/5 上限 4） */
  /** 交互区绝对行数（tui.config.json layout.footerHeight；缺省自动 1/5 上限 4） */
  footerHeight?: number;
  /** 活动区高分母（tui.config.json layout.activityHeightDivisor；1/2 → 2） */
  activityHeightDivisor?: number;
  /** 状态列宽分母（tui.config.json layout.statusColumnDivisor；1/3 → 3） */
  statusColumnDivisor?: number;
}

export class App {
  private state: AppState;
  private unbindEvents: (() => void)[] = [];
  private disposed = false;
  private statusTicker: StatusTicker | null = null;
  // 打字机队列：仅作用于 thinking(reasoning)——正文是最终保留的回复，须即时显示；
  // 思考是“输出结束会被隐藏”的瞬态内容，按 tick 逐段放出便于阅读（slowStream 开启时使用）。
  private thinkingPending = "";
  /** 思考放完前到达的正文段按序缓冲，思考清空后再即时显示(不限制正文流速) */
  private pendingStream: string[] = [];
  /** 思考放完前到达的 turn-end 记下，放完后补执行(不分隔线；思考保留至下回合一并清) */
  private pendingTurnEnd = false;
  private slowTimer: ReturnType<typeof setInterval> | null = null;
  private slowCps = SLOW_DEFAULT_CPS;
  /** 每 turn 思考的初始流速（配置值或默认）；正文加速后在下个 turn 回落 */
  private slowCpsBase = SLOW_DEFAULT_CPS;
  /** 上次 Ctrl+C 时间戳；双击窗口内再次按下则退出（含输入为空时计数） */
  private lastCtrlCAt = 0;
  /** turn-end 后置位：下一条 thinking 视为新 turn，先把流速回落到 slowCpsBase */
  private slowNewTurn = false;
  /** 当前 turn 是否已画分隔线(回合开始画；turn-end 清) */
  private turnOpen = false;
  /** 每 tick 累积的字符配额余数（低速时不足 1 字符的跨 tick 累计） */
  private slowCredit = 0;

  constructor(private deps: AppDeps) {
    // 初始思考流速来自配置(默认 120)；收到正文后由 SLOW_STREAM_ARRIVED_CPS 加速，
    // turn 结束后回落到 slowCpsBase（下个 turn 重新从慢速开始）
    const cps = this.deps.streamCharsPerSecond;
    if (typeof cps === "number" && Number.isFinite(cps) && cps > 0) {
      this.slowCps = cps;
      this.slowCpsBase = cps;
    }
    this.state = initialState(
      normalizeThemeId(this.deps.initialTheme ?? DEFAULT_THEME),
      {
        messageGutter: this.deps.messageGutter,
        footerHeight: this.deps.footerHeight,
        activityDivisor: this.deps.activityHeightDivisor,
        statusDivisor: this.deps.statusColumnDivisor,
      },
    );
  }

  /** 预留日志注入点（当前无内部消费方，保持 API 兼容为 no-op） */
  setLogger(_fn: (msg: string) => void): void {}

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
    // 首帧前同步 renderer 主题（基底色/词槽位随 /theme 切换）
    this.deps.renderer.setTheme(this.state.themeId);
    this.paint();
    // 拉取权限/agent 预设目录写入 state（状态列 Mode 块可选值；缺默服务则保持降级）
    this.refreshCatalogs();
    // 拉取宿主命令注册表目录（输入补全候选；服务缺失时仅本地目录）
    this.refreshCommandCatalog();
    // 补 Mode 块初始值（log-only 事件启动不产生，从会话日志折叠一次）
    this.refreshSessionModes();
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
   * 刷新当前会话 Mode 初始值（plan/sandbox/permission/policy）：log-only 事件
   * 启动不产生，主动从会话日志折叠一次补 Mode 块快照；宿主无读取面时静默。
   */
  private refreshSessionModes(): void {
    const a = this.deps.adapter;
    // 启动初期 state.activeSessionId 尚为 null（真实 adapter 不发 session-list、
    // 全新会话 title 要等首条消息）→ 按 adapter 视角的活跃会话 id 兜底
    const sid = this.state.activeSessionId ?? a.sessionId;
    if (!a.refreshSessionModes || !sid) return;
    void a
      .refreshSessionModes(sid)
      .then(() => {
        if (!this.disposed) this.paint();
      })
      .catch(() => {});
  }

  /** 生效模型缓存 key；值变化才重绘（避免每 5s 空重绘） */
  private modelStatusKey: string | undefined;

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
    this.disposed = true;
    this.dropThinking();
    this.pendingStream = [];
    this.pendingTurnEnd = false;
    for (const f of this.unbindEvents) f();
    this.unbindEvents = [];
    this.deps.adapter.dispose?.();
    this.deps.renderer.close();
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
          if (wasUnidentified) this.refreshSessionModes();
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
        if (this.deps.slowStream && this.slowTimer) {
          // 思考打字机进行中：正文段入缓冲，等思考放完再即时显示(不限制正文流速)；
          // 正文已到=模型进入正题，剩余思考加速放完
          this.slowCps = SLOW_STREAM_ARRIVED_CPS;
          this.pendingStream.push(e.text);
        } else {
          this.apply((s) => reduceState(s, { type: "append", text: e.text }));
        }
        break;
      case "thinking":
        if (
          this.state.activeSessionId &&
          e.sessionId !== this.state.activeSessionId
        ) {
          break;
        }
        this.beginTurnIfNeeded();
        if (this.deps.slowStream) {
          // 打字机只作用于 thinking(reasoning)：逐段放出便于阅读；正文不受此限制。
          // 每个 turn 的思考从初始流速开始（正文加速仅限当次回合）
          if (this.slowNewTurn) {
            this.slowNewTurn = false;
            this.slowCps = this.slowCpsBase;
          }
          this.thinkingPending += e.text;
          this.slowStart();
        } else {
          this.apply((s) => reduceState(s, { type: "thinking", text: e.text }));
        }
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
        // turn 结束：不再画分隔线(下个回合开始时画)；登记下轮流速回落。
        // 思考打字机进行中则等其放完再清思考(不打断思考读取)
        this.slowNewTurn = true;
        this.turnOpen = false;
        if (this.deps.slowStream && this.slowTimer) {
          this.pendingTurnEnd = true;
        } else {
          this.apply((s) => reduceState(s, { type: "turn-end" }));
          this.warnStrippedChars();
        }
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
        break;
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

  /** 回合开始：先画分隔线(仅首个回合空历史时跳过)；submit 与首条思考/正文均需走这里 */
  private beginTurnIfNeeded(): void {
    if (this.turnOpen) return;
    this.turnOpen = true;
    this.apply((s) => reduceState(s, { type: "turn-begin" }));
  }

  /** 启动 thinking 打字机；已在跑或已 disposed 时不动 */
  private slowStart(): void {
    if (this.slowTimer || this.disposed) return;
    this.slowTimer = setInterval(() => {
      if (this.thinkingPending === "") {
        this.flushPending();
        return;
      }
      // 分数累计配额：cps→每 tick 的字符数，余数跨 tick 保留（低速也逐步输出）
      this.slowCredit += (this.slowCps * SLOW_TICK_MS) / 1000;
      let n = Math.floor(this.slowCredit);
      this.slowCredit -= n;
      if (n < 1) return; // 本 tick 不足 1 字符，继续等待下一 tick
      const pts = Array.from(this.thinkingPending);
      n = Math.min(n, pts.length);
      const text = pts.slice(0, n).join("");
      this.thinkingPending = pts.slice(n).join("");
      this.apply((s) => reduceState(s, { type: "thinking", text }));
      this.paint();
      if (this.thinkingPending === "") this.flushPending();
    }, SLOW_TICK_MS);
  }

  /** thinking 放完后：按序即时显示积压正文，再补挂起的 turn-end(不再画线；思考保留显示) */
  private flushPending(): void {
    this.slowStop();
    const texts = this.pendingStream;
    this.pendingStream = [];
    if (texts.length > 0) {
      this.dropThinking(); // 正文 append 会清除 thinking 行，未放完的队列一并丢弃
      for (const t of texts)
        this.apply((s) => reduceState(s, { type: "append", text: t }));
      this.paint();
    }
    if (this.pendingTurnEnd) {
      this.pendingTurnEnd = false;
      this.dropThinking();
      this.apply((s) => reduceState(s, { type: "turn-end" }));
      this.warnStrippedChars();
      this.paint();
    }
  }

  private slowStop(): void {
    if (this.slowTimer) {
      clearInterval(this.slowTimer);
      this.slowTimer = null;
    }
  }

  /** 正文/turn-end 接管：思考为瞬态展示，未放完的队列直接丢弃（正文即时优先） */
  private dropThinking(): void {
    this.slowStop();
    this.thinkingPending = "";
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

  private handleKey(k: KeyEvent): void {
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

    // /jobs 任务面板：↑/↓ 移动高亮、Enter 取消高亮任务、Esc 关闭；其余按键吞掉
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
      // 翻页页高 = 活动区可视行数（与面板窗口同口径，见 COMMANDS-SPEC.md §0.4 接线点 5）
      const page = inputPanelHeights(
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
        } else {
          void this.showPanelDetail(panel.kind, row.payload);
        }
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
      if (this.state.agentStatus === "idle" && this.state.inputText === "") {
        this.dispose();
      }
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
        // Esc：打断运行（agent 非 idle 时 interrupt；picker 面板已在上方分支关闭）。
        // idle + 空输入：退出顶部面板焦点循环（有焦点 → 回到无焦点）
        if (this.state.agentStatus !== "idle") {
          this.deps.adapter.interrupt();
        } else if (this.state.inputText === "" && this.state.focusedPanel) {
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
        if (panel === "activity" || panel === "status") {
          this.apply((s) => reduceState(s, focusedLineScroll(panel, dir)));
        } else {
          const { dialogueH } = dialogueScrollMetrics(
            this.state,
            this.deps.renderer.getSize(),
          );
          this.apply((s) =>
            reduceState(s, {
              type: "scroll",
              delta: dir * dialogueHalfPage(dialogueH),
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
          const page = inputPanelHeights(
            this.state,
            this.deps.renderer.getSize(),
          );
          this.apply((s) =>
            reduceState(s, focusedPageScroll(panel, dir, page)),
          );
        } else {
          const m = dialogueScrollMetrics(
            this.state,
            this.deps.renderer.getSize(),
          );
          const jump = userInputJump(
            this.state.buffer,
            m.contentW,
            this.state.messageGutter,
            this.state.themeId,
            m.dialogueH,
            this.state.followBottom,
            this.state.scrollOffset,
            dir,
          );
          if (jump)
            this.apply((s) => reduceState(s, { type: "user-jump", ...jump }));
        }
        break;
      }
      case "home":
        this.apply((s) => ({ ...s, scrollOffset: 0, followBottom: true }));
        break;
      case "end":
        this.apply((s) => ({
          ...s,
          scrollOffset: Number.MAX_SAFE_INTEGER,
          followBottom: false,
        }));
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
    // 回合开始时先画分隔线(上一轮内容 → 新回合内容)
    this.beginTurnIfNeeded();
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

  private submit(interrupt = false): void {
    const text = this.state.inputText.trim();
    if (!text) return;
    // Alt+Enter：先打断当前 agent，再发送（普通 Enter 排队发送路径无标志）
    if (interrupt) this.deps.adapter.interrupt();
    const mode = this.state.inputMode;
    // 记录本次提交所用模式：提示符左字符符号来源（随后 inputMode 回退 normal 不影响）
    this.apply((s) => reduceState(s, { type: "last-submit-mode", mode }));
    // slash 模式：自动补 "/" 前缀走既有路由（规则：文本中不需要再在开头加 /）
    const slashLine =
      mode === "slash" && !text.startsWith("/") ? "/" + text : text;
    if (slashLine.startsWith("/")) {
      this.handleSlash(slashLine);
      this.apply((s) => reduceState(s, { type: "input", text: "", cursor: 0 }));
      this.apply((s) => reduceState(s, { type: "input-mode", mode: "normal" }));
      return;
    }
    this.sendUserText(text);
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
            text: this.helpText(),
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
        // /goal 不再打开面板：goal/todo 详情常驻右侧顶部状态列
        this.notice("goal/todo 详情见右侧信息栏", "info");
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
      case "fork":
        this.handleForkCommand();
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
    this.notice(`theme: ${next} (${THEMES[next].name})`, "success");
  }

  /** 面板 d/Delete：进入删除二次确认（不可删时以 notice 说明原因，不改列表） */
  private confirmDeleteRecord(): void {
    const h = this.state.history;
    const rec = h ? historyVisibleRecords(this.state)[h.index] : undefined;
    if (!h || !rec) return;
    if (rec.current === true) {
      this.historyNotice("当前活跃会话不可删除", "warn");
      return;
    }
    if (rec.live) {
      this.historyNotice(
        "live 会话不可删除（仅可删除已持久化的非活跃会话）",
        "warn",
      );
      return;
    }
    if (!rec.persisted) {
      this.historyNotice("该会话未持久化，没有可删除的文件", "warn");
      return;
    }
    if (!this.deps.adapter.deleteSession) {
      this.historyNotice("会话删除不可用（宿主未挂载 sessionQuery）", "warn");
      return;
    }
    this.apply((st) => reduceState(st, { type: "history-confirm-delete" }));
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
      const id = h.pendingDelete;
      if (!id) return;
      // 先取标题再删记录：historyRecordLabel 依赖面板记录，删后只剩短 id
      const label = this.historyRecordLabel(id);
      this.apply((st) => reduceState(st, { type: "history-delete" }));
      this.paint();
      let removed = false;
      let reason: string | undefined;
      try {
        // SAFETY: adapter 方法未约定自带绑定（实现可为原型方法），
        // 按接收者调用保留 this（同 setApprovalPolicy 的 .call(adapter) 约定）
        const res = await del.call(adapter, id);
        removed = res.ok;
        if (!res.ok) reason = res.reason;
      } catch (err) {
        reason = String(err);
      }
      this.apply((st) =>
        reduceState(st, { type: "history-delete-done", id, removed }),
      );
      this.paint();
      if (!removed) {
        this.historyNotice(`删除失败：${reason ?? "未知原因"}`, "error");
        return;
      }
      this.historyNotice(`已删除会话「${label}」`, "success");
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
      // 新会话 Mode 初始值（log-only 事件不随 resume 回放，主动折叠一次）
      this.refreshSessionModes();
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
      .catch(() => this.notice(`${label} 服务不可用`, "warn"));
  }

  /** 面板 Enter（详情型 kind：skills / tools）：读取正文并以 info notice 展示；
   *  服务缺失/失败 → warn。面板占满活动区会遮住瞬态 notice（与 /jobs 一致），
   *  故先关面板再提示详情。 */
  private async showPanelDetail(
    kind: "skills" | "tools",
    name: string,
  ): Promise<void> {
    const adapter = this.deps.adapter;
    const label = kind === "skills" ? "skills" : "tools";
    const detail = kind === "skills" ? adapter.skillDetail : adapter.toolDetail;
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

  private helpText(): string {
    return [
      "本地命令：",
      "  /help   显示本帮助",
      "  /clearscreen (/cls)  清空缓冲(只清显示，不动上下文)",
      "  /quit   退出",
      "  /theme [dark|light|toggle]  切换主题(默认 dark=fffdark, light=ffflight)",
      "  /session  会话列表：Enter 切换到 persisted 会话(live 不可续)",
      "  /goal     当前会话目标迷你面板（goal/todo 只读；↑/↓ 滚动，Esc 关闭）",
      "  /copy     复制最后一条模型回复到剪贴板(OSC52)",
      "  /model [provider/]model  switch current-session model; bare /model: interactive picker",
      "  /provider、/effort (/thinking)  无参直达 /model 面板并定位到 provider / effort 列",
      "  /permission [预设名]  权限预设（sandbox+审批捆绑；无参列当前与可用，带参切换）",
      "  /preset [预设名]      agent 预设目录（无参列当前/可用/默认，带参切换）",
      "  /jobs 后台任务面板（只读列表；↑/↓ 选择、Enter 取消、Esc 关闭）",
      "  /init    初始化 AGENTS.md（当前目录缺失时由模型阅读目录生成；已存在则提示退出）",
      "  /stats (/usage /context)  本回合 token 用量与上下文占比（最近一次模型调用）",
      "  /rename <标题>  重命名当前会话标题",
      "  /skills [过滤]  技能目录面板（↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      "  /agents  子代理面板（↑/↓ 选择、Enter 直接中断选中项、Esc 关闭）",
      "  /tools [过滤]  工具目录面板（↑/↓ 选择、PgUp/PgDn 翻页、Enter 详情、Esc 关闭）",
      "  /settings  只读展示配置（ns：value，secret 脱敏）",
      "  /fork  分叉当前会话为新会话（success 提示 + 必要时提示用 /session 查看）",
      "其他 /name 通过 commands 注册表执行(未命中则提示未知命令)。",
    ].join("\n");
  }

  /** 接受补全候选（Tab）：候选名写入输入框并补尾随空格（便于接参数），
   *  列表随输入重算自动收起（`/name ` 已非命令 token）。 */
  /** 补全面板可显示的候选行数（活动区可视行 - 标题行；与 CommandCompletion 渲染同口径） */
  private completionVisibleRows(): number {
    const activityH = inputPanelHeights(
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
    const frame = buildFrame(this.state, size);
    this.deps.renderer.refresh(frame);
  }

  private paint(): void {
    if (this.disposed) return;
    const size = this.deps.renderer.getSize();
    const frame = buildFrame(this.state, size);
    this.deps.renderer.render(frame);
  }

  private apply(fn: (s: AppState) => AppState): void {
    this.state = fn(this.state);
  }
}
