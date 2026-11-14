/**
 * tool.ts — `consult_tools` 的定义与结果渲染（不直接接触宿主 API）。
 *
 * 工具只做三件事：检索、把命中项交给运行时去授权、把结果渲染成模型可读的
 * 短文本（名称 + 一句话 + 已揭示数）。完整说明与完整参数 schema 由 pinNotes
 * 按工具投递，不改变工具声明。
 */

import type { ResolvedConfig } from "./config.ts";
import type { Matcher } from "./matcher.ts";
import { oneLine } from "./matcher.ts";
import type { GrantResult } from "./state.ts";

/** 咨询工具名（常驻可见，不参与遮罩）。 */
export const CONSULT_TOOL_NAME = "consult_tools";

/** 单次查询命中的展示上限（与配置 maxResults 取小）。 */
const HARD_LIMIT = 20;

/** 渲染与执行所需的运行时（由接线层按代理构造）。 */
export interface ConsultRuntime {
  matcher: Matcher;
  config: ResolvedConfig;
  /** 是否可调用（初始集或本会话已揭示；denied 恒 false）。 */
  isCallable: (name: string) => boolean;
  /** 是否初始集成员（用于结果文案）。 */
  isInitial: (name: string) => boolean;
  /** 已揭示的工具名。 */
  grantedNames: () => string[];
  /** 执行授权；只接受当前可揭示的名字。 */
  reveal: (names: string[]) => Array<{ name: string; result: GrantResult }>;
}

/** 参数解析后的形态。 */
interface ParsedArgs {
  query: string | undefined;
  names: string[] | undefined;
  limit: number;
  reveal: boolean;
}

/** 归一化入参（非法值回退，不抛错）。 */
function parseArgs(
  args: Record<string, unknown>,
  config: ResolvedConfig,
): ParsedArgs {
  const query =
    typeof args["query"] === "string" && args["query"].trim().length > 0
      ? args["query"].trim()
      : undefined;
  const names = Array.isArray(args["names"])
    ? args["names"].filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : undefined;
  const rawLimit =
    typeof args["limit"] === "number"
      ? Math.floor(args["limit"])
      : config.maxResults;
  const limit = Math.min(HARD_LIMIT, config.maxResults, Math.max(1, rawLimit));
  return {
    query,
    names: names !== undefined && names.length > 0 ? names : undefined,
    limit,
    reveal: args["reveal"] !== false,
  };
}

/** 名称分组回退文本（无匹配时给名字索引，不给描述）。 */
function renderGroups(matcher: Matcher): string {
  const groups = matcher.nameGroups();
  if (groups.length === 0) return "当前没有可咨询的工具（工具面为空）。";
  const lines = groups.map(
    (group) =>
      `- ${group.prefix}（${group.names.length}）：${group.names.join(", ")}`,
  );
  return [
    "没有匹配的工具。可用的工具分组：",
    ...lines,
    "",
    "请换更宽泛的词，或用 names 精确指定。",
  ].join("\n");
}

/** 配额提示：只报已揭示数量，会话内只增不减。 */
function renderQuota(runtime: ConsultRuntime): string {
  return `本会话已揭示 ${runtime.grantedNames().length} 项（会话内只增不减，不设上限）。`;
}

/** 单条揭示结果的一行。 */
function describeResult(
  runtime: ConsultRuntime,
  name: string,
  result: GrantResult,
): string {
  const doc = runtime.matcher.get(name);
  const summary = doc === undefined ? "（无描述）" : oneLine(doc.description);
  const suffix = result.granted ? "" : "（此前已揭示）";
  return `- ${name}：${summary}${suffix}`;
}

/** 已可调用项的提示行。 */
function describeCallable(runtime: ConsultRuntime, name: string): string {
  const doc = runtime.matcher.get(name);
  const summary = doc === undefined ? "" : `：${oneLine(doc.description)}`;
  if (name === CONSULT_TOOL_NAME) {
    return `- ${name}${summary}（查询入口，直接调用即可）`;
  }
  const where = runtime.isInitial(name) ? "已在初始工具面" : "已在本会话揭示";
  return `- ${name}${summary}（${where}，直接调用即可）`;
}

/**
 * 创建咨询工具定义。
 * @param runtime 按代理构造的运行时。
 * @returns 宿主可注册的工具定义（结构类型）。
 */
export function createConsultTool(runtime: ConsultRuntime): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (
      args: unknown,
      value: unknown,
    ) => Array<{ type: string; text: string }>;
  };
} {
  const description = [
    "用途: 按用途查找并揭示工具, 用一句话描述要做什么(中英文均可), 返回匹配工具的名称与一句话简述并让它们在本会话可调用。\n",
    "用法: query 与 names 二选一; limit 控制返回数量; reveal=false 只预览, 不写授权。\n",
    "效果: 咨询即授权, 调用本工具本身就等于允许这些工具在本会话被揭示, 无需另行确认; 揭示只增不减, 已揭示的工具不会被本工具收回; 完整说明与参数 schema 在揭示后按工具投递。\n",
    "边界: 授权在本会话内有效; 初始工具面已可调用, 无需咨询; 不确定某个能力是否存在、或记得名字但在当前工具面看不到它时, 先用本工具咨询。\n",
  ].join("");

  return {
    name: CONSULT_TOOL_NAME,
    description,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "自然语言描述要做什么（中英文均可），与 names 二选一",
        },
        names: {
          type: "array",
          items: { type: "string" },
          description: "直接按名揭示（跳过检索），与 query 二选一",
        },
        limit: {
          type: "number",
          description: "匹配返回数量，1 至 20，缺省取插件配置",
        },
        reveal: {
          type: "boolean",
          description: "false = 只预览，不写授权（缺省 true）",
        },
      },
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<unknown> {
      const args = parseArgs(rawArgs ?? {}, runtime.config);
      const sections: string[] = [];
      const granted: string[] = [];
      const notices: string[] = [];
      /** 查询命中项是否全部已可调用（决定是否打「都已在工具面」抬头）。 */
      let allHitsCallable = false;

      if (args.names !== undefined) {
        for (const name of args.names) {
          // 可调用性先判：`consult_tools` 自身不在检索索引里，但它常驻可见。
          if (runtime.isCallable(name)) {
            sections.push(describeCallable(runtime, name));
            continue;
          }
          if (runtime.matcher.get(name) === undefined) {
            notices.push(`- ${name}：未知工具（不在当前工具面里）`);
            continue;
          }
          if (!args.reveal) {
            const doc = runtime.matcher.get(name);
            sections.push(
              `- ${name}：${doc === undefined ? "" : oneLine(doc.description)}（预览，未揭示）`,
            );
            continue;
          }
          const [outcome] = runtime.reveal([name]);
          if (outcome === undefined) continue;
          granted.push(describeResult(runtime, name, outcome.result));
        }
      } else if (args.query !== undefined) {
        const hits = runtime.matcher.search(args.query, args.limit);
        if (hits.length === 0) {
          return {
            text: `${renderGroups(runtime.matcher)}\n\n${renderQuota(runtime)}`,
          };
        }
        const fresh: string[] = [];
        let callableHits = 0;
        for (const hit of hits) {
          if (runtime.isCallable(hit.name)) {
            callableHits += 1;
            sections.push(describeCallable(runtime, hit.name));
            continue;
          }
          if (!args.reveal) {
            const doc = runtime.matcher.get(hit.name);
            sections.push(
              `- ${hit.name}：${doc === undefined ? "" : oneLine(doc.description)}（预览，未揭示）`,
            );
            continue;
          }
          fresh.push(hit.name);
        }
        if (fresh.length > 0) {
          for (const outcome of runtime.reveal(fresh)) {
            granted.push(describeResult(runtime, outcome.name, outcome.result));
          }
        }
        allHitsCallable = hits.length > 0 && callableHits === hits.length;
      }

      const lines: string[] = [];
      if (allHitsCallable) {
        lines.push("命中的工具都已在工具面中，直接调用即可。");
      }
      if (granted.length > 0) {
        lines.push(
          "已揭示（本会话内有效，下一次请求起可调用；完整说明与参数 schema 随后投递）：",
          ...granted,
        );
      }
      if (sections.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(...sections);
      }
      if (notices.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(...notices);
      }
      if (lines.length === 0) lines.push(renderGroups(runtime.matcher));
      lines.push("", renderQuota(runtime));
      return { text: lines.join("\n") };
    },
    output: {
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      render: (
        _args: unknown,
        value: unknown,
      ): Array<{ type: string; text: string }> => {
        const record = value as { text?: unknown } | undefined;
        const text =
          typeof record?.text === "string" ? record.text : String(value);
        return [{ type: "text", text }];
      },
    },
  };
}
