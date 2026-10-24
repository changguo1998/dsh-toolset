/**
 * tool.ts — `consult_tools` 的定义与结果渲染（不直接接触宿主 API）。
 *
 * 工具只做三件事：检索、把命中项交给运行时去授权、把结果渲染成模型可读的
 * 短文本（名称 + 一句话 + 状态 / 名额），完整参数定义由宿主随下一次请求送达。
 */

import type { ResolvedConfig, RevealScope } from "./config.ts";
import type { Matcher } from "./matcher.ts";
import { oneLine } from "./matcher.ts";
import type { AgentGrants, GrantResult } from "./state.ts";

/** 咨询工具名（常驻可见，不参与遮罩）。 */
export const CONSULT_TOOL_NAME = "consult_tools";

/** 单次查询命中的展示上限（与配置 maxResults 取小）。 */
const HARD_LIMIT = 20;

/** 渲染与执行所需的运行时（由接线层按代理构造）。 */
export interface ConsultRuntime {
  matcher: Matcher;
  config: ResolvedConfig;
  grants: AgentGrants;
  /** 当前回合号（授权时间戳用）。 */
  currentTurn: () => number;
  /** 是否已在可见集（初始集 ∪ 已授权）。 */
  isVisible: (name: string) => boolean;
  /** 已授权的工具名（用于名额提示）。 */
  grantedNames: () => string[];
  /** 执行授权；返回每个名字的结果（未知名字由调用方过滤）。 */
  reveal: (
    names: string[],
    scope: RevealScope,
    pin: boolean,
  ) => Array<{ name: string; result: GrantResult }>;
}

/** 参数解析后的形态。 */
interface ParsedArgs {
  query: string | undefined;
  names: string[] | undefined;
  limit: number;
  reveal: boolean;
  scope: RevealScope;
  pin: boolean;
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
  const scope: RevealScope =
    args["scope"] === "turn" || args["scope"] === "session"
      ? args["scope"]
      : config.revealScope;
  return {
    query,
    names: names !== undefined && names.length > 0 ? names : undefined,
    limit,
    reveal: args["reveal"] !== false,
    scope,
    pin: args["pin"] === true,
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

/** 名额 / 容量提示。 */
function renderQuota(
  runtime: ConsultRuntime,
  scope: RevealScope,
  config: ResolvedConfig,
): string {
  if (scope === "session") {
    return `名额：session 档已揭示 ${runtime.grants.sessionCount()} / ${config.maxRevealed}（新增上限）。授权只增不减，本会话内不会收回。`;
  }
  return `容量：turn 档已揭示 ${runtime.grants.turnCount()} 项（钉住 ${runtime.grants.pinnedCount()} / ${config.maxPinned}）；turn 档不设新增上限，回合末按最久未用收敛，闲置超 TTL 也会收回。`;
}

/** 单条揭示结果的一行。 */
function describeResult(
  runtime: ConsultRuntime,
  name: string,
  result: GrantResult,
): string {
  const doc = runtime.matcher.get(name);
  const summary = doc === undefined ? "（无描述）" : oneLine(doc.description);
  const tags: string[] = [];
  if (result.pinApplied) tags.push("已钉住");
  if (result.pinIgnored === "pinned-full")
    tags.push("钉住名额已满，按普通揭示处理");
  if (result.pinIgnored === "session-scope")
    tags.push("pin 仅 turn 档生效，本次忽略");
  const suffix = tags.length > 0 ? ` [${tags.join("；")}]` : "";
  return `- ${name}：${summary}${suffix}`;
}

/** 已可见项的提示行。 */
function describeVisible(runtime: ConsultRuntime, name: string): string {
  const doc = runtime.matcher.get(name);
  const summary = doc === undefined ? "" : `：${oneLine(doc.description)}`;
  return `- ${name}${summary}（已在可见集，直接调用即可）`;
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
    "按用途查找并揭示工具：用一句话描述要做什么（中英文均可），返回匹配工具的名称与一句话简述，",
    "并让它们在当前会话可见（下一次请求起可调用）。",
    "已可见的工具不会重复计数。揭示两档可配：session（缺省，会话内一直可见）与 turn（仅本回合，回合末收敛）；",
    "可用 scope 逐次覆盖、pin（仅 turn 档）钉住少数跨回合仍要用的工具。",
    "当你不确定某个能力是否存在、或记得名字但看不到它时，先用本工具咨询，不要凭记忆调用未揭示的工具。",
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
          description: "false = 只预览，不改变可见性（缺省 true）",
        },
        scope: {
          type: "string",
          enum: ["session", "turn"],
          description: "逐次覆盖揭示作用域：session 会话内有效 / turn 仅本回合",
        },
        pin: {
          type: "boolean",
          description: "仅 turn 档生效：钉住本次揭示项，不参与回合末收敛",
        },
      },
      additionalProperties: false,
    },
    async execute(rawArgs: Record<string, unknown>): Promise<unknown> {
      const args = parseArgs(rawArgs ?? {}, runtime.config);
      const sections: string[] = [];
      const granted: string[] = [];
      const notices: string[] = [];
      /** 查询命中项是否全部已可见（决定是否打「都已在可见集中」抬头）。 */
      let allHitsVisible = false;

      if (args.names !== undefined) {
        for (const name of args.names) {
          // 可见性先判：`consult_tools` 自身不在检索索引里（刻意排除），但它常驻可见，
          // 先判未知会把它错报成「不在当前工具面里」。
          if (runtime.isVisible(name)) {
            sections.push(describeVisible(runtime, name));
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
          const [outcome] = runtime.reveal([name], args.scope, args.pin);
          if (outcome === undefined) continue;
          if (outcome.result.status === "rejected-cap") {
            notices.push("cap");
            continue;
          }
          granted.push(describeResult(runtime, name, outcome.result));
        }
      } else if (args.query !== undefined) {
        const hits = runtime.matcher.search(args.query, args.limit);
        if (hits.length === 0) {
          return {
            text: `${renderGroups(runtime.matcher)}\n\n${renderQuota(runtime, args.scope, runtime.config)}`,
          };
        }
        const fresh: string[] = [];
        let visibleHits = 0;
        for (const hit of hits) {
          if (runtime.isVisible(hit.name)) {
            visibleHits += 1;
            sections.push(describeVisible(runtime, hit.name));
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
          for (const outcome of runtime.reveal(fresh, args.scope, args.pin)) {
            if (outcome.result.status === "rejected-cap") {
              notices.push("cap");
              continue;
            }
            granted.push(describeResult(runtime, outcome.name, outcome.result));
          }
        }
        allHitsVisible = hits.length > 0 && visibleHits === hits.length;
      }

      const lines: string[] = [];
      if (allHitsVisible) {
        // 全部命中项都已可见（预览模式下命中集可能含未揭示项，故不能只看 granted）。
        lines.push("命中的工具都已在可见集中，直接调用即可。");
      }
      if (granted.length > 0) {
        const header =
          args.scope === "session"
            ? "已揭示（本会话内持续可见，下一次请求起可调用）："
            : "已揭示（仅本回合有效，下一次请求起可调用）：";
        lines.push(header, ...granted);
      }
      if (sections.length > 0) {
        if (lines.length > 0) lines.push("");
        lines.push(...sections);
      }
      if (notices.includes("cap")) {
        if (lines.length > 0) lines.push("");
        lines.push(
          `已达新增揭示上限（${runtime.config.maxRevealed} / ${runtime.config.maxRevealed}），本次未揭示新工具。`,
          '已授权的工具不受影响；如确需更多，可逐次改用 scope: "turn" 揭示，或结束会话重开。',
        );
      }
      if (notices.some((item) => item !== "cap")) {
        if (lines.length > 0) lines.push("");
        lines.push(...notices.filter((item) => item !== "cap"));
      }
      if (lines.length === 0) lines.push(renderGroups(runtime.matcher));
      lines.push("", renderQuota(runtime, args.scope, runtime.config));
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
