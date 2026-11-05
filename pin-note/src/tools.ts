/**
 * pin-note/src/tools.ts — 模型侧工具 `pin_note` / `note_list` / `note_remove`。
 *
 * memory-base 不注册模型侧写工具（模型只有只读 `memory_query`），故写通道必须由本插件提供；
 * 参数是纯文本，不进 `security-guard` 的登记表（同 `memory_query` 口径）。
 */

import { MIN_CONTENT_CHARS, sizeHint, type PinStore } from "./store.ts";

/** 工具定义（宿主 `tools.register` 的最小形态，与 `background-daemon` 一致）。 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    exec?: unknown,
  ): Promise<Record<string, unknown>>;
  output: {
    schema: Record<string, unknown>;
    render: (
      args: unknown,
      value: unknown,
    ) => Array<{ type: string; text: string }>;
  };
}

/** 工具描述与注入引导共用的口径（决策项 3：不做硬限制，给软提示）。 */
export const GUIDANCE =
  "只保留大致思路、用户的风格要求这类要点, 不贴大段原文；建议总量 < 10K 字符。";

/** 列表里的内容摘录长度。 */
const EXCERPT_CHARS = 200;

/** 从宿主 `exec` 取调用方会话 id（`exec.agent.session.id`，兼容 `exec.session`）。 */
export function callerSessionId(exec: unknown): string | undefined {
  const agent = (exec as { agent?: { session?: unknown } } | undefined)?.agent;
  const direct = (exec as { session?: unknown } | undefined)?.session;
  const session = (agent?.session ?? direct) as { id?: unknown } | undefined;
  const id = session?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 统一的输出面（结构化值 + JSON 文本渲染）。 */
const OUTPUT: ToolDef["output"] = {
  schema: { type: "object", additionalProperties: true, properties: {} },
  render: (_args: unknown, value: unknown) => [
    { type: "text", text: jsonText(value) },
  ],
};

/** 缺会话 id 时的统一回执（不抛未捕获异常）。 */
const NO_SESSION = {
  ok: false,
  error: "no_session",
  message: "取不到调用方会话 id（工具要在会话内调用）, 本次未登记 / 未查询",
};

/** 登记一条保持项。 */
function pinNoteTool(store: PinStore): ToolDef {
  return {
    name: "pin_note",
    description:
      "用途: 把要点登记为「跨压缩保持」——登记后每一轮都会出现在模型可见上下文, 手动压缩后依然在场。\n" +
      `用法: 给 content（要点正文, 至少 ${MIN_CONTENT_CHARS} 字）与可选 title；返回新 id 与当前条数与合计字数。\n` +
      "效果: 落本会话记忆库（会话层）, 随会话结束失效。\n" +
      `边界: ${GUIDANCE}\n` +
      "相关: note_list、note_remove、memory_query。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: {
          type: "string",
          description:
            "要一直保持的要点正文（大致思路 / 用户的风格要求 / 不能忘的约束）；过短会被拒绝",
        },
        title: {
          type: "string",
          description: "短标题（缺省用序号）, 便于后续按标题辨认",
        },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = callerSessionId(exec);
      if (sessionId === undefined) return { ...NO_SESSION };
      const content =
        typeof args["content"] === "string" ? args["content"] : "";
      const title =
        typeof args["title"] === "string" ? args["title"] : undefined;
      const result = await store.add(sessionId, content, title);
      if (!result.ok) {
        return { ok: false, error: result.reason, message: result.message };
      }
      const hint = sizeHint(result.totalChars);
      return {
        ok: true,
        id: result.id,
        total: result.total,
        totalChars: result.totalChars,
        ...(hint === undefined ? {} : { hint }),
      };
    },
  };
}

/** 列出本会话的保持项。 */
function noteListTool(store: PinStore): ToolDef {
  return {
    name: "note_list",
    description:
      "用途: 列出本会话已登记的全部「跨压缩保持项」。\n" +
      "用法: 无需参数；返回每条 id、标题、内容摘录与字数, 以及合计字数。\n" +
      "效果: 只读, 不改任何记录。\n" +
      "边界: 只看本会话（会话层）, 跨会话不共享；要删用 note_remove。\n" +
      "相关: pin_note、note_remove。",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    output: OUTPUT,
    async execute(_args, exec) {
      const sessionId = callerSessionId(exec);
      if (sessionId === undefined) return { ...NO_SESSION };
      const records = await store.list(sessionId);
      const totalChars = records.reduce(
        (sum, record) => sum + record.content.length,
        0,
      );
      const hint = sizeHint(totalChars);
      return {
        ok: true,
        count: records.length,
        totalChars,
        notes: records.map((record) => ({
          id: record.id,
          title: record.title,
          length: record.content.length,
          excerpt:
            record.content.length > EXCERPT_CHARS
              ? `${record.content.slice(0, EXCERPT_CHARS)}…`
              : record.content,
        })),
        ...(hint === undefined ? {} : { hint }),
      };
    },
  };
}

/** 删一条保持项。 */
function noteRemoveTool(store: PinStore): ToolDef {
  return {
    name: "note_remove",
    description:
      "用途: 删掉一条已登记的「跨压缩保持项」, 删后不再注入。\n" +
      "用法: 给 id（note_list 里列出的编号）；不存在时返回可读错误。\n" +
      "效果: 真删（会话层记忆库）, 下一轮起不再出现。\n" +
      "边界: 只能删本会话的条目；删完最后一条即不再注入。\n" +
      "相关: pin_note、note_list。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: {
          type: "integer",
          minimum: 1,
          description: "note_list 返回的条目 id",
        },
      },
    },
    output: OUTPUT,
    async execute(args, exec) {
      const sessionId = callerSessionId(exec);
      if (sessionId === undefined) return { ...NO_SESSION };
      const id = args["id"];
      if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
        return {
          ok: false,
          error: "invalid_id",
          message: "id 必须是正整数（用 note_list 查已登记的编号）",
        };
      }
      const removed = await store.remove(sessionId, id);
      return removed
        ? { ok: true, id }
        : {
            ok: false,
            error: "not_found",
            message: `本会话没有 id ${id} 的保持项（用 note_list 查已登记的编号）`,
          };
    },
  };
}

/** 本插件的三个工具（顺序即工具面展示顺序）。 */
export function noteTools(store: PinStore): ToolDef[] {
  return [pinNoteTool(store), noteListTool(store), noteRemoveTool(store)];
}
