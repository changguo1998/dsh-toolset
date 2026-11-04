// TUI/src/app/adapter/history-normalize.ts — 历史事件 → app 消息列表（P9 折叠口径）

import type { TurnEndReason } from "../state.ts";
import { isUserMessage } from "../state.ts";
import type {
  DshEvent,
  DshAdapter,
  AgentRowInfo,
  AgentGroupViewLike,
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
  MemoryRowRef,
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
  ConfigEntrySummary,
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
  retryStartedLine,
} from "../layout/tool-line.ts";
import { createRealDshAdapter } from "./dsh.ts";

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
  const pushText = (
    role: "user" | "assistant",
    raw: string,
    turn: number | undefined = curTurn,
  ): void => {
    const text = raw.trim() === "" ? "" : raw;
    if (text === "") return;
    out.push({
      role,
      text,
      ...(turn === undefined ? {} : { turn }),
    });
  };
  // 用户输入的注入副本：宿主把用户自己发的消息**同时**记进 `agent/inbox/spliced`（日志实测
  // 54 条副本的 id 与 `user/message` 全部重合）。恢复时若两条都出，每条用户消息会出现两次，
  // 且副本没有终态 → 显示 `?`（真机现象：自己的消息块一直是 `?`）。先收集 `user/message` 的
  // id，主循环里丢弃同 id 的副本——与实时路径同口径（spliced 的用户输入由本地回显覆盖，不重复显示）
  // 「消息先落库、回合后开始」：宿主把用户输入记成**不带 turn** 的 `user/message`，紧随其后
  // 才发 `turn/start`。若按 `curTurn` 兜底，用户块会挂到**上一个**回合号上，它对应的
  // `turn/end` 永远匹配不上 → 恢复出来一直是 `?`（条目 27 真机现象）。故：紧跟在
  // `turn/end`（或会话开头）之后的无 turn 用户消息，归给**下一个** `turn/start` 的回合号。
  const pendingUsers: number[] = [];
  let awaitingTurnStart = true;
  const userIds = new Set<string>();
  /** 已在正文里出过的用户输入正文（spliced 副本换 id 重发时的兜底去重，见下） */
  const userTexts = new Set<string>();
  /** 人工输入行（`source.kind === "user"`）在 `out` 里的下标：终态回填优先给它们 */
  const humanUsers: number[] = [];
  for (const e of events) {
    if (e.type !== "user/message") continue;
    const data = e.data as { id?: unknown; content?: unknown } | undefined;
    if (typeof data?.id === "string") userIds.add(data.id);
    const text = extractTextBlocks(data?.content).trim();
    if (text !== "") userTexts.add(text);
  }
  for (const e of events) {
    const data = e.data as Record<string, unknown> | undefined;
    if (!data) continue;
    /** 本事件自带的回合号（缺省 undefined）——消息各用自己事件的号，避免迟到事件串号 */
    const ownTurn = typeof data.turn === "number" ? data.turn : undefined;
    // 宿主回合号逐层保留（恢复路径真回合号的来源；缺省保持上一个已知值）
    if (ownTurn !== undefined) {
      // 回合号**不后退**（BACKLOG #20 真机实测：长工具的迟到结果带着原回合号到达，
      // 归一化输出因此出现 10→2 / 35→13 之类回退，重放时把分隔线号搅乱）。
      // `curTurn` 只作「事件不带号」时的兜底，且只增不减
      curTurn = curTurn === undefined || ownTurn > curTurn ? ownTurn : curTurn;
      if (e.type === "turn/start") {
        awaitingTurnStart = false;
        for (const idx of pendingUsers) {
          const m = out[idx];
          if (m !== undefined) out[idx] = { ...m, turn: curTurn };
        }
        pendingUsers.length = 0;
      }
    }
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
      // 失败判定与 live 同口径（结构化 error 或 message.isError）
      const failed = toolResultFailed(data);
      out.push({
        role: "tool",
        text: toolResultLine(
          !failed,
          toolResultDetail(data.message),
          data.meta,
        ),
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
      awaitingTurnStart = true;
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
      else {
        pushText("user", extractTextBlocks(data.content));
        if (awaitingTurnStart) pendingUsers.push(out.length - 1);
        // 人工输入（宿主 `source.kind === "user"`）：终态回填时优先给它，别让注入块抢走
        if ((data.source as { kind?: unknown } | undefined)?.kind === "user")
          humanUsers.push(out.length - 1);
      }
    } else if (e.type === "llm/retry") {
      // 辅助行还原（BACKLOG #23①）：live 口径是 notice（`state.ts` 的 retry toast），
      // 文本形制与 live 完全一致
      const r = data as {
        retry?: number;
        maxRetries?: number;
        delayMs?: number;
        failure?: { code?: string; message?: string };
      };
      out.push({
        role: "notice",
        text:
          `重试 ${r.retry ?? 0}/${r.maxRetries ?? 0} (${((r.delayMs ?? 0) / 1000).toFixed(1)}s): ${r.failure?.code ?? ""}` +
          (r.failure?.message ? " " + r.failure.message : ""),
        ...(curTurn === undefined ? {} : { turn: curTurn }),
      });
    } else if (e.type === "llm/retry-started") {
      // 启动行（↻ 灰行）：live 口径是 tool 行（`appendToolLine(..., "log")`）
      const r = data as { retry?: number };
      out.push({
        role: "tool",
        text: retryStartedLine(r.retry ?? 0),
        ...(curTurn === undefined ? {} : { turn: curTurn }),
      });
    } else if (e.type === "assistant/message") {
      const msg = data.message as Record<string, unknown> | undefined;
      pushText("assistant", extractTextBlocks(msg?.content));
    } else if (e.type === "agent/inbox/spliced") {
      // steer 认领（BACKLOG #23②）：step 边界摘除排队项 = 上一条用户输入被续接 →
      // 打 `steerContinued`（渲染永久 `←`）。判据与实时路径发 `inbox-claim` 的同一条。
      if (
        typeof data.removedCount === "number" &&
        data.removedCount > 0 &&
        data.target === "next-step"
      ) {
        for (let i = out.length - 1; i >= 0; i--) {
          const m = out[i]!;
          if (!isUserMessage(m.role)) continue;
          out[i] = { ...m, steerContinued: true };
          break;
        }
      }
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
        if (isUserMessage(role) && typeof id === "string" && userIds.has(id))
          continue;
        // 同一句话可能被宿主**换一个 id** 再 splice 一次（真机实测：排队中的输入重发 →
        // 两条 spliced 事件 id 不同、正文相同，而其中一条永远等不到 `turn/end`）→ 画面上
        // 多出一个恒 `?` 的重块。正文与某条 `user/message` 完全相同也丢弃；真的重复发送
        // 同一句话不受影响（那两次各自都有 `user/message` 正文行，丢的只是 spliced 副本）。
        if (isUserMessage(role)) {
          const text = extractTextBlocks(item.content).trim();
          if (text !== "" && userTexts.has(text)) continue;
        }
        pushText(role, extractTextBlocks(item.content));
        if (
          isUserMessage(role) &&
          isUserMessage((item.source as { kind?: unknown } | undefined)?.kind)
        )
          humanUsers.push(out.length - 1);
      }
    }
  }
  flushStep(); // 末尾收口（最后一步可能没有 step/end）
  // 回填用户块终态：`turn/end` 在用户消息之后到达，故按回合号回溯该回合的用户块。
  // **优先人工输入**：宿主把注入（rule-engine / system-reminder / goal 回合 / 子代理结果…）
  // 也记成 user 行，它们常排在人工输入之后——按「最后一个用户块」落符号会让注入块把符号
  // 抢走、人工输入留 `?`（真机实例：用户中途发的一条指令显示 `?`，同回合的人工输入反而没有
  // 符号）。找不到人工输入才退回「最后一个用户块」。
  for (const [turn, status] of turnStatus) {
    let at = -1;
    for (const index of humanUsers) {
      const m = out[index];
      if (m !== undefined && isUserMessage(m.role) && m.turn === turn)
        at = index;
    }
    if (at < 0) {
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i]!;
        if (!isUserMessage(m.role) || m.turn !== turn) continue;
        at = i;
        break;
      }
    }
    if (at < 0) continue;
    const m = out[at]!;
    // 已有终态不覆盖：回合号缺失时 `curTurn` 沿用上一个已知值，同一条 `turn/end` 会挂到
    // 已标过的用户块上（截断 / 旧格式日志），覆盖会把先前正确的符号改错
    if (m.status === undefined) out[at] = { ...m, status };
  }
  return out;
}

/** 状态列 Agents 块「工作内容」：`name 参数摘要`（截 ≤40 字符；空参数只留 name） */
export function workSummary(name: string, args: unknown): string {
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
export function toolResultCallId(message: unknown): string | undefined {
  const id = (message as { callId?: unknown } | undefined)?.callId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/**
 * tool/result.message（ToolResultMessage.content=[ToolResultBlock]）→ 首段文本：
 * 取内层第一个 text 块首行（v1 足够）；形状不符/空 → ""。
 */
/** 工具结果是否失败：结构化 `error`，或真机形态的 `message.isError` 任一成立 */
export function toolResultFailed(data: Record<string, unknown>): boolean {
  if (data.error !== undefined) return true;
  return (data.message as { isError?: unknown } | undefined)?.isError === true;
}

export function toolResultDetail(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  for (const block of content as unknown[]) {
    const flat = block as Record<string, unknown> | undefined;
    // 真机形态：`message.content = [{ type: "text", text }]`（扁平）——直接取首行
    if (
      flat?.type === "text" &&
      typeof flat["text"] === "string" &&
      flat["text"] !== ""
    ) {
      return (flat["text"] as string).split("\n")[0] ?? "";
    }
    const inner = flat?.content;
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
 *  interrupted / 未知）保持未定 → 渲染 `?`（与「已进会话区但未收到终态」同口径）。 */
export function turnEndReason(reason: unknown): TurnEndReason | undefined {
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
export function turnEndNotice(
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
export function collectJobs(
  rows: ReadonlyArray<Record<string, unknown>>,
): JobInfo[] {
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
 * 实际生效的等级（provider 级 reasoning 配置，如 max），与 TUI 状态行
 * 显示的「当前生效 effort」保持一致。非思考模型/服务缺失/解析失败 → undefined。
 * 宿主等级名首字母大写（Off/Low/High/Max），归一为全小写再展示。
 */
export async function resolveModelReasoning(
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
