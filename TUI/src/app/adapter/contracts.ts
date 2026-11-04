// TUI/src/app/adapter/contracts.ts — Done-when 契约与群组状态的文本面

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

/** task 树先序展平（行归一化用；children 自左向右，与 engine.nested() 同序） */
type FlatTask = {
  id: string;
  title: string;
  status: string;
  needDecompose: boolean;
  depth: number;
};

export function flattenTasks(tasks: readonly TaskEngineTaskLike[]): FlatTask[] {
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
export function findTask(
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

/** 群组状态文本（notice 展示）：带组名 → 单组详情（≤4 行：组头/成员/连接/指令计数）；
 *  无组名 → 首行计数 + 每组一行紧凑摘要（成员 + 指令 进行中/成功/失败/阻塞/超时）。
 *  行数受 notice 多行视口前 4 行约束；空白组集返回「无群组」单行。 */
export function groupStatusText(
  groups: readonly { name: string; view: AgentGroupViewLike }[],
  groupName?: string,
): string {
  if (groups.length === 0) {
    return "当前会话无群组";
  }
  if (groupName !== undefined) {
    const view = groups[0]!.view;
    const s = view.summary;
    const date = new Date(view.createdAt).toISOString().slice(0, 10);
    const members = view.members
      .map((m) => (m.role === "manager" ? `${m.name}(管理)` : m.name))
      .join(" ");
    return [
      `群组 ${view.name} · 建组 ${date}`,
      `成员 ${view.members.length}：${members}`,
      `连接 主从 ${view.links.length} · 平等 ${view.peerLinks.length}`,
      `指令 进行中 ${s.open} · 成功 ${s.success} · 失败 ${s.failure} · 阻塞 ${s.blocked} · 超时 ${s.timeout}`,
    ].join("\n");
  }
  const lines = [`群组状态（当前会话）：${groups.length} 个群组`];
  for (const g of groups) {
    const s = g.view.summary;
    lines.push(
      `  ${g.name}：成员 ${s.members} · 指令 进行中 ${s.open} · 成功 ${s.success} · 失败 ${s.failure} · 阻塞 ${s.blocked} · 超时 ${s.timeout}`,
    );
  }
  return lines.join("\n");
}
