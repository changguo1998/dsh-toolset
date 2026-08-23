// src/app/adapter/dsh.ts — DSH 适配层契约（阶段 1 + 阶段 2 真实实现）
//
// 接口化让 mock（demo/）与真实（阶段 2）可互换，app 层不感知实现。
// 类型骨架依据官方 deepseek-harness 源码研读沉淀对齐（见 dsh-toolset/DSH-CTX-API.md，
// clone b150a551b8 = dsh-0.1.1-rc.2）。
//
// DSH 原生信号 → app 归一化事件的映射（阶段 2 已在 createRealDshAdapter 内实现）：
//   runtime.on('session/event', (session, e))  → 按 e.type 归一化：
//     - 'assistant/chunk' {turn,step,chunk} 中 chunk.type='text-delta'|'reasoning-delta'
//       的 text 合并 → { type: 'stream' }
//     - 'turn/start' | 'turn/end'          → { type: 'turn-end' }
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
  | { type: "approval"; id: string; prompt: string }
  | { type: "agent-status"; sessionId: string; status: AgentStatus }
  | { type: "notice"; text: string }
  | { type: "turn-end" };

/** 应用层对 adapter 的唯一依赖面：事件流入 + 两个出站回调 */
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
    const data = raw.data as { chunk?: StreamChunk; text?: string };
    switch (raw.type) {
      case "assistant/chunk": {
        const chunk = data.chunk as StreamChunk | undefined;
        if (!chunk) return;
        // DSH deepseek adapter 实测送达形式：block-start/block-end(block-end 携带
        // 完整 text)。text-delta/reasoning-delta 为增量契约(部分 provider 使用)。
        // 统一归一化为 stream 事件，两种形态不会在同一 provider 上同时出现。
        if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
          emit({ type: "stream", sessionId: sid, text: chunk.text });
        } else if (
          chunk.type === "block-end" &&
          (chunk.block?.text ??
            (chunk as StreamChunk & { text?: string }).text) !== undefined
        ) {
          emit({
            type: "stream",
            sessionId: sid,
            text:
              chunk.block?.text ??
              (chunk as StreamChunk & { text?: string }).text!,
          });
        }
        return;
      }
      case "turn/start":
      case "turn/end":
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
      listeners.clear();
    },
    approve(id, allow) {
      if (disposed) return;
      settle(id, allow ? "allowed-once" : "rejected");
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
