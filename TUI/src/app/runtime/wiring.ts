// TUI/src/app/runtime/wiring.ts — 事件桥与插件接线: 适配器事件、回合开始、服务懒读、状态行刷新
//
// 2026-11-04 拆分自 TUI/src/app/index.ts 的 App 类体: 方法体只做 this. -> ctx. 改写,
// 跨模块调用经 ctx.self, 公共状态在 ./context.ts.

import { reduceState, setSystemStatus } from "../state.ts";
import type { StatusExtras } from "../state.ts";
import type {
  DshEvent,
  ModelReasoning,
  SymbolNormalizerLike,
  RuleEngineLike,
} from "../adapter/dsh.ts";
import type { NoticeTone } from "../adapter/types.ts";
import { formatNoticeLine } from "../notice-format.ts";
import { allSections, lastTextOfSources } from "../layout/pipeline/sections.ts";
import { modelLabel, runPhase } from "../layout.ts";
import { sectionsOf } from "../layout/pipeline/frame.ts";
import type { AppContext } from "./context.ts";
import { taskExtrasOf, type TaskQueryLike } from "./task-status.ts";

/** 别名段读取失败告警阈值（连续失败次数）：别名段是增强项，session-channel 首连失败会
 *  后台重试，启动窗口内静默；连续失败到阈值才留痕一次 */
const ALIAS_WARN_AFTER_FAILS = 3;

export function createWiringPart(ctx: AppContext) {
  /**
   * 拉取权限/agent 预设目录写入 state（原状态列 Mode 块的可选项，P7 移除该块后
   * 暂无渲染消费方；目录变化低频，start + /permission 命令时刷新已足够）。目录服务
   * 缺失或读失败静默降级（state 保持 []），不崩溃。
   */
  function refreshCatalogs(): void {
    const a = ctx.deps.adapter;
    if (a.permissionCatalog) {
      void a
        .permissionCatalog()
        .then((info) => {
          if (ctx.disposed || !info) return;
          ctx.self.apply((s) =>
            reduceState(s, { type: "permission-catalog", names: info.names }),
          );
          ctx.self.paint();
        })
        .catch(() => {});
    }
    if (a.agentPresetCatalog) {
      void a
        .agentPresetCatalog()
        .then((info) => {
          if (ctx.disposed || !info) return;
          ctx.self.apply((s) =>
            reduceState(s, {
              type: "agent-preset-catalog",
              ids: info.presets.map((pp) => pp.id),
            }),
          );
          ctx.self.paint();
        })
        .catch(() => {});
    }
  }

  /** 拉取宿主命令注册表目录（ctx.commands.list）写入 state：补全候选并入本地目录。
   *  服务缺失/未暴露 list → 静默跳过（仅本地命令可补全）。 */
  function refreshCommandCatalog(): void {
    const list = ctx.deps.adapter.commandList?.();
    if (!list || list.length === 0) return;
    ctx.self.apply((s) =>
      reduceState(s, { type: "command-catalog", commands: list }),
    );
  }

  /** 运行中闪烁时间驱动：仅 inputStatus=running 时推进虚拟状态（virt-tick）——
   *  没有新数据也按衰减中的虚拟速度持续积分（闪烁频率渐降到最低而不断）；
   *  等待交互（△）/空闲（✓/?）不推进。P5：相位未变时不重绘（tick 只改虚拟
   *  状态，画面无变化；相位变化才出一帧）。
   *  发送中（首字节未到）不积分 token，闪烁相位不变，此时靠旋转相位 `sendPhase`
   *  的推进来判定重绘——否则 4 拍一圈的箭头永远等不到帧。 */
  function virtTick(): void {
    // BACKLOG #1：Agents 块前导符号也按同一 250ms 相位闪 —— 有运行中子代理时同样推进
    const agentsRunning =
      ctx.state.agentsBySession[ctx.state.activeSessionId ?? ""]?.some(
        (a) => a.status === "running",
      ) === true;
    if (ctx.disposed || (ctx.state.inputStatus !== "running" && !agentsRunning))
      return;
    const beforePhase = runPhase(ctx.state.runVirt.tokens);
    const beforeSend = ctx.state.runVirt.sendPhase;
    ctx.self.apply((s) =>
      reduceState(s, { type: "virt-tick", time: Date.now() }),
    );
    if (
      runPhase(ctx.state.runVirt.tokens) !== beforePhase ||
      ctx.state.runVirt.sendPhase !== beforeSend
    )
      ctx.self.paint();
  }

  /** 读取生效模型(会话切换 ?? 宿主默认)写入状态行 model+思考徽标；无变化时跳过 */
  async function refreshModelStatus(): Promise<void> {
    const catalog = await ctx.deps.adapter.modelCatalog();
    if (ctx.disposed) return;
    const cur = catalog.current;
    if (!cur?.provider || !cur.model) return;
    const key = modelLabel(cur);
    if (key === ctx.modelStatusKey) return;
    ctx.modelStatusKey = key;
    const thinking = await resolveThinking(
      cur.provider,
      cur.model,
      cur.reasoningEffort,
    );
    if (ctx.disposed || key !== ctx.modelStatusKey) return;
    ctx.self.apply((s) =>
      reduceState(s, {
        type: "status",
        status: { model: key, modelThinking: thinking },
      }),
    );
    ctx.self.paint();
  }

  /** 解析思考后缀（写状态行 model 段）：none=不支持、off=未开启、on=单等级开启、
   *  多等级开启时返回实际等级名（如 high/low/max）。
   *  未显式选择等级时返回 provider 默认等级（defaultEffort），保证状态行显示的
   *  与实际请求生效的 effort 一致（后台按 provider 级 reasoning 配置兜底，如 max）。 */
  async function resolveThinking(
    provider: string,
    model: string,
    effort?: string,
  ): Promise<string> {
    let info: ModelReasoning | undefined;
    try {
      info = await ctx.deps.adapter.modelReasoning?.(provider, model);
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

  /** TUI#39：静默重拉子代理目录（喂状态列 Agents 块；方法缺失或失败都不打扰用户） */
  function refreshAgentsQuiet(): void {
    if (ctx.disposed) return;
    void ctx.deps.adapter.refreshAgents?.().catch(() => {});
  }

  /** 状态列五块（task / flow / pin / daemon / group）：随 ticker 异步取数，值变化才重绘。
   *  任一来源不可用 / 无内容 → 该块字段缺省（整块不渲染）。 */
  async function refreshStatusExtras(): Promise<void> {
    if (ctx.disposed) return;
    const sessionId =
      ctx.state.activeSessionId ?? ctx.deps.adapter.sessionId ?? "";
    const next: StatusExtras = {};
    // Task：只取当前任务栈（帧 id → 标题），不铺整棵树；没有真实任务时不建块
    try {
      const engine = ctx.deps.getTaskEngine?.() as TaskQueryLike | undefined;
      const task = taskExtrasOf(engine?.query?.());
      if (task !== undefined) next.task = task;
    } catch {
      /* 忽略：保持该块缺省 */
    }
    // Flow：开关 + 每 slug 最新记录
    try {
      const face = ctx.deps.getFlowTrack?.() as
        | {
            summary?(): {
              records: Array<{
                slug: string;
                stage: string;
                status: string;
                active: boolean;
              }>;
            };
          }
        | undefined;
      const records = face?.summary?.().records ?? [];
      if (records.length > 0) {
        next.flow = {
          stage: `${records[0]!.slug}@${records[0]!.stage}`,
          items: records.map((record) => ({
            slug: record.slug,
            stage: record.stage,
            status: record.status,
            active: record.active,
          })),
        };
      }
    } catch {
      /* 忽略 */
    }
    // Pin：会话层摘要（会话 id 未知时跳过）
    if (sessionId !== "") {
      try {
        const face = ctx.deps.getPinNotes?.() as
          | {
              summary?(
                id: string,
              ): Promise<{ count: number; chars: number; titles: string[] }>;
            }
          | undefined;
        const summary = await face?.summary?.(sessionId);
        if (summary !== undefined && summary.count > 0) {
          next.pin = {
            count: summary.count,
            chars: summary.chars,
            titles: summary.titles,
          };
        }
      } catch {
        /* 忽略 */
      }
    }
    // Daemon：开关 / 运行中 / 每任务
    try {
      const face = ctx.deps.getDaemon?.() as
        | {
            status?(): { enabled?: boolean };
            list?(): readonly { name?: string; id?: string; status?: string }[];
          }
        | undefined;
      const list = face?.list?.() ?? [];
      if (list.length > 0) {
        const items = list.map((task) => ({
          name: task.name ?? task.id ?? "（未命名任务）",
          status: task.status ?? "unknown",
        }));
        next.daemon = {
          enabled: face?.status?.().enabled === true,
          running: items.filter(
            (item) => item.status === "running" || item.status === "stopping",
          ).length,
          total: items.length,
          items,
        };
      }
    } catch {
      /* 忽略 */
    }
    // Group：按会话汇总（只到直接关系）
    if (sessionId !== "") {
      try {
        const face = ctx.deps.getAgentGroup?.() as
          | {
              summary?(id: string): Promise<{
                ok: boolean;
                created?: Array<{ name: string; children: string[] }>;
                joined?: Array<{ name: string; parent: string }>;
              }>;
            }
          | undefined;
        const summary = await face?.summary?.(sessionId);
        if (summary?.ok === true) {
          const created = summary.created ?? [];
          const joined = summary.joined ?? [];
          if (created.length + joined.length > 0)
            next.group = { created, joined };
        }
      } catch {
        /* 忽略 */
      }
    }
    const after = JSON.stringify(next);
    const before = JSON.stringify(ctx.state.statusExtras ?? null);
    if (after === before) return;
    ctx.self.apply((s) =>
      reduceState(s, { type: "status-extras", extras: next }),
    );
    ctx.self.paint();
  }

  /** flow-track 注入开关保鲜：随 StatusTicker 懒读服务面，值变化才重绘标题栏符号。
   *  插件未挂载 / 服务无 `enabled()` → 保持 undefined（标题栏不渲染该符号）。 */
  function maybeRefreshFlowTrack(): void {
    if (ctx.disposed) return;
    const read = ctx.deps.getFlowTrack;
    if (read === undefined) return;
    let enabled: unknown;
    try {
      enabled = read()?.enabled?.();
    } catch {
      return;
    }
    if (typeof enabled !== "boolean") return;
    if (ctx.state.flowTrackEnabled === enabled) return;
    ctx.self.apply((s) => reduceState(s, { type: "flow-track", enabled }));
    ctx.self.paint();
  }

  /** background-daemon 开关保鲜：随 StatusTicker 懒读服务面，值变化才重绘标题栏符号。
   *  符号**始终显示**：读不到服务（未挂载 / 无 `status()`）时保持 `undefined`, 按关（灰）渲染。 */
  function maybeRefreshDaemon(): void {
    if (ctx.disposed) return;
    const read = ctx.deps.getDaemon;
    if (read === undefined) return;
    let enabled: unknown;
    try {
      enabled = (
        read() as { status?(): { enabled?: boolean } } | undefined
      )?.status?.()?.enabled;
    } catch {
      return;
    }
    if (typeof enabled !== "boolean") return;
    if (ctx.state.daemonEnabled === enabled) return;
    ctx.self.apply((s) => reduceState(s, { type: "daemon", enabled }));
    ctx.self.paint();
  }

  /**
   * TUI#39：状态列 Agents 块的**定时**保鲜（随 StatusTicker 节律，缺省 1s）。
   * 停止条件只留「状态列被 Ctrl+S 隐藏 / 无活跃会话」：不依赖 `subagent-activity` 事件面
   * （真机 playbook 场景事件不可靠），空数据也轮询——首个有效快照到达即出块（≤1s）；
   * 事件路径仍作即时加速（见 `subagent-activity` 分支；BACKLOG TUI#55）。
   */
  /** 会话别名保鲜（TUI#48）：懒读 session-channel 别名清单，值变化才重绘。
   *  插件未挂载 / 未设别名 / 读取失败 → 静默跳过（状态行增强项，不影响主流程）。 */
  async function maybeRefreshSessionAlias(): Promise<void> {
    const get = ctx.deps.getSessionChannel;
    if (get === undefined) return;
    const sessionId =
      ctx.state.activeSessionId ?? ctx.deps.adapter.sessionId ?? "";
    if (sessionId === "") return;
    try {
      const service = get();
      if (service === undefined) return;
      const result = await service.aliasList();
      if (!result.ok) {
        // 增强项失败不阻塞主流程：通道首连失败会后台重试，故启动窗口内（连续失败未达阈值）
        // 静默，达阈值才留痕一次（每进程一次）
        ctx.aliasFailStreak += 1;
        if (ctx.aliasFailStreak >= ALIAS_WARN_AFTER_FAILS && !ctx.aliasWarned) {
          ctx.aliasWarned = true;
          ctx.deps.logger?.(
            `warn: 会话别名读取失败（状态行不显示别名段）：${result.error ?? "未知原因"}`,
          );
        }
        return;
      }
      ctx.aliasFailStreak = 0;
      const alias = result.aliases?.find(
        (entry: { sessionId: string; alias: string }) =>
          entry.sessionId === sessionId,
      )?.alias;
      if (alias === ctx.aliasCache) return;
      ctx.aliasCache = alias;
      ctx.self.apply((s) =>
        setSystemStatus(s, alias === undefined ? {} : { alias }),
      );
      ctx.self.paint();
    } catch (err) {
      if (!ctx.aliasWarned) {
        ctx.aliasWarned = true;
        ctx.deps.logger?.(`warn: 会话别名刷新异常：${String(err)}`);
      }
    }
  }

  function maybeRefreshAgents(): void {
    if (ctx.disposed) return;
    if (!ctx.state.statusColumnVisible) return;
    if (!ctx.state.activeSessionId) return;
    refreshAgentsQuiet();
  }

  function handleEvent(e: DshEvent): void {
    // 启动初期 activeSessionId 尚未建立（真实 adapter 不发 session-list，全新会话
    // 的 title 要等首条用户消息）：首个带 sessionId 的事件到达即确立活跃会话，
    // 使 Mode 快照等按会话槽位的内容在未输入前即可展示（随后真实 title 覆盖）
    if (!ctx.state.activeSessionId) {
      const sid = (e as { sessionId?: unknown }).sessionId;
      if (typeof sid === "string" && sid !== "") {
        ctx.self.apply((s) =>
          reduceState(s, { type: "session-identify", id: sid, title: "" }),
        );
      }
    }
    switch (e.type) {
      case "session-list":
        ctx.self.apply((s) =>
          reduceState(s, { type: "sessions", sessions: e.sessions }),
        );
        break;
      case "session-title":
        // 官方 dsh-session-title 事件（fallback/provider/user 任一 source）。
        // adapter 已按活跃会话过滤；App 启动初期 activeSessionId 尚未建立时仍接受
        if (
          !ctx.state.activeSessionId ||
          e.sessionId === ctx.state.activeSessionId
        ) {
          const wasUnidentified = !ctx.state.activeSessionId;
          ctx.self.apply((s) =>
            reduceState(s, {
              type: "session-identify",
              id: e.sessionId,
              title: e.title,
            }),
          );
          // 启动初期 activeSessionId 尚为 null，start() 的 Mode 快照被跳过；
          // 首个 title 事件建立会话后补拉一次（全新会话日志无 mode 事件时，
          // adapter 以宿主默认预设兜底，见 emitSessionModeSnapshot）
          if (wasUnidentified) ctx.self.restoreSessionState();
        }
        break;
      case "stream":
        // 单活跃会话：非当前活跃会话的流式事件不进入 buffer（adapter 已过滤，
        // 此处 App 侧兜底，供直接 push 事件的集成断言使用）
        if (
          ctx.state.activeSessionId &&
          e.sessionId !== ctx.state.activeSessionId
        ) {
          break;
        }
        beginTurnIfNeeded();
        // 符号统一（/symbol-unify）只在本文件 `ingestDelivery`（交付入口）做一次：
        // 流水线是唯一渲染源，缓冲文本已不再是展示来源（审查 / notice / 模型反馈在插件侧）
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "append",
            text: e.text,
            time: Date.now(),
          }),
        );
        break;
      case "thinking":
        if (
          ctx.state.activeSessionId &&
          e.sessionId !== ctx.state.activeSessionId
        ) {
          break;
        }
        beginTurnIfNeeded();
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "thinking",
            text: e.text,
            time: Date.now(),
          }),
        );
        break;
      case "agent-status":
        if (
          ctx.state.activeSessionId &&
          e.sessionId !== ctx.state.activeSessionId
        ) {
          break;
        }
        ctx.self.apply((s) =>
          reduceState(s, { type: "agent-status", status: e.status }),
        );
        break;
      case "approval":
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "approval",
            approval: { id: e.id, prompt: e.prompt },
            // 倒计时来源（BACKLOG 3.2.5）：与 adapter 默认超时同口径
            deadline: Date.now() + ctx.self.approvalTimeoutMs(),
          }),
        );
        // 需交互（审批）→ 立即响铃并起催促计时（BACKLOG 3.4.1 / 3.4.3）
        ctx.self.beginInteractiveBell();
        break;
      case "approval-closed": {
        // 3.3.2：宿主侧裁定（超时 / abort）已生效 → 面板必须同步关闭，否则用户看到的
        // 是「面板还开着，再按 y 却毫无反应」（settle 后 pending 已删，approve 静默丢失）
        if (ctx.state.approval?.id !== e.id) break;
        ctx.self.apply((s) =>
          reduceState(s, { type: "approval", approval: null }),
        );
        ctx.self.shortNotice(
          e.reason === "timeout"
            ? "审批已超时（按默认拒绝处理）"
            : "审批已取消（连接中断）",
          "warn",
        );
        break;
      }
      case "question":
        // DSH 提问：整批题一次打开（一次 ask() 一批；面板内逐题导航，提交整批）
        // 3.2.10：带上回合区最近一条非思考正文（通常是提问前的题干说明），面板期间展示
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "question-open",
            id: e.id,
            questions: e.questions,
            // 上文来源：最近一段正文（模型说明 / 用户块；节模型，跨工具行——条目 7 选项 1
            // 前取自缓冲的「最近正文块」）
            source:
              lastTextOfSources(sectionsOf(s), ["assistant", "user"]) ?? "",
          }),
        );
        // 需交互（问答）→ 立即响铃并起催促计时（BACKLOG 3.4.1 / 3.4.3）
        ctx.self.beginInteractiveBell();
        break;
      case "notice": {
        // 命令通知(结果/提示/错误)只进 UI 缓冲，绝不进模型历史；
        // error 标记(如未知 slash 命令 fail-close)→ 输入区失败色(红)；
        // tone 标记（turn/end finish reason 等）→ 渲染层按红/黄/灰着色
        // 展示文本补统一前缀（`[hh:mm:ss 来源] 正文`）；旁路日志记原文。
        const shown = formatNoticeLine(e.text, Date.now());
        ctx.self.apply((s) =>
          reduceState(s, {
            type: "notice",
            text: shown,
            error: e.error,
            tone: e.tone,
          }),
        );
        // 旁路：adapter 事件态 notice 同样只给用户看 → 落本地日志供模型侧工具读
        ctx.self.recordLocalLog("notice", e.text);
        break;
      }
      case "turn-start":
        // #3：把宿主回合号回填到本回合的分隔线（分隔线已在本地 turn-begin 落行、暂时无号）
        if (typeof e.turn === "number") {
          const turn = e.turn;
          ctx.self.apply((s) => reduceState(s, { type: "turn-number", turn }));
        }
        break;
      case "turn-end":
        // turn 结束：不再画分隔线(下个回合开始时画)。
        // P2#33 声音提醒：任务结束 bell + 启动「等待用户输入超阈值」计时（输入即清）
        ctx.self.onTurnEnded();
        ctx.turnOpen = false;
        // P1：把 adapter 归一化的收尾原因转给 reducer——它给该回合的用户块打终态符号
        // （completed→绿 ✓ / aborted→灰 ■ / error→红 ✗ / 其余保持未定 → `?`）；漏传则
        // 真实事件路径下用户块永远不会显示终态
        ctx.self.apply((s) =>
          reduceState(s, { type: "turn-end", reason: e.reason }),
        );
        warnStrippedChars();
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
        // 阶段 2 按事件落 toast / 状态行槽位；P2 B 阶段渲染前同此处理
        // 条目 7 批 A：这条分支写下的可见行（retry / subagent / hook / feedback /
        // 压缩提示 / 重试中 …）过去只进缓冲、不投块 → 流水线看不到，这里补投块。
        // **adapter 已直接交付的事件不桥接**（重复投递会在回合区出现两行）：
        // `tool-call` / `tool-result`（批与结果）、`step`（step-start）、
        // `compaction-prune`（shadow）—— 见 TUI/src/app/adapter/dsh.ts 的 deliver 调用点。
        const tailBefore = ctx.state.local.length;
        ctx.self.apply((s) => reduceState(s, e));
        const bridged =
          e.type !== "step" &&
          e.type !== "compaction-prune" &&
          e.type !== "tool-call" &&
          e.type !== "tool-result";
        if (bridged) ctx.self.deliverBufferTail(tailBefore);
        // 模型/模式类状态变化 → 刷新会话状态快照（宿主日志仍是主来源，快照作兜底）
        if (
          e.type === "model-selection" ||
          e.type === "mode" ||
          e.type === "approval-policy"
        ) {
          ctx.self.scheduleSessionStateSave();
        }
        break;
      case "subagent-activity":
        // TUI#10：子代理生命周期变化 → /agents 面板打开时即时重拉（2s 定时仍作兜底；
        // 非 agents 面板不受影响，panelRefreshTick 自带 kind 守卫）
        if (ctx.state.commandPanel?.kind === "agents")
          ctx.self.panelRefreshTick();
        // TUI#39：同时即时刷新状态列 Agents 块（5s 定时之外的「启停即刻可见」通道）
        refreshAgentsQuiet();
        break;
      case "rule-injection":
        // BACKLOG TUI#49：rule-engine 注入消息（正文 `[RULE]` 前缀）按用户块实时显示；
        // 历史恢复路径由 adapter 折叠为用户消息，无需 App 额外处理。id 去重防双通道重复
        if (e.id !== "" && ctx.renderedRuleInjections.has(e.id)) break;
        if (e.id !== "") {
          if (ctx.renderedRuleInjections.size > 200)
            ctx.renderedRuleInjections.clear();
          ctx.renderedRuleInjections.add(e.id);
        }
        ctx.self.apply((s) =>
          reduceState(s, { type: "user-line", text: e.text }),
        );
        // 双写：流水线用户节（回合中 → 当前上下文；启动注入（尚无回合）→ 归回合 1）
        if (ctx.sections !== null) {
          const scope = ctx.sections.lastScope;
          ctx.self.deliverLocal({
            kind: "user",
            turn: scope.turn > 0 ? scope.turn : (ctx.pipelineLastTurn ?? 1),
            step: scope.step,
            text: e.text,
            // 注入块：`turn-end` 的终态符号优先落给人工输入（见 `Item.injected`）
            injected: true,
          });
        }
        ctx.self.paint();
        break;
      case "inbox-claim":
        // TUI#43：steer 在**本回合的 step 边界**被核心认领 → 该条从排队块转入历史流。
        // next-turn 的认领仍走回合开始路径（beginTurnIfNeeded → queued-claim），
        // 这里只处理 steer，避免同一条被认领两次
        if (e.target === "next-step") {
          // 宿主一次摘走**整批** next-step（`inbox.claim("next-step")`），故这里认领队列里
          // 全部 steer：合成一个用户块（原文换行连接），与宿主该步注入的整批内容对齐
          const claimed = ctx.state.queued.filter((q) => q.kind === "steer");
          ctx.self.apply((s) => reduceState(s, { type: "queued-claim-steer" }));
          // steer 认领转入历史流 → 当前步用户节（与旧路径同组；`queued: "steer"`
          // 让节带 steer 标记 → 第 3 步在它与上一条输入之间留空行）
          if (claimed.length > 0) {
            const scope = ctx.sections?.lastScope;
            if (scope !== undefined) {
              const turn =
                scope.turn > 0 ? scope.turn : (ctx.pipelineLastTurn ?? 1);
              // 先给**上一条**用户输入置「被续接」（永久 `←`）——必须在投新块之前，
              // 否则「最后一条用户条目」已变成刚认领的这条（批 B1：符号不再回查 buffer）
              ctx.self.deliverLocal({
                kind: "user-flag",
                steerContinued: true,
              });
              ctx.self.deliverLocal({
                kind: "user",
                turn,
                step: scope.step,
                text: claimed.map((q) => q.text).join("\n"),
                queued: "steer",
              });
            }
          }
          ctx.self.paint();
        }
        break;
      case "ui-flags": {
        // 切换会话后回填 TUI 本地开关（宿主日志不记录 verbose / symbol-unify）
        if (
          ctx.state.activeSessionId &&
          e.sessionId !== ctx.state.activeSessionId
        ) {
          break;
        }
        if (e.symbolUnify !== undefined) {
          ctx.self.apply((s) =>
            reduceState(s, { type: "symbol-unify", on: e.symbolUnify! }),
          );
        }
        if (e.statusColumn !== undefined) {
          ctx.self.apply((s) =>
            reduceState(s, { type: "status-column", visible: e.statusColumn! }),
          );
        }
        // #9：恢复下半区（Turn/Tool）显隐
        if (e.lowerPanes !== undefined) {
          ctx.self.apply((s) =>
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
          ctx.state.activeSessionId &&
          e.sessionId !== ctx.state.activeSessionId
        ) {
          break;
        }
        ctx.self.apply((s) => reduceState(s, e));
        break;
      }
      default: {
        const _exhaustive: never = e;
        void _exhaustive;
      }
    }
    ctx.self.paint();
  }

  /**
   * 回合开始：先画分隔线(仅首个回合空历史时跳过)；submit 与首条思考/正文均需走这里。
   * 新回合开始 = 核心认领最早一条排队消息（每回合认领一条）→ 该条转入历史流。
   *
   * @param userInput 本次回合是否由用户输入开启（提交）。回合区内容只在
   *   「用户输入开启的回合」整体清空（含排队消息被认领）；核心自发的回合
   *   （goal 轮次/定时唤醒等）保留上一轮内容继续往上堆——回合区只在下一次
   *   输入后清空，且清空时思考/工具/notice 一起清，不做单类清除。
   */
  function beginTurnIfNeeded(userInput = false): void {
    if (ctx.turnOpen) return;
    ctx.turnOpen = true;
    const clearActivity = userInput || ctx.state.queued.length > 0;
    // #3：回合分隔线要显示时间（`hh:mm:ss`）；回合号由随后的宿主 `turn/start` 回填
    const beginTime = Date.now();
    // 六步流水线：分隔线时间的真源同步交付（首回合分隔线由 frame 层预置）
    // 排队项在回合开始被认领（followup）→ 转入历史流；流水线同步交付用户节
    const claimed = ctx.state.queued.find((q) => q.kind === "followup");
    let predictedTurn = 0;
    if (ctx.sections !== null) {
      // 回合号本地预测：宿主 turn/start 稍后回填（旧路径改写缓冲行；节缓存不可变），
      // 这里按上一已知回合 +1 预测（首回合 1），分隔线时间随预测号登记
      predictedTurn = (ctx.pipelineLastTurn ?? 0) + 1;
      // 画线判据（条目 7 选项 1：改读节模型 / 交付事实，不再回查缓冲）：与旧路径
      // appendTurnSeparator 镜像——「回合区清理后仍有内容」才算有历史，首回合空历史不画
      // （frame 层不预置重复线）；末尾刚投过 turn-start（其后无内容）也不重复画。
      // 清理回合区的回合（用户输入开启）只看会留下的内容（用户块 / 最终总结 / shell——
      // 思考、工具、notice、非 final 正文随后会被清掉，不算）；
      // 核心自发回合不清回合区 → 任何内容交付都算（旧口径「缓冲非空」）。
      const all = allSections(ctx.sections);
      const hasContent = clearActivity
        ? all.some((section) =>
            section.items.some(
              (item) =>
                item.source === "user" ||
                item.source === "shell" ||
                (item.source === "assistant" && section.final === true),
            ),
          )
        : ctx.pipelineAnyContent;
      const drawsSeparator = hasContent && ctx.pipelineSepPending !== true;
      if (drawsSeparator) {
        ctx.self.ingestDelivery({
          kind: "turn-start",
          turn: predictedTurn,
          time: beginTime,
        });
      } else {
        // 不画线（首回合空历史 / 末行已是分隔线）：回合号基线仍要推进，
        // 否则下一回合的本地预测会重复同一号
        ctx.pipelineLastTurn = predictedTurn;
      }
    }
    ctx.self.apply((s) =>
      reduceState(s, {
        type: "turn-begin",
        clearActivity,
        time: beginTime,
      }),
    );
    // 只有本回合**确实认领了排队消息**才派发（`queued-claim` 会弹队列 + 复位焦点；
    // 每回合无条件派发会在核心自发续轮时把用户设定的区域焦点甩掉，2026-10-15）
    if (ctx.state.queued.length > 0) {
      ctx.self.apply((s) => reduceState(s, { type: "queued-claim" }));
    }
    // 认领的用户块交付（符号 / 终态由节模型给出，不再带缓冲行号）
    if (claimed !== undefined && ctx.sections !== null) {
      ctx.self.deliverLocal({
        kind: "user",
        turn: predictedTurn,
        step: 0,
        text: claimed.text,
      });
    }
  }

  /** turn 结束后警告：本回合剔除的非打印控制字符（渲染保护兜底） */
  function warnStrippedChars(): void {
    const n = ctx.state.strippedChars;
    if (n <= 0) return;
    ctx.self.shortNotice(`已过滤 ${n} 个非打印控制字符（渲染保护）`, "warn");
    ctx.self.apply((s) => reduceState(s, { type: "clear-stripped" }));
    ctx.self.paint();
  }

  /**
   * 符号服务懒读：首次可用时解析并订阅审查事件（notice 展示）。
   * 容忍插件装载顺序（symbol-normalizer 可能在 TUI 之后 provide）；未挂载返回 undefined。
   * 审查（冷却 / 文案生成 / 模型反馈）全在插件侧，TUI 只负责展示归一与 notice。
   */
  function symbols(): SymbolNormalizerLike | undefined {
    if (ctx.symbolService !== null) return ctx.symbolService;
    let service: SymbolNormalizerLike | undefined;
    try {
      service = ctx.deps.getSymbols?.();
    } catch {
      service = undefined;
    }
    if (service === undefined) return undefined;
    ctx.symbolService = service;
    try {
      ctx.symbolUnsubscribe = service.onReview((event) => {
        // /symbol-unify off 时不提示；会话过滤与其它事件同口径
        if (!ctx.state.symbolUnify) return;
        if (
          ctx.state.activeSessionId &&
          event.sessionId !== ctx.state.activeSessionId
        ) {
          return;
        }
        ctx.self.notice(event.notice, "warn");
      });
    } catch {
      ctx.symbolUnsubscribe = null;
    }
    return service;
  }

  /**
   * 外部告警行入口（stderr 桥 / 插件 notice 总线）：进回合区、可回溯（tone 缺省 log）。
   * 接线见 main.ts（桥）与 ruleEngine()（总线）。
   * 行文本在此补统一前缀（`[hh:mm:ss 来源] 正文`，见 app/notice-format.ts）：时间取
   * 到达时刻，故启动挂起（bootLogPending）在入列前就格式化，补发时不再重算。
   */
  function appendExternalLog(line: string, tone?: NoticeTone): void {
    const text = formatNoticeLine(line, Date.now());
    if (ctx.bootLogPending !== null) {
      ctx.bootLogPending.push({ text, tone });
      return;
    }
    ctx.self.notice(text, tone ?? "log");
  }

  /**
   * rule-engine 服务懒读：首次可用时订阅告警总线（`onNotice` → 回合区）。
   * 容忍插件装载顺序；未挂载 / 未实现 onNotice → undefined（插件侧 stderr 兜底）。
   */
  function ruleEngine(): RuleEngineLike | undefined {
    if (ctx.ruleEngineService !== null) return ctx.ruleEngineService;
    let service: RuleEngineLike | undefined;
    try {
      service = ctx.deps.getRuleEngine?.();
    } catch {
      service = undefined;
    }
    if (service === undefined) return undefined;
    ctx.ruleEngineService = service;
    try {
      if (typeof service.onNotice === "function") {
        ctx.ruleEngineUnsubscribe = service.onNotice((event) => {
          appendExternalLog(event.text, event.tone);
        });
      } else {
        ctx.ruleEngineUnsubscribe = null;
      }
    } catch {
      ctx.ruleEngineUnsubscribe = null;
    }
    return service;
  }

  return {
    refreshCatalogs,
    refreshCommandCatalog,
    virtTick,
    refreshModelStatus,
    resolveThinking,
    refreshAgentsQuiet,
    maybeRefreshFlowTrack,
    maybeRefreshDaemon,
    refreshStatusExtras,
    maybeRefreshSessionAlias,
    maybeRefreshAgents,
    handleEvent,
    beginTurnIfNeeded,
    warnStrippedChars,
    symbols,
    appendExternalLog,
    ruleEngine,
  };
}
