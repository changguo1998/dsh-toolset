/**
 * plan-mode/src/guard.ts — 判定核（纯函数，无宿主依赖）。
 *
 * 回答「这次工具调用在 plan 只读段该不该拒」：段规则（决策项 4）、工具分类
 * （决策项 3）、命令白名单（决策项 9）、判定顺序与回执文案都在这里，装配端
 * （index.ts）只负责读会话、取快照、调本核、发拒绝回执。
 *
 * 判定顺序（短路，先命中先返回）：
 *   1. 会话没有映射 → 放行（决策项 2b, 非 plan 会话零动作）。
 *   2. 推不出段（树缺失 / 帧对不上）→ 放行, 按未知段处理, 不把人锁死。
 *   3. 计划段已 done, 或段是实施 → 放行（决策项 4a 的放行点）。
 *   4. 工具不在写面 → 放行（flow_select / plan_start / task_* 照常可用）。
 *   5. 在写面 → 按工具分类判, 命中即拒。
 */

import {
  basenameOf,
  splitCommandSegments,
  tokenizeSegment,
} from "@dsh-toolset/shell-parse";

/** 只读拒绝的错误码（决策项 5a, 与 flow-arbiter 的 info.code 同一口径）。 */
export const STAGE_READONLY_CODE = "plan_stage_readonly";

/** 会话当前所处的段。 */
export type Stage = "explore" | "plan" | "implement" | "unknown";

/** 工具分类（决策项 3b 的清单逐项归位）。 */
export type ToolKind =
  "direct-write" | "terminal" | "code" | "derived" | "task" | "none";

/** 直接写面（不带开关, 恒拦）。 */
export const DIRECT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "apply_patch",
  "patch",
  "hash_edit",
]);

/** 带写开关的工具：开关命中才算写面（ast_replace 缺省 dry-run, md_logic 非 replace 只读）。 */
export const OPTIONAL_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "ast_replace",
  "md_logic",
]);

/** 终端命令面：按命令白名单判, 认不出的命令放行。 */
export const TERMINAL_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "shell",
  "pwsh",
  "herdr_run",
  "herdr_text",
]);

/** 代码执行类：代码体里判不出写不写, 一律拒。 */
export const CODE_TOOLS: ReadonlySet<string> = new Set([
  "run_code",
  "script_run",
]);

/** 派生会话类：只能拦发起, 内部写来不及拦。 */
export const DERIVED_TOOLS: ReadonlySet<string> = new Set([
  "workflow",
  "task_execute",
]);

/** 任务面工具：不在写面, 只读期间照常可用（否则流程推不动）。 */
export const TASK_TOOLS: ReadonlySet<string> = new Set([
  "flow_select",
  "plan_start",
  "task_decompose",
  "task_implement",
  "task_stop",
]);

/** 命令白名单里的写命令（决策项 9a）。 */
const WRITE_COMMANDS: ReadonlySet<string> = new Set([
  "tee",
  "mv",
  "cp",
  "rm",
  "mkdir",
  "touch",
  "truncate",
  "dd",
]);

/** sed -i / perl -i：原地编辑是写面。 */
const INPLACE_COMMANDS: ReadonlySet<string> = new Set(["sed", "perl"]);

/** `python -c <代码>`：代码体判不出写不写, 与 run_code / script_run 同口径一律拒。 */
const PYTHON_COMMANDS: ReadonlySet<string> = new Set(["python", "python3"]);

/** 重定向记号（`>` / `>>` / `&>` 及带 fd 的形态; `<` 输入侧不算写）。 */
const REDIRECT_RE = /^[0-9&]*(?:>>?|&>)(?:&[0-9]+)?$/;

/** 工具是否在写面。带开关的工具按 args 判（开关未命中不算写面）。 */
export function toolWriteKind(
  toolName: string,
  args: Record<string, unknown>,
): ToolKind {
  if (DIRECT_WRITE_TOOLS.has(toolName)) return "direct-write";
  if (OPTIONAL_WRITE_TOOLS.has(toolName)) {
    if (toolName === "ast_replace" && args["write"] !== true) return "none";
    if (toolName === "md_logic" && args["action"] !== "replace") return "none";
    return "direct-write";
  }
  if (TERMINAL_TOOLS.has(toolName)) return "terminal";
  if (CODE_TOOLS.has(toolName)) return "code";
  if (DERIVED_TOOLS.has(toolName)) return "derived";
  if (TASK_TOOLS.has(toolName)) return "task";
  return "none";
}

/** 命令白名单：整条命令是否算写（认不出的命令放行, 决策项 9a）。 */
export function isWriteCommand(command: string): boolean {
  for (const segment of splitCommandSegments(command).segments) {
    const tokens = tokenizeSegment(segment).map((token) => token.value);
    for (const token of tokens) {
      if (REDIRECT_RE.test(token)) return true;
    }
    const first = tokens[0];
    if (first === undefined) continue;
    const commandName = basenameOf(first);
    if (WRITE_COMMANDS.has(commandName)) return true;
    if (
      INPLACE_COMMANDS.has(commandName) &&
      tokens.some((token) => token.startsWith("-i"))
    ) {
      return true;
    }
    if (PYTHON_COMMANDS.has(commandName) && tokens.includes("-c")) return true;
  }
  return false;
}

/** 判定核：按判定顺序给结论（命中返回 deny + 回执文案）。 */
export function decide(input: {
  mapped: boolean;
  stage: Stage;
  planDone: boolean;
  kind: ToolKind;
  command?: string;
}): { deny: boolean; reason?: string } {
  if (!input.mapped) return { deny: false };
  if (input.stage === "unknown") return { deny: false };
  if (input.planDone || input.stage === "implement") return { deny: false };
  if (input.kind === "task" || input.kind === "none") return { deny: false };
  if (input.kind === "terminal") {
    if (input.command !== undefined && isWriteCommand(input.command)) {
      return { deny: true, reason: reasonFor(input.stage, input.command) };
    }
    return { deny: false };
  }
  return { deny: true, reason: reasonFor(input.stage) };
}

/** 回执文案：当前段、为什么不能写、下一步做什么（决策项 5a）。 */
function reasonFor(stage: "explore" | "plan", command?: string): string {
  const what =
    command === undefined
      ? "本工具会改动文件"
      : `命令判定为写（${truncate(command)}）`;
  const next =
    stage === "explore" ? "先交探索结论, 再进入计划" : "计划经人工确认后再改";
  return `当前段是${
    stage === "explore" ? "探索" : "计划"
  }, ${what}; 下一步: ${next}`;
}

function truncate(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
