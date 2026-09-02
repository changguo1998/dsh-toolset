// src/app/adapter/dsh.ts — DSH 适配层：真实实现 + 兼容重导（类型/纯函数已拆出）
//
// 29 个纯类型见 ./types.ts，5 个纯归一化函数见 ./normalize.ts；本文件保留
// installSessionModelSelection 与 createRealDshAdapter，并以显式重导保持原
// ./adapter/dsh.ts 公共导出不变（外部 import 路径无需改动）。
//
// 接口化让 mock（demo/）与真实（阶段 2）可互换，app 层不感知实现。
// tool-bootstrap（锚定工具引导）见 ./tool-bootstrap.ts，本文件显式重导保持公共导出不变。
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

import type {
  DshEvent,
  DshAdapter,
  ModelInfo,
  ModelSelection,
  SessionModelSelectionRef,
  ModelCatalog,
  StreamChunk,
  ApprovalRequest,
  ApprovalOutcome,
  QuestionAnswer,
  UserQuestionRequestLike,
  SessionEvent,
  DshRuntime,
  DshAgentLike,
  RealAdapterOptions,
  HistoryMessage,
  SessionSurfaceView,
} from "./types.ts";
import {
  buildApprovalPrompt,
  buildUserMessage,
  localTitleFromText,
  normalizeAgentStatus,
  parseSlashCommand,
  readDefaultSelection,
} from "./normalize.ts";

export type {
  AgentStatus,
  SessionMeta,
  ApprovalItem,
  DshEvent,
  DshAdapter,
  ModelInfo,
  ModelSelection,
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
  UserQuestionsLike,
  UserQuestionRequestLike,
  SessionEventDataMap,
  SessionEvent,
  DshRuntime,
  DshAgentLike,
  DshUserMessageLike,
  DshCommandLike,
  LlmLike,
  AgentDefaultModelLike,
  RealAdapterOptions,
  SessionInfo,
  HistoryMessage,
  SessionSurfaceView,
  SessionQueryLike,
  SessionStoreLike,
  AgentRegistryLike,
} from "./types.ts";
export {
  buildApprovalPrompt,
  buildUserMessage,
  normalizeAgentStatus,
  parseSlashCommand,
  readDefaultSelection,
} from "./normalize.ts";

export {
  classifyTask,
  coreFor,
  personaFor,
  applyPersona,
  sessionMode,
  isV4ProModel,
  isPromotedFromEvents,
  installToolBootstrap,
  type ToolBootstrapOptions,
  type TaskAnchor,
} from "./tool-bootstrap.ts";

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

// ---------------------------------------------------------------------------
// 阶段 2 真实实现：createRealDshAdapter
// ---------------------------------------------------------------------------

/** 从表面事件 content 块数组提取纯文本（v1 仅取 text 块；reasoning/tool-result 省略） */
function extractTextBlocks(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content as Array<Record<string, unknown>>) {
    if (b && b.type === "text" && typeof b.text === "string")
      parts.push(b.text);
  }
  return parts.join("\n");
}

/** 表面事件数组 → app 消息列表。
 * 支持两种落在原始日志里的消息形态：
 *  1. user/message、assistant/message（旧/其他 backend 的完整消息事件）；
 *  2. agent/inbox/spliced（当前 dsh 内存会话承载消息的形态）——文本在
 *     data.inserted[].content[]（role 取 inserted[].role，仅 user/assistant）。
 * 其余（tool/result、系统事件）省略。
 */
function normalizeHistoryMessages(
  events: readonly Record<string, unknown>[],
): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const e of events) {
    const data = e.data as Record<string, unknown> | undefined;
    if (!data) continue;
    if (e.type === "user/message") {
      out.push({ role: "user", text: extractTextBlocks(data.content) });
    } else if (e.type === "assistant/message") {
      const msg = data.message as Record<string, unknown> | undefined;
      out.push({ role: "assistant", text: extractTextBlocks(msg?.content) });
    } else if (e.type === "agent/inbox/spliced") {
      const inserted = data.inserted;
      if (!Array.isArray(inserted)) continue;
      for (const item of inserted as Array<Record<string, unknown>>) {
        const role = item.role;
        if (role !== "user" && role !== "assistant") continue;
        out.push({ role, text: extractTextBlocks(item.content) });
      }
    }
  }
  return out;
}

/** 构造真实 DSH adapter：注册应答者 + 订阅会话事件，归一化为 DshEvent。 */
export function createRealDshAdapter(opts: RealAdapterOptions): DshAdapter {
  const { runtime } = opts;
  const sessionQuery = opts.sessionQuery;
  // 活跃会话引用（可变）：初始来自 opts；resumeTo 切换后指向新 agent/会话。
  // 旧 handle 在切换成功后释放（activeDispose），新 handle 由 adapter.dispose 释放。
  let activeSessionId = opts.sessionId;
  let activeAgent = opts.agent;
  let activeCommandAgent = opts.commandAgent;
  let activeCancel = opts.interrupt ?? (() => {});
  let activeDispose = opts.handleDispose;
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

  /** 只读会话表面（live 直接读内存事件；persisted 走 readSurface；兜底 readSession） */
  const doReadSessionSurface = async (
    id: string,
  ): Promise<SessionSurfaceView> => {
    if (!sessionQuery) {
      throw new Error(
        "sessionQuery 未暴露 readSession/readSurface，无法读取会话内容",
      );
    }
    const live = opts.sessions?.get(id);
    if (live && Array.isArray(live.events)) {
      return {
        sessionId: id,
        messages: normalizeHistoryMessages(live.events),
      };
    }
    if (sessionQuery.readSurface) {
      const snap = await sessionQuery.readSurface(id);
      return {
        sessionId: id,
        messages: normalizeHistoryMessages(snap.events),
      };
    }
    if (sessionQuery.readSession) {
      const snap = await sessionQuery.readSession(id);
      return {
        sessionId: id,
        messages: normalizeHistoryMessages(snap.events),
      };
    }
    throw new Error(
      "sessionQuery 未暴露 readSession/readSurface，无法读取会话内容",
    );
  };

  /** 有界并发助手（列表标题本地兜底读取用，避免 180+ 会话顺序读拖慢面板） */
  const mapLimit = async <T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> => {
    const out = new Array<R>(items.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]!);
      }
    };
    const n = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: n }, () => worker()));
    return out;
  };

  /** 官方标题：批量折叠 session/title 事件（readTitleSnapshots 优先；缺失逐条 readTitle） */
  const officialTitles = async (
    ids: string[],
  ): Promise<Map<string, string>> => {
    const map = new Map<string, string>();
    if (!sessionQuery) return map;
    try {
      if (typeof sessionQuery.readTitleSnapshots === "function") {
        const snaps = await sessionQuery.readTitleSnapshots(ids);
        for (const snap of snaps) {
          if (snap?.sessionId && snap.title?.title) {
            map.set(snap.sessionId, snap.title.title);
          }
        }
      } else if (typeof sessionQuery.readTitle === "function") {
        await mapLimit(ids, 8, async (id) => {
          try {
            const t = await sessionQuery.readTitle!(id);
            if (t?.title) map.set(id, t.title);
          } catch {
            /* 单个会话标题读取失败不阻断 */
          }
        });
      }
    } catch {
      /* 标题服务不可用 → 全走本地兜底 */
    }
    return map;
  };

  // --- session/event 归一化 ---
  const onSessionEvent = (session: unknown, raw: SessionEvent): void => {
    const sid = (session as { id?: string } | null)?.id ?? activeSessionId;
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
      case "session/title": {
        // 官方 dsh-session-title 落盘事件（fallback/provider/user 任一 source）：
        // 仅转发当前活跃会话（adapter 视角权威），状态栏标题优先该官方折叠结果
        const title = (raw.data as { title?: unknown }).title;
        if (
          sid === activeSessionId &&
          typeof title === "string" &&
          title.trim() !== ""
        ) {
          emit({ type: "session-title", sessionId: sid, title });
        }
        return;
      }
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

  // --- user-questions provider 接线（0.1.1 单 provider；每次最多一个活动请求） ---
  let questionSeq = 0;
  const pendingQuestions = new Map<
    string,
    {
      resolve: (a: QuestionAnswer) => void;
      reject: (err: unknown) => void;
      cleanup: () => void;
    }
  >();
  const questionDisposers: (() => void)[] = [];
  // 构造期注册失败先缓冲，待首个监听者订阅后补发（构造时无人订阅，直接 emit 会丢）
  let pendingRegNotices: DshEvent[] = [];

  const questionProvider = {
    ask(req: UserQuestionRequestLike): Promise<QuestionAnswer> {
      // 单面板约束：已有活动请求时拒绝新请求（绝不覆盖旧 Promise），让 agent 自行处理
      if (pendingQuestions.size > 0) {
        return Promise.reject(
          new Error("已有待回答的提问，请先完成当前问答面板"),
        );
      }
      const id = "question-" + questionSeq++;
      return new Promise<QuestionAnswer>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          cleanup: () => {},
        };
        const onAbort = () => {
          entry.cleanup();
          reject(
            new Error("ask_user_question was aborted before the user answered"),
          );
        };
        entry.cleanup = () => {
          if (pendingQuestions.get(id) !== entry) return;
          pendingQuestions.delete(id);
          req.signal?.removeEventListener("abort", onAbort);
        };
        pendingQuestions.set(id, entry);
        if (req.signal?.aborted) {
          onAbort();
          return;
        }
        req.signal?.addEventListener("abort", onAbort, { once: true });
        emit({ type: "question", id, questions: req.questions });
      });
    },
  };

  // 注册问题 provider。0.1.1 是单 provider：已有 provider（如官方 client UI）时
  // 宿主抛 DUPLICATE_PROVIDER —— 不覆盖、不阻塞 TUI 启动，仅报告并 fail-safe。
  try {
    const disposer = opts.userQuestions?.registerProvider(questionProvider);
    if (disposer) questionDisposers.push(disposer);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      "[dsh adapter] userQuestions provider 注册失败: " + detail + "\n",
    );
    const notice: DshEvent = {
      type: "notice",
      text: "问答面板不可用（provider 注册失败）：" + detail,
      error: true,
    };
    if (listeners.size > 0) {
      emit(notice);
    } else {
      // 构造期无订阅者：缓冲，onEvent 首次订阅时补发（真实链路 App 紧随订阅）
      pendingRegNotices.push(notice);
    }
  }

  const adapter: DshAdapter = {
    onEvent(cb) {
      if (disposed) return () => {};
      listeners.add(cb);
      // 补发构造期缓冲的注册失败 notice（一次性，触碰即清）
      if (pendingRegNotices.length > 0) {
        const flush = pendingRegNotices;
        pendingRegNotices = [];
        for (const n of flush) {
          try {
            cb(n);
          } catch {
            /* 订阅者异常不影响其他事件 */
          }
        }
      }
      return () => listeners.delete(cb);
    },
    sendMessage(text, targetSessionId) {
      if (disposed) return;
      if (targetSessionId && targetSessionId !== activeSessionId) {
        process.stderr.write(
          "[dsh adapter] sendMessage: sessionId " +
            targetSessionId +
            " not active\n",
        );
        return;
      }
      activeAgent.followup(buildUserMessage(text));
    },
    runCommand(line, targetSessionId) {
      if (disposed) return;
      if (targetSessionId && targetSessionId !== activeSessionId) {
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
      // 拒绝所有悬挂问答（绝不留下悬浮 Promise），并注销 provider
      for (const p of pendingQuestions.values()) {
        p.cleanup();
        p.reject(new Error("adapter disposed"));
      }
      pendingQuestions.clear();
      for (const d of questionDisposers) {
        try {
          d();
        } catch {
          /* 注销失败不影响退出 */
        }
      }
      questionDisposers.length = 0;
      emittedByBlock.clear();
      stepEmitted.clear();
      listeners.clear();
      if (activeDispose) {
        void activeDispose().catch(() => {});
        activeDispose = undefined;
      }
    },
    approve(id, allow) {
      if (disposed) return;
      settle(id, allow ? "allowed-once" : "rejected");
    },
    answerQuestion(id, answer) {
      if (disposed) return;
      const pending = pendingQuestions.get(id);
      if (!pending) return;
      pending.cleanup();
      pending.resolve(answer);
    },
    cancelQuestion(id) {
      if (disposed) return;
      const pending = pendingQuestions.get(id);
      if (!pending) return;
      pending.cleanup();
      pending.reject(new Error("用户取消了提问"));
    },
    interrupt() {
      if (disposed) return;
      activeCancel?.();
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
    // 历史会话列表（宿主挂载 sessionQuery 时可用）：newest-first；
    // 标题优先官方 session/title 事件（批量折叠），缺失时本地兜底首条用户消息
    listSessions: sessionQuery
      ? async () => {
          const rs = await sessionQuery.listSessions();
          const ids = rs.map((r) => r.header.id);
          const official = await officialTitles(ids);
          // 无官方标题的会话：本地兜底（surface 首条用户消息）；损坏/不可读取 → 省略
          const fallback = await mapLimit(
            ids.filter((id) => !official.has(id)),
            8,
            async (id) => {
              try {
                const view = await doReadSessionSurface(id);
                const first = view.messages.find((m) => m.role === "user");
                return [id, localTitleFromText(first?.text)] as const;
              } catch {
                return [id, undefined] as const;
              }
            },
          );
          const byId = new Map(fallback.filter(([, t]) => t !== undefined));
          return rs.map((r) => ({
            id: r.header.id,
            createdAt: r.header.createdAt,
            cwd: r.header.cwd,
            live: r.live,
            persisted: r.persisted,
            // 当前活跃判定以 adapter 视角为准（活跃会话在内存 store 中必为 live）
            ...(r.live && r.header.id === activeSessionId
              ? { current: true }
              : {}),
            ...((official.get(r.header.id) ?? byId.get(r.header.id))
              ? { title: official.get(r.header.id) ?? byId.get(r.header.id) }
              : {}),
          }));
        }
      : undefined,
    readSessionSurface: sessionQuery
      ? (id) => {
          // 读取顺序（按 live/persisted 判定，避免走错接口）见 doReadSessionSurface
          return doReadSessionSurface(id);
        }
      : undefined,
    async sessionTitle(id) {
      if (!sessionQuery || typeof sessionQuery.readTitle !== "function") {
        return undefined;
      }
      try {
        const t = await sessionQuery.readTitle(id);
        return t?.title;
      } catch {
        return undefined;
      }
    },
    async resumeTo(id) {
      if (disposed) {
        throw new Error("adapter 已释放，无法切换会话");
      }
      if (!opts.agents || typeof opts.agents.resume !== "function") {
        throw new Error("agents 未暴露 resume（宿主未配置会话持久化）");
      }
      // 契约顺序（P0 切换）：先释放当前 agent 的 handle（旧会话不再活跃），
      // 再 agents.resume 加载目标持久化会话；resume 失败 → 面板 error 态不崩溃。
      const prevDispose = activeDispose;
      if (prevDispose) {
        activeDispose = undefined;
        try {
          await prevDispose();
        } catch {
          /* 旧 handle 释放失败不阻断切换 */
        }
      }
      const handle = await opts.agents.resume({
        resumeSessionId: id,
        ...(opts.agentOptions ? { agentOptions: opts.agentOptions } : {}),
        ...(opts.setup ? { setup: opts.setup } : {}),
      });
      const rawAgent = handle.agent as
        | {
            session?: { id?: string };
            followup?: (m: ReturnType<typeof buildUserMessage>) => void;
            cancel?: (cause: { kind: "user" }) => void;
          }
        | undefined;
      if (!rawAgent?.session || !rawAgent.session.id) {
        try {
          await handle.dispose();
        } catch {
          /* 释放失败不阻断 */
        }
        throw new Error("resume 未返回有效 agent");
      }
      const newAgent = {
        session: rawAgent.session,
        followup: (m: ReturnType<typeof buildUserMessage>) =>
          rawAgent.followup?.(m),
      } as DshAgentLike;
      activeAgent = newAgent;
      activeCommandAgent = rawAgent as unknown;
      activeCancel =
        rawAgent.cancel === undefined
          ? () => {}
          : () => rawAgent.cancel?.({ kind: "user" });
      activeSessionId = id;
      activeDispose = () => handle.dispose();
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
      emit({
        type: "notice",
        text: "commands 未就绪，无法执行 /" + name,
        error: true,
      });
      return;
    }
    const controller = new AbortController();
    activeCommands.add(controller);
    const execAgent = activeCommandAgent ?? activeAgent;
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
      // 官方 fail-close：未命中 → 提示(标记失败色)，绝不 sendMessage 给模型
      emit({
        type: "notice",
        text: "未知命令，输入 /help 查看可用命令。",
        error: true,
      });
      return;
    }
    const kind = exec.result?.kind;
    const text = exec.result?.text;
    if (kind === "error") {
      emit({
        type: "notice",
        text: "命令 " + (exec.commandId ?? "") + " 执行出错：" + (text ?? ""),
        error: true,
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
    emit({ type: "agent-status", sessionId: activeSessionId, status });
  }
}
