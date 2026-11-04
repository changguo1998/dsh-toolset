// TUI/src/app/adapter/dsh.ts — DSH 适配层：装配与兼容重导
//
// 2026-11-04 按面拆分（行为不变）:
//   - ./context.ts     上下文对象: 全部可变状态 + emit / deliver 三件套（原闭包变量）
//   - ./dsh-events.ts  事件转接: session/event 归一化 + assistant-stream 实时帧
//   - ./dsh-session.ts 连接与会话: 会话读取 / 恢复 / 切换 / 模型目录
//   - ./dsh-approval.ts 审批桥: approval/request 与 user-questions 应答
//   - ./dsh-panels.ts  面板查询: 各面板的只读服务面成员
// 本文件只剩: 工厂装配（defineProperties 合并各面, 保留 getter）、runtime.on 接线
// （注册顺序敏感）、jobs 订阅、slash 命令分派与 dispose; 并以显式重导保持
// ./adapter/dsh.ts 公共导出不变（外部 import 路径无需改动）。
//
// 接口化让 mock（demo/）与真实（阶段 2）可互换，app 层不感知实现。
// tool-bootstrap（锚定工具引导）见 ./tool-bootstrap.ts，本文件显式重导保持公共导出不变。
// 类型骨架依据官方 deepseek-harness 源码研读沉淀对齐（见 docs/host/DSH-CTX-API.md，
// 研读基线 dsh-v0.1.7-rc.2 = commit 477b4f42）。
//
// DSH 原生信号 → app 归一化事件的映射（实现见 ./dsh-events.ts）：
//   runtime.on('session/event', (session, e))  → 按 e.type 归一化：
//     - 'assistant/attempt'（一次性 stream 数组）展开 text-delta → { type: 'stream' }；
//       reasoning-delta / reasoning block → { type: 'thinking' }
//       （正文与思考分别归一化，思考仅作为临时 UI 流展示）
//     - 'turn/start' 忽略；'turn/end' → { type: 'turn-end' }
//   runtime.on('agent/status', ({agent, status})) → { type: 'agent-status' }
//     （agent/status 是 agent 层事件，不在 session 日志词汇表内）
//
// 审批应答契约（实现见 ./dsh-approval.ts）：DSH 侧是 waterfall 链事件
// 'approval/request'(req, next)，监听者返回 ApprovalOutcome 即裁定；调用 next() 放行给
// 后续监听者，最终无应答 fail-closed。request 须在 open turn 内发起。adapter 注册应答者，
// 并把 app 的 approve(id, allow) 映射为 allow ? 'allowed-once' : 'rejected'；signal 中断/
// 超时 → 'cancelled'：request 携带的 signal 中断立即取消，另有可配置的 approvalTimeoutMs
// 超时兜底。
// 问答应答契约：DSH 侧是 waterfall 链事件 'user-questions/request'(req, next)，监听者返回
// QuestionAnswer 即占用该请求；调用 next() 放行给后续监听者，最终无应答 NO_PROVIDER。
// adapter 经 runtime.on 注册应答者（与 approval/request 同构），并把 app 的
// answerQuestion(id, {answers}) 映射为整批回答 resolve；Esc/cancel → reject；
// signal 中断 → reject。单活动请求守卫：已有待答提问时直接 reject（单面板约束）。

import type {
  DshAdapter,
  ModelSelection,
  SessionModelSelectionRef,
  SessionEvent,
  DshRuntime,
  RealAdapterOptions,
} from "./types.ts";
import { parseSlashCommand } from "./normalize.ts";

// 会话目录定位/删除（兼容旧 import 路径：实现已移到 ./session-paths.ts）
export { isSafeSessionId, sessionRoots } from "./session-paths.ts";
export type { SessionUiState } from "./session-ui-state.ts";
export { SESSION_UI_STATE_VERSION } from "./session-ui-state.ts";

export type {
  AgentStatus,
  SessionMeta,
  ApprovalItem,
  DshEvent,
  DshAdapter,
  ModelInfo,
  ModelSelection,
  ModelReasoning,
  ModelSelectionLike,
  SessionModelSelectionRef,
  ModelCatalog,
  SessionEventType,
  StreamChunk,
  ApprovalRequest,
  ApprovalOutcome,
  QuestionOption,
  QuestionIntent,
  QuestionItem,
  QuestionAnswerItem,
  QuestionAnswer,
  UserQuestionRequestLike,
  SessionEventDataMap,
  SessionEvent,
  DshRuntime,
  DshAgentLike,
  AgentRowInfo,
  DshUserMessageLike,
  DshCommandLike,
  LlmLike,
  AgentDefaultModelLike,
  AgentGroupLike,
  RealAdapterOptions,
  SessionInfo,
  SessionDeleteResult,
  HistoryMessage,
  SessionSurfaceView,
  SessionQueryLike,
  SessionStoreLike,
  SessionTitleLike,
  SkillsLike,
  SubagentsLike,
  SubagentEntryLike,
  ToolsLike,
  ToolSchemaLike,
  ScopeKeyLike,
  SettingsLike,
  SettingsDescriptorLike,
  ConfigEditorLike,
  ConfigEntrySummary,
  TaskEngineLike,
  TaskEngineQueryLike,
  TaskEngineTaskLike,
  SecurityGuardLike,
  GuardRecordLike,
  PolicySnapshotLike,
  KnowledgeServiceLike,
  KnowledgeBundleSummaryLike,
  MemoryRowRef,
  MetricLoopLike,
  LoopSummaryLike,
  SessionChannelLike,
  SymbolNormalizerLike,
  // 规则提示的消费面（app / main）统一从 adapter 面取类型，避免同一类型出现两条
  // 导入路径；2026-10-01 追认保留（见 TUI/docs/archived/2026-10-01-dsh-reexport-ratify.md）
  RuleEngineLike,
  RuleEngineNotice,
  ContractParseResult,
  ContractClauseLike,
  GoalContractServiceLike,
  WorkflowRunLike,
  WorkflowEngineLike,
  WebSearchLike,
  SearchProviderLike,
  SearchSourceLike,
  CommandPanelRow,
  CommandPanelKind,
  AgentRegistryLike,
  NoticeTone,
  TokenUsage,
  GoalOperation,
  GoalActivation,
  GoalRefLike,
  GoalSnapshotLike,
  GoalChangeLike,
  TodoItemLike,
  SubagentDescriptorLike,
  ContentBlockLike,
  CompactionSummaryPayloadLike,
  PermissionPresetInfo,
  PermissionPresetServiceLike,
  AgentPresetInfo,
  AgentPresetsLike,
  JobInfo,
  JobsLike,
  FileReferenceLike,
} from "./types.ts";
export {
  buildApprovalPrompt,
  buildUserMessage,
  normalizeAgentStatus,
  noticeSummaryOf,
  parseSlashCommand,
  readDefaultSelection,
  ruleInjectionTextOf,
} from "./normalize.ts";

// 启动自检 kickoff：本文件只在适配器方法里构造该消息（其余纯函数经下方重导暴露）

export {
  classifyTask,
  coreFor,
  personaFor,
  applyPersona,
  sessionMode,
  isDeepseekModel,
  isPromotedFromEvents,
  sessionMessages,
  hasToolCallInMessages,
  sessionModeFromMessages,
  firstUserText,
  shouldAutoKickoff,
  newSessionKickoffText,
  BOOTSTRAP_KICKOFF_TEXT,
  buildBootstrapKickoffMessage,
  type BootstrapKickoffMessage,
  installToolBootstrap,
  type ToolBootstrapOptions,
  type TaskAnchor,
} from "./tool-bootstrap.ts";
import { collectJobs } from "./history-normalize.ts";
export { normalizeHistoryMessages } from "./history-normalize.ts";
export {
  deleteSessionDir,
  listSessionRecords,
  pickContinueTarget,
  pickRecentSession,
} from "./session-records.ts";
export type {
  ContinueTarget,
  SessionDeleteOutcome,
} from "./session-records.ts";
export {
  contractSummaryText,
  groupStatusText,
  parseContractObjective,
} from "./contracts.ts";
export { aggregateSearchSources } from "./search-aggregate.ts";

/**
 * 镜像官方 @deepseek-ai/dsh-agent installModelSelection：挂钩 agentCtx 的
 * system-prompt/assemble 与 agent/request waterfall，把 ref.current 应用到
 * 下一 step 请求(provider/model + 可选 effort)。assembled 快照保证切换不撕裂
 * 当步请求(prompt 组装先于 request，二者读同一快照)。零运行时依赖，仅用结构面。
 */
export function installSessionModelSelection(
  ctx: DshRuntime,
  ref: SessionModelSelectionRef,
  /** 未切换时的实时兜底（宿主 agentDefaultModel.currentSelection，read-only） */
  fallback?: () => ModelSelection | undefined,
): () => void {
  const unbinds: Array<(() => void) | void> = [];
  unbinds.push(
    ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
      // 有效选择 = 会话内切换 ?? 宿主实时默认；settings 热加载完成后自动生效
      const selected = ref.current ?? fallback?.();
      const assembled = await (next as () => unknown)();
      ref.assembled = selected;
      if (selected === undefined) return assembled;
      return {
        ...(assembled as object),
        variables: {
          ...(assembled as { variables?: object }).variables,
          provider: selected.provider,
          model: selected.model,
        },
      } as unknown;
    }),
  );
  unbinds.push(
    ctx.on("agent/request", async (_payload, next) => {
      const resolved = await (next as () => unknown)();
      const selected = ref.assembled;
      if (selected === undefined) return resolved;
      const { reasoningEffort: _inherited, ...rest } = resolved as {
        reasoningEffort?: string;
        [k: string]: unknown;
      };
      return {
        ...rest,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort
          ? { reasoningEffort: selected.reasoningEffort }
          : {}),
      } as unknown;
    }),
  );
  return () => {
    for (const u of unbinds) if (typeof u === "function") u();
  };
}

// ---- 真实适配层装配（2026-11-04 拆分: 状态收进 context.ts, 职责拆进 dsh-*.ts） ----
import { createAdapterContext } from "./context.ts";
import { createEventBridge } from "./dsh-events.ts";
import { createSessionBridge } from "./dsh-session.ts";
import { createApprovalBridge } from "./dsh-approval.ts";
import { createPanelBridge } from "./dsh-panels.ts";

/** 合并各职责模块的成员: 用 defineProperties 保留 getter（spread 会把它固化成常量） */
function assembleAdapter(parts: Partial<DshAdapter>[]): DshAdapter {
  const out = {} as DshAdapter;
  for (const part of parts) {
    Object.defineProperties(out, Object.getOwnPropertyDescriptors(part));
  }
  return out;
}

export function createRealDshAdapter(opts: RealAdapterOptions): DshAdapter {
  const ctx = createAdapterContext(opts);
  const s = ctx.state;
  const { runtime } = opts;
  const session = createSessionBridge(ctx);
  const approval = createApprovalBridge(ctx);
  const events = createEventBridge(ctx, {
    resolveContextWindow: session.resolveContextWindow,
    settle: approval.settle,
  });
  const panels = createPanelBridge(ctx);

  const adapter = assembleAdapter([
    session.part,
    events.part,
    approval.part,
    panels.part,
    {
      runCommand(line, targetSessionId) {
        if (s.disposed) return;
        if (targetSessionId && targetSessionId !== s.activeSessionId) {
          process.stderr.write(
            "[dsh adapter] runCommand: sessionId " +
              targetSessionId +
              " not active\n",
          );
          return;
        }
        dispatchCommand(line);
      },
      dispose() {
        if (s.disposed) return;
        s.disposed = true;
        for (const c of s.activeCommands) c.abort();
        s.activeCommands.clear();
        for (const u of s.runtimeUnbinds) u();
        s.runtimeUnbinds.length = 0;
        // 拒绝所有悬挂问答（绝不留下悬浮 Promise）；监听者经 runtimeUnbinds 注销
        for (const p of s.pendingQuestions.values()) {
          p.cleanup();
          p.reject(new Error("adapter disposed"));
        }
        s.pendingQuestions.clear();
        s.emittedByBlock.clear();
        s.stepEmitted.clear();
        s.listeners.clear();
        const activeDispose = s.activeDispose;
        if (activeDispose) {
          void activeDispose().catch(() => {});
          s.activeDispose = undefined;
        }
      },
    },
  ]);

  // 经 runtime.on 注册 waterfall 应答者（与 approval/request 同构; unscoped ctx 全局放行）
  collectUnbind(
    runtime.on(
      "user-questions/request",
      approval.questionAnswerer as (...args: unknown[]) => unknown,
    ),
  );

  collectUnbind(
    runtime.on("session/event", (session, event) =>
      events.onSessionEvent(session, event as SessionEvent),
    ),
  );
  // goal 自动续轮开关（`goal/activation-changed`：宿主 `setActivation` 值真变化时才发）：
  // **进程本地**事件——不进会话日志、回放拿不到（重启后宿主为 disarmed），故只按事件存
  // 「最后一条原始边」；`activation` 缺省 = 宿主该会话已无当前 goal → 清该会话记录。
  // 不按活跃会话过滤：宿主边可来自非活跃会话，按 sessionId 隔离存；「切走再切回」的陈旧
  // armed 由 `resumeTo` 的清空边兜底（宿主 resume 会重建 Session，见该处注释）。
  collectUnbind(
    runtime.on("goal/activation-changed", (payload) => {
      const p = payload as {
        sessionId?: unknown;
        goal?: { id?: unknown; activation?: unknown };
      };
      const goalId = p?.goal?.id;
      const activation = p?.goal?.activation;
      // 载荷带 goal 但 activation 非法（宿主契约破坏）：忽略整条事件，不误当「无当前 goal」清空
      if (
        p?.goal !== undefined &&
        activation !== "armed" &&
        activation !== "disarmed"
      ) {
        return;
      }
      ctx.emit({
        type: "goal-activation",
        sessionId:
          typeof p?.sessionId === "string" ? p.sessionId : s.activeSessionId,
        ...(typeof goalId === "string" ? { goalId } : {}),
        ...(activation === "armed" || activation === "disarmed"
          ? { activation }
          : {}),
      });
    }),
  );
  // agent/assistant-stream 实时帧（agent-subject 事件，payload 含 agent + frame）：
  // 宿主 agent-loop 流中逐 chunk 发布；TUI 据此实时渲染正文与运行中 ●/○ 动画。
  // 老宿主无此事件时静默（订阅不报错），回退到 session/event 结算一次性输出。
  collectUnbind(
    runtime.on("agent/assistant-stream", (payload) => {
      const p = payload as {
        agent?: { session?: { id?: string } };
        frame?: Parameters<typeof events.onAssistantFrame>[1];
      };
      const sessionId = p?.agent?.session?.id;
      if (!sessionId || !p?.frame) return;
      events.onAssistantFrame(sessionId, p.frame);
    }),
  );
  collectUnbind(
    runtime.on("agent/status", (payload) =>
      events.emitAgentStatus(payload as { agent?: unknown; status?: string }),
    ),
  );
  // TUI#10：子代理生命周期事件（dsh-subagent：subagent/start · subagent/end）——
  // /agents 面板打开期间据此即时刷新（2s 定时仍作兜底）；老宿主无此事件时静默。
  for (const evt of ["subagent/start", "subagent/end"] as const) {
    collectUnbind(
      runtime.on(evt, () => {
        ctx.emit({ type: "subagent-activity" });
      }),
    );
  }
  collectUnbind(
    runtime.on(
      "approval/request",
      approval.approvalAnswerer as (...args: unknown[]) => unknown,
    ),
  );

  // P3：jobs 增量订阅——任务变化 → 推送全量快照（/jobs 面板实时刷新）。
  // 0.1.7 起走 jobs.events.subscribe({owner})（按 owner 过滤的事件流）；订阅不可用或抛错
  // → 退化为打开面板时的 refreshJobs() 主动拉取一次（不崩）。
  const jobsSvc = opts.jobs;
  if (jobsSvc !== undefined) {
    const pushJobs = (): void => {
      if (s.disposed || typeof jobsSvc.list !== "function") return;
      ctx.emit({
        type: "jobs-changed",
        sessionId: s.activeSessionId,
        jobs: collectJobs(jobsSvc.list(s.activeSessionId)),
      });
    };
    try {
      const jobsEvents = jobsSvc.events;
      const off =
        typeof jobsEvents?.subscribe === "function"
          ? jobsEvents.subscribe({ owner: s.activeSessionId }, pushJobs)
          : undefined;
      if (typeof off === "function") s.runtimeUnbinds.push(off);
    } catch {
      /* 订阅异常 → 打开面板时 refreshJobs() 兜底拉取 */
    }
  }

  return adapter;

  /** 收集 runtime.on 解绑函数(可能有返回)；dispose 时一并释放 */
  function collectUnbind(fn: (() => void) | void): void {
    if (typeof fn === "function") s.runtimeUnbinds.push(fn);
  }

  /**
   * 执行 slash 命令行：解析出命令名 → 查注册表 → 分发。结果经 notice 回报。
   * - 未注册(execute 返回 undefined) → notice 提示未知命令(fail-close)
   * - execute 抛错/reject → notice 错误文本
   * - 成功 → notice 文本(若有)
   * 全程不调用 agent.followup(不进模型历史)。
   */
  function dispatchCommand(line: string): void {
    const name = parseSlashCommand(line);
    if (!name) {
      ctx.emit({
        type: "notice",
        text: "invalid slash command: " + line,
        tone: "error",
      });
      return;
    }
    const { commands } = opts;
    if (!commands || typeof commands.execute !== "function") {
      ctx.emit({
        type: "notice",
        text: "commands 未就绪，无法执行 /" + name,
        error: true,
        tone: "warn",
      });
      return;
    }
    const controller = new AbortController();
    s.activeCommands.add(controller);
    const execAgent = s.activeCommandAgent ?? s.activeAgent;
    let res: unknown;
    try {
      res = commands.execute(execAgent, line, [], controller.signal);
    } catch (err) {
      s.activeCommands.delete(controller);
      ctx.emit({
        type: "notice",
        text: formatCommandError(name, err),
        tone: "error",
      });
      return;
    }
    if (res && typeof (res as { then?: unknown }).then === "function") {
      void (res as Promise<unknown>)
        .then((r) => finish(r, controller))
        .catch((err) => {
          s.activeCommands.delete(controller);
          ctx.emit({
            type: "notice",
            text: formatCommandError(name, err),
            tone: "error",
          });
        });
    } else {
      finish(res, controller);
    }
  }

  function finish(res: unknown, controller: AbortController): void {
    s.activeCommands.delete(controller);
    if (s.disposed) return;
    const exec = res as
      | { commandId?: string; result?: { kind?: string; text?: string } }
      | undefined;
    if (exec === undefined) {
      // 官方 fail-close：未命中 → 提示(标记失败色)，绝不 sendMessage 给模型
      ctx.emit({
        type: "notice",
        text: "未知命令，输入 /help 查看可用命令。",
        error: true,
        tone: "error",
      });
      return;
    }
    const kind = exec.result?.kind;
    const text = exec.result?.text;
    if (kind === "error") {
      ctx.emit({
        type: "notice",
        text: "命令 " + (exec.commandId ?? "") + " 执行出错：" + (text ?? ""),
        error: true,
        tone: "error",
      });
      return;
    }
    ctx.emit({
      type: "notice",
      text: (exec.commandId ? "[" + exec.commandId + "] " : "") + (text ?? ""),
      tone: "success",
    });
  }

  function formatCommandError(name: string, err: unknown): string {
    return "/" + name + " 执行出错：" + String(err);
  }
}
