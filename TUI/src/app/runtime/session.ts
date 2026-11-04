// TUI/src/app/runtime/session.ts — 会话控制: 提交 / shell / 会话历史与恢复 / 会话状态快照
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  cleanableSessionIds,
  historyVisibleRecords,
  isCompacting,
  isUserMessage,
  markableSessionIds,
  reduceState,
  currentProjectCwd,
} from "../state.ts";
import type {
  HistoryMessage,
  SessionInfo,
  SessionSurfaceView,
  ContinueTarget,
  SessionUiState,
} from "../adapter/dsh.ts";
import type { NoticeTone } from "../adapter/types.ts";
import { joinedLastTextBySource } from "../layout/pipeline/sections.ts";
import {
  SESSION_UI_STATE_VERSION,
  pickContinueTarget,
} from "../adapter/dsh.ts";
import {
  resolveShellCwd,
  SHELL_GUARD_SKIPPED_LINE,
  shellGuardBlockedLines,
  shellResultLines,
} from "../local-shell.ts";
import {
  INIT_PROMPT,
  buildOsc52,
  deriveTitle,
  renameCommandDecision,
  surfaceToBuffer,
} from "../commands.ts";
import { sectionsOf } from "../layout/pipeline/frame.ts";
import type { AppContext } from "./context.ts";

/** 会话状态快照落盘合并窗口(ms)：/model、/collapse、模式事件等连续变更只写一次文件 */
const SESSION_STATE_SAVE_MS = 400;

export function createSessionPart(ctx: AppContext) {
  /**
   * 回填当前会话状态（启动、切换会话成功后调用）：模型选择、plan/sandbox/permission/
   * policy、goal/todo、TUI 本地开关（verbose/symbol-unify）。宿主日志里的 log-only
   * 事件启动不产生、切会话也不重放，故主动折叠一次；TUI 本地开关只在会话状态快照里。
   * 回填后刷新状态行模型徽标（会话内模型引用已被 adapter 写回）。
   */
  function restoreSessionState(): void {
    const a = ctx.deps.adapter;
    // 启动初期 state.activeSessionId 尚为 null（真实 adapter 不发 session-list、
    // 全新会话 title 要等首条消息）→ 按 adapter 视角的活跃会话 id 兜底
    const sid = ctx.state.activeSessionId ?? a.sessionId;
    if (!a.restoreSessionState || !sid) return;
    void a
      .restoreSessionState(sid)
      .then(() => {
        if (ctx.disposed) return;
        ctx.self.refreshModelStatus();
        ctx.self.paint();
      })
      .catch(() => {});
  }

  /**
   * TUI#40：CLI **启动即恢复**（`--resume <id>` / `-c`）时把既有消息折叠进 buffer。
   *
   * 背景：启动路径只走 `main.ts` 的 `agents.resume` + `restoreSessionState()`（model/mode/
   * goal/todo 回填），历史行折叠原先只在 `/session` 面板切换路径发生 → 启动后会话区为空、
   * 需手动再切一次会话才可见内容（agent 侧上下文其实已恢复）。
   *
   * 口径：复用 `/session` 路径同一段折叠（`surfaceToBuffer` → `history-restore`），
   * 不新建第二条渲染路径；`readSessionSurface` 缺失 / 读取失败 / 空会话 → 保持空历史并提示
   * （不阻塞启动）；迟到结果在 disposed 或会话已切走时丢弃。
   */
  function restoreStartupHistory(): void {
    const a = ctx.deps.adapter;
    if (a.resumedAtLaunch !== true) {
      flushKickoffPending();
      return;
    }
    const read = a.readSessionSurface;
    const sid = ctx.state.activeSessionId ?? a.sessionId;
    if (!read || !sid) {
      flushKickoffPending();
      return;
    }
    void read
      .call(a, sid)
      .then((view) => {
        if (ctx.disposed) return;
        // 陈旧守卫：会话已切走（非同一 id）→ 丢弃
        if (
          ctx.state.activeSessionId !== null &&
          ctx.state.activeSessionId !== sid
        ) {
          return;
        }
        if (view.messages.length === 0) return; // 空会话：保持空历史
        const firstUser = view.messages.find((m) => isUserMessage(m.role));
        const title =
          ctx.state.sessionTitle !== ""
            ? ctx.state.sessionTitle
            : deriveTitle(firstUser?.text);
        const rows = surfaceToBuffer(view.messages);
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "history-restore",
            id: sid,
            title,
            rows,
          }),
        );
        ctx.self.apply((s) => reduceState(s, { type: "queued-clear" }));
        // 六步流水线：恢复的历史行重放成节缓存（此后新事件继续按节增量接收）
        ctx.self.replaySectionsFromRows(rows);
        ctx.self.paint();
      })
      .catch(() => ctx.self.notice("启动恢复：既有消息读取失败", "warn"))
      // 无论折叠成功与否都补发挂起的 kickoff（读取失败不该吞掉启动自检）
      .finally(() => flushKickoffPending());
  }

  /** 当前 TUI 视角的会话状态快照（宿主不掌握 verbose/symbol-unify；模型/模式作兜底） */
  function sessionUiState(): SessionUiState {
    const sid = ctx.state.activeSessionId ?? ctx.deps.adapter.sessionId ?? "";
    const model = ctx.state.modelBySession[sid];
    const mode = ctx.state.modeBySession[sid] ?? {};
    const policy = ctx.state.policyBySession[sid];
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
      symbolUnify: ctx.state.symbolUnify,
      // P7：垂直状态列显隐（TUI 本地开关，随会话持久化）
      statusColumn: ctx.state.statusColumnVisible,
      // #9：下半区（Turn/Tool）显隐（TUI 本地开关，随会话持久化）
      lowerPanes: ctx.state.lowerPanesVisible,
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
  function scheduleSessionStateSave(): void {
    const a = ctx.deps.adapter;
    if (!a.saveSessionUiState) return;
    const sid = ctx.state.activeSessionId ?? a.sessionId;
    if (!sid) return;
    ctx.sessionStatePendingSid = sid;
    if (ctx.sessionStateTimer) clearTimeout(ctx.sessionStateTimer);
    ctx.sessionStateTimer = setTimeout(() => {
      ctx.sessionStateTimer = null;
      flushSessionStateSave();
    }, SESSION_STATE_SAVE_MS);
    ctx.sessionStateTimer.unref?.();
  }

  /** 立即落盘待写的会话状态快照（切换会话前、退出时调用；无待写则 no-op） */
  function flushSessionStateSave(): void {
    if (ctx.sessionStateTimer) {
      clearTimeout(ctx.sessionStateTimer);
      ctx.sessionStateTimer = null;
    }
    const sid = ctx.sessionStatePendingSid;
    ctx.sessionStatePendingSid = null;
    const save = ctx.deps.adapter.saveSessionUiState;
    if (!sid || !save) return;
    try {
      save.call(ctx.deps.adapter, sid, sessionUiState());
    } catch {
      /* 快照落盘失败不影响渲染与退出 */
    }
  }

  /** 启动自检 kickoff 调度（BACKLOG TUI「启动后自动触发首轮工具调用」）：门控（开关 /
   *  模型 / 会话未解锁）已在 main.ts 判过，这里只管时机——新会话**同步发**（首帧已在上方
   *  paintNow 出帧）：`createNewSession()` 决议后的续跑是微任务，而 rule-engine 的会话注入在
   *  `session/created` 时只排入宏任务（见其 `inject.ts` 红线）→ 同步发送必先入 next-step 队列
   *  （BACKLOG「`[AUTO]` 注入时序」；勿在会话创建与 `app.start()` 之间引入 await，否则退化）；
   *  恢复会话先挂起，等 restoreStartupHistory 折叠落定后由 flushKickoffPending 发。 */
  function startBootstrapKickoff(): void {
    const text = ctx.deps.bootstrapKickoffText;
    if (typeof text !== "string" || text.trim() === "") return;
    if (typeof ctx.deps.adapter.sendBootstrapKickoff !== "function") return;
    if (ctx.deps.adapter.resumedAtLaunch === true) {
      ctx.kickoffPending = text;
      return;
    }
    submitBootstrapKickoff(text);
  }

  /** 启动历史折叠已落定（或不会发生）→ 补发挂起的 kickoff，随后补发挂起的启动期告警行
   *  （顺序固定：kickoff 先——它开新回合会清回合区，先补发告警会被清掉）；无挂起则无操作。 */
  function flushKickoffPending(): void {
    const text = ctx.kickoffPending;
    ctx.kickoffPending = null;
    if (text !== null) submitBootstrapKickoff(text);
    const logs = ctx.bootLogPending;
    ctx.bootLogPending = null;
    if (logs !== null) {
      for (const l of logs) ctx.self.notice(l.text, l.tone ?? "log");
    }
  }

  /** 发出启动自检消息：与用户提交同路径回显（状态置运行 + 回合开始 + 用户行），消息本体
   *  由 adapter 构造（正文 `[AUTO]` 开头，`source.kind:"tool-bootstrap"` 不进模式分类）。 */
  function submitBootstrapKickoff(text: string): void {
    if (ctx.disposed) return;
    const send = ctx.deps.adapter.sendBootstrapKickoff;
    if (typeof send !== "function") return;
    ctx.self.apply((s) =>
      reduceState(s, { type: "input-status", status: "running" }),
    );
    ctx.self.beginTurnIfNeeded(true);
    ctx.self.apply((s) => reduceState(s, { type: "user-line", text }));
    // 双写：流水线用户节（同 sendUserText）。缺了它，注册 sink 后内容不再写缓冲，
    // 启动自检的回显在画面里就消失了（条目 16 段 C1 暴露出的真实缺口）。
    if (ctx.sections !== null) {
      const scope = ctx.sections.lastScope;
      const sameTurn =
        ctx.turnOpen && scope.turn === (ctx.pipelineLastTurn ?? 1);
      ctx.self.deliverLocal({
        kind: "user",
        turn: sameTurn ? scope.turn : (ctx.pipelineLastTurn ?? 1),
        step: sameTurn ? scope.step : 0,
        text,
      });
    }
    // 启动关键路径：这里是 App.start() 的同步调用链（非宏任务），宿主抛错不得冒出启动
    // （会经 main() 让插件 apply 失败）——捕获后退化为一条 warn notice。
    try {
      send.call(ctx.deps.adapter);
    } catch (err) {
      ctx.self.notice(
        `启动自检发送失败：${err instanceof Error ? err.message : String(err)}`,
        "warn",
      );
    }
  }

  /** 发送用户文本（状态置运行 + 本地回显 + adapter 分发）：普通提交、`<` steer 与 /init 共用。
   *  echoText 为缓冲回显文本（默认同发送文本）；/init 回显命令名、发送初始化指令。
   *  target=`next-step` = 官方 steer（BACKLOG TUI#36：投递到最近 step 边界，仍属当前回合）。 */
  function sendUserText(
    sendText: string,
    echoText: string = sendText,
    target?: "next-step",
  ): void {
    ctx.self.apply((s) =>
      reduceState(s, { type: "input-status", status: "running" }),
    );
    // 真实 DSH 不回显 user/message,由 app 在发送前本地追加用户行。
    // 回合开始时先画分隔线(上一轮内容 → 新回合内容)；用户输入开启 → 清空回合区
    ctx.self.beginTurnIfNeeded(true);
    ctx.self.apply((s) =>
      reduceState(s, { type: "user-line", text: echoText }),
    );
    // 双写：流水线用户节。回合刚开 → 预测新回合（step 0）；回合仍开（打断后立即
    // 重发）→ 归当前回合当前步，与旧路径同组
    if (ctx.sections !== null) {
      const scope = ctx.sections.lastScope;
      const sameTurn =
        ctx.turnOpen && scope.turn === (ctx.pipelineLastTurn ?? 1);
      ctx.self.deliverLocal({
        kind: "user",
        turn: sameTurn ? scope.turn : (ctx.pipelineLastTurn ?? 1),
        step: sameTurn ? scope.step : 0,
        text: echoText,
      });
    }
    ctx.deps.adapter.sendMessage(
      sendText,
      ctx.state.activeSessionId ?? undefined,
      target,
    );
  }

  /** /init：当前目录无 AGENTS.md 时注入初始化指令（模型阅读目录并生成）；
   *  已存在则提示并直接结束（不发送任何消息） */
  function runInit(): void {
    // BACKLOG TUI#45：状态行 cwd 是显示用缩写（`~/…`，status.ts shortenHome），
    // 与 `$` shell 同口径走 resolveShellCwd（`~` 展开 + 目录存在校验，失败回落进程 cwd）
    const dir = resolveShellCwd(ctx.state.systemStatus.cwd) ?? process.cwd();
    if (existsSync(join(dir, "AGENTS.md"))) {
      ctx.self.notice("AGENTS.md 已存在，跳过初始化", "info");
      return;
    }
    sendUserText(INIT_PROMPT, "/init");
  }

  /** agent 是否正在跑（排队判据）：agent 状态权威 + 本地刚提交的过渡态 +
   *  P8「压缩上下文期间也算活跃」（否则压缩期间提交会绕过排队直接发送） */
  function agentBusy(): boolean {
    return (
      ctx.state.agentStatus !== "idle" ||
      ctx.state.inputStatus === "running" ||
      isCompacting(ctx.state)
    );
  }

  /**
   * 排队消息退回输入区（`!` 模式提交时用）：按提交顺序排在已有输入之前
   * （核心打断时会清空自己的 next-turn 队列，本机登记的先留底，避免静默丢输入）。
   * 2026-10-15 起 Esc 不再调用它：Esc 不打断运行，核心队列照旧认领，退回会重复发送。
   */
  function restoreQueued(): boolean {
    if (ctx.state.queued.length === 0) return false;
    // TUI#43：队列项带类型（followup / steer）→ 退回输入区只取文本，按**提交顺序**拼接
    // （渲染时的 steer 优先排序不影响这里，避免打乱用户实际输入顺序）
    const text = ctx.state.queued.map((q) => q.text).join("\n");
    const cur = ctx.state.inputText;
    const next = cur === "" ? text : text + "\n" + cur;
    ctx.self.apply((s) =>
      reduceState(s, { type: "input", text: next, cursor: next.length }),
    );
    ctx.self.apply((s) => reduceState(s, { type: "queued-clear" }));
    return true;
  }

  function submit(interrupt = false): void {
    // 空输入且无排队：`!` 模式（interrupt）= **只打断**（忙时；空闲无可打断的回合 → no-op），
    // 其余模式维持 no-op（打断入口收敛到 `!` 模式，见 BACKLOG「Esc 取消打断」）
    if (ctx.state.inputText.trim() === "" && ctx.state.queued.length === 0) {
      if (interrupt) {
        if (agentBusy()) ctx.deps.adapter.interrupt();
        // `!` 模式空输入提交 = 一次「只打断」提交：与其它模式提交同口径回退默认 `>`（2026-10-15
        // 真机缺陷：此分支早退漏了模式回退，打断后提示符仍停在 `!`）
        ctx.self.apply((s) =>
          reduceState(s, { type: "input-mode", mode: "steer" }),
        );
      }
      return;
    }
    // `!` 模式：先把排队登记并回输入区，再打断当前回合，然后整条直发（普通 Enter 走排队/直发
    // 分流）。已排队内容按时间顺序并入本次提交文本（restoreQueued 前置），避免「新文本先发、
    // 排队内容后发」的顺序颠倒；**仅忙时打断** —— 空闲没有可打断的回合，而 `interrupt()` 落到
    // 宿主是 `rawAgent.cancel({kind:'user'})`，会连带清空核心 next-turn 队列（BACKLOG 决策 2）
    if (interrupt) {
      restoreQueued();
      if (agentBusy()) ctx.deps.adapter.interrupt();
      // 打断 = 放弃当前回合：本地回合边界提前关闭，使直发走 `sendUserText` 里的
      // `beginTurnIfNeeded` 开**新回合**（预测新回合号）。否则直发块与被打断块同号同世代，
      // 宿主 `turn-end(aborted)` 的终态会错落给新块（BACKLOG「`!` 打断并直发后用户块终态
      // 符号错位」）；`turnOpen` 在 host `turn-end` 事件处理里也会置 false，此处幂等。
      ctx.turnOpen = false;
    }
    const text = ctx.state.inputText.trim();
    if (!text) return;
    // 输入历史（BACKLOG TUI#34）：普通输入与 `/` 命令共用一份；空串/相邻重复不入栈。
    // 入栈即退出翻看态（游标归零、草稿清空，见 reduceInputHistory 的 push 分支）。
    ctx.self.apply((s) =>
      reduceState(s, { type: "input-history", action: "push" }),
    );
    const mode = ctx.state.inputMode;
    // slash 模式：自动补 "/" 前缀走既有路由（规则：文本中不需要再在开头加 /）
    const slashLine =
      mode === "slash" && !text.startsWith("/") ? "/" + text : text;
    if (slashLine.startsWith("/")) {
      ctx.self.handleSlash(slashLine);
      ctx.self.apply((s) =>
        reduceState(s, { type: "input", text: "", cursor: 0 }),
      );
      ctx.self.apply((s) =>
        reduceState(s, { type: "input-mode", mode: "steer" }),
      );
      return;
    }
    // `<` followup 模式：排队等**下一回合**（运行中进排队块、走核心 next-turn 队列；
    // 空闲时直接发送）。`!` 模式打断后已空闲 → 直发（排队内容已并回输入区）
    if (mode === "followup") {
      if (!interrupt && agentBusy()) {
        ctx.self.apply((s) => reduceState(s, { type: "queued-push", text }));
        ctx.deps.adapter.sendMessage(
          text,
          ctx.state.activeSessionId ?? undefined,
        );
      } else {
        sendUserText(text);
      }
      ctx.self.apply((s) =>
        reduceState(s, { type: "input", text: "", cursor: 0 }),
      );
      ctx.self.apply((s) =>
        reduceState(s, { type: "input-mode", mode: "steer" }),
      );
      return;
    }
    // shell 模式（BACKLOG TUI#37）：提交内容按**本地命令**执行（不经模型、不进会话与模型
    // 上下文、不占审批链）；命令回显与输出进回合区本地行。异步执行、不阻塞输入。
    if (mode === "shell") {
      void runLocalShell(text);
      ctx.self.apply((s) =>
        reduceState(s, { type: "input", text: "", cursor: 0 }),
      );
      ctx.self.apply((s) =>
        reduceState(s, { type: "input-mode", mode: "steer" }),
      );
      return;
    }
    // 默认模式（提示符 `>`）= steer（BACKLOG TUI#36）：投递到宿主最近 step 边界
    // （官方 agent.steer = send(m,'next-step',true)；运行中下一 step 认领，空闲时立即起
    // 一轮）。语义上仍属**当前回合**，故与直发同路径（立即回显用户块、开回合分隔），
    // **不登记排队块**（排队语义 = 等下一回合，见上面的 followup 分支）。
    // 宿主 agent 无 steer（旧宿主）→ 降级 followup 并明确提示。
    // `!` 模式（interrupt）也落到这里：打断后直发，不走 step 边界投递（`interrupt` 为真时
    // 上面的排队分支不成立），即 BACKLOG「打断并发送」的直发口径
    {
      // canSteer 缺省（mock/旧 adapter 未实现）视为「不确定」→ 仍按 steer 投递，
      // 由 adapter 侧按宿主结构面决定 steer/followup（dsh adapter 有 steer 才用）
      const canSteer = ctx.deps.adapter.canSteer?.() !== false;
      const target = canSteer ? "next-step" : undefined;
      if (!interrupt && agentBusy()) {
        // 本回合在跑 → 进排队块（TUI#43）：独立成行、steer 右缘竖线黄，等下一次 step 认领后
        // 由 `inbox-claim` 转入历史流；宿主无 steer 时按 followup 类型排队（等下一回合）
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "queued-push",
            text,
            kind: canSteer ? "steer" : "followup",
          }),
        );
        ctx.deps.adapter.sendMessage(
          text,
          ctx.state.activeSessionId ?? undefined,
          target,
        );
      } else {
        // 空闲 / `!` 模式打断后：没有可插队的 step（steer 会直接起一轮）→ 直达回显。
        // 打断后**不带** next-step（打断即放弃当前回合，按「打断并发送」口径直发）
        sendUserText(text, text, interrupt ? undefined : target);
      }
      // 降级提示放在发送**之后**：发送路径可能开回合（turn-begin 清回合区），先提示会被清掉
      if (!canSteer) {
        ctx.self.shortNotice("宿主不支持 steer，已按 followup 投递", "warn");
      }
      ctx.self.apply((s) =>
        reduceState(s, { type: "input", text: "", cursor: 0 }),
      );
      ctx.self.apply((s) =>
        reduceState(s, { type: "input-mode", mode: "steer" }),
      );
    }
  }

  /**
   * `$` 模式本地命令执行（BACKLOG TUI#37）：
   *  1. 命令回显先行入回合区（用户即时看到「已提交了什么」，也是审计线索）；
   *  2. 异步执行——不阻塞输入与渲染；完成后追加 stdout/stderr 与退出摘要行；
   *  3. 结果**只进 buffer**（kind="shell"）：不经 adapter、不进会话事件流与模型上下文。
   * 执行前经 security-guard 复查一次（命中即不执行、回执进输出区；guard 不可用 fail-open，
   * 见 `shellGuard` 与 local-shell.ts 的 makeShellGuardChecker）。
   * 执行器已把 spawn 失败归一为结果（不抛）；disposed 后丢弃迟到结果。
   */
  async function runLocalShell(command: string): Promise<void> {
    const cwd = currentProjectCwd(ctx.state) ?? process.cwd();
    ctx.self.apply((s) =>
      reduceState(s, {
        type: "shell-lines",
        lines: [{ text: `$ ${command}`, tone: "info" }],
      }),
    );
    // 双写：命令回显行（流水线 shell 节）
    ctx.self.deliverLocal({ kind: "shell", text: `$ ${command}` });
    ctx.self.paint();
    // 执行前复查一次（BACKLOG「TUI `$` 模式执行面不经 guard」）：命中即**不执行**，回执
    // （含来源标注与规则 id）进输出区；guard 不可用 → 复查器内每种失效模式告警一次 + 留痕后
    // fail-open 照常执行。
    const check = ctx.shellGuard?.(command) ?? null;
    const receipt = check?.receipt ?? null;
    if (receipt !== null) {
      const blocked = shellGuardBlockedLines(command, receipt).slice(1);
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "shell-lines",
          lines: blocked,
        }),
      );
      // 双写：guard 拦截回执
      ctx.self.deliverLocal({
        kind: "shell",
        text: blocked.map((l) => l.text).join("\n"),
      });
      // 旁路：拦截事实与回执同样只给用户看 → 落本地日志（未执行，无 exitCode）
      ctx.self.recordLocalLog(
        "shell",
        [`$ ${command}`, ...blocked.map((l) => l.text)].join("\n"),
        { command, blocked: true },
      );
      ctx.self.paint();
      return;
    }
    // 复查被跳过（guard 未挂载 / 抛错）→ fail-open 照常执行，但输出区**留痕**（不静默；
    // 与 metric-loop / task-engine 的 guardSkipped 同口径）。未接线（checker=null）不留痕。
    if (check?.skipped === true) {
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "shell-lines",
          lines: [SHELL_GUARD_SKIPPED_LINE],
        }),
      );
      // 双写：guard 跳过留痕
      ctx.self.deliverLocal({
        kind: "shell",
        text: SHELL_GUARD_SKIPPED_LINE.text,
      });
      ctx.self.paint();
    }
    const started = Date.now();
    const result = await ctx.shellRunner(command, { cwd });
    if (ctx.disposed) return;
    // 跳过 shellResultLines 的命令回显行（首行已在提交时入 buffer）
    const resultLines = shellResultLines(
      command,
      result,
      Date.now() - started,
    ).slice(1);
    ctx.self.apply((s) =>
      reduceState(s, {
        type: "shell-lines",
        lines: resultLines,
      }),
    );
    // 双写：本地 shell 回执进回合区（流水线 shell 节；命令回显行已先行交付）
    ctx.self.deliverLocal({
      kind: "shell",
      text: resultLines.map((l) => l.text).join("\n"),
    });
    // 旁路：`$` 模式的命令与结果不进模型上下文 → 整条（回显 + 输出 + 退出摘要）落本地日志
    ctx.self.recordLocalLog(
      "shell",
      [`$ ${command}`, ...resultLines.map((l) => l.text)].join("\n"),
      {
        command,
        ...(result.code === null ? {} : { exitCode: result.code }),
        ...(result.signal === null ? {} : { signal: result.signal }),
        ms: Date.now() - started,
        ...(result.timedOut ? { timedOut: true } : {}),
        ...(result.truncated ? { truncated: true } : {}),
      },
    );
    ctx.self.paint();
  }

  /** 单条会话不可删除原因（可删返回 undefined）；标记/单删共用的护栏文案 */
  function deleteBlockReason(rec: SessionInfo): string | undefined {
    if (rec.current === true) return "当前活跃会话不可删除";
    if (rec.live) return "live 会话不可删除（仅可删除已持久化的非活跃会话）";
    if (rec.persisted !== true) return "该会话未持久化，没有可删除的文件";
    return undefined;
  }

  /** 面板 d/Delete：无标记 → 单条删除；有标记 → 批量删除（判据在 reducer 逐个复核） */
  function confirmDeleteRecord(): void {
    const h = ctx.state.history;
    if (!h) return;
    if (!ctx.deps.adapter.deleteSession) {
      historyNotice("会话删除不可用（宿主未挂载 sessionQuery）", "warn");
      return;
    }
    if ((h.marked?.length ?? 0) > 0) {
      ctx.self.apply((st) =>
        reduceState(st, { type: "history-confirm-delete" }),
      );
      ctx.self.paint();
      return;
    }
    const rec = historyVisibleRecords(ctx.state)[h.index];
    if (!rec) return;
    const reason = deleteBlockReason(rec);
    if (reason) {
      historyNotice(reason, "warn");
      return;
    }
    ctx.self.apply((st) => reduceState(st, { type: "history-confirm-delete" }));
    ctx.self.paint();
  }

  /** Space：切换高亮行标记（不可删项提示原因；标记由 reducer 置 + 高亮下移一行） */
  function toggleMarkRecord(): void {
    const h = ctx.state.history;
    const rec = h ? historyVisibleRecords(ctx.state)[h.index] : undefined;
    if (!h || !rec) return;
    const reason = deleteBlockReason(rec);
    if (reason) {
      historyNotice(reason, "warn");
      return;
    }
    ctx.self.apply((st) => reduceState(st, { type: "history-mark-toggle" }));
    ctx.self.paint();
  }

  /** a：全选当前列表范围的可删项（当前活跃 / live / 未持久化天然排除） */
  function markAllRecords(): void {
    const h = ctx.state.history;
    if (!h) return;
    if (markableSessionIds(ctx.state).length === 0) {
      historyNotice(
        ctx.state.history?.scope === "all"
          ? "全部目录没有可标记的会话"
          : "当前项目没有可标记的会话",
        "info",
      );
      return;
    }
    ctx.self.apply((st) => reduceState(st, { type: "history-mark-all" }));
    ctx.self.paint();
  }

  /** c：清空批量删除标记 */
  function clearMarkedRecords(): void {
    const h = ctx.state.history;
    if (!h) return;
    if ((h.marked?.length ?? 0) === 0) {
      historyNotice("当前没有批量删除标记", "info");
      return;
    }
    ctx.self.apply((st) => reduceState(st, { type: "history-mark-clear" }));
    ctx.self.paint();
  }

  /** 面板 x：进入清理空会话二次确认（范围=当前列表范围；无可清理项时以 notice 说明） */
  function confirmClean(): void {
    if (!ctx.deps.adapter.deleteSession) {
      historyNotice("会话删除不可用（宿主未挂载 sessionQuery）", "warn");
      return;
    }
    const ids = cleanableSessionIds(ctx.state);
    if (ids.length === 0) {
      historyNotice(
        ctx.state.history?.scope === "all"
          ? "全部目录没有可清理的空会话"
          : "当前项目没有可清理的空会话",
        "info",
      );
      return;
    }
    ctx.self.apply((st) => reduceState(st, { type: "history-confirm-clean" }));
    ctx.self.paint();
  }

  /** 确认后执行删除/清理（y/Enter）：调 adapter.deleteSession，成功后重拉列表并提示 */
  async function runPendingHistoryOp(): Promise<void> {
    const h = ctx.state.history;
    const adapter = ctx.deps.adapter;
    const del = adapter.deleteSession;
    if (!h || !del) return;
    if (h.phase === "confirm-delete") {
      // 目标集：单条（pendingDelete）或批量（pendingDeleteIds，优先级高）
      const ids =
        h.pendingDeleteIds ?? (h.pendingDelete ? [h.pendingDelete] : []);
      if (ids.length === 0) return;
      const isBatch = h.pendingDeleteIds !== undefined;
      // 先取标题再删记录：historyRecordLabel 依赖面板记录，删后只剩短 id
      const labels = ids.map((id) => historyRecordLabel(id));
      ctx.self.apply((st) => reduceState(st, { type: "history-delete" }));
      ctx.self.paint();
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
      ctx.self.apply((st) =>
        reduceState(st, { type: "history-delete-done", ids: removed }),
      );
      ctx.self.paint();
      if (removed.length === 0) {
        historyNotice(`删除失败：${reason ?? "未知原因"}`, "error");
        return;
      }
      if (isBatch) {
        historyNotice(
          failed > 0
            ? `已删除 ${removed.length} 个会话（${failed} 个失败）`
            : `已删除 ${removed.length} 个会话`,
          failed > 0 ? "warn" : "success",
        );
      } else {
        historyNotice(`已删除会话「${labels[0] ?? ""}」`, "success");
      }
      await refreshHistoryList();
      return;
    }
    if (h.phase === "confirm-clean") {
      const ids = h.pendingClean ?? [];
      if (ids.length === 0) return;
      ctx.self.apply((st) => reduceState(st, { type: "history-clean" }));
      ctx.self.paint();
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
      ctx.self.apply((st) =>
        reduceState(st, { type: "history-clean-done", ids: removed }),
      );
      ctx.self.paint();
      if (removed.length === 0) {
        historyNotice("清理失败：没有会话被删除", "error");
        return;
      }
      historyNotice(
        failed > 0
          ? `已清理 ${removed.length} 个空会话（${failed} 个失败）`
          : `已清理 ${removed.length} 个空会话`,
        failed > 0 ? "warn" : "success",
      );
      // 批量清理只重拉一次（无论删了几条）
      await refreshHistoryList();
    }
  }

  /** 删除/清理成功后重拉会话列表刷新面板（保留高亮位置并 clamp；失败保留本地结果） */
  async function refreshHistoryList(): Promise<void> {
    const adapter = ctx.deps.adapter;
    const list = adapter.listSessions;
    if (!list) return;
    try {
      const records = await list.call(adapter);
      ctx.self.apply((st) =>
        reduceState(st, { type: "history-refresh", records }),
      );
      ctx.self.paint();
    } catch {
      // 拉取失败不报错：删除已生效、本地列表已收敛，保持面板可用
    }
  }

  /** /session clean：打开面板并直接进入空会话清理确认 */
  async function openHistoryClean(): Promise<void> {
    await openHistory();
    if (ctx.state.history?.phase !== "list") return;
    confirmClean();
  }

  /** 面板内提示 + 缓冲 notice：面板占满回合区时 notice 不可见（notice 归回合区），
   *  故删除/清理结果与护栏文案需在面板内呈现；notice 仍留痕于会话区（关面板后可见） */
  function historyNotice(text: string, tone?: NoticeTone): void {
    ctx.self.apply((st) => reduceState(st, { type: "history-result", text }));
    ctx.self.notice(text, tone);
  }

  /** 会话展示名：列表标题优先，缺失用短 id（notice 文案用） */
  function historyRecordLabel(id: string): string {
    const rec = ctx.state.history?.records.find((r) => r.id === id);
    const title = rec?.title?.trim();
    return title ? title : id.slice(0, 8);
  }

  /** /continue（TUI#1/#23）：恢复当前目录下**最新的会话**——候选含当前会话
   *  （仅当它已有用户消息）；若当前会话就是最新 → 提示不切换。刚起的新会话
   *  仍回退到最近退出的会话；选择规则见 `pickContinueTarget`，加载走 /session 的
   *  `resumeToSession`。 */
  async function continueRecentSession(): Promise<void> {
    const list = ctx.deps.adapter.listSessions;
    if (!list || !ctx.deps.adapter.resumeTo) {
      ctx.self.notice("历史会话服务不可用（宿主未挂载 sessionQuery）", "warn");
      return;
    }
    let target: ContinueTarget | undefined;
    try {
      const records = await list.call(ctx.deps.adapter);
      // cwd 口径与 /session project 范围一致：活跃会话记录优先（创建时 meta.cwd
      // 可能与进程 cwd 不同），回退状态区 cwd、再回退进程 cwd
      const cwd =
        records.find((r) => r.current === true)?.cwd ??
        currentProjectCwd(ctx.state) ??
        process.cwd();
      target = pickContinueTarget(records, cwd);
    } catch (err) {
      ctx.self.notice("会话列表读取失败：" + String(err), "warn");
      return;
    }
    if (!target) {
      ctx.self.notice("当前目录下没有可恢复的会话", "info");
      return;
    }
    if (target.kind === "current") {
      ctx.self.notice("当前会话已是最新，无需恢复", "info");
      return;
    }
    // 复用 /session 切换路径（resuming 态一闪而过；成功后 history-resume-ok 自动关面板）
    ctx.self.apply((s) => reduceState(s, { type: "history-open" }));
    await resumeToSession(target.record.id);
  }

  /** /session：打开历史会话面板（宿主未挂载会话查询服务时提示不可用） */
  async function openHistory(): Promise<void> {
    const list = ctx.deps.adapter.listSessions;
    if (!list) {
      ctx.self.notice("历史会话服务不可用（宿主未挂载 sessionQuery）", "warn");
      return;
    }
    ctx.self.apply((s) => reduceState(s, { type: "history-open" }));
    ctx.self.paint();
    try {
      const records = await list.call(ctx.deps.adapter);
      ctx.self.apply((s) => reduceState(s, { type: "history-list", records }));
    } catch (err) {
      ctx.self.apply((s) =>
        reduceState(s, { type: "history-list-error", error: String(err) }),
      );
    }
    ctx.self.paint();
  }

  /** 历史面板 list→view：读取高亮会话的只读表面（损坏会话进入 error 阶段） */
  async function openHistoryView(): Promise<void> {
    const read = ctx.deps.adapter.readSessionSurface;
    if (!read) return;
    ctx.self.apply((s) => reduceState(s, { type: "history-open-view" }));
    ctx.self.paint();
    const panel = ctx.state.history;
    const rec = panel
      ? historyVisibleRecords(ctx.state)[panel.index]
      : undefined;
    if (!panel || !rec) return;
    try {
      const view = await read.call(ctx.deps.adapter, rec.id);
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "history-view",
          id: rec.id,
          messages: view.messages,
        }),
      );
    } catch (err) {
      ctx.self.apply((s) =>
        reduceState(s, { type: "history-view-error", error: String(err) }),
      );
    }
    ctx.self.paint();
  }

  /** 切换到持久化会话：agents.resume → 读 surface 展示上下文 → 生成标题并关面板 */
  async function resumeToSession(id: string): Promise<void> {
    void openHistoryView; // 保留只读查看方法引用（list Enter 现走切换，需要时可恢复引出）
    const resumeTo = ctx.deps.adapter.resumeTo;
    if (!resumeTo) {
      // 无持久化能力：面板已上移到回合区（占满该区），关面板让 notice 可见
      ctx.self.apply((s) => reduceState(s, { type: "history-close" }));
      ctx.self.notice("会话切换不可用（宿主未配置会话持久化）", "warn");
      return;
    }
    // 切走前先把当前会话的 TUI 侧状态落盘（快照按会话隔离）
    flushSessionStateSave();
    ctx.self.apply((s) => reduceState(s, { type: "history-resume", id }));
    ctx.self.paint();
    try {
      await resumeTo.call(ctx.deps.adapter, id);
      const read = ctx.deps.adapter.readSessionSurface;
      let view: SessionSurfaceView;
      if (read) {
        // 切换后刚 resume 的会话在内存 store 可能尚未完全入列：读空则轻量轮询
        view = await read.call(ctx.deps.adapter, id);
        for (
          let i = 0;
          i < 4 && view.messages.length === 0 && !ctx.disposed;
          i++
        ) {
          await new Promise((r) => setTimeout(r, 250));
          if (ctx.disposed) return;
          view = await read.call(ctx.deps.adapter, id);
        }
      } else {
        view = { sessionId: id, messages: [] as HistoryMessage[] };
      }
      if (ctx.disposed) return;
      // stale guard：面板已关闭/目标已换 → 丢弃结果
      const cur = ctx.state.history;
      if (!cur || cur.phase !== "resuming" || cur.pendingResume !== id) return;
      const firstUser = view.messages.find((m) => isUserMessage(m.role));
      // 标题：官方 session/title 事件优先（dsh-session-title 落盘日志），
      // 缺失时本地兜底（surface 首条用户消息前 30 字符 / （新会话））
      const official = ctx.deps.adapter.sessionTitle
        ? await ctx.deps.adapter.sessionTitle(id).catch(() => undefined)
        : undefined;
      const title = official ?? deriveTitle(firstUser?.text);
      const rows = surfaceToBuffer(view.messages);
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "history-resume-ok",
          id,
          title,
          rows,
        }),
      );
      // 六步流水线：切换后的历史行重放成节缓存。此前缺失 → 下一次交付按「会话已换」
      // 重建空节缓存，恢复出的历史在回合区不见（仅 /session 切换路径，启动恢复有重放）
      ctx.self.replaySectionsFromRows(rows);
      ctx.self.notice(`已切换到会话「${title}」`, "success");
      // 排队块属于切换前会话（核心队列里那条仍在原会话）：显示登记清空
      ctx.self.apply((s) => reduceState(s, { type: "queued-clear" }));
      // 新会话 Mode 初始值（log-only 事件不随 resume 回放，主动折叠一次）
      restoreSessionState();
    } catch (err) {
      if (ctx.disposed) return;
      ctx.self.apply((s) =>
        reduceState(s, {
          type: "history-resume-error",
          id,
          error: String(err),
        }),
      );
    }
    ctx.self.paint();
  }

  /** /copy：最后一条模型回复经 OSC52 写入系统剪贴板（ANSI 已剥离，纯文本）。
   *  来源 = 节模型（条目 7 选项 1：不再回查缓冲；无 sink 时 `sectionsOf` 回退重放）。 */
  function copyLastReply(): void {
    // 整条回复 = 该节 assistant 各块条目按序拼接（块身份只用于渲染分段）
    const text = (
      joinedLastTextBySource(sectionsOf(ctx.state), "assistant") ?? ""
    ).trim();
    if (text === "") {
      ctx.self.notice("没有可复制的模型回复", "warn");
      return;
    }
    process.stdout.write(buildOsc52(text));
    ctx.self.notice("已复制最后一条回复到剪贴板", "success");
  }

  /** /rename <title>：经 adapter 调宿主 sessionTitle.rename(live Session, title)。
   *  非法标题本地拒绝（不发服务调用）；服务缺失/失败 → warn；
   *  标题栏由既有 session/title 事件链路刷新，不手工改 state。 */
  function handleRenameCommand(line: string): void {
    const decision = renameCommandDecision(line);
    if (decision.kind === "usage") {
      ctx.self.notice("用法：/rename <标题>", "info");
      return;
    }
    if (decision.kind === "invalid") {
      ctx.self.notice(decision.reason, "error");
      return;
    }
    const adapter = ctx.deps.adapter;
    const rename = adapter.renameSession;
    if (!rename) {
      ctx.self.notice("sessionTitle 服务不可用", "warn");
      return;
    }
    void rename.call(adapter, decision.title).then(
      () => ctx.self.notice(`已重命名为「${decision.title}」`, "success"),
      () => ctx.self.notice("sessionTitle 服务不可用", "warn"),
    );
  }

  /** `/new`：不重启进程新建会话——释放当前 agent handle → `agents.create` 全新会话
   *  （同一 setup / agentOptions / meta）→ 切到新会话（缓冲与滚动按空会话重置，
   *  模型/Mode/开关由 restoreSessionState 回默认值）。旧会话已持久化在磁盘上，
   *  可经 `/session` 列表切回。宿主未暴露 agents.create → warn 不动作。 */
  function startNewSession(): void {
    const adapter = ctx.deps.adapter;
    const create = adapter.newSession;
    if (!create) {
      ctx.self.notice("新建会话不可用（宿主未配置会话创建）", "warn");
      return;
    }
    // 切走前先把当前会话的 TUI 侧状态落盘（快照按会话隔离）
    flushSessionStateSave();
    void create.call(adapter).then(
      ({ id }) => {
        if (ctx.disposed) return;
        ctx.turnOpen = false; // 新会话没有在跑的回合（旧 handle 已释放）
        ctx.self.apply((s) =>
          reduceState(s, { type: "session-switch", id, title: "" }),
        );
        ctx.self.apply((s) => reduceState(s, { type: "queued-clear" }));
        restoreSessionState();
        ctx.self.notice(
          `已新建会话 ${id}（原会话可用 /session 切回）`,
          "success",
        );
        ctx.self.paint();
        // 启动自检补发（BACKLOG TUI#57）：与启动路径同款时序——切换后同步发送（首帧已在上方
        // paint；`create().then` 是微任务，先于任何待跑宏任务入队；竞速理由见 startBootstrapKickoff）。
        // 门控惰性求值——按当前有效模型判定，全新会话必未解锁。
        const kickoff = ctx.deps.bootstrapKickoffForNewSession?.();
        if (typeof kickoff === "string" && kickoff.trim() !== "") {
          submitBootstrapKickoff(kickoff);
        }
      },
      (err: unknown) =>
        ctx.self.notice(
          `新建会话失败：${err instanceof Error ? err.message : "未知错误"}`,
          "warn",
        ),
    );
  }

  /** /fork：`sessions.fork(当前会话)` 分叉新会话（后两参省略 = 源会话最后事件 + store id 策略）。
   *  成功 → success（新会话 id）；新会话与当前不同 → 提示用 /session 查看；
   *  错误码 5 个（adapter 已映射中文）→ warn；服务缺失 → warn。 */
  function handleForkCommand(): void {
    const adapter = ctx.deps.adapter;
    const fork = adapter.forkCurrentSession;
    if (!fork) {
      ctx.self.notice("sessions 服务不可用", "warn");
      return;
    }
    void fork.call(adapter).then(
      (child) => {
        const tip =
          child.id !== ctx.state.activeSessionId
            ? "，可用 /session 查看或切换"
            : "";
        ctx.self.notice(`已分叉新会话 ${child.id}${tip}`, "success");
      },
      (err: unknown) =>
        ctx.self.notice(
          `分叉失败：${err instanceof Error ? err.message : "未知错误"}`,
          "warn",
        ),
    );
  }

  return {
    restoreSessionState,
    restoreStartupHistory,
    sessionUiState,
    scheduleSessionStateSave,
    flushSessionStateSave,
    startBootstrapKickoff,
    flushKickoffPending,
    submitBootstrapKickoff,
    sendUserText,
    runInit,
    agentBusy,
    restoreQueued,
    submit,
    runLocalShell,
    deleteBlockReason,
    confirmDeleteRecord,
    toggleMarkRecord,
    markAllRecords,
    clearMarkedRecords,
    confirmClean,
    runPendingHistoryOp,
    refreshHistoryList,
    openHistoryClean,
    historyNotice,
    historyRecordLabel,
    continueRecentSession,
    openHistory,
    openHistoryView,
    resumeToSession,
    copyLastReply,
    handleRenameCommand,
    startNewSession,
    handleForkCommand,
  };
}
