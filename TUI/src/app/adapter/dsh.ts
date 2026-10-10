// src/app/adapter/dsh.ts — DSH 适配层：真实实现 + 兼容重导（类型/纯函数已拆出）
//
// 纯类型见 ./types.ts，纯归一化函数见 ./normalize.ts；本文件保留
// installSessionModelSelection 与 createRealDshAdapter，并以显式重导保持原
// ./adapter/dsh.ts 公共导出不变（外部 import 路径无需改动）。
//
// 接口化让 mock（demo/）与真实（阶段 2）可互换，app 层不感知实现。
// tool-bootstrap（锚定工具引导）见 ./tool-bootstrap.ts，本文件显式重导保持公共导出不变。
// 类型骨架依据官方 deepseek-harness 源码研读沉淀对齐（见 docs/host/DSH-CTX-API.md，
// 研读基线 dsh-v0.1.7-rc.2 = commit 477b4f42）。
//
// DSH 原生信号 → app 归一化事件的映射（阶段 2 已在 createRealDshAdapter 内实现）：
//   runtime.on('session/event', (session, e))  → 按 e.type 归一化：
//     - 'assistant/attempt'（一次性 stream 数组）展开 text-delta → { type: 'stream' }；
//       reasoning-delta / reasoning block → { type: 'thinking' }
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
// 问答应答契约：DSH 侧是 waterfall 链事件 'user-questions/request'(req, next)，监听者返回
// QuestionAnswer 即占用该请求；调用 next() 放行给后续监听者，最终无应答 NO_PROVIDER。
// adapter 经 runtime.on 注册应答者（与 approval/request 同构），并把 app 的
// answerQuestion(id, {answers}) 映射为整批回答 resolve；Esc/cancel → reject；
// signal 中断 → reject。单活动请求守卫：已有待答提问时直接 reject（单面板约束）。

import type { TurnEndReason } from "../state.ts";
import type { BlockDelivery } from "../layout/pipeline/types.ts";
import { clockHms } from "../clock.ts";
import type {
  DshEvent,
  DshAdapter,
  AgentRowInfo,
  ModelInfo,
  ModelSelection,
  SessionModelSelectionRef,
  ModelCatalog,
  ModelReasoning,
  StreamChunk,
  AssistantStreamRecord,
  ApprovalRequest,
  ApprovalOutcome,
  QuestionAnswer,
  UserQuestionRequestLike,
  SessionEvent,
  DshRuntime,
  DshAgentLike,
  RealAdapterOptions,
  LiveSessionHandle,
  HistoryMessage,
  SessionInfo,
  SessionQueryLike,
  SessionSurfaceView,
  TokenUsage,
  TaskEngineTaskLike,
  CommandPanelRow,
  KnowledgeBundleSummaryLike,
  CandidateRowLike,
  MemoryReviewVerdictLike,
  LoopSummaryLike,
  ContractParseResult,
  ContractClauseLike,
  WorkflowRunLike,
  SearchSourceLike,
  GoalChangeLike,
  TodoItemLike,
  SubagentDescriptorLike,
  ContentBlockLike,
  CompactionSummaryPayloadLike,
  AgentPresetInfo,
  PermissionPresetServiceLike,
  JobInfo,
} from "./types.ts";
import {
  type ApprovalDetail,
  buildApprovalPrompt,
  buildUserMessage,
  extractTextBlocks,
  localTitleFromText,
  normalizeAgentStatus,
  noticeSummaryOf,
  parseSlashCommand,
  readDefaultSelection,
  ruleInjectionTextOf,
  summarizeToolArguments,
} from "./normalize.ts";
import {
  stepHeaderLine,
  toolCallLine,
  toolResultLine,
} from "../layout/tool-line.ts";
import { rmSync } from "node:fs";
import { locateSessionDir, sessionRoots } from "./session-paths.ts";
import {
  readSessionUiState,
  writeSessionUiState,
  type SessionUiState,
} from "./session-ui-state.ts";

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
  TaskEngineLike,
  TaskEngineQueryLike,
  TaskEngineTaskLike,
  SecurityGuardLike,
  GuardRecordLike,
  PolicySnapshotLike,
  KnowledgeServiceLike,
  KnowledgeBundleSummaryLike,
  CandidateRowLike,
  MemoryReviewVerdictLike,
  MemoryCandidatesLike,
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
import { buildBootstrapKickoffMessage } from "./tool-bootstrap.ts";

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

/** 事件数组 → app 消息列表（P9：含 step 级工具概要行）。
 * 支持两种落在原始日志里的消息形态：
 *  1. user/message、assistant/message（旧/其他 backend 的完整消息事件）；
 *  2. agent/inbox/spliced（当前 dsh 内存会话承载消息的形态）——文本在
 *     data.inserted[].content[]（role 取 inserted[].role，仅 user/assistant）。
 *
 * P9 折叠口径：
 *  - 每个 step 折成**一行摘要**（见 `flushStep`），只保留工具名去重计数与失败数；
 *    参数摘要、结果详情、thinking 一概不还原；
 *  - 无工具调用的 step（纯思考/纯正文）不出行；
 *  - **整条消息为空（纯空白）时不产出行**——宿主每步补发的 `"\n\n"` 文本块正是
 *    恢复后成片空行的来源；消息**内部**的空行属段落间隔，保留（与实时渲染一致）。
 */
export function normalizeHistoryMessages(
  events: readonly Record<string, unknown>[],
): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  /** 是否处于某个 step 内（`step/start` → `step/end`）：工具行按到达顺序落行，标记只用于收口 */
  let inStep = false;
  /** 宿主回合号（跟随事件流的 data.turn）：恢复路径保留宿主索引（真回合号） */
  let curTurn: number | undefined;
  /** 回合 → 用户块终态（`turn/end` 的 reason 归一；循环后落到该回合最后一个用户消息上） */
  const turnStatus = new Map<number, "success" | "failure" | "aborted">();
  /** step 头行（与实时路径同形制：`hh:mm:ss ⇆N #M`）：每个 `step/start` 落一条，作为工具行
   *  的归属作用域；渲染层按「内容驱动」只在有回合区内容时画头，故无内容的 step 不会成孤儿头 */
  const pushStepHead = (n: number, time?: number): void => {
    out.push({
      role: "step",
      text: stepHeaderLine(n, time, curTurn),
      ...(curTurn === undefined ? {} : { turn: curTurn }),
    });
  };
  /** 收口当前 step（step/end 或截断日志）：摘要行已由「step 头 + 工具行」取代，这里只清状态 */
  const flushStep = (): void => {
    inStep = false;
  };
  /** 正文消息：整条纯空白 → 丢弃（P9 空行来源） */
  const pushText = (role: "user" | "assistant", raw: string): void => {
    const text = raw.trim() === "" ? "" : raw;
    if (text === "") return;
    out.push({
      role,
      text,
      ...(curTurn === undefined ? {} : { turn: curTurn }),
    });
  };
  // 用户输入的注入副本：宿主把用户自己发的消息**同时**记进 `agent/inbox/spliced`（日志实测
  // 54 条副本的 id 与 `user/message` 全部重合）。恢复时若两条都出，每条用户消息会出现两次，
  // 且副本没有终态 → 显示 `?`（真机现象：自己的消息块一直是 `?`）。先收集 `user/message` 的
  // id，主循环里丢弃同 id 的副本——与实时路径同口径（spliced 的用户输入由本地回显覆盖，不重复显示）
  const userIds = new Set<string>();
  for (const e of events) {
    if (e.type !== "user/message") continue;
    const id = (e.data as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") userIds.add(id);
  }
  for (const e of events) {
    const data = e.data as Record<string, unknown> | undefined;
    if (!data) continue;
    // 宿主回合号逐层保留（恢复路径真回合号的来源；缺省保持上一个已知值）
    if (typeof data.turn === "number") curTurn = data.turn;
    if (e.type === "step/start") {
      flushStep(); // 防御：上一个 step 未发 step/end（截断日志）时先收口
      const n = typeof data.step === "number" ? data.step : 0;
      const time = typeof e.time === "number" ? e.time : undefined;
      inStep = true;
      pushStepHead(n, time);
    } else if (e.type === "step/end") {
      flushStep();
    } else if (e.type === "tool/call") {
      // 工具批**逐条还原**（BACKLOG「恢复的记录要能区分输入 / 正文 / 工具调用」）：调用行
      // 与结果行按到达顺序落行，交给重放器还原成 tool-call / tool-result 交付（与实时路径
      // 同形制）；不再折成一行 step 摘要
      const name = typeof data.name === "string" ? data.name : "";
      if (name === "") continue;
      const args = typeof data.arguments === "string" ? data.arguments : "";
      out.push({
        role: "tool",
        text: toolCallLine(name, summarizeToolArguments(args)),
        ...(curTurn === undefined ? {} : { turn: curTurn }),
      });
    } else if (e.type === "tool/result") {
      // 失败判定与实时路径同口径：error 字段存在即失败
      const err = data.error;
      out.push({
        role: "tool",
        text: toolResultLine(!err, toolResultDetail(data.message), data.meta),
        ...(curTurn === undefined ? {} : { turn: curTurn }),
      });
    } else if (e.type === "turn/end") {
      // 恢复的用户块终态（BACKLOG「恢复的会话记录也保留用户块终态符号」）：记下该回合的收尾
      // 原因，循环后落到**该回合最后一个**用户消息上（与实时路径同口径：completed → success /
      // aborted → aborted / error → failure，其余原因不落终态 → 渲染仍为 `?`）
      const reason = turnEndReason(data.reason);
      const status =
        reason === "completed"
          ? "success"
          : reason === "aborted"
            ? "aborted"
            : reason === "error"
              ? "failure"
              : undefined;
      // 归属：事件自带 `turn` → 权威，后到者覆盖（同一回合的最终收尾原因）；不带 `turn`
      // 的收尾只能沿用上一个已知回合 → 仅在该回合尚无记录时采用，避免归属不明的收尾
      // 把先前正确的终态改错（截断 / 旧格式日志）
      const own = typeof data.turn === "number" ? data.turn : undefined;
      const at = own ?? curTurn;
      if (status !== undefined && at !== undefined) {
        if (own !== undefined || !turnStatus.has(at))
          turnStatus.set(at, status);
      }
    } else if (e.type === "user/message") {
      // TUI#17：插件注入的 notice 形态（source.form:'notice' + summary）→ 单行摘要行
      const summary = noticeSummaryOf(data);
      if (summary !== undefined)
        out.push({
          role: "notice",
          text: summary,
          ...(curTurn === undefined ? {} : { turn: curTurn }),
        });
      else pushText("user", extractTextBlocks(data.content));
    } else if (e.type === "assistant/message") {
      const msg = data.message as Record<string, unknown> | undefined;
      pushText("assistant", extractTextBlocks(msg?.content));
    } else if (e.type === "agent/inbox/spliced") {
      const inserted = data.inserted;
      if (!Array.isArray(inserted)) continue;
      for (const item of inserted as Array<Record<string, unknown>>) {
        // TUI#17：注入 notice 项折成一行摘要；其余项按 role 走正文（现状）
        const summary = noticeSummaryOf(item);
        if (summary !== undefined) {
          out.push({
            role: "notice",
            text: summary,
            ...(curTurn === undefined ? {} : { turn: curTurn }),
          });
          continue;
        }
        const role = item.role;
        if (role !== "user" && role !== "assistant") continue;
        // 同 id 的 `user/message` 已经在正文里出过一次 → 注入副本丢弃（无 id 的照旧显示）
        const id = item.id;
        if (role === "user" && typeof id === "string" && userIds.has(id))
          continue;
        pushText(role, extractTextBlocks(item.content));
      }
    }
  }
  flushStep(); // 末尾收口（最后一步可能没有 step/end）
  // 回填用户块终态：`turn/end` 在用户消息之后到达，故此处按回合号从后往前找该回合最后一个用户消息
  for (const [turn, status] of turnStatus) {
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i]!;
      if (m.role !== "user" || m.turn !== turn) continue;
      // 已有终态不覆盖：回合号缺失时 `curTurn` 沿用上一个已知值，同一条 `turn/end` 会挂到
      // 已标过的用户块上（截断 / 旧格式日志），覆盖会把先前正确的符号改错
      if (m.status === undefined) out[i] = { ...m, status };
      break;
    }
  }
  return out;
}

/** 状态列 Agents 块「工作内容」：`name 参数摘要`（截 ≤40 字符；空参数只留 name） */
function workSummary(name: string, args: unknown): string {
  const detail =
    typeof args === "string" && args.trim() !== ""
      ? summarizeToolArguments(args)
      : "";
  const text = (detail === "" ? name : `${name} ${detail}`)
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 40 ? text.slice(0, 39) + "…" : text;
}

/** tool/result 的配对键：宿主 append 的 `message.callId`（缺失返回 undefined → 接收层按到达顺序配对） */
function toolResultCallId(message: unknown): string | undefined {
  const id = (message as { callId?: unknown } | undefined)?.callId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * tool/result.message（ToolResultMessage.content=[ToolResultBlock]）→ 首段文本：
 * 取内层第一个 text 块首行（v1 足够）；形状不符/空 → ""。
 */
function toolResultDetail(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  for (const block of content as unknown[]) {
    const inner = (block as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(inner)) continue;
    for (const part of inner as Array<Record<string, unknown>>) {
      if (
        part?.type === "text" &&
        typeof part.text === "string" &&
        part.text !== ""
      ) {
        return part.text.split("\n")[0] ?? "";
      }
    }
  }
  return "";
}

/** turn/end 的 reason → 归一化收尾原因（宿主用 `reason` 字符串或 `reason.kind`；未识别返回 undefined）。
 *  P1：只有 completed / aborted / error 会在用户块上落终态符号，其余（blocked / max-tokens /
 *  interrupted / 未知）保持未定 → 渲染 `?`（与「已进历史区但未收到终态」同口径）。 */
function turnEndReason(reason: unknown): TurnEndReason | undefined {
  const kind =
    typeof reason === "string"
      ? reason
      : (reason as { kind?: unknown } | null)?.kind;
  switch (kind) {
    case "completed":
    case "aborted":
    case "error":
    case "blocked":
    case "max-tokens":
    case "interrupted":
      return kind;
    default:
      return undefined;
  }
}

/**
 * turn/end.reason（结构化判别联合；向后兼容字符串 reason）→ 分级 notice：
 * error/max-tokens/aborted/interrupted/blocked 显式提示并带 tone，completed 及未知静默。
 */
function turnEndNotice(
  reason: unknown,
): Extract<DshEvent, { type: "notice" }> | undefined {
  const kind =
    typeof reason === "string"
      ? reason
      : (reason as { kind?: unknown } | null)?.kind;
  switch (kind) {
    case "error": {
      const err = (reason as { error?: { code?: string; message?: string } })
        .error;
      const text = "✗ " + [err?.code, err?.message].filter(Boolean).join(": ");
      return {
        type: "notice",
        text: text === "✗ " ? "✗ 输出错误" : text,
        error: true,
        tone: "error",
      };
    }
    case "max-tokens":
      return { type: "notice", text: "输出达 token 上限", tone: "warn" };
    case "aborted":
      return { type: "notice", text: "已取消", tone: "info" };
    case "interrupted":
      return { type: "notice", text: "已中断", tone: "info" };
    case "blocked":
      return { type: "notice", text: "已阻塞（等待审批）", tone: "warn" };
    case "completed":
      return undefined;
    default:
      // 向后兼容：字符串 reason（历史日志/测试）不视为已知失败，静默处理
      return undefined;
  }
}
/** 构造真实 DSH adapter：注册应答者 + 订阅会话事件，归一化为 DshEvent。 */

/**
 * 宽松读取 ctx.jobs.list() 快照 → JobInfo（JobView 字段；缺失项降级，绝不崩）。
 * P3：jobs 服务结构面外字段（kind/label/status/detail）仅作展示，id 缺失则该行跳过。
 */
function collectJobs(rows: ReadonlyArray<Record<string, unknown>>): JobInfo[] {
  const out: JobInfo[] = [];
  for (const r of rows) {
    if (typeof r?.id !== "string" || r.id === "") continue;
    out.push({
      id: r.id,
      kind: typeof r.kind === "string" ? r.kind : "",
      label: typeof r.label === "string" ? r.label : r.id,
      status: typeof r.status === "string" ? r.status : "unknown",
      ...(typeof r.detail === "string" && r.detail !== ""
        ? { detail: r.detail }
        : {}),
    });
  }
  return out;
}

/**
 * 经宿主 llm.resolveModelInfo 读取指定 provider/model 的推理元数据
 * （可选思考等级 + provider 默认等级）。defaultEffort 即请求未显式指定时
 * 实际生效的等级（provider 级 reasoning 配置，如 max），与 TUI 状态栏
 * 显示的「当前生效 effort」保持一致。非思考模型/服务缺失/解析失败 → undefined。
 * 宿主等级名首字母大写（Off/Low/High/Max），归一为全小写再展示。
 */
async function resolveModelReasoning(
  opts: Pick<RealAdapterOptions, "llm">,
  provider: string,
  model: string,
): Promise<ModelReasoning | undefined> {
  const llm = opts.llm;
  if (!llm || typeof llm.resolveModelInfo !== "function") return undefined;
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model);
  } catch {
    return undefined;
  }
  const efforts = (info?.reasoning?.efforts ?? [])
    .map((e) =>
      e.id ? { id: e.id, name: (e.name ?? e.id).toLowerCase() } : null,
    )
    .filter((e): e is { id: string; name: string } => e !== null);
  const defaultEffort = info?.reasoning?.defaultEffort;
  // 无任何推理元数据（非思考模型）→ undefined，与“服务缺失”语义一致
  if (efforts.length === 0 && !defaultEffort) return undefined;
  const out: ModelReasoning = {};
  if (efforts.length > 0) out.efforts = efforts;
  if (defaultEffort) out.defaultEffort = String(defaultEffort).toLowerCase();
  return out;
}

// ---------------------------------------------------------------------------
// 历史会话清理（文件级）：安全语义对齐官方 dsh-tui 的 compat/sessionLog
// ---------------------------------------------------------------------------

/** surface 探针：一次读取同时给出标题兜底、是否有用户消息、是否可读 */
interface SessionSurfaceProbe {
  title: string | undefined;
  hasPrompt: boolean;
  readable: boolean;
}

/** 有界并发助手（会话列表读取用，避免 180+ 会话顺序读拖慢面板） */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
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
}

/** 官方标题：批量折叠 session/title 事件（readTitleSnapshots 优先；缺失逐条 readTitle） */
async function officialTitles(
  sessionQuery: SessionQueryLike | undefined,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!sessionQuery) return map;
  try {
    if (typeof sessionQuery.readTitleSnapshots === "function") {
      const snaps = await sessionQuery.readTitleSnapshots([...ids]);
      for (const snap of snaps) {
        // 官方 settlement 形态：仅消费 fulfilled 的 value.title；rejected 隔离到单会话
        if (
          snap.status === "fulfilled" &&
          snap.value?.title?.title &&
          snap.sessionId
        ) {
          map.set(snap.sessionId, snap.value.title.title);
        }
      }
    } else if (typeof sessionQuery.readTitle === "function") {
      await mapLimit([...ids], 8, async (id) => {
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
}

/** 编辑时间（TUI#1）：会话日志末条事件 `time`（listEvents 轻量面）。
 *  无事件 / 读取失败 / 服务缺失 → undefined（调用方回退 `createdAt`）。 */
async function lastEventTime(
  sessionQuery: SessionQueryLike,
  id: string,
): Promise<number | undefined> {
  if (typeof sessionQuery.listEvents !== "function") return undefined;
  try {
    const events = await sessionQuery.listEvents(id);
    let last: number | undefined;
    for (const e of events) {
      const t = (e as { time?: unknown }).time;
      if (typeof t === "number" && Number.isFinite(t)) last = t;
    }
    return last;
  } catch {
    return undefined;
  }
}

/**
 * 历史会话记录（TUI#1）：宿主 `listSessions` 归一化 + **编辑时间**（listEvents 末条
 * 事件 time，缺失回退 createdAt）+ 标题 / 空会话探针；按编辑时间**从晚到早**排序
 * （并列 createdAt 降序、id 兜底）。
 *
 * 单一来源：`adapter.listSessions`（面板）与 `main.ts` 的 `-c` / `--continue` 启动
 * 解析共用；`readMessages` 缺省时跳过标题兜底与 isEmpty 判定（CLI 路径省 surface 读取）。
 */
export async function listSessionRecords(deps: {
  sessionQuery: SessionQueryLike;
  /** 读取某会话的归一化消息（标题兜底 + isEmpty 判定用；缺省跳过该探针） */
  readMessages?: (id: string) => Promise<HistoryMessage[]>;
  activeSessionId?: string;
}): Promise<SessionInfo[]> {
  const { sessionQuery, readMessages, activeSessionId } = deps;
  const rs = await sessionQuery.listSessions();
  const ids = rs.map((r) => r.header.id);
  const official = await officialTitles(sessionQuery, ids);
  // 编辑时间：listEvents 末条事件 time（轻量面；读取失败/缺失回退 createdAt）
  const times = await mapLimit(ids, 8, async (id) => {
    return [id, await lastEventTime(sessionQuery, id)] as const;
  });
  const updatedById = new Map<string, number>();
  for (const [id, t] of times) if (t !== undefined) updatedById.set(id, t);
  // 无官方标题的会话：本地兜底标题 + 空会话判定；
  // 读取失败 → readable:false（不臆断为空，清理时跳过）
  // 探针：无官方标题的会话（标题兜底 + 空会话判定）；另**当前活跃会话**必探（TUI#23：
  // hasPrompt 供 /continue 区分「用过的当前会话」与「刚起的新会话」）
  const probeIds =
    readMessages === undefined
      ? []
      : ids.filter((id) => !official.has(id) || id === activeSessionId);
  const probes = await mapLimit(probeIds, 8, async (id) => {
    try {
      const messages = await readMessages!(id);
      const first = messages.find((m) => m.role === "user");
      return [
        id,
        {
          title: localTitleFromText(first?.text),
          hasPrompt: first !== undefined,
          readable: true,
        },
      ] as [string, SessionSurfaceProbe];
    } catch {
      return [id, { title: undefined, hasPrompt: true, readable: false }] as [
        string,
        SessionSurfaceProbe,
      ];
    }
  });
  const probeById = new Map(probes);
  const records: SessionInfo[] = rs.map((r) => {
    const probe = probeById.get(r.header.id);
    const title = official.get(r.header.id) ?? probe?.title;
    // 空会话：持久化 + 非 live + surface 确认无用户消息
    // （有官方标题即视为有对话；读取面缺失 → 不判空）
    const isEmpty =
      r.persisted &&
      !r.live &&
      probe !== undefined &&
      probe.readable &&
      !probe.hasPrompt;
    return {
      id: r.header.id,
      createdAt: r.header.createdAt,
      updatedAt: updatedById.get(r.header.id) ?? r.header.createdAt,
      cwd: r.header.cwd,
      live: r.live,
      persisted: r.persisted,
      // 当前活跃判定以 adapter 视角为准（活跃会话在内存 store 中必为 live）
      ...(r.live && r.header.id === activeSessionId ? { current: true } : {}),
      ...(isEmpty ? { isEmpty: true } : {}),
      ...(probe === undefined ? {} : { hasPrompt: probe.hasPrompt }),
      ...(title === undefined ? {} : { title }),
    };
  });
  // TUI#1：面板/选择一律按「编辑时间」从晚到早（并列 createdAt 降序、id 兜底）
  records.sort(byUpdatedDesc);
  return records;
}

/** 记录排序比较器（TUI#1）：编辑时间降序、并列创建时间降序、id 兜底 */
function byUpdatedDesc(a: SessionInfo, b: SessionInfo): number {
  return (
    (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt) ||
    b.createdAt - a.createdAt ||
    a.id.localeCompare(b.id)
  );
}

/**
 * 「最近退出」会话选择（TUI#1 / #2 共用）：当前目录（cwd 精确匹配，与 `/session`
 * project 范围同口径）+ 已持久化 + 非 live（当前活跃必为 live，天然排除），
 * 取编辑时间（`updatedAt`，缺省 `createdAt`）最大的一条；无匹配 → undefined。
 */
export function pickRecentSession(
  records: readonly SessionInfo[],
  cwd: string | undefined,
): SessionInfo | undefined {
  if (cwd === undefined) return undefined;
  const candidates = records.filter(
    (r) => r.cwd === cwd && r.persisted === true && !r.live,
  );
  if (candidates.length === 0) return undefined;
  return [...candidates].sort(byUpdatedDesc)[0];
}

/** `/continue` 目标（TUI#23，用户裁定「最新会话」语义） */
export type ContinueTarget =
  { kind: "current" } | { kind: "session"; record: SessionInfo };

/**
 * `/continue` 目标选择（TUI#23）：候选 = 同目录已持久化且非 live 的会话 ∪ **当前会话**
 * （仅当它已有用户消息——刚起的新会话不算，仍可回退到最近退出的会话）。取编辑时间
 * 最大者；若它就是当前会话 → `{ kind: "current" }`（调用方提示「已是最新」、不切换）；
 * 无候选 → undefined。CLI `-c` 仍用 `pickRecentSession`（启动时无当前会话）。
 */
export function pickContinueTarget(
  records: readonly SessionInfo[],
  cwd: string | undefined,
): ContinueTarget | undefined {
  if (cwd === undefined) return undefined;
  const current = records.find((r) => r.current === true);
  const candidates = records.filter(
    (r) =>
      r.cwd === cwd &&
      ((r.persisted === true && !r.live) ||
        (current !== undefined &&
          r.id === current.id &&
          current.hasPrompt !== false)),
  );
  if (candidates.length === 0) return undefined;
  const top = [...candidates].sort(byUpdatedDesc)[0]!;
  return current !== undefined && top.id === current.id
    ? { kind: "current" }
    : { kind: "session", record: top };
}

/** 会话目录删除结果：ok=true 时 path 为实际删除的目录（realpath 解析后） */
export type SessionDeleteOutcome =
  { ok: true; path: string } | { ok: false; reason: string };

/**
 * 文件级删除一个持久化会话目录。
 * 安全线由 `locateSessionDir` 承担（单段 id 校验 → 各根下按 <project-slug>/<id>
 * 定位 → realpath 包含性校验，slug 或会话目录为指向根外的符号链接则跳过）；
 * 本函数只负责找到后 rmSync(recursive)。未找到 → 返回失败且无副作用。
 */
export function deleteSessionDir(
  id: string,
  roots: readonly string[] = sessionRoots(),
): SessionDeleteOutcome {
  const found = locateSessionDir(id, roots);
  if (!found.ok) {
    return {
      ok: false,
      reason:
        found.reason === "会话 id 非法"
          ? "会话 id 非法，拒绝删除"
          : "未找到该会话的持久化文件（可能仅存在于内存或已删除）",
    };
  }
  try {
    rmSync(found.path, { recursive: true, force: true });
    return { ok: true, path: found.path };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/** 展示用设置值：对象/数组 → 单行 JSON；超长值截断（notice 每行再按面板宽截断） */
function formatSettingValue(v: unknown): string {
  if (v === undefined || v === null) return "∅";
  if (typeof v === "string") {
    const s = v.replace(/\s+/g, " ").trim();
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  }
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** SessionForkErrorCode（dsh-session lib/types/index.d.ts:296-305）→ 中文提示，不抛穿宿主错误对象 */
function forkErrorMessage(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case "SESSION_NOT_FOUND":
      return "源会话不存在";
    case "SESSION_NOT_LIVE":
      return "源会话不可用";
    case "SESSION_ALREADY_EXISTS":
      return "目标会话已存在";
    case "INVALID_BOUNDARY":
      return "分叉边界无效";
    case "OPEN_TURN":
      return "上一回合未闭合，无法分叉";
    default:
      return err instanceof Error && err.message !== ""
        ? err.message
        : "未知错误";
  }
}

/** task 树先序展平（行归一化用；children 自左向右，与 engine.nested() 同序） */
type FlatTask = {
  id: string;
  title: string;
  status: string;
  needDecompose: boolean;
  depth: number;
};

function flattenTasks(tasks: readonly TaskEngineTaskLike[]): FlatTask[] {
  const out: FlatTask[] = [];
  const walk = (items: readonly TaskEngineTaskLike[], depth: number): void => {
    for (const it of items) {
      out.push({
        id: it.id,
        title: it.title,
        status: it.status,
        needDecompose: it.needDecompose,
        depth,
      });
      if (it.children !== undefined) walk(it.children, depth + 1);
    }
  };
  walk(tasks, 0);
  return out;
}

/** task 树按 id 定位（先序） */
function findTask(
  tasks: readonly TaskEngineTaskLike[],
  id: string,
): FlatTask | undefined {
  return flattenTasks(tasks).find((t) => t.id === id);
}

/** goal-contract 契约标记行（契约嵌入格式：<objective>\n\nDone-when:\n<JSON 条款>）。 */
const DONE_WHEN_MARKER = "Done-when:";

/** 契约回读（纯函数，与 goal-contract `parseContract` 同构）：
 *  定位第一个独占一行的 `Done-when:` 标记 → 之前为 objective（trim）→ 之后为
 *  JSON 条款数组（宽松校验 id/check/level/command）。无标记 → 普通目标（空条款）；
 *  objective 为空 / JSON 非法 → error（供 notice 直接呈现）。 */
export function parseContractObjective(text: string): ContractParseResult {
  const lines = text.split("\n");
  let marker = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === DONE_WHEN_MARKER) {
      marker = i;
      break;
    }
  }
  if (marker === -1) {
    return { ok: true, objective: text.trim(), clauses: [] };
  }
  const objective = lines.slice(0, marker).join("\n").trim();
  if (objective.length === 0) {
    return {
      ok: false,
      objective,
      clauses: [],
      error: "Done-when 段之前的 objective 为空",
    };
  }
  const jsonText = lines
    .slice(marker + 1)
    .join("\n")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return {
      ok: false,
      objective,
      clauses: [],
      error: `Done-when 段不是合法 JSON：${String(err)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      objective,
      clauses: [],
      error: "Done-when 段应为条款 JSON 数组",
    };
  }
  const clauses: ContractClauseLike[] = [];
  for (const raw of parsed) {
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as { check?: unknown }).check === "string"
    ) {
      const c = raw as Record<string, unknown>;
      clauses.push({
        id: typeof c.id === "string" ? c.id : undefined,
        check: c.check as string,
        level: typeof c.level === "string" ? c.level : undefined,
        command: typeof c.command === "string" ? c.command : undefined,
      });
    } else {
      return {
        ok: false,
        objective,
        clauses: [],
        error: "Done-when 段含非法条款条目",
      };
    }
  }
  return { ok: true, objective, clauses };
}

/** 契约摘要文本（notice 展示，≤4 行）：无标记 → 单行「目标」；有条款 → 目标 + 计数 + 前 3
 *  条 check（等级标注）。行数受 notice 多行视口前 4 行约束。 */
export function contractSummaryText(
  r: ContractParseResult,
  objectiveLimit: number,
): string {
  const obj =
    r.objective.length > objectiveLimit
      ? r.objective.slice(0, objectiveLimit) + "…"
      : r.objective;
  if (!r.ok) {
    return `契约解析失败：${r.error ?? "未知原因"}`;
  }
  if (r.clauses.length === 0) {
    return `当前目标：${obj}（未附契约条款）`;
  }
  const lines = [`当前目标：${obj}`, `Done-when 契约：${r.clauses.length} 条`];
  for (const c of r.clauses.slice(0, 3)) {
    const tag = c.level ? `[${c.level}]` : "";
    const check = c.check.length > 48 ? c.check.slice(0, 48) + "…" : c.check;
    lines.push(`  ${tag}${check}`);
  }
  return lines.join("\n");
}

/** URL → host（搜索行 title 回落：无标题用域名展示；解析失败原样返回） */
function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** query → 归一化 token（小写、去空白、切词）；关联度排序用 */
function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter((t) => t !== "");
}

/** 单一来源的关联度评分：token 在 title（2 倍权重）与 snippet 的命中数。
 *  皆为 0 时按合并顺序保住（provider 顺序稳定）。 */
function relevanceScore(hit: {
  title: string;
  snippet: string;
  tokens: string[];
}): number {
  let score = 0;
  const title = hit.title.toLowerCase();
  const snippet = hit.snippet.toLowerCase();
  for (const token of hit.tokens) {
    if (title.includes(token)) score += 2;
    if (snippet.includes(token)) score += 1;
  }
  return score;
}

/** 多 provider 搜索结果聚合（/search 核心，纯函数）：
 *  并行 allSettled → 成功 sources 逐个合并（记 provider id）→ 按 URL 去重（首现保留）→
 *  query-token 关联度降序（分数一致保 provider/来源顺序稳定）。返回行 + 成败统计；
 *  单个 provider 失败仅丢其数据（其余保留），全部失败由调用方据 failed===total 判 reject。 */
export function aggregateSearchSources(params: {
  providers: {
    id: string;
    search(): Promise<{ sources: readonly SearchSourceLike[] }>;
  }[];
  query: string;
  maxResults: number;
}): Promise<{
  rows: { title: string; detail: string; payload: string }[];
  success: number;
  failed: number;
  total: number;
}> {
  const tokens = queryTokens(params.query);
  const results = params.providers.map((p) =>
    Promise.resolve()
      .then(() => p.search())
      .then(
        (r) => ({ status: "fulfilled" as const, provider: p.id, r }),
        (err) => ({ status: "rejected" as const, provider: p.id, err }),
      ),
  );
  return Promise.all(results).then((settled) => {
    const seen = new Set<string>();
    const hits: {
      title: string;
      snippet: string;
      tokens: string[];
      source: SearchSourceLike;
      provider: string;
    }[] = [];
    let success = 0;
    let failed = 0;
    for (const s of settled) {
      if (s.status === "rejected") {
        failed++;
        continue;
      }
      success++;
      const sources = Array.isArray(s.r.sources) ? s.r.sources : [];
      for (const src of sources) {
        if (!src || typeof src.url !== "string" || src.url === "") continue;
        const key = src.url.toLowerCase();
        if (seen.has(key)) continue; // URL 去重：首现保留
        seen.add(key);
        hits.push({
          title: typeof src.title === "string" ? src.title : "",
          snippet: typeof src.snippet === "string" ? src.snippet : "",
          tokens,
          source: src,
          provider: s.provider,
        });
      }
    }
    const ordered = hits
      .map((h) => ({ h, score: relevanceScore(h) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, params.maxResults));
    const rows = ordered.map(({ h }) => ({
      title: (h.title !== "" ? h.title : "") || urlHost(h.source.url),
      detail: [
        `[${h.provider}]`,
        h.source.snippet ?? "",
        h.source.publishedAt ?? "",
      ]
        .filter((p) => p !== "")
        .join(" · "),
      payload: h.source.url,
    }));
    return { rows, success, failed, total: params.providers.length };
  });
}

/** 循环 updatedAt → HH:MM（本地时区，行 detail 展示用） */
function loopTime(ms: number | undefined): string {
  if (typeof ms !== "number" || Number.isNaN(ms)) return "?";
  return new Date(ms).toTimeString().slice(0, 5);
}

/** 循环行 detail：状态 · 方向 · 轮数 · 历史最优 · 更新时间 */
function loopRowDetail(s: LoopSummaryLike): string {
  const parts = [
    s.status === "running" ? "运行中" : "已停止",
    s.direction === "min" ? "最小化" : s.direction === "max" ? "最大化" : "",
    s.measureCmd ?? "",
    `轮 ${s.rounds ?? 0}/${s.maxRounds ?? "?"}`,
    typeof s.best === "number" ? `best ${s.best}` : "",
    `更新 ${loopTime(s.updatedAt)}`,
  ].filter((p) => p !== "");
  return parts.join(" · ");
}

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
  // 会话内模型引用的初始值（main.ts 的 config 固定种子；settings 默认走实时兜底不进这里）：
  // 恢复会话时若无任何记录 → 回到该种子，既不丢配置固定模型、也不残留上一个会话的选择。
  const sessionModelSeed = opts.sessionModel?.current;
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
  // 实时帧通道（agent/assistant-stream）已完整交付（delta 累计 + block-end 补发）
  // 的块：结算数组（assistant/attempt）处理时跳过，避免正文重复显示；turn/end 清空
  const completedBlocks = new Set<string>();
  // P2 seq 守卫：per-session 游标，同 seq 重复/倒序丢弃（防重放），间隙接受
  const sessionSeq = new Map<string, number>();
  /** 状态列 Agents 块「工作内容」：各会话（含子代理会话）最近一次工具调用摘要。
   *  随 `refreshAgents` 清理离场会话（见 BACKLOG「Agents 列表显示别名 + 工作内容」）。 */
  const lastToolBySession = new Map<string, string>();
  // TUI#17：已渲染的注入 notice 消息 id（user/message 与 agent/inbox/spliced 双通道
  // 可能携带同一条注入消息 → 去重；超上限清空，避免无界增长）
  const renderedNoticeIds = new Set<string>();
  // 按 (session:turn:step) 累计已流式输出的正文（text 块；reasoning 不计）。
  // assistant/message 是每个 step 结束必发的完整正文表面事件，据此只补发缺失后缀；
  // 非流式 provider（无任何 chunk）时累计为空 → 直接输出完整正文，保证回复可见。
  const stepEmitted = new Map<string, string>();
  // P3 command/run-done 配对：commandId → 命令名（run 记录 / done 读取后删除；缺 run 直接 done）
  const commandNames = new Map<string, string>();
  // P2/16：tool-workflow 运行集合（/workflows 面板数据源；按 runId 分组，增量维护）
  const workflowRuns = new Map<string, WorkflowRunLike>();
  // /workflows 面板行：runs 集合 → CommandPanelRow[]（running → active 黄 / done → inactive 灰）。
  // 行归一只在 refreshWorkflows 主动调用时 emit（面板打开）；tool-workflow 增量事件仅更新
  // 内部 Map、不 emit 额外事件（避免污染既有事件流尾索引断言），面板实时性由 App 打开期间
  // 定时刷新承担（与 /agents 同款定时刷新基建）。
  const workflowRows = (): {
    title: string;
    detail: string;
    status: string;
  }[] =>
    Array.from(workflowRuns.values()).map((r) => ({
      title: r.name,
      detail: `${r.phase} · 成员 ${r.membersDone}/${r.members}`,
      status: r.status === "running" ? "active" : "inactive",
    }));

  const emit = (e: DshEvent): void => {
    if (disposed) return;
    // 六步流水线接收层：自造 notice 与宿主内容一视同仁（设计「自造内容走同一流程」）；
    // 未注入 sink（开关关闭）时零开销。
    if (e.type === "notice" && opts.onDelivery !== undefined) {
      opts.onDelivery(
        e.tone === undefined
          ? { kind: "notice", text: e.text }
          : { kind: "notice", text: e.text, tone: e.tone },
      );
    }
    for (const cb of listeners) {
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

  // 当前 (turn, step)：宿主部分事件（tool/call、tool/result）不带归属，接收层不能拿 0
  // 兜底（会开出 0/0 假节、把调用与结果拆到两节）→ 由带归属的事件推进、缺归属的沿用。
  let liveScope: { turn: number; step: number } | undefined;

  // 上下文窗口缓存：provider:model → 模型上下文容量（LlmResolvedModelInfo.context.contextWindow，
  // 供状态栏 ctx 占用百分比作分母）。undefined=已解析但模型未披露（不再重试）；缺失/异常视为未知。
  const ctxWindowCache = new Map<string, number | undefined>();
  const resolveContextWindow = async (
    key: string,
  ): Promise<number | undefined> => {
    if (ctxWindowCache.has(key)) return ctxWindowCache.get(key);
    const i = key.indexOf(":");
    const provider = i < 0 ? key : key.slice(0, i);
    const model = i < 0 ? key : key.slice(i + 1);
    const llm = opts.llm;
    let w: number | undefined;
    if (llm && typeof llm.resolveModelInfo === "function") {
      try {
        const info = await llm.resolveModelInfo(provider, model);
        w = info?.context?.contextWindow;
      } catch {
        /* 解析失败视为未披露 */
      }
    }
    ctxWindowCache.set(key, w);
    return w;
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
      const messages = normalizeHistoryMessages(live.events);
      // 刚 resume 的会话在内存 store 可能尚未完全入列：live 表面为空时
      // 回退到 persisted 读取面（readSurface）拿完整历史，避免切换后空屏
      if (messages.length > 0) {
        return { sessionId: id, messages };
      }
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

  /**
   * 会话状态回填：启动/恢复会话时把**宿主日志**（log-only 事件，切换会话不重放）
   * 与 **TUI 侧快照**（`<会话目录>/tui-state.json`）折叠成事件推给 App。
   *
   * 折叠口径（每项都是「宿主日志末条 → 快照 → 宿主默认」）：
   *  - model：末条 `model/selection`（显式意图）→ 快照 `model` → 末条
   *    `request/header.header.config`（该会话最近一次**实际使用**的 provider/model/
   *    effort）。命中即写回 `opts.sessionModel.current`（agent/request 钩子的生效源，
   *    也是 /model 面板与状态栏的显示源）；三者都没有 → 清空会话内引用回落宿主默认。
   *  - mode：`plan/mode` / `sandbox/mode` / `permission/preset`；`approval/policy`
   *    同理单独成事件。宿主无记录时退回快照，再退回 permissionPresets.defaultPreset
   *    捆绑（= pinInitialPermission 会给全新会话钉上的组合），plan 无记录即 off。
   *  - goal：按 seq 顺序回放全部 `goal/change`（累积成会话 goal 历史，当前 + 旧 goal 一并展示）；
   *    todo：末条 `todo/write`（全量快照事件，latest-wins）。
   *  - TUI 本地开关（`/collapse`、`/symbol-unify`）宿主不认识，只在快照里 → ui-flags。
   *
   * 读取源：live 会话优先读内存 events（全量原始，最省事）；否则走
   * `sessionQuery.readSession`（readSurface 做 surface fold 会滤掉 log-only 事件）。
   * 宿主既无 live 会话也无 sessionQuery 时只回填快照能提供的部分；快照也没有则静默
   * （模式值保持事件驱动）。
   */
  const restoreSessionState = async (id: string): Promise<void> => {
    let events: readonly { type?: string; data?: unknown }[] | undefined;
    const live = opts.sessions?.get(id);
    if (live && Array.isArray(live.events) && live.events.length > 0) {
      events = live.events as readonly { type?: string; data?: unknown }[];
    } else if (sessionQuery?.readSession) {
      try {
        const snap = await sessionQuery.readSession(id);
        events = snap.events as readonly { type?: string; data?: unknown }[];
      } catch {
        events = undefined; // 混合日志校验失败等：退回快照/默认值，不阻断恢复
      }
    }
    const uiState = readSessionUiState(
      id,
      opts.sessionStateRoots ?? sessionRoots(),
    );
    const lastOf = <T>(type: string): T | undefined => {
      if (!events) return undefined;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.type === type) return events[i]?.data as T;
      }
      return undefined;
    };
    // 宿主默认预设（全新会话会被 pin 的值）：presets 表属结构面之外，宽松读取，
    // 缺 defaultPreset/presets 条目时降级跳过对应旋钮（不发默认值、不臆造模式）。
    const svc = opts.permissionPresets as
      | (PermissionPresetServiceLike & {
          presets?: Record<string, { sandbox?: unknown; approval?: unknown }>;
        })
      | undefined;
    const defName = svc?.defaultPreset;
    const defSpec = defName ? svc?.presets?.[defName] : undefined;
    const defSandbox =
      typeof defSpec?.sandbox === "string" ? defSpec.sandbox : undefined;
    const defPolicy =
      defSpec?.approval === "ask" || defSpec?.approval === "never"
        ? defSpec.approval
        : undefined;

    // —— 模式（宿主末条事件 → 快照 → 宿主默认） ——
    const planRec = lastOf("plan/mode") as { active?: unknown } | undefined;
    // plan 是 opt-in：宿主无记录时看快照，仍无记录即未开启（off）
    const plan: "on" | "off" =
      planRec !== undefined
        ? planRec.active === true
          ? "on"
          : "off"
        : (uiState?.modes?.plan ?? "off");
    emit({ type: "mode", sessionId: id, kind: "plan", value: plan });
    const sandbox = lastOf("sandbox/mode") as { mode?: unknown } | undefined;
    const sandboxValue =
      typeof sandbox?.mode === "string"
        ? sandbox.mode
        : (uiState?.modes?.sandbox ?? defSandbox);
    if (sandboxValue !== undefined) {
      emit({
        type: "mode",
        sessionId: id,
        kind: "sandbox",
        value: sandboxValue,
      });
    }
    const perm = lastOf("permission/preset") as
      { preset?: unknown } | undefined;
    const permValue =
      typeof perm?.preset === "string"
        ? perm.preset
        : (uiState?.modes?.permission ?? defName);
    if (permValue !== undefined) {
      emit({
        type: "mode",
        sessionId: id,
        kind: "permission",
        value: permValue,
      });
    }
    const pol = lastOf("approval/policy") as { policy?: unknown } | undefined;
    const policyValue =
      pol?.policy === "ask" || pol?.policy === "never"
        ? pol.policy
        : (uiState?.modes?.policy ?? defPolicy);
    if (policyValue !== undefined) {
      emit({ type: "approval-policy", sessionId: id, policy: policyValue });
    }

    // —— 模型（宿主显式意图 → TUI 快照 → 宿主最近实际使用） ——
    const pick = (
      v:
        | { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
        | undefined,
    ):
      | { provider: string; model: string; reasoningEffort?: string }
      | undefined => {
      if (typeof v?.provider !== "string" || typeof v.model !== "string")
        return undefined;
      return {
        provider: v.provider,
        model: v.model,
        ...(typeof v.reasoningEffort === "string"
          ? { reasoningEffort: v.reasoningEffort }
          : {}),
      };
    };
    const header = lastOf("request/header") as
      { header?: { config?: Record<string, unknown> } } | undefined;
    const selected =
      pick(lastOf("model/selection")) ??
      pick(uiState?.model) ??
      pick(header?.header?.config);
    // sessionModel 引用是 agent/request 钩子的生效源：恢复后本会话的请求就用该模型。
    // 三者皆无 → 回到初始种子（config 固定模型；无种子即 undefined → 回落宿主实时默认），
    // 避免「上一个会话的选择」泄漏进本会话，也不把 config 固定的模型清掉。
    if (opts.sessionModel)
      opts.sessionModel.current = selected ?? sessionModelSeed;
    if (selected) {
      emit({
        type: "model-selection",
        sessionId: id,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort }),
      });
    }

    // —— goal / todo ——
    // goal：按 seq 顺序回放**全部** `goal/change`（状态列按会话累积成历史：当前 + 旧 goal；
    // 只取末条会丢掉已完成的历史）。activation 是进程本地态、不在日志里，故回放不产出
    // （重启后宿主即 disarmed，显示层按「无记录 → disarmed」推导）。todo：末条
    // `todo/write`（全量快照，latest-wins）。
    for (const ev of events ?? []) {
      if (ev.type !== "goal/change") continue;
      const change = ev.data as GoalChangeLike | undefined;
      if (change === undefined) continue;
      if (change.operation === "clear") {
        emit({
          type: "goal-change",
          sessionId: id,
          operation: "clear",
          cleared: change.cleared,
          clearedAt: change.clearedAt,
        });
      } else {
        emit({
          type: "goal-change",
          sessionId: id,
          operation: change.operation,
          goal: change.goal,
          roundsStarted: change.roundsStarted,
          createdAt: change.createdAt,
          updatedAt: change.updatedAt,
        });
      }
    }
    const todos = lastOf("todo/write") as { todos?: unknown } | undefined;
    if (todos !== undefined) {
      emit({
        type: "todo-write",
        sessionId: id,
        todos: Array.isArray(todos.todos)
          ? (todos.todos as TodoItemLike[])
          : [],
      });
    }

    // —— TUI 本地开关（宿主日志没有，只有快照） ——
    if (
      uiState?.collapse !== undefined ||
      uiState?.verbose !== undefined ||
      uiState?.symbolUnify !== undefined ||
      uiState?.statusColumn !== undefined ||
      uiState?.lowerPanes !== undefined
    ) {
      emit({
        type: "ui-flags",
        sessionId: id,
        // #8：详略（/collapse）与内容档位（/verbose）分列两个字段
        ...(uiState.collapse === undefined
          ? {}
          : { collapse: uiState.collapse }),
        ...(uiState.verbose === undefined ? {} : { verbose: uiState.verbose }),
        ...(uiState.symbolUnify === undefined
          ? {}
          : { symbolUnify: uiState.symbolUnify }),
        // P7：垂直状态列显隐（缺省显示）
        ...(uiState.statusColumn === undefined
          ? {}
          : { statusColumn: uiState.statusColumn }),
        // #9：下半区（Turn/Tool）显隐（缺省显示）
        ...(uiState.lowerPanes === undefined
          ? {}
          : { lowerPanes: uiState.lowerPanes }),
      });
    }
  };

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
      emittedByBlock.delete(blockKey);
    } else if (
      chunk.type === "reasoning-delta" ||
      chunk.type === "text-delta"
    ) {
      // 实时帧已完整交付（completedBlocks 有 key）的块：结算数组里的 delta 跳过
      if (completedBlocks.has(blockKey)) return;
      const emitted = emittedByBlock.get(blockKey) ?? "";
      // 结算 delta 与实时帧 delta 同源同切分：该片段已实时输出过（新 delta 是
      // 已累计文本的前缀）则跳过，只输出尚未覆盖的新片段（实时帧中途丢失时结算补全）
      if (
        emitted !== "" &&
        chunk.text.length <= emitted.length &&
        emitted.startsWith(chunk.text)
      ) {
        return;
      }
      emittedByBlock.set(blockKey, emitted + chunk.text);
      // 结算线（settle）的逐成员重放不投递给接收层：它在记录层按块聚合投递一次 full
      if (!settle) {
        deliverText(
          turn,
          step,
          index,
          isReasoning ? "reasoning" : "assistant",
          chunk.text,
        );
      }
      emit({
        type: isReasoning ? "thinking" : "stream",
        sessionId: sid,
        text: chunk.text,
      });
      // 仅正文进 step 累计（reasoning 为瞬态展示，不进 assistant/message）
      if (!isReasoning) {
        stepEmitted.set(sk, (stepEmitted.get(sk) ?? "") + chunk.text);
      }
    } else if (chunk.type === "block-end") {
      // 实时帧已完整交付（completedBlocks 有 key）的块：结算数组跳过
      if (completedBlocks.has(blockKey)) return;
      const full =
        chunk.block?.text ?? (chunk as StreamChunk & { text?: string }).text;
      if (full === undefined) return;
      const done = emittedByBlock.get(blockKey) ?? "";
      emittedByBlock.delete(blockKey);
      // 结算整块投递给接收层（前缀对齐在接收层做：与已交付增量不重复）
      deliverText(
        turn,
        step,
        index,
        isReasoning ? "reasoning" : "assistant",
        full,
        true,
      );
      if (done === "") {
        // 无 delta 的 provider：block-end 即完整文本
        emit({
          type: isReasoning ? "thinking" : "stream",
          sessionId: sid,
          text: full,
        });
        if (!isReasoning) {
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
            stepEmitted.set(sk, (stepEmitted.get(sk) ?? "") + rest);
          }
        }
      }
      // 块已完整处理（delta 与 block-end 不一致时不再输出——append-only UI 无法
      // 安全重写）→ 标记完成，结算通道不再重复尝试
      completedBlocks.add(blockKey);
    }
  };

  // --- agent/assistant-stream 实时帧（逐 chunk、流中实时；agent-subject 事件） ---
  // 宿主 agent-loop 在流进行中每 chunk 发一帧（含 time 时间戳），流结束后才经
  // session/event 发一次性 assistant/attempt 结算。实时帧先行输出正文（驱动逐
  // chunk 渲染 + 运行中 ●/○ 动画），结算数组经 completedBlocks 去重只补缺失。
  // attemptId → {turn, step}（chunk 帧不带 turn/step，由 start 帧登记）
  const attemptMeta = new Map<string, { turn: number; step: number }>();
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
    if (sessionId !== activeSessionId) return;
    if (frame.type === "start" && frame.turn !== undefined) {
      attemptMeta.set(frame.attemptId, {
        turn: frame.turn,
        step: frame.step ?? 0,
      });
      liveScope = { turn: frame.turn, step: frame.step ?? 0 };
      return;
    }
    if (frame.type === "chunk" && frame.chunk) {
      const meta = attemptMeta.get(frame.attemptId);
      if (!meta) return;
      // usage/finish 等非文本块不参与流式正文（usage 由结算通道 assistant/message 提取）
      if (frame.chunk.type !== "usage" && frame.chunk.type !== "finish") {
        applyChunk(sessionId, meta.turn, meta.step, frame.chunk);
      }
      return;
    }
    if (frame.type === "end") {
      attemptMeta.delete(frame.attemptId);
    }
  };

  // --- session/event 归一化 ---
  const onSessionEvent = (session: unknown, raw: SessionEvent): void => {
    const sid = (session as { id?: string } | null)?.id ?? activeSessionId;
    // 状态列 Agents 块「工作内容」：**全会话**记录最近一次工具调用（先于活跃会话过滤；
    // 子代理会话的事件只用于状态列，不进本会话 buffer）
    if (raw.type === "tool/call") {
      const call = raw.data as { name?: unknown; arguments?: unknown };
      if (typeof call.name === "string" && call.name !== "") {
        lastToolBySession.set(sid, workSummary(call.name, call.arguments));
      }
    }
    // 单活跃会话：非当前活跃会话的事件一律丢弃——其他 live 会话（列表标 [不可续]）
    // 不可注入输出/思考/标题到本会话 buffer 或状态栏
    if (sid !== activeSessionId) return;
    // P2 seq 守卫：同 seq 重复/倒序（<= lastSeq）丢弃防重放；间隙接受并更新游标
    // （seed 边界由宿主 session/end-seed 标记；缺 seq 的事件（旧 mock）跳过守卫）
    const seq = (raw as { seq?: unknown }).seq;
    if (typeof seq === "number") {
      const last = sessionSeq.get(sid) ?? 0;
      if (seq <= last) return;
      sessionSeq.set(sid, seq);
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
        liveScope = { turn, step };
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
            deliverText(
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
            deliverText(
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
        // surfaceOp 为 replace 的影子覆盖事件跳过（append-only 无法安全重写）。
        const op = (raw as { surfaceOp?: string }).surfaceOp;
        if (op === "replace") return;
        // 单次模型调用 token 用量：与正文同行送达（阶段 2 依 state.usage 落状态栏槽位）。
        // 占用百分比分母 = 所选模型窗口（resolveModelInfo.context.contextWindow）；
        // 未知/未披露时省略（状态栏仅显绝对大小），懒解析命中后补发一次同载荷 usage。
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
            ? (ctxWindowCache.get(winKey) ?? undefined)
            : undefined;
          emit({
            type: "usage",
            sessionId: sid,
            input,
            output,
            cacheRead,
            ...(knownWindow === undefined
              ? {}
              : { contextWindow: knownWindow }),
          });
          if (winKey && !ctxWindowCache.has(winKey)) {
            void resolveContextWindow(winKey).then((w) => {
              if (w !== undefined) {
                emit({
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
        liveScope = { turn: data.turn ?? 0, step: data.step ?? 0 };
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
          deliverFinalize(
            data.turn ?? 0,
            data.step ?? 0,
            data?.interrupted === true,
            raw.seq,
          );
          return;
        }
        const sk = sid + ":" + (data.turn ?? 0) + ":" + (data.step ?? 0);
        const done = stepEmitted.get(sk) ?? "";
        stepEmitted.delete(sk);
        let rest = "";
        if (done === "") rest = text;
        else if (text.startsWith(done)) rest = text.slice(done.length);
        if (rest.length > 0) {
          emit({ type: "stream", sessionId: sid, text: rest });
          // 结算整块（step 级）：接收层按 `index = -1` 单独记账，与逐块增量不重复
          deliverText(
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
        deliverFinalize(
          data.turn ?? 0,
          data.step ?? 0,
          data?.interrupted === true,
          raw.seq,
        );
        // 0.1.2-rc.1：输出被打断标记（assistant/message.interrupted）→ muted notice
        if (data?.interrupted === true) {
          emit({ type: "notice", text: "（模型输出已中断）", tone: "info" });
        }
        return;
      }

      case "user/message":
      case "agent/inbox/spliced": {
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
          emit({ type: "inbox-claim", target: splicedData.target });
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
          if (id !== undefined && renderedNoticeIds.has(id)) continue;
          // TUI#49：rule-engine 注入（无 notice form）→ 走用户块实时通道；
          // 历史路径（surface）自然折叠为用户消息，故只处理实时显示
          const ruleText = ruleInjectionTextOf(item);
          if (ruleText !== undefined) {
            if (id !== undefined) {
              if (renderedNoticeIds.size > 200) renderedNoticeIds.clear();
              renderedNoticeIds.add(id);
            }
            emit({ type: "rule-injection", id: id ?? "", text: ruleText });
            continue;
          }
          const summary = noticeSummaryOf(item);
          if (summary === undefined) continue;
          if (id !== undefined) {
            if (renderedNoticeIds.size > 200) renderedNoticeIds.clear();
            renderedNoticeIds.add(id);
          }
          emit({ type: "notice", text: summary, tone: "log" });
        }
        return;
      }
      case "turn/start": {
        // turn/start 本身不插入历史分隔线（用户本地回显后应紧邻模型响应），但把**回合号**
        // 转给上层（#3）：会话区回合分隔线要显示 `hh:mm:ss ⇆N`（符号见 layout/tool-line.ts 的
        // turnHeaderLine），而本地 turn-begin 早于本事件。
        const turn = (data as { turn?: unknown }).turn;
        emit({
          type: "turn-start",
          turn: typeof turn === "number" ? turn : undefined,
        });
        return;
      }
      case "turn/end": {
        // turn 结束：清空流式累计，block index 跨 turn 复用不残留
        emittedByBlock.clear();
        stepEmitted.clear();
        completedBlocks.clear();
        // 接收层：回合结束（封闭当前节 + 标记该回合的最终总结节）
        {
          const explicit = data as unknown as { turn?: number; step?: number };
          const scope =
            explicit.turn === undefined
              ? liveScope
              : {
                  turn: explicit.turn,
                  step: explicit.step ?? liveScope?.step ?? 0,
                };
          if (scope) {
            liveScope = scope;
            // 收尾原因随交付透传（条目 7 批 B1）：节层把它落到该回合最后一个用户条目上，
            // 用户块终态符号不再按 seq 回查 buffer
            const ended = turnEndReason(data.reason);
            deliver({
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
        emit(reason ? { type: "turn-end", reason } : { type: "turn-end" });
        // finish reason 分级 notice：completed 静默、异常 kind 带 tone（阶段 2 按 tone 渲染）
        const endNote = turnEndNotice(data.reason);
        if (endNote) emit(endNote);
        return;
      }
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
      case "tool/call": {
        // 工具调用：紧凑一行（名称 + arguments 摘要）；阶段 2 渲染 ⚙ <name> <summary>
        // 3.3.3：同批把 callId → 参数明细登记进短期表，供审批草稿展示命令/参数
        const name = data.name;
        if (typeof name !== "string" || name === "") return;
        const argsRaw =
          typeof data.arguments === "string" ? data.arguments : "";
        const summary = summarizeToolArguments(argsRaw);
        rememberToolCall(data.callId, name, argsRaw, summary);
        if (typeof data.callId === "string" && data.callId !== "") {
          const explicit = data as unknown as { turn?: number; step?: number };
          const scope =
            explicit.turn === undefined
              ? liveScope
              : { turn: explicit.turn, step: explicit.step ?? 0 };
          // 归属不可知 → 不投递（0 兜底会开出 0/0 假节）
          if (scope) {
            liveScope = scope;
            deliver({
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
        emit({
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
        // 工具结果：成功/失败一行；error 分支（结构化错误 {name, code}）标记失败
        const err = data.error;
        const detail = toolResultDetail(data.message);
        const meta = data.meta;
        {
          const explicit = data as unknown as { turn?: number; step?: number };
          const scope =
            explicit.turn === undefined
              ? liveScope
              : { turn: explicit.turn, step: explicit.step ?? 0 };
          // 归属不可知（会话刚开始就来了结果）→ 不投递，避免 0/0 假节
          if (scope) {
            liveScope = scope;
            const callId = toolResultCallId(data.message);
            deliver({
              kind: "tool-result",
              turn: scope.turn,
              step: scope.step,
              ...(callId === undefined ? {} : { callId }),
              ok: !err,
              detail,
              ...(raw.seq === undefined ? {} : { seq: raw.seq }),
            });
          }
        }
        emit({
          type: "tool-result",
          sessionId: sid,
          ok: !err,
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
        emit({
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
        emit({
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
        emit({
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
          emit({
            type: "goal-change",
            sessionId: sid,
            operation: "clear",
            cleared: goal.cleared,
            clearedAt: goal.clearedAt,
          });
          return;
        }
        emit({
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
        emit({
          type: "todo-write",
          sessionId: sid,
          todos: Array.isArray(todos) ? (todos as TodoItemLike[]) : [],
        });
        return;
      }
      case "plan/mode": {
        const active = (raw.data as { active?: unknown }).active;
        emit({
          type: "mode",
          sessionId: sid,
          kind: "plan",
          value: active === true ? "on" : "off",
        });
        return;
      }
      case "sandbox/mode": {
        const mode = (raw.data as { mode?: unknown }).mode;
        emit({
          type: "mode",
          sessionId: sid,
          kind: "sandbox",
          value: typeof mode === "string" ? mode : "",
        });
        return;
      }
      case "permission/preset": {
        const preset = (raw.data as { preset?: unknown }).preset;
        emit({
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
          liveScope = { turn: data.turn ?? 0, step: data.step ?? 0 };
          deliver({
            kind: "step-start",
            turn: liveScope.turn,
            step: liveScope.step,
            ...(typeof raw.time === "number" ? { time: raw.time } : {}),
            ...(raw.seq === undefined ? {} : { seq: raw.seq }),
          });
        }
        emit({
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
        emit({
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
        emit({
          type: "compaction-summary",
          sessionId: sid,
          text: firstText ? firstText.text : "",
          raw: payload,
        });
        return;
      }
      case "approval/policy": {
        // C 阶段：既有审计对事件归一化为第 10 个 DshEvent（载荷 {policy: 'ask'|'never'}）；
        // 显示当前策略（状态栏）。无效载荷整体丢弃（fail-safe）。
        const policy = (raw.data as { policy?: unknown }).policy;
        if (policy !== "ask" && policy !== "never") return;
        emit({ type: "approval-policy", sessionId: sid, policy });
        return;
      }
      case "tool-workflow/run-start": {
        // P3 workflow 运行打开：{runId, name}，仅显示名；/workflows 运行集合建条目
        const w = raw.data as { runId?: unknown; name?: unknown };
        const runId = typeof w.runId === "string" ? w.runId : "";
        const name = typeof w.name === "string" ? w.name : "";
        emit({
          type: "workflow",
          sessionId: sid,
          phase: "run-start",
          label: name,
          runId,
        });
        if (runId !== "") {
          workflowRuns.set(runId, {
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
        emit({
          type: "workflow",
          sessionId: sid,
          phase: "agent-start",
          label: typeof w.label === "string" && w.label !== "" ? w.label : "",
          detail: typeof w.seq === "number" ? String(w.seq) : "",
          runId,
        });
        const run = runId !== "" ? workflowRuns.get(runId) : undefined;
        if (run) {
          const next = {
            ...run,
            phase: "agent-start",
            members: run.members + 1,
            updatedAt: Date.now(),
          };
          workflowRuns.set(runId, next);
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
        emit({
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
        const run = runId !== "" ? workflowRuns.get(runId) : undefined;
        if (run) {
          const next = {
            ...run,
            phase: "agent-end",
            membersDone: run.membersDone + 1,
            updatedAt: Date.now(),
          };
          workflowRuns.set(runId, next);
        }
        return;
      }
      case "tool-workflow/run-end": {
        // P3 workflow 收尾：{runId, stopReason}；fold 为 toast；/workflows 标记 done
        const w = raw.data as { runId?: unknown; stopReason?: unknown };
        const runId = typeof w.runId === "string" ? w.runId : "";
        emit({
          type: "workflow",
          sessionId: sid,
          phase: "run-end",
          label: "",
          detail: typeof w.stopReason === "string" ? w.stopReason : "",
          runId,
        });
        if (runId !== "") {
          const run = workflowRuns.get(runId);
          if (run) {
            workflowRuns.set(runId, {
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
          commandNames.set(c.commandId, c.name);
        }
        emit({
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
            ? commandNames.get(c.commandId)
            : undefined;
        if (typeof c.commandId === "string") commandNames.delete(c.commandId);
        emit({
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
        emit({
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
        emit({
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
        emit({
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
        emit({
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
        emit({
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
          deliver({
            kind: "shadow",
            seqs: p.shadowedSeqs.filter(
              (seq): seq is number => typeof seq === "number",
            ),
            ...(raw.seq === undefined ? {} : { seq: raw.seq }),
          });
        }
        emit({
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
        emit({
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
        emit({
          type: "retry-started",
          sessionId: sid,
          attempt: typeof r.retry === "number" ? r.retry : 0,
        });
        return;
      }
      case "agent-preset/selected": {
        // P3：agent 预设选中（rc.2 会话事件；payload {agentPreset}）→ 状态栏 preset:<id>。
        // 经上方通用 seq 守卫 + 非活跃会话丢弃（与其它会话事件同链）。
        const p = raw.data as { agentPreset?: unknown };
        if (typeof p.agentPreset !== "string" || p.agentPreset === "") return;
        emit({ type: "agent-preset", sessionId: sid, preset: p.agentPreset });
        return;
      }
      default:
        return;
    }
  };

  // --- approval/request waterfall 应答者 ---
  // 3.3.3：tool/call 参数短期登记表（键 = 宿主 callId）。容量上限防长会话堆积；
  // 审批裁定 / 超时 / abort 后立即清理（见 approvalAnswerer 的 finally）。
  const toolCallsByCallId = new Map<string, ApprovalDetail>();
  const TOOL_CALL_CACHE_MAX = 64;

  /** 由原始 arguments 抽审批草稿明细：command 字段取全文，非 JSON 原样，摘要兜底 */
  const approvalDetailOf = (
    name: string,
    argsRaw: string,
    summary: string,
  ): ApprovalDetail => {
    const detail: ApprovalDetail = { tool: name, summary };
    const raw = argsRaw.trim();
    if (raw === "") return detail;
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (typeof obj.command === "string" && obj.command.trim() !== "") {
        detail.command = obj.command;
      }
    } catch {
      detail.command = raw;
    }
    return detail;
  };

  const rememberToolCall = (
    callId: unknown,
    name: string,
    argsRaw: string,
    summary: string,
  ): void => {
    if (typeof callId !== "string" || callId === "") return;
    toolCallsByCallId.delete(callId); // 重放时移到队尾（LRU 近似）
    toolCallsByCallId.set(callId, approvalDetailOf(name, argsRaw, summary));
    while (toolCallsByCallId.size > TOOL_CALL_CACHE_MAX) {
      const oldest = toolCallsByCallId.keys().next().value;
      if (oldest === undefined) break;
      toolCallsByCallId.delete(oldest);
    }
  };

  /**
   * 裁定并清理。reason 非空表示「由宿主侧裁定」（超时 / abort）——此时额外发
   * approval-closed 让 app 关闭面板并提示，避免「面板仍开着但决议已失效」（3.3.2）。
   */
  const settle = (
    id: string,
    outcome: ApprovalOutcome,
    reason?: "timeout" | "abort",
  ): void => {
    const pending = pendingApprovals.get(id);
    if (!pending) return;
    pendingApprovals.delete(id);
    clearTimeout(pending.timer);
    if (reason) emit({ type: "approval-closed", id, reason });
    pending.resolve(outcome);
  };

  const approvalAnswerer = (
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> => {
    if (disposed || listeners.size === 0) return next();
    const id = "approval-" + approvalSeq++;
    const prompt = buildApprovalPrompt(
      req,
      typeof req.callId === "string"
        ? toolCallsByCallId.get(req.callId)
        : undefined,
    );
    // 超时裁定为 rejected（BACKLOG 3.3.5：无操作到点 = 默认拒绝，比取消更保守）
    const timer = setTimeout(
      () => settle(id, "rejected", "timeout"),
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
      signal?.addEventListener(
        "abort",
        () => settle(id, "cancelled", "abort"),
        {
          once: true,
        },
      );
    }).finally(() => {
      if (typeof req.callId === "string") toolCallsByCallId.delete(req.callId);
    });
  };

  // --- user-questions/request waterfall 应答者（每次最多一个活动请求） ---
  let questionSeq = 0;
  const pendingQuestions = new Map<
    string,
    {
      resolve: (a: QuestionAnswer) => void;
      reject: (err: unknown) => void;
      cleanup: () => void;
    }
  >();
  const questionAnswerer = (
    req: UserQuestionRequestLike,
    next: () => Promise<QuestionAnswer>,
  ): Promise<QuestionAnswer> => {
    // 无监听者/已释放 → 放行给后续 waterfall 监听者（最终无应答 NO_PROVIDER）
    if (disposed || listeners.size === 0) return next();
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
  };

  // 经 runtime.on 注册 waterfall 应答者（与 approval/request 同构；unscoped ctx 全局放行）
  collectUnbind(
    runtime.on(
      "user-questions/request",
      questionAnswerer as (...args: unknown[]) => unknown,
    ),
  );

  const adapter: DshAdapter = {
    // 实时取当前活跃会话（resume 切换后仍正确）；App 启动初期 state 未建立时兜底用
    get sessionId() {
      return activeSessionId;
    },
    // TUI#40：启动即恢复（--resume / -c）标记，App 据此补一次历史折叠
    resumedAtLaunch: opts.resumedAtLaunch === true,
    onEvent(cb) {
      if (disposed) return () => {};
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    canSteer() {
      // TUI#36：**优先看原始宿主 agent**（activeCommandAgent，随 resume/new 同步切换）。
      // 瘦 agent（opts.agent / resume 时新建）只转发 followup，早期实现只看它 → 真实会话里
      // 恒 false、`<` 提交静默降级成 followup（真机缺陷，2026-09-27）。
      const raw = activeCommandAgent as { steer?: unknown } | undefined;
      return (
        typeof raw?.steer === "function" ||
        typeof activeAgent.steer === "function"
      );
    },
    sendMessage(text, targetSessionId, target) {
      if (disposed) return;
      if (targetSessionId && targetSessionId !== activeSessionId) {
        process.stderr.write(
          "[dsh adapter] sendMessage: sessionId " +
            targetSessionId +
            " not active\n",
        );
        return;
      }
      // steer（BACKLOG TUI#36）：官方 agent.steer = 投递到最近 step 边界。
      // 走原始宿主 agent；两者都没有 steer（旧宿主）→ 回落 followup（App 侧另有降级提示）
      if (target === "next-step") {
        const message = buildUserMessage(text);
        const raw = activeCommandAgent as
          { steer?: (m: typeof message) => void } | undefined;
        if (typeof raw?.steer === "function") {
          raw.steer(message);
          return;
        }
        if (typeof activeAgent.steer === "function") {
          activeAgent.steer(message);
          return;
        }
      }
      activeAgent.followup(buildUserMessage(text));
    },
    /**
     * 启动自检 kickoff（锚定解锁）：以 `source.kind:"tool-bootstrap"` 发一条 user 消息
     * （正文 `[AUTO]` 开头），驱动模型发起首个工具调用完成解锁。真实 DSH 不回显非 notice
     * 的注入 user 消息，故回显由 App 侧负责；仅启动期由 App 门控后调用一次。
     */
    sendBootstrapKickoff() {
      if (disposed) return;
      const message = buildBootstrapKickoffMessage();
      // BACKLOG #2：kickoff 优先走 steer（next-step 队列 —— 投递到最近 step 边界，启动竞态下
      // 已有回合在跑也能被**当前回合**领取；空闲时立刻起回合），查找次序与 sendMessage 的
      // next-step 分支一致（优先原始宿主 agent，见 canSteer 的两层判据）；
      // 无 steer 的宿主（旧宿主）→ 回落 followup（降级不丢，日志可见）。
      const raw = activeCommandAgent as
        { steer?: (m: typeof message) => void } | undefined;
      if (typeof raw?.steer === "function") {
        raw.steer(message);
        return;
      }
      if (typeof activeAgent.steer === "function") {
        activeAgent.steer(message);
        return;
      }
      process.stderr.write(
        "[dsh adapter] sendBootstrapKickoff: 宿主无 steer，回落 followup\n",
      );
      activeAgent.followup(message);
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
      // 拒绝所有悬挂问答（绝不留下悬浮 Promise）；监听者经 runtimeUnbinds 注销
      for (const p of pendingQuestions.values()) {
        p.cleanup();
        p.reject(new Error("adapter disposed"));
      }
      pendingQuestions.clear();
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
    cancelApproval(id) {
      if (disposed) return;
      settle(id, "cancelled");
    },
    approvalTimeoutMs() {
      // App 侧倒计时据此显示（与上面 setTimeout 同源，BACKLOG 3.3.2）
      return opts.approvalTimeoutMs ?? 60_000;
    },
    stopApprovalTimeout(id) {
      // 用户已开始操作 → 不再自动裁定（BACKLOG 3.3.5）；已裁定时 pending 不在，天然幂等
      const pending = pendingApprovals.get(id);
      if (pending) clearTimeout(pending.timer);
    },
    async setApprovalPolicy(policy) {
      // C 阶段：两态切换写路径 → 宿主 ctx.approval.setPolicy(agent, policy)（A0 已核实
      // user-approval/src/index.ts L226 → session.append('approval/policy', {policy})，
      // 即本调用是 approval/policy 事件的产生源，状态栏经事件回读 latest-wins）。
      // 宿主未挂载 ctx.approval 或活跃 agent 缺失 → reject，调用方 notice「审批策略服务不可用」。
      if (disposed) return;
      // SAFETY: DshRuntime 结构面仅声明 on()；ctx.approval 为可选宿主服务，
      // 经 userspace 结构分类（{setPolicy(agent, policy)}）窄化，缺失则下方 reject，
      // 绝不无保护访问成员——与既有结构面（sessionQuery/llm 等）同构。
      const approval = (
        runtime as unknown as {
          approval?: { setPolicy?: (agent: unknown, p: string) => unknown };
        }
      ).approval;
      if (
        !approval ||
        typeof approval.setPolicy !== "function" ||
        !activeAgent
      ) {
        throw new Error("审批策略服务不可用");
      }
      await approval.setPolicy(activeAgent, policy);
    },

    async permissionCatalog() {
      const svc = opts.permissionPresets;
      if (
        !svc ||
        typeof svc.current !== "function" ||
        !Array.isArray(svc.names)
      ) {
        return undefined;
      }
      let current = "";
      try {
        // SAFETY: 服务结构面仅保证 names/current；activeAgent.session.events 宽松读取——
        // 缺 events / 服务抛错都降级（current 置空），绝不崩。
        const child = activeAgent as
          { session?: { events?: readonly unknown[] } } | null | undefined;
        const events = child?.session?.events ?? [];
        const c = svc.current(events);
        if (typeof c === "string") current = c;
      } catch {
        /* 服务读异常 → 当前值降级为空 */
      }
      // 展示描述宽松读取（PresetSpec.name/description，非结构面保证；缺省回落键名）。
      // SAFETY: 结构面之外的身份 presets 表仅作展示增强——字段缺失/形状不符时
      // 下方的 optional chaining 与 typeof 检查全部走降级（回落键名），不成立也不会崩。
      const specTable = (
        svc as unknown as {
          presets?: Record<string, { name?: string; description?: string }>;
        }
      ).presets;
      const entries = [...svc.names].map((key) => {
        const spec = specTable?.[key];
        return {
          key,
          name:
            typeof spec?.name === "string" && spec.name !== ""
              ? spec.name
              : key,
          ...(typeof spec?.description === "string" && spec.description !== ""
            ? { description: spec.description }
            : {}),
        };
      });
      return { current, names: [...svc.names], entries };
    },
    async agentPresetCatalog() {
      // P3：agent 预设目录——可用预设（ctx.agentPresets.list）+ 当前选中（agent-preset/selected
      // 事件回读）+ 未来会话默认（defaultId）。宿主未挂载服务 → undefined（顶层提示不可用）。
      const svc = opts.agentPresets;
      if (!svc || typeof svc.list !== "function") return undefined;
      const presets: AgentPresetInfo["presets"] = [];
      try {
        // SAFETY: 仅依赖 list() 元素 id；name/description 宽松读取（缺省回落 id），绝不崩。
        for (const row of await svc.list()) {
          const rec = row as {
            id?: unknown;
            name?: unknown;
            description?: unknown;
          };
          if (typeof rec?.id !== "string" || rec.id === "") continue;
          presets.push({
            id: rec.id,
            name:
              typeof rec.name === "string" && rec.name !== ""
                ? rec.name
                : rec.id,
            ...(typeof rec.description === "string" && rec.description !== ""
              ? { description: rec.description }
              : {}),
          });
        }
      } catch {
        return undefined;
      }
      // 当前选中回读：activeAgent.session.events 末条 agent-preset/selected（latest-wins）
      let current = "";
      try {
        const child = activeAgent as
          { session?: { events?: readonly unknown[] } } | null | undefined;
        const events = child?.session?.events ?? [];
        for (let i = events.length - 1; i >= 0; i--) {
          const ev = events[i] as {
            type?: unknown;
            data?: { agentPreset?: unknown };
          };
          if (
            ev?.type === "agent-preset/selected" &&
            typeof ev.data?.agentPreset === "string"
          ) {
            current = ev.data.agentPreset;
            break;
          }
        }
      } catch {
        /* 回读异常 → 当前值保持空 */
      }
      const defaultId = typeof svc.defaultId === "string" ? svc.defaultId : "";
      return { current, defaultId, presets };
    },
    async refreshJobs() {
      // P3：读 ctx.jobs.list() 全量快照（caller=当前会话，owner-relative），经 jobs-changed
      // 推送（reducer 更新 /jobs 面板）。宿主未挂载 ctx.jobs / list 缺失 → reject
      // （调用方 notice「jobs 服务不可用」，绝不静默假成功）。
      const svc = opts.jobs;
      if (!svc || typeof svc.list !== "function") {
        throw new Error("jobs 服务不可用");
      }
      // caller = 当前会话 id（0.1.7 起 `JobRegistry` 的 caller 为裸 SessionId 字符串）
      const jobs = collectJobs(svc.list(activeSessionId));
      emit({ type: "jobs-changed", sessionId: activeSessionId, jobs });
    },
    async killJob(id) {
      // P3：取消后台任务 → ctx.jobs.kill(id, caller)。宿主未挂载 → reject（面板 notice）。
      // caller 同上（owner-relative 权限核对）。
      if (disposed) return;
      const svc = opts.jobs;
      if (!svc || typeof svc.kill !== "function") {
        throw new Error("jobs 服务不可用");
      }
      svc.kill(id, activeSessionId);
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
    // 命令注册表目录（ctx.commands.list(agent)：CommandDescriptor[]）：仅取 name/description
    // 供输入补全；服务未暴露 list 或读取异常 → undefined（调用方降级为仅本地命令）
    commandList() {
      const svc = opts.commands;
      if (!svc || typeof svc.list !== "function") return undefined;
      const agent = activeCommandAgent ?? activeAgent;
      if (!agent) return undefined;
      try {
        const out: { name: string; desc: string }[] = [];
        for (const d of svc.list(agent) ?? []) {
          const name = typeof d?.name === "string" ? d.name : "";
          if (!name) continue;
          out.push({
            name,
            desc: typeof d.description === "string" ? d.description : "",
          });
        }
        return out;
      } catch {
        return undefined;
      }
    },
    // 历史会话列表（宿主挂载 sessionQuery 时可用）：按**编辑时间**从晚到早（TUI#1）；
    // 标题优先官方 session/title 事件（批量折叠），缺失时本地兜底首条用户消息；
    // 同一趟 surface 读取顺带判定 isEmpty（持久化且从未有用户消息 → 可清理）。
    // 归一化/排序单一来源 = 模块级 listSessionRecords（与 main.ts 的 -c 解析共用）。
    listSessions: sessionQuery
      ? () =>
          listSessionRecords({
            sessionQuery,
            readMessages: async (id) =>
              (await doReadSessionSurface(id)).messages,
            ...(activeSessionId === undefined ? {} : { activeSessionId }),
          })
      : undefined,
    // 删除持久化会话（文件级）：安全 id + realpath 包含性校验后删除会话目录；
    // 当前活跃会话与内存中的 live 会话一律拒绝（面板侧另有前置守卫）
    deleteSession: sessionQuery
      ? async (id) => {
          if (activeSessionId !== undefined && id === activeSessionId) {
            return { ok: false as const, reason: "当前活跃会话不可删除" };
          }
          if (opts.sessions?.get(id) !== undefined) {
            return {
              ok: false as const,
              reason: "live 会话不可删除（仅可删除已持久化且不在内存中的会话）",
            };
          }
          const outcome = deleteSessionDir(id);
          return outcome.ok
            ? { ok: true as const }
            : { ok: false as const, reason: outcome.reason };
        }
      : undefined,
    readSessionSurface: sessionQuery
      ? (id) => {
          // 读取顺序（按 live/persisted 判定，避免走错接口）见 doReadSessionSurface
          return doReadSessionSurface(id);
        }
      : undefined,
    restoreSessionState:
      sessionQuery || opts.permissionPresets || opts.sessions
        ? async (id: string) => {
            await restoreSessionState(id);
          }
        : undefined,
    readSessionUiState: (id: string) =>
      readSessionUiState(id, opts.sessionStateRoots ?? sessionRoots()),
    saveSessionUiState: (id: string, state: SessionUiState) =>
      writeSessionUiState(id, state, opts.sessionStateRoots ?? sessionRoots())
        .ok,
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
    /** 重命名当前会话标题：宿主 sessionTitle.rename(live Session, title)。
     *  live Session 对象随 resume 变化，故始终取当前活跃 agent 的 session
     *  （DshAgentLike.session 运行时即 Session 实例，见 main.ts 的 agentLike 组装）。 */
    async renameSession(title: string): Promise<void> {
      const svc = opts.sessionTitle;
      if (!svc || typeof svc.rename !== "function") {
        throw new Error("sessionTitle 未挂载（宿主无会话标题服务）");
      }
      const session = (
        activeAgent as { session?: LiveSessionHandle } | undefined
      )?.session;
      if (!session) {
        throw new Error("活跃会话不可用，无法重命名");
      }
      svc.rename(session, title);
    },
    /** 拉取 skills 列表并归一化后经 command-panel-data 推送（服务缺失 → reject；
     *  读取失败 → 事件带 error，面板显示红行）。描述取首行以适配单行渲染。 */
    async refreshSkills(filter?: string): Promise<void> {
      const svc = opts.skills;
      if (!svc || typeof svc.list !== "function") {
        throw new Error("skills 未挂载（宿主无技能服务）");
      }
      try {
        const list = (await svc.list()) ?? [];
        const needle = (filter ?? "").toLowerCase();
        const matched =
          needle === ""
            ? list
            : list.filter((skill) =>
                `${skill.name} ${skill.description ?? ""} ${skill.whenToUse ?? ""}`
                  .toLowerCase()
                  .includes(needle),
              );
        emit({
          type: "command-panel-data",
          kind: "skills",
          rows: matched.map((skill) => ({
            title: skill.name,
            detail:
              (skill.description ?? skill.whenToUse ?? "").split("\n")[0] ?? "",
            payload: skill.name,
          })),
        });
      } catch (err) {
        emit({
          type: "command-panel-data",
          kind: "skills",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** 读取单个 skill 正文（Enter 详情）；服务缺失或读取失败 → undefined */
    async skillDetail(name: string): Promise<string | undefined> {
      const svc = opts.skills;
      if (!svc || typeof svc.get !== "function") return undefined;
      try {
        const def = await svc.get(name);
        return def?.content;
      } catch {
        return undefined;
      }
    },
    /** 拉取子代理列表并归一化后推送两处：/agents 面板（command-panel-data；diagnostic 与
     *  一次性条目不可中断——payload 置空，后者附 `blockedReason` 原因）与**状态列 Agents 块**
     *  （agents-changed，BACKLOG TUI#39；过滤 `unavailable` 诊断，见 TUI#56）。
     *  数据源：`listDescendants`（富条目 + depth），取 depth=1 的直接子代。 */
    async refreshAgents(): Promise<void> {
      const svc = opts.subagents;
      if (typeof svc?.listDescendants !== "function") {
        throw new Error("subagents 未挂载（宿主无子代理服务）");
      }
      try {
        // 会话别名（状态列 Agents 块显示名 = 别名 ?? label）：增强项，读取失败静默
        const aliasById = new Map<string, string>();
        try {
          const list = await opts.sessionChannel?.()?.aliasList();
          if (list?.ok === true) {
            for (const e of list.aliases ?? [])
              aliasById.set(e.sessionId, e.alias);
          }
        } catch {
          // 别名读取失败不阻塞目录刷新
        }
        const entries = (
          (await svc.listDescendants(activeSessionId)) ?? []
        ).filter((entry) => (entry.depth ?? 1) === 1);
        // 状态列 Agents 块：与面板同源归一化（label / 状态 / 异常标记），但**只保留当前活跃
        // 的行**——已结束子代（`activity: "inactive"` = 会话已不在）与全部诊断条目都不上
        // 状态列（详情仍在 /agents 面板；BACKLOG「状态列 Agents 块只列运行中 / 存活且无
        // 诊断的子代理」，含 TUI#56 的 unavailable 口径）
        const agentRows: AgentRowInfo[] = entries
          .filter(
            (entry) =>
              entry.kind !== "diagnostic" && entry.activity === "running",
          )
          .map((entry) => {
            const diagnostic = entry.kind === "diagnostic";
            const id = entry.id ?? "-";
            const alias = aliasById.get(id);
            const work = lastToolBySession.get(id);
            return {
              id,
              label: diagnostic
                ? `（诊断：${entry.reason ?? "unknown"}）`
                : (entry.label ?? "(未命名)"),
              // 投影目录形态无 activity → 退用 mode（one-shot/continuable/unknown）作状态语义
              status: diagnostic
                ? "diagnostic"
                : (entry.activity ?? entry.mode ?? ""),
              // 状态列 Agents 块：别名 + 工作内容（无别名 / 无记录时省略该段）
              ...(alias !== undefined ? { alias } : {}),
              ...(work !== undefined ? { work } : {}),
              ...(diagnostic
                ? { diagnostic: { reason: entry.reason ?? "unknown" } }
                : {}),
            };
          });
        // 清理已离场会话的工具摘要（防无界增长）
        const liveIds = new Set(agentRows.map((r) => r.id));
        for (const id of lastToolBySession.keys()) {
          if (!liveIds.has(id)) lastToolBySession.delete(id);
        }
        emit({
          type: "command-panel-data",
          kind: "agents",
          rows: entries.map((entry) => {
            const diagnostic = entry.kind === "diagnostic";
            const oneShot = entry.mode === "one-shot";
            const title = diagnostic
              ? `（诊断：${entry.reason ?? "unknown"}）`
              : (entry.label ?? "(未命名)");
            const detail = [
              entry.mode ?? "",
              entry.activity ?? "",
              entry.hasChildren === true ? "has-children" : "",
            ]
              .filter((p) => p !== "")
              .join(" · ");
            return {
              title,
              detail,
              // 投影目录形态无 activity → 退用 mode（one-shot/continuable/unknown）作状态语义
              status: diagnostic
                ? "diagnostic"
                : (entry.activity ?? entry.mode ?? ""),
              // 可中断载荷：诊断条目无可用 id；一次性条目宿主的 interrupt 是 accepted
              // no-op（只支持 live continuable）→ 同样不给载荷，改以 blockedReason 说明
              payload: diagnostic || oneShot ? undefined : entry.id,
              ...(oneShot && !diagnostic
                ? {
                    blockedReason:
                      "一次性子代理不支持中断（宿主仅支持 continuable）",
                  }
                : {}),
            };
          }),
        });
        emit({
          type: "agents-changed",
          sessionId: activeSessionId,
          agents: agentRows,
        });
      } catch (err) {
        emit({
          type: "command-panel-data",
          kind: "agents",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
        // 状态列：枚举失败不静默留旧数据，以**异常态**一行呈现（渲染红 + reason）
        emit({
          type: "agents-changed",
          sessionId: activeSessionId,
          agents: [
            {
              id: "-",
              label: "agents 目录不可用",
              status: "diagnostic",
              diagnostic: { reason: "unavailable" },
            },
          ],
        });
      }
    },
    /** 中断一个子代理（`interrupt(id, {kind:'user', parentSessionId: activeSessionId})`）；
     *  服务缺失或调用失败 → reject（调用方 notice）。 */
    async interruptAgent(childSessionId: string): Promise<void> {
      const svc = opts.subagents;
      if (!svc || typeof svc.interrupt !== "function") {
        throw new Error("subagents 未挂载（宿主无子代理服务）");
      }
      svc.interrupt(childSessionId, {
        kind: "user",
        parentSessionId: activeSessionId,
      });
    },
    /** 拉取工具 schema（`schemas()` 全局视图）按 `filter` 过滤后推送；描述取首行 */
    async refreshTools(filter?: string): Promise<void> {
      const svc = opts.tools;
      if (!svc || typeof svc.schemas !== "function") {
        throw new Error("tools 未挂载（宿主无工具服务）");
      }
      try {
        const schemas = svc.schemas() ?? [];
        const needle = (filter ?? "").toLowerCase();
        // filter 只匹配工具名子串（描述不参与，避免描述误命中）
        const matched =
          needle === ""
            ? schemas
            : schemas.filter((s) => s.name.toLowerCase().includes(needle));
        emit({
          type: "command-panel-data",
          kind: "tools",
          rows: matched.map((s) => ({
            title: s.name,
            detail: (s.description ?? "").split("\n")[0] ?? "",
            payload: s.name,
          })),
        });
      } catch (err) {
        emit({
          type: "command-panel-data",
          kind: "tools",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** 读取单个工具详情（名称 + 描述 + 参数 schema JSON）；服务缺失或读取失败 → undefined */
    async toolDetail(name: string): Promise<string | undefined> {
      const svc = opts.tools;
      if (!svc || typeof svc.get !== "function") return undefined;
      try {
        const def = svc.get(name);
        if (!def) return undefined;
        const lines = [name];
        const description = def["description"];
        if (typeof description === "string" && description !== "") {
          lines.push("", description);
        }
        const parameters = def["parameters"];
        if (parameters !== undefined) {
          lines.push("", "参数：", JSON.stringify(parameters, null, 2) ?? "");
        }
        return lines.join("\n");
      } catch {
        return undefined;
      }
    },
    /** 读取全部设置（`settings.describe()` 枚举 ns + 当前值，`ns：value` 每行一行；
     *  secret 项脱敏为 `<redacted>`）；服务缺失或读取失败 → undefined。 */
    async readSettings(): Promise<string | undefined> {
      const svc = opts.settings;
      if (!svc || typeof svc.describe !== "function") return undefined;
      try {
        const descs = svc.describe() ?? [];
        if (descs.length === 0) return "（无设置项）";
        return descs
          .map((d) => {
            const ns = d["ns"];
            const hasSecret =
              Array.isArray(d["secrets"]) && d["secrets"].length > 0;
            const valueText = hasSecret
              ? "<redacted>"
              : formatSettingValue(d["value"]);
            return ns !== undefined && ns !== ""
              ? `${String(ns)}：${valueText}`
              : valueText;
          })
          .join("\n");
      } catch {
        return undefined;
      }
    },
    /** /fork：`sessions.fork(activeSessionId)`（省略 boundary/childSessionId =
     *  源会话当前最后事件 + store id 策略）；错误码 5 个映射中文后 reject（不抛穿）。 */
    async forkCurrentSession(): Promise<{ id: string; title?: string }> {
      const svc = opts.sessions;
      if (!svc || typeof svc.fork !== "function") {
        throw new Error("sessions 未挂载（宿主无会话 fork 服务）");
      }
      let child: { id: string; title?: string } | undefined;
      try {
        child = svc.fork(activeSessionId);
      } catch (err) {
        throw new Error(forkErrorMessage(err));
      }
      if (!child || typeof child.id !== "string" || child.id === "") {
        throw new Error(forkErrorMessage({ code: "SESSION_NOT_FOUND" }));
      }
      return { id: child.id, title: child.title };
    },
    /** 任务面板：经 task-engine `query()` 只读面先序展平为行（标题 + 状态）推送；未挂载 reject。
     *  多轮（森林 > 1 棵）时给**轮根行**标注轮次——标注放 title **行首**（行右侧先被
     *  `truncateToWidth` 截掉，detail 尾的标注在窄面板会先消失）；标注只在本映射里加，
     *  不写进 `flattenTasks`（`findTask` / taskDetail 复用同一函数，详情不加轮次行）。 */
    async refreshTasks(): Promise<void> {
      const svc = opts.taskEngine;
      if (!svc || typeof svc.query !== "function") {
        throw new Error("taskEngine 未挂载（宿主无任务引擎查询面）");
      }
      try {
        const snap = svc.query();
        const forest = snap.tasks;
        // 轮根 id → 轮次：引擎 `round`（id 跳号不代表轮次）**全有才用**；任一轮根缺 `round`
        // 则整片回落轮根序号——避免同一森林里两种口径混用串号（多轮与 `round` 同版本引入，
        // 旧版引擎恒单根，故该回落实际不可达）
        const allRounded = forest.every((t) => typeof t.round === "number");
        const roundOf = new Map(
          forest.map((t, i): [string, number] => [
            t.id,
            allRounded && typeof t.round === "number" ? t.round : i + 1,
          ]),
        );
        const currentRootId = forest[forest.length - 1]?.id;
        const multiRound = forest.length > 1;
        const rows = flattenTasks(forest).map((t) => {
          const round = t.depth === 0 ? roundOf.get(t.id) : undefined;
          const tag =
            !multiRound || round === undefined
              ? ""
              : t.id === currentRootId
                ? `当前轮 ${round} · `
                : `旧轮 ${round} · `;
          return {
            title: `${tag}${t.depth > 0 ? `${"  ".repeat(t.depth)}${t.title}` : t.title}`,
            detail: `${t.status}${t.needDecompose ? " · 待拆分" : ""}`,
            status: t.status,
            payload: t.id,
          };
        });
        emit({
          type: "command-panel-data",
          kind: "task",
          rows,
        });
      } catch (err) {
        emit({
          type: "command-panel-data",
          kind: "task",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** 循环面板：经 metric-loop `list()` 归一化为行（measureCmd/id + 状态·方向·轮数
     *  ·best·更新时间）；running → status active（黄）、stopped → inactive（灰）；未挂载 reject */
    async refreshLoops(): Promise<void> {
      const svc = opts.metricLoop;
      if (!svc || typeof svc.list !== "function") {
        throw new Error("metricLoop 未挂载（宿主无循环查询面）");
      }
      try {
        const loops = svc.list() ?? [];
        const rows: CommandPanelRow[] = loops.map((s) => ({
          title: s.measureCmd && s.measureCmd !== "" ? s.measureCmd : s.id,
          detail: loopRowDetail(s),
          status: s.status === "running" ? "running" : "inactive",
          payload: s.id,
        }));
        emit({ type: "command-panel-data", kind: "loop", rows });
      } catch (err) {
        emit({
          type: "command-panel-data",
          kind: "loop",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** /search：经 ctx.web.search（统一多 provider 搜索 seam）拉取并归一化行推
     *  command-panel-data(kind=search)。title 缺省回落 URL host（与 dsh-tool-web 一致）；
     *  detail = url + snippet 首段、payload = url（Enter 打开详情）。宿主未挂载 web.search
     *  → reject（调用方 warn 不空开面板）。 */
    async search(query: string, maxResults = 10): Promise<void> {
      // provider 集合：opts.web（host 派生）+ options.searchProviders（TUI 本地可配置）
      // —— seam 是 provider-selecting 非聚合，TUI 侧负责并行遍历与合并/去重/排序。
      const providers: {
        id: string;
        search(): Promise<{ sources: readonly SearchSourceLike[] }>;
      }[] = [];
      const svc = opts.web;
      const webSearch =
        svc && typeof svc.search === "function" ? svc.search : undefined;
      if (webSearch) {
        providers.push({
          id: "web",
          search: () => webSearch({ query, maxResults }),
        });
      }
      if (Array.isArray(opts.searchProviders)) {
        for (const p of opts.searchProviders) {
          if (p && typeof p.search === "function") {
            providers.push({ id: p.id, search: () => p.search(query) });
          }
        }
      }
      if (providers.length === 0) {
        throw new Error("web 未挂载（宿主无搜索面）");
      }
      const agg = await aggregateSearchSources({
        providers,
        query,
        maxResults,
      });
      if (agg.failed > 0 && agg.success === 0) {
        // 全部失败 → 调用方 notice warn（不空开面板数据）
        throw new Error("所有搜索 provider 均失败");
      }
      emit({ type: "command-panel-data", kind: "search", rows: agg.rows });
    },
    /** /council：并行拉起 count（默认 2）个评审子代理（ctx.subagents.start，one-shot）
     *  对 target 各自给独立意见。任一 run 失败降级保留其余（idea 行列失败注明）；
     *  run 自身不 reject（stopReason:'error'），基础设施异常 reject → 调用方 warn。
     *  汇总 ≤4 行：各行 = `评审 N：<output 首行>`；全部失败 text = 失败说明。 */
    async council(target: string, count = 2): Promise<string> {
      const svc = opts.subagents;
      if (!svc || typeof svc.start !== "function") {
        throw new Error("subagents 未暴露 start（宿主无子代理启动面）");
      }
      const n = Math.max(1, Math.min(4, Math.floor(count)));
      const startFn = svc.start;
      if (typeof startFn !== "function") {
        throw new Error("subagents 未暴露 start（宿主无子代理启动面）");
      }
      const results = await Promise.allSettled(
        Array.from({ length: n }, (_, i) =>
          Promise.resolve(
            startFn("one-shot", {
              label: `council-${i + 1}`,
              prompt: [
                {
                  type: "text",
                  text:
                    `请对以下目标/问题给出独立的评审意见（指出风险、遗漏与改进建议，` +
                    `简明扼要，3 行以内）：\n\n${target}`,
                },
              ],
              parent: activeAgent as unknown,
            }),
          ).then(async (run): Promise<{ ok: boolean; text: string }> => {
            const result = run ? await run.result : undefined;
            // run 无 result / 无输出 且 stopReason=error → 该评审判定失败（降级保留序号）
            if (!result) return { ok: false, text: "（无结果）" };
            const output = Array.isArray(result.output)
              ? result.output
                  .filter((b): b is ContentBlockLike & { text?: string } => !!b)
                  .map((b) => b.text ?? "")
                  .filter((t) => t !== "")
                  .join(" ")
              : typeof result.text === "string"
                ? result.text
                : "";
            const trimmed = output.trim();
            if (trimmed !== "") return { ok: true, text: trimmed };
            const reason =
              typeof result.error === "string" && result.error !== ""
                ? result.error
                : (result.stopReason ?? "无输出");
            return { ok: result.stopReason !== "error", text: reason };
          }),
        ),
      );
      const lines = results.map((r, i) => {
        const body =
          r.status === "fulfilled"
            ? (r.value.text.trim().split("\n")[0] ?? "（无意见）")
            : `失败：${String(r.reason)}`;
        return `评审 ${i + 1}：${body}`;
      });
      const okCount = results.filter(
        (r) => r.status === "fulfilled" && r.value.ok,
      ).length;
      if (okCount === 0) {
        return `council 失败：${count} 个评审均未返回意见`;
      }
      return [`council（${okCount}/${n} 成功）`, ...lines].join("\n");
    },
    /** /workflows 面板：读 adapter 维护的 tool-workflow 运行集合推 command-panel-data；
     *  宿主未挂载 workflowEngine → reject（调用方 warn 不空开面板）。 */
    async refreshWorkflows(): Promise<void> {
      const eng = opts.workflowEngine;
      if (!eng) {
        throw new Error("workflowEngine 未挂载（宿主无工作流引擎）");
      }
      emit({
        type: "command-panel-data",
        kind: "workflows",
        rows: workflowRows(),
      });
    },
    /** 契约回读：优先 goal-contract 只读面（opts.goalContract.parseContract），宿主未挂载
     *  （当前 goal-contract 不 expose 服务）→ 内置同构回读兜底（不依赖跨包 import） */
    get workflowRuns(): readonly WorkflowRunLike[] {
      return Array.from(workflowRuns.values());
    },
    contractSummary(objectiveText: string): ContractParseResult {
      const svc = opts.goalContract;
      if (svc && typeof svc.parseContract === "function") {
        try {
          const r = svc.parseContract(objectiveText);
          if (r && typeof r === "object") {
            return r;
          }
        } catch {
          // service 实现异常 → 回落内置回读
        }
      }
      return parseContractObjective(objectiveText);
    },
    /** 循环详情（Enter）：list() 中定位该 id，输出 4 行（id/状态·停止原因/配置/进度·最优） */
    async loopDetail(id: string): Promise<string | undefined> {
      const svc = opts.metricLoop;
      const found = svc?.list?.()?.find((s) => s.id === id);
      if (!found) {
        return undefined;
      }
      const statusLine =
        found.status === "running"
          ? `状态：运行中`
          : `状态：已停止${found.stopReason ? `（${found.stopReason}）` : ""}`;
      const cfg = [
        `方向：${found.direction === "min" ? "最小化" : "最大化"}`,
        found.measureCmd
          ? `目标：${found.measureCmd}`
          : "目标：无（metricless）",
      ].join(" · ");
      return [
        `循环：${found.id}`,
        statusLine,
        cfg,
        `轮 ${found.rounds ?? 0}/${found.maxRounds ?? "?"} · 窗口 ${found.window ?? 0} · best ${found.best ?? "n/a"}`,
      ].join("\n");
    },
    /** 知识库概要：`getSummary()` 同步优先，否则 `whenReady()` 等待就绪；未就绪 →
     *  返回说明文本（调用方以 info 呈现）；服务缺失 → reject（调用方 warn）。 */
    async memorySummary(): Promise<string> {
      const svc = opts.knowledge;
      if (
        !svc ||
        (typeof svc.getSummary !== "function" &&
          typeof svc.whenReady !== "function")
      ) {
        throw new Error("knowledge 未挂载（宿主无知识库查询面）");
      }
      // 就绪概要行（helper）
      const linesOf = (
        s: KnowledgeBundleSummaryLike | undefined,
      ): string | undefined => {
        if (!s) return undefined;
        if (!s.ready) return "知识库尚未就绪（异步建库中）";
        return [
          "知识库：就绪",
          `路径：${s.dbPath}`,
          `chunks：${s.chunkCount} · sources：${s.sourceCount}`,
        ].join("\n");
      };
      try {
        if (typeof svc.getSummary === "function") {
          const direct = linesOf(svc.getSummary());
          if (direct !== undefined) return direct;
        }
        if (typeof svc.whenReady === "function") {
          const awaited = await svc
            .whenReady()
            .then((b) => linesOf(b?.summary?.()))
            .catch(() => undefined);
          if (awaited !== undefined) return awaited;
        }
        return "知识库尚未就绪（apply 尚未创建库或启动失败）";
      } catch {
        return "知识库尚未就绪（读取失败）";
      }
    },
    /** 提升审阅：拉 pending 候选（tier 缺省三库全拉——服务面按层分库）。 */
    async memoryCandidates(tier?: string): Promise<CandidateRowLike[]> {
      const list = opts.knowledge?.candidates?.list;
      if (typeof list !== "function") return [];
      return list({
        ...(tier === undefined ? {} : { tier }),
        state: "pending",
      });
    },
    /** 审阅动作（reviewer 由 App 结算函数写死 "user"——凭据约束，不参数化）。 */
    async memoryApprove(args: {
      tier: string;
      id: number;
      project?: string;
    }): Promise<MemoryReviewVerdictLike> {
      const approve = opts.knowledge?.candidates?.approve;
      if (typeof approve !== "function")
        return { ok: false, reason: "forbidden" };
      return approve({ ...args, reviewer: "user" });
    },
    async memoryReject(args: {
      tier: string;
      id: number;
      reason: string;
    }): Promise<MemoryReviewVerdictLike> {
      const reject = opts.knowledge?.candidates?.reject;
      if (typeof reject !== "function")
        return { ok: false, reason: "forbidden" };
      return reject({ ...args, reviewer: "user" });
    },
    async memoryResolveConflict(args: {
      tier: string;
      id: number;
      decision: string;
      content?: string;
    }): Promise<MemoryReviewVerdictLike> {
      const resolveConflict = opts.knowledge?.candidates?.resolveConflict;
      if (typeof resolveConflict !== "function") {
        return { ok: false, reason: "forbidden" };
      }
      return resolveConflict({ ...args, reviewer: "user" });
    },
    async memoryEdit(args: {
      tier: string;
      id: number;
      content: string;
    }): Promise<MemoryReviewVerdictLike> {
      const edit = opts.knowledge?.candidates?.edit;
      if (typeof edit !== "function") return { ok: false, reason: "forbidden" };
      return edit(args);
    },
    /** `/memory search`：跨全域检索（LayeredHit 宽松形态透传）。 */
    async memorySearch(args: {
      query: string;
      limit?: number;
    }): Promise<unknown[] | undefined> {
      const search = opts.knowledge?.search;
      if (typeof search !== "function") return undefined;
      return search({ query: args.query, limit: args.limit ?? 10 });
    },
    /** `/memory add`：用户直写（origin user；数据面仍过该层闸门——U 层禁兜底）。 */
    async memoryAdd(input: {
      content: string;
      kind?: string;
      tier: "session" | "project" | "user";
    }): Promise<{ ok: boolean; skipped?: string }> {
      const remember = opts.knowledge?.remember;
      if (typeof remember !== "function") return { ok: false };
      const result = await remember({ ...input, origin: "user" });
      if (result.skipped !== undefined || (result.ids?.length ?? 0) === 0) {
        return { ok: false, skipped: result.skipped };
      }
      return { ok: true };
    },
    /** 守卫面板：经 security-guard `recent()` 归一化为行（工具名 + 放行/拦截 + 原因首行）；
     *  deny → status failed（红）、allow → success（绿）；未挂载 reject */
    async refreshGuard(): Promise<void> {
      const svc = opts.guard;
      if (!svc || typeof svc.recent !== "function") {
        throw new Error("guard 未挂载（宿主无安全守卫查询面）");
      }
      try {
        const recs = svc.recent() ?? [];
        const rows: CommandPanelRow[] = recs.map((r) => ({
          title: r.toolName,
          detail:
            r.verdict === "deny"
              ? `拦截${typeof r.reason === "string" && r.reason !== "" ? ` · ${(r.reason.split("\n")[0] ?? "").slice(0, 60)}` : ""}`
              : "放行",
          status: r.verdict === "deny" ? "failed" : "success",
          payload: undefined,
        }));
        emit({ type: "command-panel-data", kind: "guard", rows });
      } catch (err) {
        emit({
          type: "command-panel-data",
          kind: "guard",
          rows: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    /** 策略快照（Enter 详情）：`policy()` → 4 行摘要（启用/黑名单/敏感文件/拦截计数），适配 notice 视口 */
    async guardPolicy(): Promise<string | undefined> {
      const svc = opts.guard;
      const snap = svc?.policy?.();
      if (!snap) {
        return undefined;
      }
      try {
        const cb = snap.commandBlacklist;
        const sf = snap.sensitiveFiles;
        const denyCount = (svc?.recent?.() ?? []).filter(
          (r) => r.verdict === "deny",
        ).length;
        return [
          `守卫：${snap.enabled ? "启用" : "停用"}`,
          `命令黑名单：${cb?.rules?.length ?? 0} 条规则 · 放行 ${cb?.allowPatterns?.length ?? 0} 条`,
          `敏感文件：${sf?.rules?.length ?? 0} 条规则 · 放行 ${sf?.allowedPaths?.length ?? 0} 条`,
          `拦截记录：最近 ${denyCount} 条`,
        ].join("\n");
      } catch {
        return undefined;
      }
    },
    /** 任务详情（Enter）：在 query().tasks 先序中定位该 id，输出标题/状态/id/需拆分，
     *  并按 query().frameStack 标注该任务在帧栈中的位置（objective「帧栈详情供 Enter 详情」）。 */
    async taskDetail(id: string): Promise<string | undefined> {
      const svc = opts.taskEngine;
      const snap = svc?.query?.();
      if (!snap) {
        return undefined;
      }
      try {
        const found = findTask(snap.tasks, id);
        if (!found) {
          return undefined;
        }
        const stack = snap.frameStack ?? [];
        const idx = stack.indexOf(id);
        const stackLine =
          idx === -1
            ? "不在帧栈"
            : idx === stack.length - 1
              ? "栈顶（下一待处理）"
              : `第 ${idx + 1}/${stack.length} 帧`;
        // 帧栈并入状态行：notice 多行在 activity 视口只显前 4 行，独立第 5 行会被裁掉
        return [
          `任务：${found.title}`,
          `状态：${found.status} · 帧栈：${stackLine}`,
          `id：${found.id}`,
          `需拆分：${found.needDecompose ? "是" : "否"}`,
        ].join("\n");
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
      // 宿主 `agents.resume` 走 `sessions.prepare` → **重建 Session**：activation 是进程本地态，
      // 新 Session 即 disarmed，且 `setActivation(disarmed)` 与初值相同 → **不发 activation 边**。
      // 故此处清该会话的旧边，交由「无记录 → disarmed」推导；否则切走再切回会沿用切换前的
      // armed（显绿，实际已需用户驱动）。
      emit({ type: "goal-activation", sessionId: id });
    },
    /** /new：新建会话（dispose 旧 agent → agents.create 全新会话，同一 setup/agentOptions）。
     *  旧会话已持久化在磁盘上（handle 释放后变 persisted 非 live），可经 /session 切回。 */
    async newSession() {
      if (disposed) {
        throw new Error("adapter 已释放，无法新建会话");
      }
      if (!opts.agents || typeof opts.agents.create !== "function") {
        throw new Error("agents 未暴露 create（宿主未配置会话创建）");
      }
      // 与 resumeTo 同序：先释放当前 agent 的 handle，再建新会话（失败不留下双活 handle）
      const prevDispose = activeDispose;
      if (prevDispose) {
        activeDispose = undefined;
        try {
          await prevDispose();
        } catch {
          /* 旧 handle 释放失败不阻断新建 */
        }
      }
      const { randomUUID } = await import("node:crypto");
      const sessionId = "tui-" + randomUUID();
      const handle = await opts.agents.create({
        sessionId,
        ...(opts.sessionMeta ? { meta: opts.sessionMeta } : {}),
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
        throw new Error("create 未返回有效 agent");
      }
      activeAgent = {
        session: rawAgent.session,
        followup: (m: ReturnType<typeof buildUserMessage>) =>
          rawAgent.followup?.(m),
      } as DshAgentLike;
      activeCommandAgent = rawAgent as unknown;
      activeCancel =
        rawAgent.cancel === undefined
          ? () => {}
          : () => rawAgent.cancel?.({ kind: "user" });
      activeSessionId = rawAgent.session.id;
      activeDispose = () => handle.dispose();
      return { id: activeSessionId };
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
      return (await resolveModelReasoning(opts, provider, model))?.efforts;
    },
    // 推理元数据（efforts + provider 默认等级）：状态栏/面板按实际生效值展示
    modelReasoning(provider, model) {
      return resolveModelReasoning(opts, provider, model);
    },
  };

  collectUnbind(
    runtime.on("session/event", (session, event) =>
      onSessionEvent(session, event as SessionEvent),
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
      emit({
        type: "goal-activation",
        sessionId:
          typeof p?.sessionId === "string" ? p.sessionId : activeSessionId,
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
        frame?: Parameters<typeof onAssistantFrame>[1];
      };
      const sessionId = p?.agent?.session?.id;
      if (!sessionId || !p?.frame) return;
      onAssistantFrame(sessionId, p.frame);
    }),
  );
  collectUnbind(
    runtime.on("agent/status", (payload) =>
      emitAgentStatus(payload as { agent?: unknown; status?: string }),
    ),
  );
  // TUI#10：子代理生命周期事件（dsh-subagent：subagent/start · subagent/end）——
  // /agents 面板打开期间据此即时刷新（2s 定时仍作兜底）；老宿主无此事件时静默。
  for (const evt of ["subagent/start", "subagent/end"] as const) {
    collectUnbind(
      runtime.on(evt, () => {
        emit({ type: "subagent-activity" });
      }),
    );
  }
  collectUnbind(
    runtime.on(
      "approval/request",
      approvalAnswerer as (...args: unknown[]) => unknown,
    ),
  );

  // P3：jobs 增量订阅——任务变化 → 推送全量快照（/jobs 面板实时刷新）。
  // 0.1.7 起走 jobs.events.subscribe({owner})（按 owner 过滤的事件流）；订阅不可用或抛错
  // → 退化为打开面板时的 refreshJobs() 主动拉取一次（不崩）。
  const jobsSvc = opts.jobs;
  if (jobsSvc !== undefined) {
    const pushJobs = (): void => {
      if (disposed || typeof jobsSvc.list !== "function") return;
      emit({
        type: "jobs-changed",
        sessionId: activeSessionId,
        jobs: collectJobs(jobsSvc.list(activeSessionId)),
      });
    };
    try {
      const events = jobsSvc.events;
      const off =
        typeof events?.subscribe === "function"
          ? events.subscribe({ owner: activeSessionId }, pushJobs)
          : undefined;
      if (typeof off === "function") runtimeUnbinds.push(off);
    } catch {
      /* 订阅异常 → 打开面板时 refreshJobs() 兜底拉取 */
    }
  }

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
      emit({
        type: "notice",
        text: "invalid slash command: " + line,
        tone: "error",
      });
      return;
    }
    const { commands } = opts;
    if (!commands || typeof commands.execute !== "function") {
      emit({
        type: "notice",
        text: "commands 未就绪，无法执行 /" + name,
        error: true,
        tone: "warn",
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
      emit({
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
          activeCommands.delete(controller);
          emit({
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
        tone: "error",
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
        tone: "error",
      });
      return;
    }
    emit({
      type: "notice",
      text: (exec.commandId ? "[" + exec.commandId + "] " : "") + (text ?? ""),
      tone: "success",
    });
  }

  function formatCommandError(name: string, err: unknown): string {
    return "/" + name + " 执行出错：" + String(err);
  }

  function emitAgentStatus(payload: {
    agent?: unknown;
    status?: string;
  }): void {
    // 仅转发当前活跃 agent 的状态：其他 live agent（如平行会话）不得污染状态栏
    const agentSid = (
      payload?.agent as { session?: { id?: string } } | undefined
    )?.session?.id;
    if (agentSid && agentSid !== activeSessionId) return;
    const status = normalizeAgentStatus(payload?.status);
    emit({ type: "agent-status", sessionId: activeSessionId, status });
  }
}
