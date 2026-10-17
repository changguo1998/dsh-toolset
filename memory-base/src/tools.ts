/**
 * 模型侧查询工具 `memory_query`（只读，决策项 10）：
 * - 单工具 + `action` 分派：`"search"`（全文检索，缺省）/ `"list"`（结构化列举）；
 * - 参数：`query`（search 必填）、`kind?`、`tier?`、`project?`、`limit?`（缺省 10、clamp 1..100）、
 *   `fuzzy?`（仅 search）、`offset?`（仅 list）；
 * - 输出：带 `kind` / `tier` 标签的结构化行 + 渲染文本；超限截断并在结果里标明；
 * - 安全面：参数里没有文件路径与命令文本，故不进 `security-guard` 的登记表；
 *   写侧不对模型开放（写权限留在各扩展的句柄上）。
 */

import type { SearchHit, StoreRow } from "./knowledge.ts";
import type { Tier } from "./router.ts";

/** 渲染行上限（与 `limit` 的 clamp 上限一致）。 */
export const RENDER_LIMIT = 100;

/** 缺省行数（与全局面 `list` / `search` 的缺省一致）。 */
export const DEFAULT_LIMIT = 10;

/** 单行正文的渲染长度上限（超出截断并标注）。 */
export const CONTENT_RENDER_CHARS = 300;

/** 工具执行面（由 bundle 注入；测试可直接给替身）。 */
export interface MemoryQueryExecutor {
  list(opts: {
    kind?: string;
    tier?: Tier;
    project?: string;
    limit?: number;
    offset?: number;
  }): Promise<StoreRow[]>;
  search(opts: {
    query: string;
    kind?: string;
    tier?: Tier;
    project?: string;
    limit?: number;
    fuzzy?: boolean;
  }): Promise<SearchHit[]>;
}

/** 工具返回值（`output.schema` 与 `render` 共用）。 */
export interface MemoryQueryResult {
  action: "search" | "list";
  count: number;
  /** 实际生效的行数上限（clamp 后的值）。 */
  limit: number;
  /** 命中达到上限（结果可能被截断）。 */
  truncated: boolean;
  items: StoreRow[];
  error?: string;
}

/** 参数读取（JSON 值 → 目标类型；非法值按缺省处理，不抛）。 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asTier(value: unknown): Tier | undefined {
  return value === "session" || value === "project" || value === "user"
    ? value
    : undefined;
}

function asInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}

/** 单行渲染：`[kind@tier] title` + 首行正文 + `importance` / 时间；长正文截断标注。 */
function renderItem(row: StoreRow): string {
  const flat = row.content.replace(/\s+/g, " ").trim();
  const body =
    flat.length <= CONTENT_RENDER_CHARS
      ? flat
      : `${flat.slice(0, CONTENT_RENDER_CHARS)}…（正文已截断）`;
  const head = row.title === null ? "" : ` ${row.title}`;
  const when = new Date(row.createdAt)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  return `[${row.kind}@${row.tier}]${head}\n  ${body}\n  importance=${row.importance} id=${row.id} ${when}`;
}

/** 渲染整份结果（空结果与截断都有明确标注）。 */
export function renderQueryResult(result: MemoryQueryResult): string {
  if (result.error !== undefined) return `memory_query 失败：${result.error}`;
  if (result.items.length === 0) {
    return result.action === "search" ? "(无命中)" : "(无条目)";
  }
  const head = `${result.action}：${result.items.length} 条（limit=${result.limit}${result.truncated ? "，已截断" : ""}）`;
  return [head, ...result.items.map(renderItem)].join("\n");
}

/** `memory_query` 工具定义（宿主 `ctx.tools.register()` 的入参）。 */
export function memoryQueryTool(executor: MemoryQueryExecutor): unknown {
  return {
    name: "memory_query",
    description:
      "只读查询跨会话记忆库（跨全部扩展的 kind，按层 / 项目过滤）。" +
      "action=search（缺省）做全文检索（porter 词干 + CJK 子串兜底）；action=list 按 kind 结构化列举。" +
      "选择成本：知道要查什么用 search，要「某类记忆都写了什么」用 list；" +
      "结果多时用 kind / tier / project / limit 收窄（缺省 10 行，上限 100）；" +
      "只读——写入与删除只经各扩展持有的句柄，本工具不提供写面。",
    parameters: {
      type: "object",
      additionalProperties: true,
      properties: {
        action: {
          type: "string",
          enum: ["search", "list"],
          description: "search=全文检索（缺省）；list=按 kind 列举",
        },
        query: {
          type: "string",
          description: "search 用（必填）：检索词",
        },
        kind: {
          type: "string",
          description: "收窄到单个扩展的分类（缺省跨全部已注册 kind）",
        },
        tier: {
          type: "string",
          enum: ["session", "project", "user"],
          description: "收窄到单个层（缺省全部层）",
        },
        project: {
          type: "string",
          description: "收窄到单个项目键",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "返回行数上限（缺省 10，clamp 1..100）",
        },
        fuzzy: {
          type: "boolean",
          description:
            "search 用：叠加 trigram 子串召回（无法召回 <3 字符的串）",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "list 用：分页偏移",
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<MemoryQueryResult> {
      const action = args.action === "list" ? "list" : "search";
      const limit = Math.max(
        1,
        Math.min(asInt(args.limit) ?? DEFAULT_LIMIT, RENDER_LIMIT),
      );
      const kind = asString(args.kind);
      const tier = asTier(args.tier);
      const project = asString(args.project);
      if (action === "list") {
        const items = await executor.list({
          ...(kind === undefined ? {} : { kind }),
          ...(tier === undefined ? {} : { tier }),
          ...(project === undefined ? {} : { project }),
          limit,
          offset: Math.max(0, asInt(args.offset) ?? 0),
        });
        return {
          action,
          count: items.length,
          limit,
          truncated: items.length >= limit,
          items,
        };
      }
      const query = asString(args.query);
      if (query === undefined) {
        return {
          action,
          count: 0,
          limit,
          truncated: false,
          items: [],
          error: "action=search 需要 query",
        };
      }
      const items = await executor.search({
        query,
        ...(kind === undefined ? {} : { kind }),
        ...(tier === undefined ? {} : { tier }),
        ...(project === undefined ? {} : { project }),
        limit,
        ...(args.fuzzy === true ? { fuzzy: true } : {}),
      });
      return {
        action,
        count: items.length,
        limit,
        truncated: items.length >= limit,
        items,
      };
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          action: { type: "string", enum: ["search", "list"] },
          count: { type: "integer" },
          limit: { type: "integer" },
          truncated: { type: "boolean" },
          items: { type: "array", items: { type: "object" } },
          error: { type: "string" },
        },
      },
      render: (
        _args: unknown,
        value: unknown,
      ): Array<{ type: string; text: string }> => {
        const result =
          value !== null && typeof value === "object"
            ? (value as Partial<MemoryQueryResult>)
            : {};
        return [
          {
            type: "text",
            text: renderQueryResult({
              action: result.action === "list" ? "list" : "search",
              count: typeof result.count === "number" ? result.count : 0,
              limit:
                typeof result.limit === "number" ? result.limit : DEFAULT_LIMIT,
              truncated: result.truncated === true,
              items: Array.isArray(result.items) ? result.items : [],
              ...(typeof result.error === "string"
                ? { error: result.error }
                : {}),
            }),
          },
        ];
      },
    },
  };
}
