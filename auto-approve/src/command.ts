/**
 * `/autoapprove` 命令面（`ctx.commands.register`）：自动放行是**隐形**的（不弹面板就没有提示），
 * 本命令是它的可见面与应急开关 —— 子命令口径见设计文档「决策 4 补充」。
 *
 * 命令直接针对 agent 执行、不产生模型消息（宿主 commands 语义），故命令本身与其结果都不进
 * 对话与模型上下文; 结果由 TUI 渲染。命令只改**当前进程**的运行态, 重启回落配置默认值。
 */

import type {
  AutoApproveMode,
  AutoApproveService,
  PluginHost,
} from "./types.ts";
import { readService } from "./types.ts";
import type { ResolvedConfig } from "./config.ts";

/** 命令名（不含前导 `/`）。 */
export const COMMAND_NAME = "autoapprove";

/** 宿主命令注册面的结构化子集。 */
interface CommandRuntimeLike {
  register(definition: unknown): (() => void) | undefined;
}

/** 命令调用（宿主 `CommandInvocation` 的结构化子集）。 */
interface InvocationLike {
  rawInput?: string;
}

/** 命令结果（宿主 `CommandResult`）。 */
export interface CommandResultLike {
  kind: "success" | "error";
  text?: string;
}

const MODES: readonly AutoApproveMode[] = ["rules", "rules+llm", "all", "off"];

/** 解析命令输入（返回子命令与参数）。 */
export function parseCommandInput(raw: string): {
  sub: string;
  args: readonly string[];
} {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const sub = tokens[0]?.toLowerCase() ?? "status";
  return { sub, args: tokens.slice(1) };
}

/** 渲染状态文本（`/autoapprove status`）。 */
export function renderStatus(service: AutoApproveService): string {
  const status = service.status();
  const audit = status.audit;
  const lines = [
    `auto-approve: ${status.enabled ? "已启用" : "已关闭"}`,
    `模式: ${status.mode}（配置默认 ${status.configuredMode}）`,
    `LLM 审查: ${status.llmEnabled ? `开启（路由 ${status.llmRoute}）` : "关闭"}`,
    `名单: 只读类 ${status.readonlyTools} · 白名单 ${status.allowRules} · 拒绝名单 ${status.denyRules} · 升级白名单 ${status.upgradeRules}`,
    `本会话指纹: ${status.fingerprints}`,
    `审计（会话）: ${audit.sessionWritable ? (audit.sessionFilePath ?? "可用") : `不可用（${audit.degradedReason ?? "原因未知"}）`} · ${audit.sessionLines} 行${audit.truncated ? " · 已截断" : ""}`,
    `审计（项目）: ${audit.projectWritable ? "可用" : `跳过（已跳过 ${audit.projectSkipped} 行）`}`,
  ];
  return lines.join("\n");
}

/** 渲染最近 n 条自动裁定（**不含参数原文**）。 */
export function renderLog(service: AutoApproveService, n: number): string {
  const rows = service.recent(n);
  if (rows.length === 0) return "auto-approve: 本进程还没有自动裁定记录";
  const lines = rows.map(
    (row) =>
      `${row.t} ${row.outcome === "allowed-once" ? "放行" : "拒绝"} ${row.toolName} ` +
      `来源=${row.source}${row.ruleId === undefined ? "" : ` 规则=${row.ruleId}`}` +
      `${row.risk === undefined ? "" : ` 风险=${row.risk}`}`,
  );
  return [`最近 ${rows.length} 条自动裁定:`, ...lines].join("\n");
}

/** 分发子命令。 */
export function dispatch(
  service: AutoApproveService,
  raw: string,
  options: { clearFingerprints: () => number; defaultLogLines: number },
): CommandResultLike {
  const { sub, args } = parseCommandInput(raw);
  switch (sub) {
    case "status":
      return { kind: "success", text: renderStatus(service) };
    case "mode": {
      const value = args[0];
      if (
        value === undefined ||
        !(MODES as readonly string[]).includes(value)
      ) {
        return {
          kind: "error",
          text: `用法: /${COMMAND_NAME} mode <${MODES.join("|")}>`,
        };
      }
      service.setMode(value as AutoApproveMode);
      if (value === "off") {
        return {
          kind: "success",
          text: "auto-approve: 已关闭（未命中的请求回到审批面板）",
        };
      }
      return { kind: "success", text: `auto-approve: 模式已切到 ${value}` };
    }
    case "on":
      service.setMode("rules");
      return { kind: "success", text: "auto-approve: 已开启（模式 rules）" };
    case "off":
      service.setMode("off");
      return {
        kind: "success",
        text: "auto-approve: 已关闭（未命中的请求回到审批面板）",
      };
    case "log": {
      const parsed = Number.parseInt(args[0] ?? "", 10);
      const n =
        Number.isFinite(parsed) && parsed > 0
          ? parsed
          : options.defaultLogLines;
      return { kind: "success", text: renderLog(service, n) };
    }
    case "clear-fingerprints": {
      const cleared = options.clearFingerprints();
      return {
        kind: "success",
        text: `auto-approve: 已清空 ${cleared} 条会话指纹`,
      };
    }
    default:
      return {
        kind: "error",
        text:
          `未知子命令: ${sub}。用法: /${COMMAND_NAME} ` +
          "status | mode <rules|rules+llm|all|off> | on | off | log [n] | clear-fingerprints",
      };
  }
}

/** 注册 `/autoapprove`；返回 dispose（commands 缺席时返回 undefined）。 */
export function registerCommand(
  host: PluginHost,
  options: {
    config: ResolvedConfig;
    service: () => AutoApproveService;
    clearFingerprints: () => number;
  },
): (() => void) | undefined {
  const commands = readService<CommandRuntimeLike>(host, "commands");
  if (commands === undefined || typeof commands.register !== "function") {
    return undefined;
  }
  const off = commands.register({
    definitionId: `auto-approve:${COMMAND_NAME}`,
    name: COMMAND_NAME,
    description:
      "自动审批插件：查看状态与放行记录、切换模式（status / mode / on / off / log / clear-fingerprints）",
    input: {
      hint: "status | mode <rules|rules+llm|all|off> | on | off | log [n] | clear-fingerprints",
    },
    handler: (invocation: InvocationLike) =>
      dispatch(options.service(), invocation?.rawInput ?? "", {
        clearFingerprints: options.clearFingerprints,
        defaultLogLines: 10,
      }),
  });
  return typeof off === "function" ? off : undefined;
}
