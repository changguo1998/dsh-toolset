// TUI/src/app/adapter/dsh-events.ts — 事件转接: session/event 归一化 + 实时帧
//
// 由 dsh.ts 的 createRealDshAdapter 机械搬出（行为不变）。依赖上下文对象与两个注入函数:
// resolveContextWindow（会话面）与 settle（审批桥）。

import type {
  DshEvent,
  DshAdapter,
  ModelSelection,
  StreamChunk,
  AssistantStreamRecord,
  ApprovalOutcome,
  SessionEvent,
  TokenUsage,
  GoalChangeLike,
  TodoItemLike,
  SubagentDescriptorLike,
  ContentBlockLike,
  CompactionSummaryPayloadLike,
} from "./types.ts";
import {
  normalizeAgentStatus,
  noticeSummaryOf,
  readDefaultSelection,
  ruleInjectionTextOf,
  summarizeToolArguments,
} from "./normalize.ts";
import {
  toolResultCallId,
  toolResultDetail,
  toolResultFailed,
  turnEndNotice,
  turnEndReason,
  workSummary,
} from "./history-normalize.ts";
import type { AdapterContext } from "./context.ts";

export interface EventBridgeDeps {
  resolveContextWindow(key: string): Promise<number | undefined>;
  settle(
    id: string,
    outcome: ApprovalOutcome,
    reason?: "timeout" | "abort",
  ): void;
}

export function createEventBridge(ctx: AdapterContext, deps: EventBridgeDeps) {
  const s = ctx.state;
  const { opts } = ctx;

  const recordAgentRate = (sid: string, chars: number, time: number): void => {
    if (!(chars > 0) || !(time > 0)) return;
    const w = s.rateBySession.get(sid) ?? { acc: 0, since: time };
    const secs = (time - w.since) / 1000;
    if (secs >= 1) {
      const inst = w.acc / secs;
      w.tps = w.tps === undefined ? inst : w.tps * 0.5 + inst * 0.5;
      w.acc = 0;
      w.since = time;
    }
    w.acc += chars / 4;
    s.rateBySession.set(sid, w);
  };

  /**
   * 更正事件判定：宿主 `SurfaceOp = 'append' | { op: 'replace', startSeq, endSeq }`
   * （`docs/host/DSH-CTX-API.md`），写在**事件顶层**，兼容放在 `data` 内。缺省（无标记）
   * 按 append 处理。TUI 显示面是 append-only（缓冲行不保留源事件 seq 的完整映射），无法
   * 安全重写已展示区间，故三类 surface 事件命中后一律跳过整条；口径与 `rule-engine` 一致，
   * 不支持范围替换的替代路径见 `TUI/docs/DESIGN.md`。
   */
  function isCorrectiveEvent(raw: unknown): boolean {
    if (raw === null || typeof raw !== "object") return false;
    const event = raw as { surfaceOp?: unknown; data?: unknown };
    const top = event.surfaceOp;
    if (top !== undefined) return isReplaceOp(top);
    const data = event.data;
    if (data === null || typeof data !== "object") return false;
    return isReplaceOp((data as { surfaceOp?: unknown }).surfaceOp);
  }

  /** `SurfaceOp` 是否为 replace 形态（字符串 `"replace"` 或 `{ op: "replace", … }`）。 */
  function isReplaceOp(op: unknown): boolean {
    if (typeof op === "string") return op === "replace";
    if (op === null || typeof op !== "object") return false;
    return (op as { op?: unknown }).op === "replace";
  }

  // --- 流式块应用（实时帧与结算数组共用） ---
  // 按 (session, turn, step, index) 累计已流式输出的 delta，block-end 只补发未输出
  // 部分（docs/host/DSH-CTX-API.md §2 PartialAccumulator 折叠语义），避免完整正文重复显示。
  // 同一 index 跨 turn/step 不复用累计（key 含 turn/step；turn/end 亦清空）。
  // finish/usage 等载荷可能无 index；仅带 index 的块类型参与累计。
  // completedBlocks 拦截：实时帧已完整交付的块，结算数组不再输出。
  const applyChunk = (
    sid: string,
    turn: number,
    step: number,
    chunk: StreamChunk,
    settle = false,
  ): void => {
    const index = (chunk as { index?: number }).index ?? 0;
    const blockKey = sid + ":" + turn + ":" + step + ":" + index;
    const sk = sid + ":" + turn + ":" + step;
    const isReasoning =
      chunk.type === "reasoning-delta" ||
      (chunk.type === "block-end" &&
        (chunk.block?.type === "reasoning" || chunk.blockType === "reasoning"));
    if (chunk.type === "block-start") {
      s.emittedByBlock.delete(blockKey);
    } else if (
      chunk.type === "reasoning-delta" ||
      chunk.type === "text-delta"
    ) {
      // 实时帧已完整交付（completedBlocks 有 key）的块：结算数组里的 delta 跳过
      if (s.completedBlocks.has(blockKey)) return;
      const emitted = s.emittedByBlock.get(blockKey) ?? "";
      // 结算 delta 与实时帧 delta 同源同切分：该片段已实时输出过（新 delta 是
      // 已累计文本的前缀）则跳过，只输出尚未覆盖的新片段（实时帧中途丢失时结算补全）
      if (
        emitted !== "" &&
        chunk.text.length <= emitted.length &&
        emitted.startsWith(chunk.text)
      ) {
        return;
      }
      s.emittedByBlock.set(blockKey, emitted + chunk.text);
      // 结算线（settle）的逐成员重放不投递给接收层：它在记录层按块聚合投递一次 full
      if (!settle) {
        ctx.deliverText(
          turn,
          step,
          index,
          isReasoning ? "reasoning" : "assistant",
          chunk.text,
        );
      }
      ctx.emit({
        type: isReasoning ? "thinking" : "stream",
        sessionId: sid,
        text: chunk.text,
      });
      // 仅正文进 step 累计（reasoning 为瞬态展示，不进 assistant/message）
      if (!isReasoning) {
        s.stepEmitted.set(sk, (s.stepEmitted.get(sk) ?? "") + chunk.text);
      }
    } else if (chunk.type === "block-end") {
      // 实时帧已完整交付（completedBlocks 有 key）的块：结算数组跳过
      if (s.completedBlocks.has(blockKey)) return;
      const full =
        chunk.block?.text ?? (chunk as StreamChunk & { text?: string }).text;
      if (full === undefined) return;
      const done = s.emittedByBlock.get(blockKey) ?? "";
      s.emittedByBlock.delete(blockKey);
      // 结算整块投递给接收层（前缀对齐在接收层做：与已交付增量不重复）
      ctx.deliverText(
        turn,
        step,
        index,
        isReasoning ? "reasoning" : "assistant",
        full,
        true,
      );
      if (done === "") {
        // 无 delta 的 provider：block-end 即完整文本
        ctx.emit({
          type: isReasoning ? "thinking" : "stream",
          sessionId: sid,
          text: full,
        });
        if (!isReasoning) {
          s.stepEmitted.set(sk, (s.stepEmitted.get(sk) ?? "") + full);
        }
      } else if (full.startsWith(done)) {
        // 已流式输出 delta，仅补发缺失后缀
        const rest = full.slice(done.length);
        if (rest.length > 0) {
          ctx.emit({
            type: isReasoning ? "thinking" : "stream",
            sessionId: sid,
            text: rest,
          });
          if (!isReasoning) {
            s.stepEmitted.set(sk, (s.stepEmitted.get(sk) ?? "") + rest);
          }
        }
      }
      // 块已完整处理（delta 与 block-end 不一致时不再输出——append-only UI 无法
      // 安全重写）→ 标记完成，结算通道不再重复尝试
      s.completedBlocks.add(blockKey);
    }
  };

  const onAssistantFrame = (
    sessionId: string,
    frame: {
      type: string;
      attemptId: string;
      turn?: number;
      step?: number;
      chunk?: StreamChunk;
    },
  ): void => {
    // 单活跃会话口径与 session/event 一致
    if (sessionId !== s.activeSessionId) return;
    if (frame.type === "start" && frame.turn !== undefined) {
      s.attemptMeta.set(frame.attemptId, {
        turn: frame.turn,
        step: frame.step ?? 0,
      });
      s.liveScope = { turn: frame.turn, step: frame.step ?? 0 };
      return;
    }
    if (frame.type === "chunk" && frame.chunk) {
      const meta = s.attemptMeta.get(frame.attemptId);
      if (!meta) return;
      // usage/finish 等非文本块不参与流式正文（usage 由结算通道 assistant/message 提取）
      if (frame.chunk.type !== "usage" && frame.chunk.type !== "finish") {
        applyChunk(sessionId, meta.turn, meta.step, frame.chunk);
      }
      return;
    }
    if (frame.type === "end") {
      s.attemptMeta.delete(frame.attemptId);
    }
  };

  // --- session/event 归一化 ---
  const onSessionEvent = (session: unknown, raw: SessionEvent): void => {
    const sid = (session as { id?: string } | null)?.id ?? s.activeSessionId;
    // 状态列 Agents 块「工作内容」：**全会话**记录最近一次工具调用（先于活跃会话过滤；
    // 子代理会话的事件只用于状态列，不进本会话 buffer）
    // 状态列 Agents 块：速率累计必须在下面的「非活跃会话丢弃」**之前**（子代理事件只在
    // 这里可见；写到后面会被 `sid !== activeSessionId` 滤掉）
    // 文本流也要计入（子代理大量输出走 assistant/message；此前只统计工具事件 → 文本型子代理
    // 永远测不到速率、停在缺省档）。载荷形状不定 → 用其字符串长度作体量代理（4 字符 ≈ 1 token）
    if (raw.type === "assistant/message") {
      recordAgentRate(
        sid,
        JSON.stringify(raw.data ?? "").length,
        typeof raw.time === "number" ? raw.time : 0,
      );
    }
    if (raw.type === "tool/call" || raw.type === "tool/result") {
      const chars =
        raw.type === "tool/call"
          ? typeof (raw.data as { arguments?: unknown }).arguments === "string"
            ? (raw.data as { arguments: string }).arguments.length
            : 0
          : (toolResultDetail(raw.data) ?? "").length;
      recordAgentRate(sid, chars, typeof raw.time === "number" ? raw.time : 0);
    }
    if (raw.type === "tool/call") {
      const call = raw.data as { name?: unknown; arguments?: unknown };
      if (typeof call.name === "string" && call.name !== "") {
        s.lastToolBySession.set(sid, workSummary(call.name, call.arguments));
      }
    }
    // 单活跃会话：非当前活跃会话的事件一律丢弃——其他 live 会话（列表标 [不可续]）
    // 不可注入输出/思考/标题到本会话 buffer 或状态行
    if (sid !== s.activeSessionId) return;
    // P2 seq 守卫：同 seq 重复/倒序（<= lastSeq）丢弃防重放；间隙接受并更新游标
    // （seed 边界由宿主 session/end-seed 标记；缺 seq 的事件（旧 mock）跳过守卫）
    const seq = (raw as { seq?: unknown }).seq;
    if (typeof seq === "number") {
      const last = s.sessionSeq.get(sid) ?? 0;
      if (seq <= last) return;
      s.sessionSeq.set(sid, seq);
    }
    const data = raw.data as {
      chunk?: StreamChunk;
      stream?: AssistantStreamRecord[];
      text?: string;
      turn?: number;
      step?: number;
      message?: { content?: unknown[] };
      usage?: TokenUsage;
      name?: string;
      arguments?: string;
      /** 3.3.3：工具调用 id（审批草稿据此回查命令/参数） */
      callId?: string;
      error?: { name?: string; code?: string };
      reason?: unknown;
      // 0.1.2-rc.1 扩展字段（宽容读，缺省降级）
      interrupted?: boolean;
      meta?: unknown;
      provider?: string;
      model?: string;
      reasoningEffort?: unknown;
    };
    switch (raw.type) {
      case "assistant/attempt": {
        // v0.1.5 起会话流式事件由逐 chunk 的旧流式事件改为一次性 assistant/attempt，
        // 载荷 { turn, step, stream: AssistantStreamRecord[] }（压缩流记录数组）：
        // text-chunks / reasoning-chunks / tool-call-chunks 为打包的 delta 运行（逐成员
        // 等价 text-delta / reasoning-delta / tool-call-delta），`chunk` 记录为原始
        // StreamChunk（block/usage/finish 恒为 raw chunk 记录）。
        // 结算语义：正文已由实时帧通道（agent/assistant-stream）先行输出，此处经
        // completedBlocks 去重只补缺失；实时帧未到齐时走既有完整逻辑（兜底）。
        const stream = data.stream as AssistantStreamRecord[] | undefined;
        if (!Array.isArray(stream) || stream.length === 0) return;
        const turn = data.turn ?? 0;
        const step = data.step ?? 0;
        s.liveScope = { turn, step };
        // 遍历流记录展开为逐 chunk 处理：text/reasoning-chunks 逐成员等价对应 delta；
        // tool-call-chunks 逐成员等价 tool-call-delta（id/name 随块声明带上）
        for (const rec of stream) {
          if (rec.type === "chunk") {
            applyChunk(sid, turn, step, rec.chunk);
          } else if (rec.type === "text-chunks") {
            for (const text of rec.texts) {
              applyChunk(
                sid,
                turn,
                step,
                { type: "text-delta", index: rec.index, text },
                true,
              );
            }
            // 接收层：按块聚合一次 full（不与实时线增量重复；前缀对齐在接收层做）
            ctx.deliverText(
              turn,
              step,
              rec.index,
              "assistant",
              rec.texts.join(""),
              true,
              raw.seq,
            );
          } else if (rec.type === "reasoning-chunks") {
            for (const text of rec.texts) {
              applyChunk(
                sid,
                turn,
                step,
                { type: "reasoning-delta", index: rec.index, text },
                true,
              );
            }
            ctx.deliverText(
              turn,
              step,
              rec.index,
              "reasoning",
              rec.texts.join(""),
              true,
              raw.seq,
            );
          } else {
            for (const argsDelta of rec.args) {
              applyChunk(sid, turn, step, {
                type: "tool-call-delta",
                index: rec.index,
                ...(rec.id === undefined ? {} : { id: rec.id }),
                ...(rec.name === undefined ? {} : { name: rec.name }),
                argumentsDelta: argsDelta,
              });
            }
          }
        }
        return;
      }

      case "assistant/message": {
        // 每 step 结束必发的完整正文表面事件（append 语义）。流式链路已按 delta
        // 输出正文，这里只按 step 补发缺失后缀；非流式 provider 无任何 chunk 时
        // stepEmitted 为空 → 直接输出完整正文，保证不支持流式/思考的模型回复可见。
        // 更正事件（`SurfaceOp` 的 replace 形态，字符串或 `{op:"replace"}` 对象）在
        // append-only 显示面无法安全重写，跳过整条（口径与 rule-engine 一致）。
        if (isCorrectiveEvent(raw)) return;
        // 单次模型调用 token 用量：与正文同行送达（阶段 2 依 state.usage 落状态行槽位）。
        // 占用百分比分母 = 所选模型窗口（resolveModelInfo.context.contextWindow）；
        // 未知/未披露时省略（状态行仅显绝对大小），懒解析命中后补发一次同载荷 usage。
        if (data.usage) {
          const input = data.usage.inputTokens ?? 0;
          const output = data.usage.outputTokens ?? 0;
          const cacheRead = data.usage.cacheReadTokens ?? 0;
          const sel =
            opts.sessionModel?.current ??
            readDefaultSelection(opts.defaultModel);
          const provider = data.provider ?? sel?.provider;
          const model = data.model ?? sel?.model;
          const winKey = provider && model ? provider + ":" + model : undefined;
          const knownWindow = winKey
            ? (s.ctxWindowCache.get(winKey) ?? undefined)
            : undefined;
          ctx.emit({
            type: "usage",
            sessionId: sid,
            input,
            output,
            cacheRead,
            ...(knownWindow === undefined
              ? {}
              : { contextWindow: knownWindow }),
          });
          if (winKey && !s.ctxWindowCache.has(winKey)) {
            void deps.resolveContextWindow(winKey).then((w) => {
              if (w !== undefined) {
                ctx.emit({
                  type: "usage",
                  sessionId: sid,
                  input,
                  output,
                  cacheRead,
                  contextWindow: w,
                });
              }
            });
          }
        }
        s.liveScope = { turn: data.turn ?? 0, step: data.step ?? 0 };
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
        if (text === "") {
          // 空正文也要定型（该 step 的可见内容可能只有工具调用）
          ctx.deliverFinalize(
            data.turn ?? 0,
            data.step ?? 0,
            data?.interrupted === true,
            raw.seq,
          );
          return;
        }
        const sk = sid + ":" + (data.turn ?? 0) + ":" + (data.step ?? 0);
        const done = s.stepEmitted.get(sk) ?? "";
        s.stepEmitted.delete(sk);
        let rest = "";
        if (done === "") rest = text;
        else if (text.startsWith(done)) rest = text.slice(done.length);
        if (rest.length > 0) {
          ctx.emit({ type: "stream", sessionId: sid, text: rest });
          // 结算整块（step 级）：接收层按 `index = -1` 单独记账，与逐块增量不重复
          ctx.deliverText(
            data.turn ?? 0,
            data.step ?? 0,
            -1,
            "assistant",
            rest,
            true,
            raw.seq,
          );
        }
        // delta 与 message 文本不一致时不再输出（append-only UI 无法安全重写）
        ctx.deliverFinalize(
          data.turn ?? 0,
          data.step ?? 0,
          data?.interrupted === true,
          raw.seq,
        );
        // 0.1.2-rc.1：输出被打断标记（assistant/message.interrupted）→ muted notice
        if (data?.interrupted === true) {
          ctx.emit({
            type: "notice",
            text: "（模型输出已中断）",
            tone: "info",
          });
        }
        return;
      }

      case "user/message":
      case "agent/inbox/spliced": {
        // 更正事件（replace 形态）不携带对用户可见的新增内容，append-only 显示面无法重写
        // 被覆盖区间，故跳过整条；`agent/inbox/spliced` 不是 surface 事件，不受此门影响。
        if (raw.type === "user/message" && isCorrectiveEvent(raw)) return;
        // TUI#43：`removedCount > 0` = 核心摘除了**已认领**的排队项（steer 在 step 边界、
        // followup 在回合开始）→ 通知 App 把对应排队项转入历史流（App 只处理 next-step，
        // next-turn 的认领仍由回合开始路径处理，避免一条被认领两次）
        const splicedData = raw.data as {
          removedCount?: unknown;
          target?: unknown;
        };
        if (
          typeof splicedData.removedCount === "number" &&
          splicedData.removedCount > 0 &&
          (splicedData.target === "next-step" ||
            splicedData.target === "next-turn")
        ) {
          ctx.emit({ type: "inbox-claim", target: splicedData.target });
        }
        // TUI#17：插件注入消息的 notice 形态（source.form:'notice' + summary）→
        // 渲染为一行提示（不展开、不占用户消息块）；其余 user 消息不渲染——
        // 用户输入由本地回显覆盖，未实现 notice 的注入维持现状（不显示），避免重复。
        const candidates: Array<Record<string, unknown>> = [];
        if (raw.type === "user/message") {
          candidates.push(raw.data as Record<string, unknown>);
        } else {
          const inserted = (raw.data as { inserted?: unknown }).inserted;
          if (!Array.isArray(inserted)) return;
          for (const item of inserted)
            if (item && typeof item === "object")
              candidates.push(item as Record<string, unknown>);
        }
        for (const item of candidates) {
          const id = typeof item["id"] === "string" ? item["id"] : undefined;
          // 双通道（user/message 与 spliced）可能携带同一条注入消息 → 按 id 去重
          if (id !== undefined && s.renderedNoticeIds.has(id)) continue;
          // TUI#49：rule-engine 注入（无 notice form）→ 走用户块实时通道；
          // 历史路径（surface）自然折叠为用户消息，故只处理实时显示
          const ruleText = ruleInjectionTextOf(item);
          if (ruleText !== undefined) {
            if (id !== undefined) {
              if (s.renderedNoticeIds.size > 200) s.renderedNoticeIds.clear();
              s.renderedNoticeIds.add(id);
            }
            ctx.emit({ type: "rule-injection", id: id ?? "", text: ruleText });
            continue;
          }
          const summary = noticeSummaryOf(item);
          if (summary === undefined) continue;
          if (id !== undefined) {
            if (s.renderedNoticeIds.size > 200) s.renderedNoticeIds.clear();
            s.renderedNoticeIds.add(id);
          }
          ctx.emit({ type: "notice", text: summary, tone: "log" });
        }
        return;
      }
      case "turn/start": {
        // turn/start 本身不插入历史分隔线（用户本地回显后应紧邻模型响应），但把**回合号**
        // 转给上层（#3）：会话区回合分隔线要显示 `hh:mm:ss ⇆N`（符号见 TUI/src/app/layout/tool-line.ts 的
        // turnHeaderLine），而本地 turn-begin 早于本事件。
        const turn = (data as { turn?: unknown }).turn;
        ctx.emit({
          type: "turn-start",
          turn: typeof turn === "number" ? turn : undefined,
        });
        return;
      }
      case "turn/end": {
        // turn 结束：清空流式累计，block index 跨 turn 复用不残留
        s.emittedByBlock.clear();
        s.stepEmitted.clear();
        s.completedBlocks.clear();
        // 接收层：回合结束（封闭当前节 + 标记该回合的最终总结节）
        {
          const explicit = data as unknown as { turn?: number; step?: number };
          const scope =
            explicit.turn === undefined
              ? s.liveScope
              : {
                  turn: explicit.turn,
                  step: explicit.step ?? s.liveScope?.step ?? 0,
                };
          if (scope) {
            s.liveScope = scope;
            // 收尾原因随交付透传（条目 7 批 B1）：节层把它落到该回合最后一个用户条目上，
            // 用户块终态符号不再按 seq 回查 buffer
            const ended = turnEndReason(data.reason);
            ctx.deliver({
              kind: "turn-end",
              turn: scope.turn,
              step: scope.step,
              ...(ended === undefined ? {} : { reason: ended }),
              ...(raw.seq === undefined ? {} : { seq: raw.seq }),
            });
          }
        }
        // P1：仅在能识别出收尾原因时携带 reason（其余保持既有事件形态）
        const reason = turnEndReason(data.reason);
        ctx.emit(reason ? { type: "turn-end", reason } : { type: "turn-end" });
        // finish reason 分级 notice：completed 静默、异常 kind 带 tone（阶段 2 按 tone 渲染）
        const endNote = turnEndNotice(data.reason);
        if (endNote) ctx.emit(endNote);
        return;
      }
      case "session/title": {
        // 官方 dsh-session-title 落盘事件（fallback/provider/user 任一 source）：
        // 仅转发当前活跃会话（adapter 视角权威），状态行标题优先该官方折叠结果
        const title = (raw.data as { title?: unknown }).title;
        if (
          sid === s.activeSessionId &&
          typeof title === "string" &&
          title.trim() !== ""
        ) {
          ctx.emit({ type: "session-title", sessionId: sid, title });
        }
        return;
      }
      case "tool/call": {
        // 工具调用：紧凑一行（名称 + arguments 摘要）；阶段 2 渲染 `⚙ <name> <summary>`
        // 3.3.3：同批把 callId → 参数明细登记进短期表，供审批草稿展示命令/参数
        const name = data.name;
        if (typeof name !== "string" || name === "") return;
        const argsRaw =
          typeof data.arguments === "string" ? data.arguments : "";
        const summary = summarizeToolArguments(argsRaw);
        ctx.toolCalls.remember(data.callId, name, argsRaw, summary);
        if (typeof data.callId === "string" && data.callId !== "") {
          const explicit = data as unknown as { turn?: number; step?: number };
          const scope =
            explicit.turn === undefined
              ? s.liveScope
              : { turn: explicit.turn, step: explicit.step ?? 0 };
          // 归属不可知 → 不投递（0 兜底会开出 0/0 假节）
          if (scope) {
            s.liveScope = scope;
            ctx.deliver({
              kind: "tool-call",
              turn: scope.turn,
              step: scope.step,
              callId: data.callId,
              name,
              args: argsRaw,
              // 会话事件的 arguments 是完整参数：按整块投递（实时线分片不再拼坏）
              full: true,
              ...(raw.seq === undefined ? {} : { seq: raw.seq }),
            });
          }
        }
        ctx.emit({
          type: "tool-call",
          sessionId: sid,
          name,
          summary,
          ...(typeof data.callId === "string" && data.callId !== ""
            ? { callId: data.callId }
            : {}),
        });
        return;
      }
      case "tool/result": {
        // 更正事件（replace 形态）跳过：与正文 / 用户消息同一口径（见 isCorrectiveEvent）。
        if (isCorrectiveEvent(raw)) return;
        // 工具结果：成功/失败一行；error 分支（结构化错误 {name, code}）标记失败
        const failed = toolResultFailed(data);
        const detail = toolResultDetail(data.message);
        const meta = data.meta;
        {
          const explicit = data as unknown as { turn?: number; step?: number };
          const scope =
            explicit.turn === undefined
              ? s.liveScope
              : { turn: explicit.turn, step: explicit.step ?? 0 };
          // 归属不可知（会话刚开始就来了结果）→ 不投递，避免 0/0 假节
          if (scope) {
            s.liveScope = scope;
            const callId = toolResultCallId(data.message);
            ctx.deliver({
              kind: "tool-result",
              turn: scope.turn,
              step: scope.step,
              ...(callId === undefined ? {} : { callId }),
              ok: !failed,
              detail,
              // 行级 diff 摘要（`(+N/-M)`）：宿主 `data.meta` 原样带到行层（旧缓冲路径同源）
              ...(data.meta === undefined ? {} : { meta: data.meta }),
              ...(raw.seq === undefined ? {} : { seq: raw.seq }),
            });
          }
        }
        const err = data.error as { name?: string; code?: string } | undefined;
        ctx.emit({
          type: "tool-result",
          sessionId: sid,
          ok: !failed,
          ...(meta === undefined ? {} : { meta }),
          detail: err
            ? (err.name ? err.name + ": " : "") + (detail || err.code || "")
            : detail,
        });
        return;
      }
      case "model/selection": {
        // 0.1.2-rc.1：会话内生效模型选择（ModelSelection{provider,model,reasoningEffort?}）
        // → 归一化事件消费（state.modelBySession）
        ctx.emit({
          type: "model-selection",
          sessionId: sid,
          provider: data.provider,
          model: data.model,
          reasoningEffort: data.reasoningEffort,
        });
        return;
      }
      case "compaction/start":
      case "compaction/end": {
        // 长会话压缩：start/end 折叠为一个 compaction 事件（阶段 2 渲染 toast）
        ctx.emit({
          type: "compaction",
          phase: raw.type === "compaction/start" ? "start" : "end",
          // P8：压缩期间按会话标记「活跃」
          sessionId: sid,
        });
        return;
      }
      case "llm/retry": {
        // 模型重试透明化：第 attempt/max 次 + 退避 delayMs + 失败码/消息（阶段 2 渲染 toast）
        // SAFETY: rc.2 llm/retry 载荷字段均为可选数值/可选字符串，宽松读取安全——
        // 缺字段以 0/"" 兜底，绝不抛错；raw.data 类型未含该会话事件（仅子集）。
        const retry = data as unknown as {
          retry?: number;
          maxRetries?: number;
          delayMs?: number;
          failure?: { code?: string; message?: string };
        };
        ctx.emit({
          type: "retry",
          attempt: typeof retry.retry === "number" ? retry.retry : 0,
          max: typeof retry.maxRetries === "number" ? retry.maxRetries : 0,
          delayMs: typeof retry.delayMs === "number" ? retry.delayMs : 0,
          code:
            typeof retry.failure?.code === "string" ? retry.failure.code : "",
          message:
            typeof retry.failure?.message === "string"
              ? retry.failure.message
              : undefined,
        });
        return;
      }
      case "goal/change": {
        // P2 goal 全量快照 + clear 墓碑（判别联合，完整保留字段；按 sessionId 隔离存储）
        const goal = raw.data as GoalChangeLike;
        if (goal.operation === "clear") {
          ctx.emit({
            type: "goal-change",
            sessionId: sid,
            operation: "clear",
            cleared: goal.cleared,
            clearedAt: goal.clearedAt,
          });
          return;
        }
        ctx.emit({
          type: "goal-change",
          sessionId: sid,
          operation: goal.operation,
          goal: goal.goal,
          roundsStarted: goal.roundsStarted,
          createdAt: goal.createdAt,
          updatedAt: goal.updatedAt,
        });
        return;
      }
      case "todo/write": {
        // P2 todo 全量快照（last-write-wins，无 id），按 sessionId 隔离
        const todos = (raw.data as { todos?: unknown }).todos;
        ctx.emit({
          type: "todo-write",
          sessionId: sid,
          todos: Array.isArray(todos) ? (todos as TodoItemLike[]) : [],
        });
        return;
      }
      case "plan/mode": {
        const active = (raw.data as { active?: unknown }).active;
        ctx.emit({
          type: "mode",
          sessionId: sid,
          kind: "plan",
          value: active === true ? "on" : "off",
        });
        return;
      }
      case "sandbox/mode": {
        const mode = (raw.data as { mode?: unknown }).mode;
        ctx.emit({
          type: "mode",
          sessionId: sid,
          kind: "sandbox",
          value: typeof mode === "string" ? mode : "",
        });
        return;
      }
      case "permission/preset": {
        const preset = (raw.data as { preset?: unknown }).preset;
        ctx.emit({
          type: "mode",
          sessionId: sid,
          kind: "permission",
          value: typeof preset === "string" ? preset : "",
        });
        return;
      }
      case "step/start":
      case "step/end":
        // P2 step 边界（B3 工具行分组头）；载荷为 {turn, step}，无独立值；
        // P6：转发事件信封时间（分组头渲染为 `hh:mm:ss #N`）
        if (raw.type === "step/start") {
          // 节边界（接收层）：step 开始封闭上一节，本身不开节
          s.liveScope = { turn: data.turn ?? 0, step: data.step ?? 0 };
          ctx.deliver({
            kind: "step-start",
            turn: s.liveScope.turn,
            step: s.liveScope.step,
            ...(typeof raw.time === "number" ? { time: raw.time } : {}),
            ...(raw.seq === undefined ? {} : { seq: raw.seq }),
          });
        }
        ctx.emit({
          type: "step",
          sessionId: sid,
          turn: data.turn ?? 0,
          step: data.step ?? 0,
          phase: raw.type === "step/start" ? "start" : "end",
          time: raw.time,
        });
        return;
      case "subagent/descriptor": {
        const d = raw.data as SubagentDescriptorLike;
        ctx.emit({
          type: "subagent",
          sessionId: sid,
          label:
            typeof d.label === "string" && d.label !== ""
              ? d.label
              : d.provider,
          mode: d.mode === "continuable" ? "continuable" : "one-shot",
        });
        return;
      }
      case "compaction/summary": {
        // P2 压缩摘要：text 取首个非空文本块首行入 toast；完整原始载荷随事件带出（raw，不改写）
        const payload = raw.data as CompactionSummaryPayloadLike;
        const blocks = Array.isArray(payload.summary) ? payload.summary : [];
        const firstText = blocks.find(
          (b): b is ContentBlockLike & { text: string } =>
            !!b &&
            b.type === "text" &&
            typeof b.text === "string" &&
            b.text.trim() !== "",
        );
        ctx.emit({
          type: "compaction-summary",
          sessionId: sid,
          text: firstText ? firstText.text : "",
          raw: payload,
        });
        return;
      }
      case "approval/policy": {
        // C 阶段：既有审计对事件归一化为第 10 个 DshEvent（载荷 {policy: 'ask'|'never'}）；
        // 显示当前策略（状态行）。无效载荷整体丢弃（fail-safe）。
        const policy = (raw.data as { policy?: unknown }).policy;
        if (policy !== "ask" && policy !== "never") return;
        ctx.emit({ type: "approval-policy", sessionId: sid, policy });
        return;
      }
      case "tool-workflow/run-start": {
        // P3 workflow 运行打开：{runId, name}，仅显示名；/workflows 运行集合建条目
        const w = raw.data as { runId?: unknown; name?: unknown };
        const runId = typeof w.runId === "string" ? w.runId : "";
        const name = typeof w.name === "string" ? w.name : "";
        ctx.emit({
          type: "workflow",
          sessionId: sid,
          phase: "run-start",
          label: name,
          runId,
        });
        if (runId !== "") {
          s.workflowRuns.set(runId, {
            id: runId,
            name,
            phase: "run-start",
            status: "running",
            members: 0,
            membersDone: 0,
            updatedAt: Date.now(),
          });
        }
        return;
      }
      case "tool-workflow/agent-start": {
        // P3 workflow 成员发布：{runId, seq, label, phase?, childId}；无 label 回落 #seq
        const w = raw.data as {
          runId?: unknown;
          seq?: unknown;
          label?: unknown;
        };
        const runId = typeof w.runId === "string" ? w.runId : "";
        ctx.emit({
          type: "workflow",
          sessionId: sid,
          phase: "agent-start",
          label: typeof w.label === "string" && w.label !== "" ? w.label : "",
          detail: typeof w.seq === "number" ? String(w.seq) : "",
          runId,
        });
        const run = runId !== "" ? s.workflowRuns.get(runId) : undefined;
        if (run) {
          const next = {
            ...run,
            phase: "agent-start",
            members: run.members + 1,
            updatedAt: Date.now(),
          };
          s.workflowRuns.set(runId, next);
        }
        return;
      }
      case "tool-workflow/agent-end": {
        // P3 workflow 成员结算：{runId, seq, outcome}
        const w = raw.data as {
          runId?: unknown;
          seq?: unknown;
          outcome?: unknown;
        };
        const runId = typeof w.runId === "string" ? w.runId : "";
        ctx.emit({
          type: "workflow",
          sessionId: sid,
          phase: "agent-end",
          label: "",
          detail:
            (typeof w.seq === "number" ? String(w.seq) : "") +
            (typeof w.outcome === "string" && w.outcome !== ""
              ? " " + w.outcome
              : ""),
          runId,
        });
        const run = runId !== "" ? s.workflowRuns.get(runId) : undefined;
        if (run) {
          const next = {
            ...run,
            phase: "agent-end",
            membersDone: run.membersDone + 1,
            updatedAt: Date.now(),
          };
          s.workflowRuns.set(runId, next);
        }
        return;
      }
      case "tool-workflow/run-end": {
        // P3 workflow 收尾：{runId, stopReason}；fold 为 toast；/workflows 标记 done
        const w = raw.data as { runId?: unknown; stopReason?: unknown };
        const runId = typeof w.runId === "string" ? w.runId : "";
        ctx.emit({
          type: "workflow",
          sessionId: sid,
          phase: "run-end",
          label: "",
          detail: typeof w.stopReason === "string" ? w.stopReason : "",
          runId,
        });
        if (runId !== "") {
          const run = s.workflowRuns.get(runId);
          if (run) {
            s.workflowRuns.set(runId, {
              ...run,
              phase: "run-end",
              status: "done",
              updatedAt: Date.now(),
            });
          }
        }
        return;
      }
      case "command/run": {
        // P3 命令执行开始：{commandId, name, args?, source}；记录配对供 done 取名
        const c = raw.data as { commandId?: unknown; name?: unknown };
        if (typeof c.commandId === "string" && typeof c.name === "string") {
          s.commandNames.set(c.commandId, c.name);
        }
        ctx.emit({
          type: "command",
          sessionId: sid,
          phase: "run",
          name: typeof c.name === "string" && c.name !== "" ? c.name : "",
        });
        return;
      }
      case "command/done": {
        // P3 命令执行结束：{commandId, kind, text?}；name 经配对取回（缺失回落占位）
        const c = raw.data as {
          commandId?: unknown;
          kind?: unknown;
          text?: unknown;
        };
        const paired =
          typeof c.commandId === "string"
            ? s.commandNames.get(c.commandId)
            : undefined;
        if (typeof c.commandId === "string") s.commandNames.delete(c.commandId);
        ctx.emit({
          type: "command",
          sessionId: sid,
          phase: "done",
          name: paired ?? "",
          text: typeof c.text === "string" ? c.text : "",
          ok: c.kind === "success",
        });
        return;
      }
      case "tool/ptc-dispatch-start": {
        // P3 run_code 子派发开始：{name, arguments}（dispatched 前归一化，永不失败）
        const cd = raw.data as { name?: unknown; arguments?: unknown };
        ctx.emit({
          type: "code-dispatch",
          sessionId: sid,
          phase: "start",
          name: typeof cd.name === "string" ? cd.name : "",
          summary: summarizeToolArguments(
            typeof cd.arguments === "string" ? cd.arguments : "",
          ),
          ok: true,
        });
        return;
      }
      case "tool/ptc-dispatch": {
        // P3 run_code 子派发结算：{isError, content}；成功静默降噪，失败红行
        const cd = raw.data as { name?: unknown; isError?: unknown };
        ctx.emit({
          type: "code-dispatch",
          sessionId: sid,
          phase: "settle",
          name: typeof cd.name === "string" ? cd.name : "",
          summary: "",
          ok: cd.isError !== true,
        });
        return;
      }
      case "hook/invoked": {
        // P3 hooks 调用开始：{point, ...}；显示 hook 点
        const h = raw.data as { point?: unknown };
        ctx.emit({
          type: "hook",
          sessionId: sid,
          phase: "invoked",
          point: typeof h.point === "string" && h.point !== "" ? h.point : "",
          ok: true,
        });
        return;
      }
      case "hook/result": {
        // P3 hooks 结算：{point, decision, exitCode?}；exitCode 0=成功，无 exitCode 按 decision
        const h = raw.data as {
          point?: unknown;
          decision?: unknown;
          exitCode?: unknown;
        };
        const decision = typeof h.decision === "string" ? h.decision : "";
        const exitOk =
          typeof h.exitCode === "number"
            ? h.exitCode === 0
            : decision === "allow" || decision === "pass";
        ctx.emit({
          type: "hook",
          sessionId: sid,
          phase: "result",
          point: typeof h.point === "string" && h.point !== "" ? h.point : "",
          decision: decision || undefined,
          ok: exitOk,
        });
        return;
      }
      case "schedule/change": {
        // P3 schedule 提醒：{version:1, operation: create|delete|dispatch, id?}
        const s = raw.data as { operation?: unknown; id?: unknown };
        const op = s.operation;
        if (op !== "create" && op !== "delete" && op !== "dispatch") return;
        ctx.emit({
          type: "schedule",
          sessionId: sid,
          operation: op,
          id: typeof s.id === "string" ? s.id : undefined,
        });
        return;
      }
      case "compaction/prune": {
        // P3 压缩剪枝：{shadowedRange, shadowedSeqs, shadowedTokenCount}
        const p = raw.data as {
          shadowedSeqs?: unknown;
          shadowedTokenCount?: unknown;
        };
        if (Array.isArray(p.shadowedSeqs)) {
          // 六步流水线：被遮蔽的事件号 → box 层按交集打灰（内容与行数不变）
          ctx.deliver({
            kind: "shadow",
            seqs: p.shadowedSeqs.filter(
              (seq): seq is number => typeof seq === "number",
            ),
            ...(raw.seq === undefined ? {} : { seq: raw.seq }),
          });
        }
        ctx.emit({
          type: "compaction-prune",
          sessionId: sid,
          nodeCount: Array.isArray(p.shadowedSeqs) ? p.shadowedSeqs.length : 0,
          tokenCount:
            typeof p.shadowedTokenCount === "number" ? p.shadowedTokenCount : 0,
        });
        return;
      }
      case "feedback/record": {
        // P3 反馈记录确认：{text}（/feedback 命令落库后回读）
        const f = raw.data as { text?: unknown };
        ctx.emit({
          type: "feedback",
          sessionId: sid,
          text: typeof f.text === "string" ? f.text : "",
        });
        return;
      }
      case "llm/retry-started": {
        // P3 重试启动：{retryId, turn, step, retry}；仅取第几次（retry）展示启动行，
        // 与既有 llm/retry（失败原因 toast）互补。
        const r = raw.data as { retry?: unknown };
        ctx.emit({
          type: "retry-started",
          sessionId: sid,
          attempt: typeof r.retry === "number" ? r.retry : 0,
        });
        return;
      }
      case "agent-preset/selected": {
        // P3：agent 预设选中（rc.2 会话事件；payload {agentPreset}）→ 状态行 preset:<id>。
        // 经上方通用 seq 守卫 + 非活跃会话丢弃（与其它会话事件同链）。
        const p = raw.data as { agentPreset?: unknown };
        if (typeof p.agentPreset !== "string" || p.agentPreset === "") return;
        ctx.emit({
          type: "agent-preset",
          sessionId: sid,
          preset: p.agentPreset,
        });
        return;
      }
      default:
        return;
    }
  };

  function emitAgentStatus(payload: {
    agent?: unknown;
    status?: string;
  }): void {
    // 仅转发当前活跃 agent 的状态: 其他 live agent（如平行会话）不得污染状态行
    const agentSid = (
      payload?.agent as { session?: { id?: string } } | undefined
    )?.session?.id;
    if (agentSid && agentSid !== s.activeSessionId) return;
    const status = normalizeAgentStatus(payload?.status);
    ctx.emit({
      type: "agent-status",
      sessionId: s.activeSessionId,
      status,
    });
  }

  const part: Partial<DshAdapter> = {
    onEvent(cb) {
      if (s.disposed) return () => {};
      s.listeners.add(cb);
      return () => s.listeners.delete(cb);
    },
  };

  return { part, onSessionEvent, onAssistantFrame, emitAgentStatus };
}
