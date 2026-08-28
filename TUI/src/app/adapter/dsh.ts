// src/app/adapter/dsh.ts — DSH 适配层契约（阶段 1 + 阶段 2 真实实现）
//
// 接口化让 mock（demo/）与真实（阶段 2）可互换，app 层不感知实现。
// 类型骨架依据官方 deepseek-harness 源码研读沉淀对齐（见 dsh-toolset/DSH-CTX-API.md，
// clone b150a551b8 = dsh-0.1.1-rc.2）。
//
// DSH 原生信号 → app 归一化事件的映射（阶段 2 已在 createRealDshAdapter 内实现）：
//   runtime.on('session/event', (session, e))  → 按 e.type 归一化：
//     - 'assistant/chunk' text-delta → { type: 'stream' }；reasoning-delta / reasoning block → { type: 'thinking' }
//       （正文与思考分别归一化，思考仅作为临时 UI 流展示）
//     - 'turn/start' 忽略；'turn/end' → { type: 'turn-end' }
//   runtime.on('agent/status', ({agent, status})) → { type: 'agent-status' }
//     （agent/status 是 agent 层事件，不在 session 日志词汇表内）
//
// 审批应答契约：DSH 侧是 waterfall 链事件 'approval/request'(req, next)，监听者返回
// ApprovalOutcome 即裁定；调用 next() 放行给后续监听者，最终无应答 fail-closed。
// request 须在 open turn 内发起。adapter 注册应答者，并把 app 的 approve(id, allow)
// 映射为 allow ? 'allowed-once' : 'rejected'；signal 中断/超时 → 'cancelled'：
// request 携带的 signal 中断立即取消，另有可配置的 approvalTimeoutMs 超时兜底。

export type AgentStatus = "idle" | "thinking" | "tool" | "done";

export interface SessionMeta {
  id: string;
  title: string;
}

export interface ApprovalItem {
  id: string;
  prompt: string;
}

/** 应用层收到的归一化事件（见文件头映射表） */
export type DshEvent =
  | { type: "session-list"; sessions: SessionMeta[] }
  | { type: "stream"; sessionId: string; text: string }
  | { type: "thinking"; sessionId: string; text: string }
  | { type: "approval"; id: string; prompt: string }
  | { type: "agent-status"; sessionId: string; status: AgentStatus }
  | { type: "notice"; text: string }
  | { type: "turn-end" };

/** 应用层对 adapter 的唯一依赖面：事件流入 + 出站回调（消息/命令/审批/打断） */
export interface DshAdapter {
  /** 订阅 DSH 会话事件；返回解绑函数 */
  onEvent(cb: (e: DshEvent) => void): () => void;
  /** 发送用户消息 */
  sendMessage(text: string, sessionId?: string): void;
  /**
   * 执行 slash 命令行(形如 /name args...)。约定：命令通过注册表调用 → 结果经
   * notice 事件回报；未命中(undefined)→ notice 提示未知命令(fail-close)，绝不
   * 作为用户消息发送给模型。渲染类命令(/help /clearscreen /cls /quit)由 app 层本地表处理，
   * 不经过本方法。
   */
  runCommand(line: string, sessionId?: string): void;
  /** 释放：中止在途命令分发、解绑运行时监听；可选(mock 无状态可缺省) */
  dispose?(): void;
  /** 审批：allow=true 批准（DSH 'allowed-once'），false 拒绝（'rejected'） */
  approve(id: string, allow: boolean): void;
  /** 打断当前思考/turn（真实实现映射 agent.cancel({kind:'user'})；宿主无取消能力时为 no-op） */
  interrupt(): void;
  /** 查询可用模型目录（provider + 各 provider 可用模型 + 当前默认选择） */
  modelCatalog(): Promise<ModelCatalog>;
  /** 切换当前会话模型（只改会话内 ref，绝不落盘）；返回应用后的选择 */
  setSessionModel(sel: ModelSelection): Promise<ModelSelection>;
  /** 查询指定 provider/model 的可选思考等级；非思考模型或服务缺失返回 undefined */
  modelEfforts(
    provider: string,
    model: string,
  ): Promise<{ id: string; name: string }[] | undefined>;
}

/** 模型目录条目（/model 列表展示用） */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  description?: string;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** 会话级模型选择引用：current 应用于下一 step；assembled 为当前 step 组装时的快照 */
export interface SessionModelSelectionRef {
  current: ModelSelection | undefined;
  assembled?: ModelSelection | undefined;
}

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

export interface ModelCatalog {
  providers: { provider: string; name?: string }[];
  models: ModelInfo[];
  current: ModelSelection | undefined;
}

// ---------- 以下 DSH 原生类型仅供阶段 2 adapter 实现参考（app 层不消费） ----------

/** DSH 会话事件类型子集（完整枚举见 KNOWN_SESSION_EVENT_TYPES，generated） */
export type SessionEventType =
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "user/message"
  | "assistant/message"
  | "assistant/chunk"
  | "tool/call"
  | "tool/result"
  | "approval/asked"
  | "approval/decided"
  | "approval/policy"
  | "session/end-seed"
  | "session/title"
  | "goal/change"
  | "compaction/start"
  | "compaction/end"
  | "plan/mode"
  | "sandbox/mode"
  | "subagent/descriptor"
  | "agent/preset/selected";

/** StreamChunk 子集（assistant/chunk 事件的 chunk 载荷；完整变体见 stream 契约） */
export type StreamChunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | {
      type: "tool-call-delta";
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | {
      type: "block-end";
      index: number;
      blockType?: string;
      /** 真实 DSH 载荷:完整块文本嵌套在 block.text(与 DSH-CTX-API.md StreamChunk 契约一致) */
      block?: { type?: string; text?: string; [k: string]: unknown };
    }
  | { type: "usage"; index?: number; usage: Record<string, unknown> }
  | { type: "finish"; reason: string; replayState?: unknown };

/** DSH 审批请求（approval/request 载荷） */
export interface ApprovalRequest {
  agent: unknown;
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

/** DSH 审批裁定词表（应答者返回其一，规范化） */
export type ApprovalOutcome =
  "allowed-once" | "rejected" | "cancelled" | "unavailable";

/** 各 type 的 data 载荷（阶段 2 用到的子集） */
export interface SessionEventDataMap {
  "turn/start": { turn: number };
  "turn/end": { turn: number; reason: string };
  "step/start": { turn: number; step: number };
  "step/end": { turn: number; step: number };
  "assistant/chunk": { turn: number; step: number; chunk: StreamChunk };
  "user/message": { id?: string };
  "assistant/message": { turn: number; step: number };
  "tool/call": { callId: string; name: string; arguments: string };
  "tool/result": { callId: string };
  "approval/asked": {
    id: string;
    toolName: string;
    callId?: string;
    reason?: string;
  };
  "approval/decided": { id: string; outcome: ApprovalOutcome };
  "approval/policy": { policy: "ask" | "never" };
  "session/title": { title: string };
  "agent/preset/selected": { preset: string };
}

/** DSH 会话事件（session/event 的 event 参数，type 与 data 联动窄化） */
export interface SessionEvent<T extends SessionEventType = SessionEventType> {
  type: T;
  seq: number;
  time: number;
  data: T extends keyof SessionEventDataMap
    ? SessionEventDataMap[T]
    : Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 阶段 2 真实实现：createRealDshAdapter
// ---------------------------------------------------------------------------

/** DSH 宿主的 slim 结构面（cordis Context 的结构子集），便于独立测试。 */
export interface DshRuntime {
  on(
    event: string,
    listener: (...args: unknown[]) => unknown,
  ): (() => void) | void;
}

/** 结构型 agent（真机来自 ctx.agents.create() 的 AgentHandle.agent） */
export interface DshAgentLike {
  readonly session: { readonly id: string };
  followup(message: DshUserMessageLike): void;
}

/** 结构型用户消息（真机应改用 createUserMessage 生成，字段同构） */
export interface DshUserMessageLike {
  readonly role: "user";
  readonly content: readonly { type: "text"; text: string }[];
  readonly source: { kind: "user" } | { kind: "plugin"; plugin: string };
}

/**
 * 结构面：官方 @deepseek-ai/dsh-commands 注册表（ctx.commands.execute）。
 * execute(agent, line, images, signal) → CommandExecution | undefined；
 * undefined 表示未命中注册表(fail-close)。与官方 packages/interaction/commands/
 * src/types.ts 契约一致(DSH-CTX-API.md)。
 */
export interface DshCommandLike {
  execute(
    agent: unknown,
    line: string,
    images?: unknown[],
    signal?: AbortSignal,
  ): Promise<unknown> | unknown;
}

/** ctx.get('llm') 服务（dsh-llm LlmRuntime）结构面，零运行时依赖 */
export interface LlmLike {
  listProviders?(): readonly { id?: string; name?: string }[];
  listModels?(provider: string):
    | Promise<
        readonly {
          provider?: string;
          id?: string;
          name?: string;
          description?: string;
        }[]
      >
    | readonly {
        provider?: string;
        id?: string;
        name?: string;
        description?: string;
      }[];
  /** 精确路由推理元数据（结构面：官方 LlmService.resolveModelInfo → LlmResolvedModelInfo.reasoning） */
  resolveModelInfo?(
    provider: string,
    model: string,
    signal?: unknown,
  ):
    | Promise<
        | {
            reasoning?: {
              efforts?: readonly { id?: string; name?: string }[];
              defaultEffort?: string;
            };
          }
        | undefined
      >
    | {
        reasoning?: {
          efforts?: readonly { id?: string; name?: string }[];
          defaultEffort?: string;
        };
      }
    | undefined;
}

export interface AgentDefaultModelLike {
  currentSelection?():
    { provider?: string; model?: string; reasoningEffort?: string } | undefined;
}

/** 从宿主选择读数（结构面防御：服务缺失/字段缺失均容错） */
export function readDefaultSelection(
  svc: AgentDefaultModelLike | undefined,
): ModelSelection | undefined {
  if (!svc || typeof svc.currentSelection !== "function") return undefined;
  const cur = svc.currentSelection();
  if (!cur?.provider || !cur.model) return undefined;
  return {
    provider: cur.provider,
    model: cur.model,
    ...(cur.reasoningEffort ? { reasoningEffort: cur.reasoningEffort } : {}),
  };
}

export interface RealAdapterOptions {
  runtime: DshRuntime;
  sessionId: string;
  /** app 使用的瘦 agent(用于 followup) */
  agent: DshAgentLike;
  /** 真实 Agent(注册表作用域查找用，通常与 main.ts 的 handle.agent 相同) */
  commandAgent?: unknown;
  /** DSH commands 注册表(来自 ctx.get('commands')，bundle 已挂载) */
  commands?: DshCommandLike;
  /** 审批弹窗超时（ms），超时未答 fallback 'cancelled'；默认 60s */
  approvalTimeoutMs?: number;
  /** 打断当前思考/turn 的回调（调用 agent.cancel({kind:'user'})）；宿主无 cancel 能力时不传 */
  interrupt?: () => void;
  /** ctx.get('llm') 服务（dsh-llm LlmRuntime）结构面 */
  llm?: LlmLike;
  /** 会话级模型选择引用；提供时 setSessionModel 只改 ref、不落盘 */
  sessionModel?: SessionModelSelectionRef;
  /** ctx.get('agentDefaultModel') 服务（只读兜底：会话未切换时作为目录/状态显示与组装默认） */
  defaultModel?: AgentDefaultModelLike;
}

/**
 * 解析 slash 命令行首段命令名。与官方 client 共用同一语法：
 * 小写字母开头[a-z][a-z0-9_-]*，后跟空白或行尾。非法返回 null。
 */
export function parseSlashCommand(line: string): string | null {
  const m = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/.exec(line);
  return m ? m[1]! : null;
}

/** 从 DSH ApprovalRequest 构造 app 审批提示文案 */
export function buildApprovalPrompt(req: ApprovalRequest): string {
  const reason = req.reason ? "：" + req.reason : "";
  return `允许工具 ${req.toolName} 执行?${reason}`;
}

/** 构造结构型用户消息（真机字段同 createUserMessage 输出） */
export function buildUserMessage(text: string): DshUserMessageLike {
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

/** DSH 'running'|'idle' → app AgentStatus */
export function normalizeAgentStatus(s: string | undefined): AgentStatus {
  switch (s) {
    case "running":
      return "thinking";
    case "tool":
      return "tool";
    case "idle":
      return "idle";
    default:
      return "idle";
  }
}

/** 构造真实 DSH adapter：注册应答者 + 订阅会话事件，归一化为 DshEvent。 */
export function createRealDshAdapter(opts: RealAdapterOptions): DshAdapter {
  const { runtime, sessionId, agent } = opts;
  const listeners = new Set<(e: DshEvent) => void>();
  const pendingApprovals = new Map<
    string,
    {
      resolve: (o: ApprovalOutcome) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let approvalSeq = 0;
  let disposed = false;
  const runtimeUnbinds: (() => void)[] = [];
  const activeCommands = new Set<AbortController>();
  // 流式块去重累计：key = session:turn:step:index，block-end 只补发未输出部分
  const emittedByBlock = new Map<string, string>();
  // 按 (session:turn:step) 累计已流式输出的正文（text 块；reasoning 不计）。
  // assistant/message 是每个 step 结束必发的完整正文表面事件，据此只补发缺失后缀；
  // 非流式 provider（无任何 chunk）时累计为空 → 直接输出完整正文，保证回复可见。
  const stepEmitted = new Map<string, string>();

  const emit = (e: DshEvent): void => {
    if (disposed) return;
    for (const cb of listeners) {
      try {
        cb(e);
      } catch (err) {
        process.stderr.write("[dsh adapter] emit error: " + String(err) + "\n");
      }
    }
  };

  // --- session/event 归一化 ---
  const onSessionEvent = (session: unknown, raw: SessionEvent): void => {
    const sid = (session as { id?: string } | null)?.id ?? sessionId;
    const data = raw.data as {
      chunk?: StreamChunk;
      text?: string;
      turn?: number;
      step?: number;
      message?: { content?: unknown[] };
    };
    switch (raw.type) {
      case "assistant/chunk": {
        const chunk = data.chunk as StreamChunk | undefined;
        if (!chunk) return;
        // 真实 DSH 同时送达增量 delta 与 block-end 完整块文本（DSH-CTX-API.md §2
        // PartialAccumulator 折叠语义）。按 (session, turn, step, index) 累计已流式
        // 输出的 delta，block-end 只补发未输出部分，避免完整正文被重复显示。
        // 同一 index 跨 turn/step 不复用累计（key 含 turn/step；turn/end 亦清空）。
        // finish/usage 等载荷可能无 index；仅带 index 的块类型参与累计
        const index = (chunk as { index?: number }).index ?? 0;
        const blockKey =
          sid + ":" + (data.turn ?? 0) + ":" + (data.step ?? 0) + ":" + index;
        const isReasoning =
          chunk.type === "reasoning-delta" ||
          (chunk.type === "block-end" &&
            (chunk.block?.type === "reasoning" ||
              chunk.blockType === "reasoning"));
        if (chunk.type === "block-start") {
          emittedByBlock.delete(blockKey);
        } else if (
          chunk.type === "reasoning-delta" ||
          chunk.type === "text-delta"
        ) {
          emittedByBlock.set(
            blockKey,
            (emittedByBlock.get(blockKey) ?? "") + chunk.text,
          );
          emit({
            type: isReasoning ? "thinking" : "stream",
            sessionId: sid,
            text: chunk.text,
          });
          // 仅正文进 step 累计（reasoning 为瞬态展示，不进 assistant/message）
          if (!isReasoning) {
            const sk = sid + ":" + (data.turn ?? 0) + ":" + (data.step ?? 0);
            stepEmitted.set(sk, (stepEmitted.get(sk) ?? "") + chunk.text);
          }
        } else if (chunk.type === "block-end") {
          const full =
            chunk.block?.text ??
            (chunk as StreamChunk & { text?: string }).text;
          if (full === undefined) return;
          const done = emittedByBlock.get(blockKey) ?? "";
          emittedByBlock.delete(blockKey);
          if (done === "") {
            // 无 delta 的 provider：block-end 即完整文本
            emit({
              type: isReasoning ? "thinking" : "stream",
              sessionId: sid,
              text: full,
            });
            if (!isReasoning) {
              const sk = sid + ":" + (data.turn ?? 0) + ":" + (data.step ?? 0);
              stepEmitted.set(sk, (stepEmitted.get(sk) ?? "") + full);
            }
          } else if (full.startsWith(done)) {
            // 已流式输出 delta，仅补发缺失后缀
            const rest = full.slice(done.length);
            if (rest.length > 0) {
              emit({
                type: isReasoning ? "thinking" : "stream",
                sessionId: sid,
                text: rest,
              });
              if (!isReasoning) {
                const sk =
                  sid + ":" + (data.turn ?? 0) + ":" + (data.step ?? 0);
                stepEmitted.set(sk, (stepEmitted.get(sk) ?? "") + rest);
              }
            }
          }
          // delta 与 block-end 文本不一致时不再输出（append-only UI 无法安全重写）
        }
        return;
      }

      case "assistant/message": {
        // 每 step 结束必发的完整正文表面事件（append 语义）。流式链路已按 delta
        // 输出正文，这里只按 step 补发缺失后缀；非流式 provider 无任何 chunk 时
        // stepEmitted 为空 → 直接输出完整正文，保证不支持流式/思考的模型回复可见。
        // surfaceOp 为 replace 的影子覆盖事件跳过（append-only 无法安全重写）。
        const op = (raw as { surfaceOp?: string }).surfaceOp;
        if (op === "replace") return;
        const content = data.message?.content;
        const text = Array.isArray(content)
          ? content
              .filter(
                (b): b is { type: "text"; text: string } =>
                  !!b &&
                  typeof b === "object" &&
                  (b as { type?: string }).type === "text" &&
                  typeof (b as { text?: string }).text === "string",
              )
              .map((b) => b.text)
              .join("")
          : "";
        if (text === "") return;
        const sk = sid + ":" + (data.turn ?? 0) + ":" + (data.step ?? 0);
        const done = stepEmitted.get(sk) ?? "";
        stepEmitted.delete(sk);
        if (done === "") {
          emit({ type: "stream", sessionId: sid, text });
        } else if (text.startsWith(done)) {
          const rest = text.slice(done.length);
          if (rest.length > 0) {
            emit({ type: "stream", sessionId: sid, text: rest });
          }
        }
        // delta 与 message 文本不一致时不再输出（append-only UI 无法安全重写）
        return;
      }

      case "turn/start":
        // turn/start 只标记新回合，不插入历史分隔线；用户本地回显后应紧邻模型响应。
        return;
      case "turn/end":
        // turn 结束：清空流式累计，block index 跨 turn 复用不残留
        emittedByBlock.clear();
        stepEmitted.clear();
        emit({ type: "turn-end" });
        return;
      default:
        return;
    }
  };

  // --- approval/request waterfall 应答者 ---
  const settle = (id: string, outcome: ApprovalOutcome): void => {
    const pending = pendingApprovals.get(id);
    if (!pending) return;
    pendingApprovals.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(outcome);
  };

  const approvalAnswerer = (
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    if (disposed || listeners.size === 0) return next();
    const id = "approval-" + approvalSeq++;
    const prompt = buildApprovalPrompt(req);
    const timer = setTimeout(
      () => settle(id, "cancelled"),
      opts.approvalTimeoutMs ?? 60_000,
    );
    return new Promise<ApprovalOutcome>((resolve) => {
      pendingApprovals.set(id, { resolve, timer });
      emit({ type: "approval", id, prompt });
      const signal = req.signal;
      if (signal?.aborted) {
        settle(id, "cancelled");
        resolve("cancelled");
        return;
      }
      signal?.addEventListener("abort", () => settle(id, "cancelled"), {
        once: true,
      });
    });
  };

  const adapter: DshAdapter = {
    onEvent(cb) {
      if (disposed) return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    sendMessage(text, targetSessionId) {
      if (disposed) return;
      if (targetSessionId && targetSessionId !== sessionId) {
        process.stderr.write(
          "[dsh adapter] sendMessage: sessionId " +
            targetSessionId +
            " not active\n",
        );
        return;
      }
      agent.followup(buildUserMessage(text));
    },
    runCommand(line, targetSessionId) {
      if (disposed) return;
      if (targetSessionId && targetSessionId !== sessionId) {
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
      if (disposed) return;
      disposed = true;
      for (const c of activeCommands) c.abort();
      activeCommands.clear();
      for (const u of runtimeUnbinds) u();
      runtimeUnbinds.length = 0;
      emittedByBlock.clear();
      stepEmitted.clear();
      listeners.clear();
    },
    approve(id, allow) {
      if (disposed) return;
      settle(id, allow ? "allowed-once" : "rejected");
    },
    interrupt() {
      if (disposed) return;
      opts.interrupt?.();
    },
    async modelCatalog() {
      const current =
        opts.sessionModel?.current ?? readDefaultSelection(opts.defaultModel);
      const providers: ModelCatalog["providers"] = [];
      const models: ModelInfo[] = [];
      const llm = opts.llm;
      if (llm && typeof llm.listProviders === "function") {
        for (const p of llm.listProviders() ?? []) {
          const pid = p.id ?? "";
          if (!pid) continue;
          providers.push({ provider: pid, name: p.name });
          if (typeof llm.listModels === "function") {
            const list = await llm.listModels(pid);
            for (const m of list ?? []) {
              if (!m.id) continue;
              models.push({
                provider: pid,
                id: m.id,
                name: m.name ?? m.id,
                description: m.description,
              });
            }
          }
        }
      }
      return { providers, models, current };
    },
    async setSessionModel(sel) {
      if (!opts.sessionModel) {
        throw new Error("会话模型引用未注入，无法切换模型");
      }
      // 只改会话语义内的引用，绝不写宿主 settings（避免覆盖配置默认模型）
      opts.sessionModel.current = sel;
      return sel;
    },
    async modelEfforts(provider, model) {
      const llm = opts.llm;
      if (!llm || typeof llm.resolveModelInfo !== "function") return undefined;
      let info;
      try {
        info = await llm.resolveModelInfo(provider, model);
      } catch {
        return undefined;
      }
      const efforts = info?.reasoning?.efforts ?? [];
      const list = efforts
        .map((e) => (e.id ? { id: e.id, name: e.name ?? e.id } : null))
        .filter((e): e is { id: string; name: string } => e !== null);
      // 非思考模型(无 efforts)按 undefined 处理，面板显示"不支持"
      return list.length > 0 ? list : undefined;
    },
  };

  collectUnbind(
    runtime.on("session/event", (session, event) =>
      onSessionEvent(session, event as SessionEvent),
    ),
  );
  collectUnbind(
    runtime.on("agent/status", (payload) =>
      emitAgentStatus(payload as { agent?: unknown; status?: string }),
    ),
  );
  collectUnbind(
    runtime.on(
      "approval/request",
      approvalAnswerer as (...args: unknown[]) => unknown,
    ),
  );

  return adapter;

  /** 收集 runtime.on 解绑函数(可能有返回)；dispose 时一并释放 */
  function collectUnbind(fn: (() => void) | void): void {
    if (typeof fn === "function") runtimeUnbinds.push(fn);
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
      emit({ type: "notice", text: "invalid slash command: " + line });
      return;
    }
    const { commands } = opts;
    if (!commands || typeof commands.execute !== "function") {
      emit({ type: "notice", text: "commands 未就绪，无法执行 /" + name });
      return;
    }
    const controller = new AbortController();
    activeCommands.add(controller);
    const execAgent = opts.commandAgent ?? agent;
    let res: unknown;
    try {
      res = commands.execute(execAgent, line, [], controller.signal);
    } catch (err) {
      activeCommands.delete(controller);
      emit({ type: "notice", text: formatCommandError(name, err) });
      return;
    }
    if (res && typeof (res as { then?: unknown }).then === "function") {
      void (res as Promise<unknown>)
        .then((r) => finish(r, controller))
        .catch((err) => {
          activeCommands.delete(controller);
          emit({ type: "notice", text: formatCommandError(name, err) });
        });
    } else {
      finish(res, controller);
    }
  }

  function finish(res: unknown, controller: AbortController): void {
    activeCommands.delete(controller);
    if (disposed) return;
    const exec = res as
      | { commandId?: string; result?: { kind?: string; text?: string } }
      | undefined;
    if (exec === undefined) {
      // 官方 fail-close：未命中 → 提示，绝不 sendMessage 给模型
      emit({ type: "notice", text: "未知命令，输入 /help 查看可用命令。" });
      return;
    }
    const kind = exec.result?.kind;
    const text = exec.result?.text;
    if (kind === "error") {
      emit({
        type: "notice",
        text: "命令 " + (exec.commandId ?? "") + " 执行出错：" + (text ?? ""),
      });
      return;
    }
    emit({
      type: "notice",
      text: (exec.commandId ? "[" + exec.commandId + "] " : "") + (text ?? ""),
    });
  }

  function formatCommandError(name: string, err: unknown): string {
    return "/" + name + " 执行出错：" + String(err);
  }

  function emitAgentStatus(payload: {
    agent?: unknown;
    status?: string;
  }): void {
    const status = normalizeAgentStatus(payload?.status);
    emit({ type: "agent-status", sessionId, status });
  }
}
