// TUI/src/app/adapter/context.ts — 真实适配层的显式上下文对象与事件出口
//
// 本文件由 TUI/src/app/adapter/dsh.ts 的闭包状态与 emit / deliver 三件套机械搬出
// （行为不变）: 状态集中为单个可变对象 AdapterState, 事件出口经 AdapterContext 暴露.
// 各职责模块（dsh-events / dsh-session / dsh-approval / dsh-panels）只依赖本文件的类型,
// 彼此不 import; 跨模块函数由 dsh.ts 组装时注入.

import type { BlockDelivery } from "../layout/pipeline/types.ts";
import type {
  DshEvent,
  ApprovalOutcome,
  QuestionAnswer,
  DshRuntime,
  RealAdapterOptions,
  WorkflowRunLike,
} from "./types.ts";
import { ToolCallCache } from "./approval-tool-calls.ts";

function createState(opts: RealAdapterOptions) {
  return {
    // 活跃会话引用（可变）：初始来自 opts；resumeTo 切换后指向新 agent/会话。
    // 旧 handle 在切换成功后释放（activeDispose），新 handle 由 adapter.dispose 释放。
    activeSessionId: opts.sessionId,
    activeAgent: opts.agent,
    activeCommandAgent: opts.commandAgent,
    activeCancel: opts.interrupt ?? (() => {}),
    activeDispose: opts.handleDispose,
    // 会话内模型引用的初始值（main.ts 的 config 固定种子；settings 默认走实时兜底不进这里）：
    // 恢复会话时若无任何记录 → 回到该种子，既不丢配置固定模型、也不残留上一个会话的选择。
    sessionModelSeed: opts.sessionModel?.current,

    listeners: new Set<(e: DshEvent) => void>(),
    pendingApprovals: new Map<
      string,
      {
        resolve: (o: ApprovalOutcome) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
    approvalSeq: 0,
    disposed: false,
    runtimeUnbinds: [] as (() => void)[],
    activeCommands: new Set<AbortController>(),
    // 流式块去重累计：key = session:turn:step:index，block-end 只补发未输出部分
    emittedByBlock: new Map<string, string>(),
    // 实时帧通道（agent/assistant-stream）已完整交付（delta 累计 + block-end 补发）
    // 的块：结算数组（assistant/attempt）处理时跳过，避免正文重复显示；turn/end 清空
    completedBlocks: new Set<string>(),
    // P2 seq 守卫：per-session 游标，同 seq 重复/倒序丢弃（防重放），间隙接受
    sessionSeq: new Map<string, number>(),
    /** 状态列 Agents 块「工作内容」：各会话（含子代理会话）最近一次工具调用摘要。
     *  随 `refreshAgents` 清理离场会话（见 BACKLOG「Agents 列表显示别名 + 工作内容」）。 */
    lastToolBySession: new Map<string, string>(),
    // 状态列 Agents 块「条目行闪烁速率」（条目 1）：按会话累计输出体量（按 4 字符 ≈ 1 token
    // 折算）与时间，相邻样本间隔 ≥ 1 秒时结算瞬时速率并做 0.5 指数加权 → 供 AgentRowInfo.tps。
    // 只在有样本的会话上产出（主会话通常也有样本，但状态列只列子代理，故不影响）。
    rateBySession: new Map<
      string,
      { acc: number; since: number; tps?: number }
    >(),

    // TUI#17：已渲染的注入 notice 消息 id（user/message 与 agent/inbox/spliced 双通道
    // 可能携带同一条注入消息 → 去重；超上限清空，避免无界增长）
    renderedNoticeIds: new Set<string>(),
    // 按 (session:turn:step) 累计已流式输出的正文（text 块；reasoning 不计）。
    // assistant/message 是每个 step 结束必发的完整正文表面事件，据此只补发缺失后缀；
    // 非流式 provider（无任何 chunk）时累计为空 → 直接输出完整正文，保证回复可见。
    stepEmitted: new Map<string, string>(),
    // P3 command/run-done 配对：commandId → 命令名（run 记录 / done 读取后删除；缺 run 直接 done）
    commandNames: new Map<string, string>(),
    // P2/16：tool-workflow 运行集合（/workflows 面板数据源；按 runId 分组，增量维护）
    workflowRuns: new Map<string, WorkflowRunLike>(),

    // 当前 (turn, step)：宿主部分事件（tool/call、tool/result）不带归属，接收层不能拿 0
    // 兜底（会开出 0/0 假节、把调用与结果拆到两节）→ 由带归属的事件推进、缺归属的沿用。
    liveScope: undefined as { turn: number; step: number } | undefined,

    // 上下文窗口缓存：provider:model → 模型上下文容量（LlmResolvedModelInfo.context.contextWindow，
    // 供状态行 ctx 占用百分比作分母）。undefined=已解析但模型未披露（不再重试）；缺失/异常视为未知。
    ctxWindowCache: new Map<string, number | undefined>(),

    // --- agent/assistant-stream 实时帧（逐 chunk、流中实时；agent-subject 事件） ---
    // 宿主 agent-loop 在流进行中每 chunk 发一帧（含 time 时间戳），流结束后才经
    // session/event 发一次性 assistant/attempt 结算。实时帧先行输出正文（驱动逐
    // chunk 渲染 + 运行中 ●/○ 动画），结算数组经 completedBlocks 去重只补缺失。
    // attemptId → {turn, step}（chunk 帧不带 turn/step，由 start 帧登记）
    attemptMeta: new Map<string, { turn: number; step: number }>(),

    questionSeq: 0,
    pendingQuestions: new Map<
      string,
      {
        resolve: (a: QuestionAnswer) => void;
        reject: (err: unknown) => void;
        cleanup: () => void;
      }
    >(),
  };
}

/** 适配层全部可变状态（扁平表; 字段归属见各字段上方注释与使用它的模块） */
export type AdapterState = ReturnType<typeof createState>;

/** 适配层上下文: 状态 + 共用出口。各职责模块拿它取状态与发事件。 */
export interface AdapterContext {
  readonly opts: RealAdapterOptions;
  readonly runtime: DshRuntime;
  readonly state: AdapterState;
  readonly toolCalls: ToolCallCache;
  emit(e: DshEvent): void;
  deliver(delivery: BlockDelivery): void;
  deliverFinalize(
    turn: number,
    step: number,
    interrupted: boolean,
    seq?: number,
  ): void;
  deliverText(
    turn: number,
    step: number,
    index: number,
    source: "assistant" | "reasoning",
    text: string,
    full?: boolean,
    seq?: number,
  ): void;
}

export function createAdapterContext(opts: RealAdapterOptions): AdapterContext {
  const state = createState(opts);
  const { runtime } = opts;

  const emit = (e: DshEvent): void => {
    if (state.disposed) return;
    // 六步流水线接收层：自造 notice 与宿主内容一视同仁（设计「自造内容走同一流程」）；
    // 未注入 sink（开关关闭）时零开销。
    if (e.type === "notice" && opts.onDelivery !== undefined) {
      opts.onDelivery(
        e.tone === undefined
          ? { kind: "notice", text: e.text }
          : { kind: "notice", text: e.text, tone: e.tone },
      );
    }
    for (const cb of state.listeners) {
      try {
        cb(e);
      } catch (err) {
        process.stderr.write("[dsh adapter] emit error: " + String(err) + "\n");
      }
    }
  };

  /** 投递一块到接收层（sink 缺省 = 什么都不做） */
  const deliver = (delivery: BlockDelivery): void => {
    opts.onDelivery?.(delivery);
  };

  /** 定型信号投递（`assistant/message`：宿主每 step 必发；`interrupted` = 输出被打断） */
  const deliverFinalize = (
    turn: number,
    step: number,
    interrupted: boolean,
    seq?: number,
  ): void => {
    if (opts.onDelivery === undefined) return;
    const scope = seq === undefined ? {} : { seq };
    opts.onDelivery({ kind: "finalize", turn, step, ...scope });
    if (interrupted)
      opts.onDelivery({ kind: "interrupted", turn, step, ...scope });
  };

  /** 文本块投递（增量只来自实时线；结算线按块投递 `full`，接收层负责前缀对齐） */
  const deliverText = (
    turn: number,
    step: number,
    index: number,
    source: "assistant" | "reasoning",
    text: string,
    full?: boolean,
    seq?: number,
  ): void => {
    if (opts.onDelivery === undefined) return;
    opts.onDelivery({
      kind: "text",
      turn,
      step,
      index,
      source,
      text,
      ...(full === true ? { full: true } : {}),
      ...(seq === undefined ? {} : { seq }),
    });
  };

  return {
    opts,
    runtime,
    state,
    toolCalls: new ToolCallCache(),
    emit,
    deliver,
    deliverFinalize,
    deliverText,
  };
}
