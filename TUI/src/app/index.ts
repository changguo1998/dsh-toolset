// src/app/index.ts — App 组装层：renderer + 状态 + adapter 事件流
//
// 只依赖 renderer 公共 API 与 adapter 接口契约，不感知 adapter 实现。
// 处理按键、接收事件、重绘。

import type { Renderer, KeyEvent } from "../renderer/index.ts";
import type { AppState, InputMode } from "./state.ts";
import { initialState, reduceState } from "./state.ts";
import type {
  DshAdapter,
  DshEvent,
  ModelCatalog,
  ModelSelection,
} from "./adapter/dsh.ts";
import { parseSlashCommand } from "./adapter/dsh.ts";
import { buildFrame, modelLabel } from "./layout.ts";
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
/** 收到正文回复(stream)后：剩余思考的加速流速(尽快进入正题) */
const SLOW_STREAM_ARRIVED_CPS = 200;

export interface AppDeps {
  renderer: Renderer;
  adapter: DshAdapter;
  /** 可选：系统状态区数据源；提供后 App 自动启动合并节流 ticker */
  status?: {
    queries: StatusQueries;
    intervalMs?: number;
  };
  /** 初始主题（默认 dark=BlueDark；/theme 切换仅当前会话） */
  initialTheme?: ThemeId;
  /** 真实链路：流式正文放缓显示(打字机节奏)；mock demo 默认关闭保持原速 */
  slowStream?: boolean;
  /** 打字机流速(字符/秒，合法性由 main 归一化；兜底 SLOW_DEFAULT_CPS) */
  streamCharsPerSecond?: number;
  /** thinking/reasoning 最大显示行数（默认 4，经 initialState 落到 state） */
  thinkingMaxLines?: number;
  /** 用户块左缘/回复右缘对称留空(列数，默认 4，经 initialState 落到 state) */
  messageGutter?: number;
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
  /** 思考放完前到达的 turn-end 记下，放完后补插分隔线 */
  private pendingTurnEnd = false;
  private slowTimer: ReturnType<typeof setInterval> | null = null;
  private slowCps = SLOW_DEFAULT_CPS;
  /** 每 turn 思考的初始流速（配置值或默认）；正文加速后在下个 turn 回落 */
  private slowCpsBase = SLOW_DEFAULT_CPS;
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
        thinkingMaxLines: this.deps.thinkingMaxLines,
        messageGutter: this.deps.messageGutter,
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
  }

  /** 生效模型缓存 key；值变化才重绘（避免每 5s 空重绘） */
  private modelStatusKey: string | undefined;

  /** 读取生效模型(会话切换 ?? 宿主默认)写入状态栏 model；无变化时跳过 */
  private refreshModelStatus(): void {
    void this.deps.adapter.modelCatalog().then((catalog) => {
      if (this.disposed) return;
      const cur = catalog.current;
      if (!cur?.provider || !cur.model) return;
      const key = modelLabel(cur);
      if (key === this.modelStatusKey) return;
      this.modelStatusKey = key;
      this.apply((s) =>
        reduceState(s, { type: "status", status: { model: key } }),
      );
      this.paint();
    });
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
    switch (e.type) {
      case "session-list":
        this.apply((s) =>
          reduceState(s, { type: "sessions", sessions: e.sessions }),
        );
        break;
      case "stream":
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
      case "notice":
        // 命令通知(结果/提示/错误)只进 UI 缓冲，绝不进模型历史；
        // error 标记(如未知 slash 命令 fail-close)→ 输入栏失败色(红)
        this.apply((s) =>
          reduceState(s, { type: "notice", text: e.text, error: e.error }),
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
        }
        break;
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

  /** thinking 放完后：按序即时显示积压正文，再补挂起的 turn-end(仅清思考，不再画线) */
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

  private handleKey(k: KeyEvent): void {
    if (this.disposed) return;
    const { name, ctrl } = k;

    // 审批模式：y/n + 滚动
    if (this.state.approval && (name === "y" || name === "n")) {
      const allow = name === "y";
      this.deps.adapter.approve(this.state.approval.id, allow);
      this.apply((s) => reduceState(s, { type: "approval", approval: null }));
      this.paint();
      return;
    }

    // /model 交互面板：↑/↓ 移动焦点箭头（位置指示），空格把焦点行写入
    // 选中（星号，Enter 提交它，不提交；真实键盘空格为普通字符 " "），
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
        // provider/model 区移动后重载思考等级（thinking 区移动不重载）
        const phase = this.state.picker?.phase;
        if (phase === 0 || phase === 1) void this.reloadPickerEfforts();
        return;
      }
      if (name === " " || name === "space") {
        this.apply((s) => reduceState(s, { type: "picker-select" }));
        this.paint();
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
        // 关闭面板；Esc 是唯一重置输入模式的交互（Enter 确认保留模式）
        this.apply((s) => reduceState(s, { type: "picker-close" }));
        this.apply((s) =>
          reduceState(s, { type: "input-mode", mode: "normal" }),
        );
        this.paint();
        return;
      }
      return;
    }

    // Ctrl+D：仅 idle 且输入区为空时退出（输入非空时按无操作忽略）
    if (ctrl && name === "d") {
      if (this.state.agentStatus === "idle" && this.state.inputText === "") {
        this.deps.renderer.close();
      }
      return;
    }

    // Ctrl+L：强制整帧重绘（绕过 delta 优化）。放在 switch 前，避免吞掉普通 'l' 输入。
    if (ctrl && name === "l") {
      this.refresh();
      return;
    }

    switch (name) {
      case "escape":
        // Esc：退回一般模式（符号代表模式；非 normal 时吞键回 >，不打断 agent）
        if (this.state.inputMode !== "normal") {
          this.apply((s) =>
            reduceState(s, { type: "input-mode", mode: "normal" }),
          );
        }
        break;
      case "tab":
        // ponytail: 单会话占位，多会话基建落地后再实现真正的标签页切换
        this.apply((s) =>
          reduceState(s, {
            type: "notice",
            text: "标签页切换待实现（当前为单会话）",
          }),
        );
        break;
      case "up":
        this.apply((s) => reduceState(s, { type: "scroll", delta: 1 }));
        break;
      case "down":
        this.apply((s) => reduceState(s, { type: "scroll", delta: -1 }));
        break;
      case "pageup":
        this.apply((s) => reduceState(s, { type: "scroll", delta: 10 }));
        break;
      case "pagedown":
        this.apply((s) => reduceState(s, { type: "scroll", delta: -10 }));
        break;
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
        this.apply((s) => this.backspace(s));
        break;
      case "enter":
        this.submit();
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
        // 模式键：输入框为空时按 ! / $ / / 切换模式并吞键（> 不参与；同符号幂等）
        if (
          name.length === 1 &&
          !ctrl &&
          this.state.inputText === "" &&
          (name === "!" || name === "$" || name === "/")
        ) {
          const mode: InputMode =
            name === "!" ? "interrupt" : name === "$" ? "shell" : "slash";
          if (this.state.inputMode !== mode) {
            this.apply((s) => reduceState(s, { type: "input-mode", mode }));
          }
          break;
        }
        // 可打印字符：插入输入框（Esc/Ctrl+C 不再触发退出；退出请用 /quit 或系统信号）
        if (name.length === 1 && !ctrl) this.insertChar(name);
        break;
    }
    this.paint();
  }

  private submit(): void {
    const text = this.state.inputText.trim();
    if (!text) return;
    const mode = this.state.inputMode;
    // slash 模式：自动补 "/" 前缀走既有路由（规则：文本中不需要再在开头加 /）
    const slashLine =
      mode === "slash" && !text.startsWith("/") ? "/" + text : text;
    if (slashLine.startsWith("/")) {
      this.handleSlash(slashLine);
      this.apply((s) => reduceState(s, { type: "input", text: "", cursor: 0 }));
      return;
    }
    // 打断模式：先打断当前 agent，再发送新消息（立即置进行中，黄）
    if (mode === "interrupt") this.deps.adapter.interrupt();
    this.apply((s) =>
      reduceState(s, { type: "input-status", status: "running" }),
    );
    // 真实 DSH 不回显 user/message,由 app 在发送前本地追加用户行。
    // 回合开始时先画分隔线(上一轮内容 → 分隔线 → 新用户消息)
    this.beginTurnIfNeeded();
    this.apply((s) => reduceState(s, { type: "user-line", text }));
    this.deps.adapter.sendMessage(
      text,
      this.state.activeSessionId ?? undefined,
    );
    this.apply((s) => reduceState(s, { type: "input", text: "", cursor: 0 }));
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
        reduceState(s, { type: "notice", text: "无效命令: " + line }),
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
    switch (name) {
      case "help":
        this.apply((s) =>
          reduceState(s, {
            type: "notice",
            text: this.helpText(),
          }),
        );
        return;
      case "clearscreen":
      case "cls":
        this.apply((s) => reduceState(s, { type: "clear-buffer" }));
        return;
      case "quit":
        this.deps.renderer.close();
        return;
      case "model":
        void this.handleModelCommand(line);
        return;
      case "theme":
        this.handleThemeCommand(line);
        return;
      default:
        // 非本地命令 → 注册表调用
        this.deps.adapter.runCommand(
          line,
          this.state.activeSessionId ?? undefined,
        );
    }
  }

  /** /model 命令：无参进入交互选择；带参切换当前会话模型（保留当前 reasoningEffort） */
  private async handleModelCommand(line: string): Promise<void> {
    const spec = line.slice("/model".length).trim();
    try {
      if (!spec) {
        const catalog = await this.deps.adapter.modelCatalog();
        this.openModelPicker(catalog);
        return;
      }
      const catalog = await this.deps.adapter.modelCatalog();
      const resolved = resolveModelSpec(catalog, spec);
      if ("error" in resolved) {
        this.notice(resolved.error);
        return;
      }
      await this.applyModelSelection(resolved.selection);
    } catch (err) {
      this.notice("model command failed: " + String(err));
    }
  }

  /** /theme 命令：无参/toggle 在 dark|light 间切换；带参显式设置；非法参数提示 usage */
  private handleThemeCommand(line: string): void {
    const arg = line.slice("/theme".length).trim().toLowerCase();
    const cur = this.state.themeId;
    let next: ThemeId;
    if (arg === "" || arg === "toggle") {
      next = cur === "dark" ? "light" : "dark";
    } else if (arg === "light" || arg === "dark") {
      next = arg;
    } else {
      this.notice("usage: /theme [light|dark|toggle]");
      return;
    }
    if (next !== cur) {
      this.apply((s) => reduceState(s, { type: "set-theme", themeId: next }));
      this.deps.renderer.setTheme(next);
      this.paint();
    }
    this.notice(`theme: ${next} (${THEMES[next].name})`);
  }

  /** 无参 /model：进入交互选择模式（当前模型行始终显示，不在候选目录中也补行） */
  private openModelPicker(catalog: ModelCatalog): void {
    const current = catalog.current;
    // provider 列：去重（当前 provider 恒首位，可能不在 catalog.providers 中）
    const providers: string[] = [];
    const pushProvider = (p: string | undefined) => {
      if (p && !providers.includes(p)) providers.push(p);
    };
    pushProvider(current?.provider);
    for (const pr of catalog.providers) pushProvider(pr.provider);
    for (const m of catalog.models) pushProvider(m.provider);
    // 每个 provider 的模型列表（去重；当前模型恒首位，可能不在目录中）
    const providerModels: Record<string, string[]> = {};
    const pushModel = (p: string | undefined, id: string | undefined) => {
      if (!p || !id) return;
      const list = providerModels[p] ?? (providerModels[p] = []);
      if (!list.includes(id)) list.push(id);
    };
    pushModel(current?.provider, current?.model);
    for (const m of catalog.models) pushModel(m.provider, m.id);
    const models = providerModels[providers[0]!] ?? [];
    if (models.length === 0) {
      this.notice(
        "no available models (llm service missing or no adapter registered)",
      );
      return;
    }
    this.apply((s) =>
      reduceState(s, {
        type: "picker-open",
        picker: {
          providers,
          providerIndex: 0,
          providerModels,
          models,
          modelIndex: 0,
          efforts: [],
          effortIndex: 0,
          phase: 0,
          // 初始选中 = 当前生效值（打开面板 Enter 不改模型）
          selectedProvider: current?.provider,
          selectedModel: current?.model,
          selectedEffort: current?.reasoningEffort,
          current:
            current?.provider && current?.model
              ? {
                  provider: current.provider,
                  model: current.model,
                  reasoningEffort: current.reasoningEffort,
                }
              : undefined,
        },
      }),
    );
    this.paint();
    void this.reloadPickerEfforts();
  }

  /** 按当前高亮 model 异步加载思考等级，落定后再下发（面板可能已关闭/换行） */
  private async reloadPickerEfforts(): Promise<void> {
    const picker = this.state.picker;
    if (!picker) return;
    const model = picker.models[picker.modelIndex];
    const provider = picker.providers[picker.providerIndex];
    if (!model) return;
    try {
      const efforts = await this.deps.adapter.modelEfforts(
        provider ?? "",
        model,
      );
      if (this.disposed) return;
      const cur = this.state.picker;
      const prevModel = cur?.models[cur.modelIndex];
      if (!cur || prevModel !== model) {
        return; // 已切换高亮模型或面板关闭，丢弃旧结果
      }
      // 当前生效模型自带等级时，预设为列表中同一等级（其余默认第一项）
      const onCurrent =
        cur.current &&
        cur.current.model === model &&
        cur.current.provider === (provider ?? "");
      const wantIdx =
        onCurrent && cur.current?.reasoningEffort
          ? (efforts?.findIndex((e) => e.id === cur.current!.reasoningEffort) ??
            -1)
          : -1;
      const expectedIndex = wantIdx >= 0 ? wantIdx : 0;
      this.apply((s) =>
        reduceState(s, {
          type: "picker-efforts",
          efforts: efforts ?? [],
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
    const provider =
      picker.selectedProvider ?? picker.providers[picker.providerIndex];
    const model = picker.selectedModel ?? picker.models[picker.modelIndex];
    const effort = picker.selectedEffort
      ? picker.efforts.find((e) => e.id === picker.selectedEffort)
      : picker.efforts[picker.effortIndex];
    this.apply((s) => reduceState(s, { type: "picker-close" }));
    if (!provider || !model) return;
    const selection: ModelSelection = { provider, model };
    if (effort) selection.reasoningEffort = effort.id; // 无等级可选 → 不带 effort
    try {
      await this.applyModelSelection(selection);
    } catch (err) {
      this.notice("model command failed: " + String(err));
    }
  }

  /** 切换当前会话模型（只改会话内引用，不写宿主设置）；/model 带参与交互选择共用 */
  private async applyModelSelection(selection: ModelSelection): Promise<void> {
    const catalog = await this.deps.adapter.modelCatalog();
    const cur = catalog.current;
    // 面板已显式选了等级时用面板选择，否则沿用当前模型的等级（/model <id> 路径）
    const effort = selection.reasoningEffort ?? cur?.reasoningEffort;
    if (
      cur &&
      cur.provider === selection.provider &&
      cur.model === selection.model &&
      (cur.reasoningEffort ?? "") === (effort ?? "")
    ) {
      const label = modelLabel(selection);
      this.notice(`already on current model ${label}`);
      return;
    }
    const sel: ModelSelection = effort
      ? { ...selection, reasoningEffort: effort }
      : selection;
    const saved = await this.deps.adapter.setSessionModel(sel);
    const label = modelLabel(saved);
    this.apply((s) =>
      reduceState(s, { type: "status", status: { model: label } }),
    );
    this.notice(`current model -> ${label}`);
  }

  /** 追加一条命令通知并重绘（/model 结果/错误统一入口） */
  private notice(text: string): void {
    if (this.disposed) return;
    this.apply((s) => reduceState(s, { type: "notice", text }));
    this.paint();
  }

  private helpText(): string {
    return [
      "本地命令：",
      "  /help   显示本帮助",
      "  /clearscreen (/cls)  清空缓冲(只清显示，不动上下文)",
      "  /quit   退出",
      "  /theme [dark|light|toggle]  切换主题(默认 dark=BlueDark, light=YellowBright)",
      "  /model [provider/]model  switch current-session model; bare /model: interactive picker",
      "其他 /name 通过 commands 注册表执行(未命中则提示未知命令)。",
    ].join("\n");
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

// ---------------------------------------------------------------------------
// /model 辅助（纯函数，便于单测）
// ---------------------------------------------------------------------------

/** 格式化模型目录为多行文本（/model 无参输出）：纯 ASCII，当前模型前 ->、其余空格缩进 */
export function formatModelCatalog(catalog: ModelCatalog): string {
  const current = catalog.current;
  const lines: string[] = [];
  // listModels 为 advisory 目录，当前默认模型可能不在其中——始终渲染为首行并带 -> 标记
  if (current?.provider && current?.model) {
    lines.push(`  -> ${current.provider}/${current.model}`);
  }
  for (const m of catalog.models) {
    const key = `${m.provider}/${m.id}`;
    const isCurrent =
      current?.provider === m.provider && current?.model === m.id;
    if (isCurrent) continue;
    lines.push(`     ${key}`);
  }
  if (lines.length === 0) {
    return "no available models (llm service missing or no adapter registered)";
  }
  return lines.join("\n");
}

/** 解析 /model <spec>：显式 provider/model 直通；裸 model id 需跨 provider 唯一匹配 */
export function resolveModelSpec(
  catalog: ModelCatalog,
  spec: string,
): { error: string } | { selection: ModelSelection; same: boolean } {
  const current = catalog.current;
  const same = (p: string, m: string): boolean =>
    current?.provider === p && current?.model === m;
  const slash = spec.indexOf("/");
  if (slash >= 0) {
    const provider = spec.slice(0, slash);
    const model = spec.slice(slash + 1);
    if (!provider || !model)
      return {
        error: "usage: /model <provider>/<model> or /model <modelId>",
      };
    return { selection: { provider, model }, same: same(provider, model) };
  }
  const matches = catalog.models.filter((m) => m.id === spec);
  if (matches.length === 0)
    return {
      error: `model "${spec}" not found in available models. Use /model to list.`,
    };
  if (matches.length > 1) {
    const ps = matches.map((m) => m.provider).join(", ");
    return {
      error: `model "${spec}" exists in multiple providers (${ps}). Use /model <provider>/<model>.`,
    };
  }
  const m = matches[0]!;
  return {
    selection: { provider: m.provider, model: m.id },
    same: same(m.provider, m.id),
  };
}
