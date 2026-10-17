/**
 * 判定核心的**纯函数**部分：拒绝名单 / 只读类 / 路径白名单 / 命令白名单 / 沙箱升级白名单。
 *
 * 优先级见设计文档「决策 1 优先级」表（第一个命中的规则胜出）：
 * 拒绝名单 > 指纹 > 只读类 > 路径白名单 > 命令白名单 > 升级白名单 > LLM > 人工面板。
 * 指纹层不在这里（它是状态），由 `decide.ts` 编排。
 *
 * 一条纪律：**缺信息不猜**。规则要求看参数而参数取不到时，该规则不生效（结果 `undefined`,
 * 由上层落人工面板）；只有当用户显式配了 `deny.missingArguments` 才把「缺参数」判为拒绝。
 */

import {
  matchesAnyTool,
  modeAllowed,
  normalizeCommand,
  normalizePath,
  parseEscalationTarget,
  pickString,
  pickStringArray,
  PATH_KEYS,
  COMMAND_KEYS,
} from "./patterns.ts";
import { SHELL_TOOLS, type ResolvedConfig } from "./config.ts";
import type { CallInfo, Decision } from "./types.ts";

/** 判定所需的最小上下文（`callId → 参数` 表命中后的快照）。 */
export interface RuleInput {
  call: CallInfo;
  /** 审批请求的理由（升级目标模式从这里取；`pre-execute` 侧无理由）。 */
  reason?: string;
  /** 本次请求的目标模式（已解析；undefined = 非升级请求或解析失败）。 */
  escalationTarget?: string;
}

/** 判定结果：命中返回裁定，未命中返回 `undefined`。 */
export type RuleHit = Pick<Decision, "outcome" | "source" | "ruleId" | "reason">;

/** 拒绝名单：工具类「永不自动批」。 */
export function checkDenyTools(
  config: ResolvedConfig,
  toolName: string,
): RuleHit | undefined {
  if (!matchesAnyTool(config.denyTools, toolName)) return undefined;
  return {
    outcome: "rejected",
    source: "rule",
    ruleId: `deny.tools:${toolName}`,
    reason: denialReason(toolName, "该工具在拒绝名单里（永不自动批）"),
  };
}

/** 拒绝名单：升级例外「允许升级但永不升到某档」。 */
export function checkDenyEscalation(
  config: ResolvedConfig,
  toolName: string,
  target: string | undefined,
): RuleHit | undefined {
  if (target === undefined) return undefined;
  if (!config.denyEscalationTo.includes(target)) return undefined;
  return {
    outcome: "rejected",
    source: "rule",
    ruleId: `deny.escalation:${target}`,
    reason: denialReason(toolName, `不允许升级到 ${target}`),
  };
}

/** 只读类工具（按工具名即可判定）。 */
export function checkReadonly(
  config: ResolvedConfig,
  toolName: string,
): RuleHit | undefined {
  if (!config.readonlyTools.includes(toolName)) return undefined;
  return {
    outcome: "allowed-once",
    source: "readonly",
    ruleId: `readonly:${toolName}`,
  };
}

/** 命令原文（`bash` / `pwsh` / `shell` 的 `command` / `script`）。 */
export function commandOf(
  config: ResolvedConfig,
  call: CallInfo,
): string | undefined {
  if (!matchesAnyTool(SHELL_TOOLS, call.name)) return undefined;
  return pickString(call.arguments, COMMAND_KEYS);
}

/** 路径原文列表（文件工具的路径参数；写工具会有多个）。 */
export function pathsOf(config: ResolvedConfig, call: CallInfo): readonly string[] {
  const single = pickString(call.arguments, PATH_KEYS);
  const many = pickStringArray(call.arguments, ["paths"]);
  if (single !== undefined && many.length === 0) return [single];
  if (many.length > 0) return many;
  return [];
}

/** 路径白名单：任一（归一化后的）路径命中即放行。 */
export function checkPathAllow(
  config: ResolvedConfig,
  call: CallInfo,
): RuleHit | undefined {
  const rules = config.allowPaths.filter((rule) => rule.tool === call.name);
  if (rules.length === 0) return undefined;
  const paths = pathsOf(config, call).map((path) =>
    normalizePath(path, call.cwd),
  );
  if (paths.length === 0) return undefined;
  for (const rule of rules) {
    if (paths.some((path) => rule.pattern.test(path))) {
      return {
        outcome: "allowed-once",
        source: "rule",
        ruleId: rule.id,
      };
    }
  }
  return undefined;
}

/** 命令白名单：命令原文（归一化后）命中即放行。 */
export function checkCommandAllow(
  config: ResolvedConfig,
  call: CallInfo,
): RuleHit | undefined {
  const rules = config.allowCommands.filter((rule) => rule.tool === call.name);
  if (rules.length === 0) return undefined;
  const command = commandOf(config, call);
  if (command === undefined) return undefined;
  const normalized = normalizeCommand(command);
  for (const rule of rules) {
    if (rule.pattern.test(normalized)) {
      return {
        outcome: "allowed-once",
        source: "rule",
        ruleId: rule.id,
      };
    }
  }
  return undefined;
}

/**
 * 沙箱升级白名单（两维判定：命令 / 路径命中 **且** 目标模式在 `to` 内）。
 *
 * `justification` 不参与判定（`reason` 只用来取目标模式）；取不到目标模式时本层不生效。
 */
export function checkEscalationAllow(
  config: ResolvedConfig,
  call: CallInfo,
  target: string | undefined,
): RuleHit | undefined {
  if (target === undefined) return undefined;
  if (config.escalationMode === "any") {
    return { outcome: "allowed-once", source: "upgrade", ruleId: "escalation:any" };
  }
  const command = commandOf(config, call);
  const normalizedCommand =
    command === undefined ? undefined : normalizeCommand(command);
  const paths = pathsOf(config, call).map((path) => normalizePath(path, call.cwd));
  for (const rule of config.escalationRules) {
    const toolOk =
      rule.tools.length === 0
        ? rule.command !== undefined
          ? matchesAnyTool(SHELL_TOOLS, call.name)
          : paths.length > 0
        : matchesAnyTool(rule.tools, call.name);
    if (!toolOk) continue;
    if (!modeAllowed(rule.to, target)) continue;
    if (rule.command !== undefined) {
      if (normalizedCommand === undefined) continue;
      if (rule.command.test(normalizedCommand)) {
        return { outcome: "allowed-once", source: "upgrade", ruleId: rule.id };
      }
      continue;
    }
    if (rule.path !== undefined && paths.some((path) => rule.path?.test(path) === true)) {
      return { outcome: "allowed-once", source: "upgrade", ruleId: rule.id };
    }
  }
  return undefined;
}

/** 规则层是否**需要**参数（用于「缺参数」保守闸门的措辞与判定）。 */
export function needsArguments(
  config: ResolvedConfig,
  toolName: string,
  target: string | undefined,
): boolean {
  if (config.allowPaths.some((rule) => rule.tool === toolName)) return true;
  if (config.allowCommands.some((rule) => rule.tool === toolName)) return true;
  if (target !== undefined && config.escalationRules.length > 0) return true;
  return false;
}

/** 拒绝文案（模型看到的人类拒绝同款形态）。 */
export function denialReason(toolName: string, detail: string): string {
  return `auto-approve 拒绝了工具 "${toolName}" 的这次调用：${detail}。本次调用未执行。`;
}

/** 工具是否在 `bypassTools`（不参与自动裁定）。 */
export function isBypassed(config: ResolvedConfig, toolName: string): boolean {
  return matchesAnyTool(config.bypassTools, toolName);
}

/** 工具是否在 `gateTools` 白名单外（非空时）。 */
export function isGatedOut(config: ResolvedConfig, toolName: string): boolean {
  return config.gateTools.length > 0 && !matchesAnyTool(config.gateTools, toolName);
}

export { parseEscalationTarget };
