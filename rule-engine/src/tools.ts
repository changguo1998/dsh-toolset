/**
 * 模型面工具族：`rule_add` / `rule_list` / `rule_update` / `rule_remove` / `rule_test`。
 *
 * 契约对齐 metric-loop：工具定义含 `name` / `description` / `parameters` / `execute` /
 * `output.schema` + `render`；execute 内任何异常转结构化错误（不向宿主抛），返回值 JSON 安全。
 * 增删改落运行时层（`~/.dsh/rule-engine/rules.json`），配置基线只读。
 */

import { predicateNames } from "./match.ts";
import { RULE_DELIVERIES, RULE_SOURCES } from "./rules.ts";
import type { RuleEngine } from "./engine.ts";
import type { RuleSource } from "./types.ts";

/** 工具定义（与 dsh tools.register 接受形态对齐）。 */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): unknown[];
  };
}

/** 注入正文参数说明（模型侧可读）。 */
const TEXT_PARAM = {
  type: "string",
  description: "命中后代替用户注入的正文（写清要模型做什么/遵守什么）",
} as const;

/** match 参数 schema。 */
const MATCH_SCHEMA = {
  type: "object",
  description:
    "命中条件；keywords / regex / predicates 之间是「任一档命中即命中」，predicates 内部为与关系。缺省仅对 turn-end 表示无条件命中",
  properties: {
    keywords: {
      type: "array",
      items: { type: "string" },
      description: "关键词（大小写不敏感，任一出现即命中）",
    },
    regex: {
      type: "array",
      items: { type: "string" },
      description: "正则源串（任一匹配即命中）",
    },
    flags: { type: "string", description: '正则 flags，缺省 "i"' },
    predicates: {
      type: "array",
      items: { type: "string", enum: predicateNames() },
      description: `内置谓词名（全部满足才命中）：${predicateNames().join(" / ")}`,
    },
  },
  additionalProperties: false,
} as const;

/** 规则公共参数（add 用；update 走 patch）。 */
const RULE_PARAMS = {
  id: { type: "string", description: "规则标识（唯一，两层合并与节流记账用）" },
  source: {
    type: "string",
    enum: [...RULE_SOURCES],
    description:
      "节点（匹配面），缺省 assistant-text：assistant-text 回合结束时对整回合正文判定 / user-message 用户消息落盘 / tool-call 工具调用 / tool-result 工具结果 / turn-start 回合开始 / turn-end 回合边界 / step-start、step-end 步边界 / session-start 会话建立（含恢复）/ compaction 上下文压缩完成（边界类节点文本为空，match 可省 = 无条件命中）",
  },
  delivery: {
    type: "string",
    enum: [...RULE_DELIVERIES],
    description:
      "注入送达路径，缺省 followup：followup=作为独立新回合（agent.followup）；steer=挂到最近 pre-step 并唤醒（agent.steer，空闲时立刻开新回合）；inject=挂到最近 pre-step 不唤醒（agent.inject，会话空闲时要等到下一条输入；宿主 rc.2+）",
  },
  match: MATCH_SCHEMA,
  text: TEXT_PARAM,
  summary: {
    type: "string",
    description: "一行摘要（宿主 notice 呈现用），缺省取正文首行截断",
  },
  description: { type: "string", description: "规则说明（仅展示）" },
  enabled: { type: "boolean", description: "是否启用，缺省 true" },
  cooldownTurns: {
    type: "number",
    description: "同一会话两次命中的最小回合间隔，缺省 0",
  },
  cooldownMs: {
    type: "number",
    description: "同一会话两次命中的最小毫秒间隔，缺省 0（不限制）",
  },
  dedupeInRecord: {
    type: "number",
    description:
      "按记录去重，缺省 0 = 无限制：会话可见投影里最多允许 N 条本注入（1 = 已有就跳过，重载不重复、被压缩挤出投影后才补；N≥2 = 允许最多 N 条）",
  },
} as const;

/** 输出契约：JSON 安全 + 文本渲染（与 metric-loop 一致）。 */
const OUTPUT = {
  schema: { type: "object", additionalProperties: true, properties: {} },
  render: (_args: unknown, value: unknown): unknown[] => [
    { type: "text", text: JSON.stringify(value, null, 2) },
  ],
} as const;

/** 从工具参数拼出规则对象（action 由 text/summary 组装）。 */
function ruleFromArgs(args: Record<string, unknown>): Record<string, unknown> {
  const action: Record<string, unknown> = {
    type: "inject",
    text: args["text"],
  };
  if (args["summary"] !== undefined) action["summary"] = args["summary"];
  const rule: Record<string, unknown> = { id: args["id"], action };
  for (const key of [
    "source",
    "delivery",
    "match",
    "description",
    "enabled",
    "cooldownTurns",
    "cooldownMs",
    "dedupeInRecord",
  ] as const) {
    if (args[key] !== undefined) rule[key] = args[key];
  }
  return rule;
}

/** 构造工具族（绑定到一个引擎实例）。 */
export function toToolDefs(engine: RuleEngine): ToolDef[] {
  const add: ToolDef = {
    name: "rule_add",
    description:
      "新增一条注入规则：命中条件（关键词/正则/内置谓词）成立时，代替用户向下一个回合注入一条 user-role 消息。" +
      "source=tool-call/tool-result 时命中即注入（落下一个回合）；assistant-text/turn-end 在回合结束时对整回合正文判定；compaction 在上下文压缩完成（compaction/end）时判定。" +
      "id 已存在会报错（改用 rule_update）。",
    parameters: {
      type: "object",
      properties: RULE_PARAMS,
      required: ["id", "text"],
    },
    async execute(args) {
      try {
        const result = engine.add(ruleFromArgs(args));
        return { ok: result.ok, error: result.error, rule: result.rule };
      } catch (err) {
        return {
          ok: false,
          error: String(err instanceof Error ? err.message : err),
        };
      }
    },
    output: OUTPUT,
  };

  const list: ToolDef = {
    name: "rule_list",
    description:
      "只读列出生效规则（配置基线 + 运行时层，含来源层 origin、送达路径 delivery 与节流参数）与引擎状态。",
    parameters: { type: "object", properties: {} },
    async execute() {
      try {
        return { ok: true, rules: engine.summaries(), status: engine.status() };
      } catch (err) {
        return {
          ok: false,
          error: String(err instanceof Error ? err.message : err),
        };
      }
    },
    output: OUTPUT,
  };

  const update: ToolDef = {
    name: "rule_update",
    description:
      "更新一条规则（浅合并 patch：可只改 text / match / cooldownTurns 等；action.text 用 patch.action.text 或 patch.text 均可）。" +
      "基线规则被更新后以运行时版本生效（原配置不改）。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "目标规则 id" },
        patch: {
          type: "object",
          description:
            "要覆盖的字段（text / summary / match / source / delivery / enabled / cooldownTurns / cooldownMs / dedupeInRecord / description / action）",
          properties: RULE_PARAMS,
          additionalProperties: false,
        },
      },
      required: ["id", "patch"],
    },
    async execute(args) {
      try {
        const patchRaw = args["patch"];
        const patch =
          patchRaw !== null &&
          typeof patchRaw === "object" &&
          !Array.isArray(patchRaw)
            ? { ...(patchRaw as Record<string, unknown>) }
            : patchRaw;
        // 便捷写法：patch.text / patch.summary 归入 action
        if (
          patch !== null &&
          typeof patch === "object" &&
          !Array.isArray(patch)
        ) {
          const p = patch as Record<string, unknown>;
          if (p["text"] !== undefined || p["summary"] !== undefined) {
            p["action"] = {
              ...(typeof p["action"] === "object" && p["action"] !== null
                ? (p["action"] as Record<string, unknown>)
                : {}),
              ...(p["text"] === undefined ? {} : { text: p["text"] }),
              ...(p["summary"] === undefined ? {} : { summary: p["summary"] }),
            };
            delete p["text"];
            delete p["summary"];
          }
        }
        const result = engine.update(String(args["id"] ?? ""), patch);
        return { ok: result.ok, error: result.error, rule: result.rule };
      } catch (err) {
        return {
          ok: false,
          error: String(err instanceof Error ? err.message : err),
        };
      }
    },
    output: OUTPUT,
  };

  const remove: ToolDef = {
    name: "rule_remove",
    description:
      "删除一条规则：运行时规则直接移除；配置基线规则记入运行时层的屏蔽列表（配置文件本身不改）。",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "要删除的规则 id" } },
      required: ["id"],
    },
    async execute(args) {
      try {
        const result = engine.remove(String(args["id"] ?? ""));
        return { ok: result.ok, error: result.error };
      } catch (err) {
        return {
          ok: false,
          error: String(err instanceof Error ? err.message : err),
        };
      }
    },
    output: OUTPUT,
  };

  const test: ToolDef = {
    name: "rule_test",
    description:
      "干跑：对给定文本按指定匹配面判定哪些规则会命中（不注入、不改状态），用于调试规则写法。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "待判定文本" },
        source: {
          type: "string",
          enum: [...RULE_SOURCES],
          description: "匹配面，缺省 assistant-text",
        },
      },
      required: ["text"],
    },
    async execute(args) {
      try {
        const text = typeof args["text"] === "string" ? args["text"] : "";
        const source =
          typeof args["source"] === "string"
            ? (args["source"] as RuleSource)
            : undefined;
        return {
          ok: true,
          ...engine.test({ text, ...(source === undefined ? {} : { source }) }),
        };
      } catch (err) {
        return {
          ok: false,
          error: String(err instanceof Error ? err.message : err),
        };
      }
    },
    output: OUTPUT,
  };

  return [add, list, update, remove, test];
}
