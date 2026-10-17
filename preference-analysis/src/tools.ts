/**
 * 模型侧工具面（设计 D12）：`preference_list` / `preference_add` / `preference_remove`。
 *
 * 边界：`preference_add` 一律落**候选待审**（不自动应用，设计 D8 附）；`preference_remove`
 * 的描述写明只在用户当次明确要求撤销时调用 —— 审阅权不交给模型。
 */
import type { LedgerEntry, LedgerStatus } from "./ledger.ts";

/** 工具返回的内容块（宿主 render 契约的最小形态）。 */
export interface ToolContentBlock {
  type: "text";
  text: string;
}

/** 工具定义（宿主 `ctx.tools.register` 的入参形态）。 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => ToolContentBlock[];
  };
}

/** 列表参数。 */
export interface PreferenceListOptions {
  status?: LedgerStatus;
  limit?: number;
}

/** 提议参数（模型只能给正文 / 项目 / 标题）。 */
export interface PreferenceAddInput {
  text: string;
  project?: string;
  title?: string;
}

/** 提议结果。 */
export interface PreferenceAddResult {
  ok: boolean;
  id?: string;
  status?: string;
  reason?: string;
}

/** 撤销结果。 */
export interface PreferenceRemoveResult {
  ok: boolean;
  reason?: string;
  removed?: number;
}

/** 工具实现依赖的最小能力面（由 main 提供；测试可用假实现）。 */
export interface PreferenceApi {
  list(opts?: PreferenceListOptions): Promise<LedgerEntry[]>;
  add(input: PreferenceAddInput): Promise<PreferenceAddResult>;
  remove(id: string): Promise<PreferenceRemoveResult>;
}

/** 三个工具的注册名。 */
export const TOOL_NAMES = [
  "preference_list",
  "preference_add",
  "preference_remove",
] as const;

const STATUSES: readonly LedgerStatus[] = [
  "observe",
  "candidate",
  "active",
  "dormant",
  "retired",
];

const LIST_DESCRIPTION =
  "列出偏好账簿条目（id / 正文 / 状态 / 证据数 / 跨会话数 / 重要度 / 最近证据时间）。" +
  "只读，不改任何状态；用户问「现在有哪些偏好」或确认某条是否存在时使用。状态：" +
  "observe（观察中）/ candidate（候选待审）/ active（生效并注入）/ dormant（休眠）/ retired（已退休）。";

const ADD_DESCRIPTION =
  "登记一条用户偏好建议。一律落候选待审（status = candidate），**不自动应用、不自动注入**；" +
  "仅在用户明确表达一条持久偏好（而不是一次性要求）时调用。正文写成用户可读的一句约束，" +
  "保留用户原话，不要自己概括成抽象规则。";

const REMOVE_DESCRIPTION =
  "撤销一条偏好（按 id）。**仅在用户当次明确要求撤销时调用**；撤销后该模式记入抑制键，" +
  "重放同一行为不会再被归纳出来。";

/** 构造三个工具定义。 */
export function createTools(api: PreferenceApi): ToolDef[] {
  return [
    {
      name: "preference_list",
      description: LIST_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...STATUSES],
            description: "只列指定状态；缺省列全部（含退休，便于核对）",
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "条数上限，缺省 20",
          },
        },
      },
      execute: async (args) => {
        const status = statusOf(args["status"]);
        const limit = positiveInt(args["limit"], 20);
        const entries = await api.list({
          ...(status === undefined ? {} : { status }),
          limit,
        });
        return {
          count: entries.length,
          entries: entries.map(rowOf),
        };
      },
      output: jsonOutput(),
    },
    {
      name: "preference_add",
      description: ADD_DESCRIPTION,
      parameters: {
        type: "object",
        required: ["text"],
        properties: {
          text: {
            type: "string",
            description: "偏好正文（用户原话片段，一句约束）",
          },
          project: {
            type: "string",
            description: "项目作用域（缺省取当前会话 cwd）",
          },
          title: {
            type: "string",
            description: "可选短标题",
          },
        },
      },
      execute: async (args) => {
        const text =
          typeof args["text"] === "string" ? args["text"].trim() : "";
        if (text.length === 0) {
          return { ok: false, reason: "text 不能为空" };
        }
        const project =
          typeof args["project"] === "string" ? args["project"] : undefined;
        const title =
          typeof args["title"] === "string" ? args["title"] : undefined;
        return api.add({
          text,
          ...(project === undefined ? {} : { project }),
          ...(title === undefined ? {} : { title }),
        });
      },
      output: jsonOutput(),
    },
    {
      name: "preference_remove",
      description: REMOVE_DESCRIPTION,
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            description: "偏好 id（preference_list 返回的 id）",
          },
        },
      },
      execute: async (args) => {
        const id = typeof args["id"] === "string" ? args["id"].trim() : "";
        if (id.length === 0) return { ok: false, reason: "id 不能为空" };
        return api.remove(id);
      },
      output: jsonOutput(),
    },
  ];
}

/** 工具行（模型可读、字段精简）。 */
function rowOf(entry: LedgerEntry): Record<string, unknown> {
  return {
    id: entry.id,
    text: entry.text,
    status: entry.status,
    evidence: entry.evidence,
    sessions: entry.sessions.length,
    origin: entry.origin,
    importance: entry.importance,
    lastSeen: new Date(entry.lastSeen).toISOString(),
    ...(entry.title === undefined ? {} : { title: entry.title }),
  };
}

function statusOf(value: unknown): LedgerStatus | undefined {
  return typeof value === "string" &&
    (STATUSES as readonly string[]).includes(value)
    ? (value as LedgerStatus)
    : undefined;
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.min(100, Math.floor(value));
}

function jsonOutput(): ToolDef["output"] {
  return {
    schema: { type: "object", additionalProperties: true, properties: {} },
    render: (_args, value) => [{ type: "text", text: jsonText(value) }],
  };
}

function jsonText(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  return typeof text === "string" ? text : String(value);
}
