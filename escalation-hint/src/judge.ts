/**
 * escalation-hint 判定层（纯函数，不依赖宿主类型）。
 *
 * 三层判据（见 `docs/implementation/2026-10-24-escalation-hint-package.md` 决策 3）：
 *   1. 结果里已有宿主升级提示（`[sandbox: escalation available …`）→ 跳过，不重复提示；
 *   2. 结果里出现宿主策略拒绝标记（`[sandbox: file access denied under <mode> mode]`）或
 *      `FS_SANDBOX_DENIED` 码，却没有升级提示 → 补提示；
 *   3. 两者都没有时用**结构化结果**兜底：沙箱模式下非零退出 / 信号终止，且命令形状像越界写。
 *
 * 本层只回答「该不该提示、提示什么」，不做任何拦截。
 */

/** 工具调用面（宿主 `ToolExecution` 的结构面子集）。 */
export interface ToolExecLike {
  readonly name?: string;
  readonly arguments?: unknown;
  readonly callId?: string;
}

/** 工具结果面（宿主 `ToolExecutionResult` 的结构面子集）。 */
export interface ToolResultLike {
  readonly content?: unknown;
  readonly value?: unknown;
  readonly isError?: boolean;
  readonly error?: unknown;
}

/** 工具族：命令类（bash / pwsh）与文件操作类（write / edit / …）。 */
export type ToolFamily = "command" | "operation";

/** 判定选项（已归一）。 */
export interface JudgeOptions {
  readonly commandTools: readonly string[];
  readonly fileTools: readonly string[];
}

/** 一条待注入的提示。 */
export interface Hint {
  readonly text: string;
  readonly summary: string;
}

/** 宿主常量：升级提示行（`escalationHintMarker` 的前缀）。 */
export const ESCALATION_HINT_PREFIX = "[sandbox: escalation available";

/** 宿主常量：策略拒绝行（`sandboxDenialMarker` 的前缀）。 */
export const DENIAL_MARKER_PREFIX = "[sandbox: file access denied under ";

/** 宿主文件沙箱拒绝的错误码。 */
export const FS_DENIED_CODE = "FS_SANDBOX_DENIED";

/** 归一化：去掉 `/dev/null` 重定向与 `2>&1`，避免把它们当成「写」。 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\d*>>?\s*\/dev\/null/g, " ")
    .replace(/\d*>&\d*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 重定向形状（归一化后仍存在 `> 目标` 才算写）。 */
const REDIRECT_SHAPE = /(?:^|[^>])>>?(?!&)\s*[^\s|;&]/;

/** 沙箱拒绝的强特征文本（中英 + 常见内核口径）；第 3 层用它压误报。 */
const DENIAL_TEXT =
  /read-only file system|只读文件系统|permission denied|permissionerror|operation not permitted|eacces|eprem/i;

/**
 * 第 3 层的命令形状表（首批，决策 4 选 b）：git 写 + 常见写操作。
 * 只在「沙箱模式 + 非零退出」两个前提都成立时才使用，误报面很小。
 */
const WRITE_SHAPES: readonly RegExp[] = [
  /\bgit\s+(?:-[Cc]\s+\S+\s+)?(?:add|commit|tag)\b/,
  /\btee\b/,
  /\bcp\b/,
  /\bmv\b/,
  /\bln\b/,
  /\bmkdir\b/,
  /\btouch\b/,
  /\brm\b/,
  /\bdd\b/,
  /\bsed\s+-i\b/,
  REDIRECT_SHAPE,
];

/** 一元对象判定。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 结果里所有文本块拼成的正文（缺字段按空串）。 */
export function resultText(result: ToolResultLike): string {
  const content = result.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record === undefined) continue;
    const text = record["text"];
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/** 错误码（`error.code`；兼容 `error.info.code`）。 */
export function resultErrorCode(result: ToolResultLike): string | undefined {
  const error = asRecord(result.error);
  if (error === undefined) return undefined;
  const code = error["code"];
  if (typeof code === "string") return code;
  const info = asRecord(error["info"]);
  const nested = info?.["code"];
  return typeof nested === "string" ? nested : undefined;
}

/** 结构化结果里的 stderr 文本（`{text}` 或字符串）。 */
function stderrText(value: Record<string, unknown>): string {
  const raw = value["stderr"];
  if (typeof raw === "string") return raw;
  const record = asRecord(raw);
  const nested = record?.["text"];
  return typeof nested === "string" ? nested : "";
}

/** 命令文本（命令类工具的 `command` 参数；没有则 undefined）。 */
export function commandOf(exec: ToolExecLike): string | undefined {
  const args = asRecord(exec.arguments);
  const command = args?.["command"];
  return typeof command === "string" ? command : undefined;
}

/** 工具 → 族；不在配置名单里返回 undefined。 */
export function familyOf(
  toolName: string | undefined,
  options: JudgeOptions,
): ToolFamily | undefined {
  if (toolName === undefined) return undefined;
  if (options.commandTools.includes(toolName)) return "command";
  if (options.fileTools.includes(toolName)) return "operation";
  return undefined;
}

/** 第 3 层：结构化结果显示「沙箱内失败且命令像越界写」。 */
function structuredDenial(exec: ToolExecLike, result: ToolResultLike): boolean {
  const value = asRecord(result.value);
  if (value === undefined) return false;
  const sandbox = asRecord(value["sandbox"]);
  if (sandbox === undefined) return false;
  const mode = sandbox["mode"];
  if (typeof mode !== "string" || mode.length === 0) return false;
  // 沙箱执行器自己没起来（runnerFailed）= 不是「写越界被拒」，不能提示升级
  if (sandbox["runnerFailed"] === true || value["runnerFailed"] === true) {
    return false;
  }
  // 中断 / 超时不是拒绝：升级重试解决不了
  if (value["aborted"] === true || value["timedOut"] === true) return false;
  // `denied` 不作判据（宿主按英文签名判定，本地化报错恒 false）
  const exitCode = value["exitCode"];
  const failed =
    (typeof exitCode === "number" && exitCode !== 0) ||
    (typeof value["signal"] === "string" && value["signal"].length > 0);
  if (!failed) return false;
  // 失败必须像「沙箱拒绝」：stderr / 结果文本命中强特征，或宿主已判定 denied
  const haystack = [stderrText(value), resultText(result)].join("\n");
  if (sandbox["denied"] !== true && !DENIAL_TEXT.test(haystack)) return false;
  const command = commandOf(exec);
  if (command === undefined) return false;
  const normalized = normalizeCommand(command);
  return WRITE_SHAPES.some((shape) => shape.test(normalized));
}

/** 提示正文（按工具族分别措辞，决策 8 选 b）。 */
export function hintFor(family: ToolFamily): Hint {
  if (family === "command") {
    return {
      text: [
        "刚才这条命令被沙箱拒绝（越界写只读文件系统，或等价的文件访问拒绝）。",
        "若确需写工作区之外：用同一命令加 `sandbox_permissions`（最小够用的更宽档，通常是 `danger-full-access`）与 `justification`（一句话说明为什么必须写），重试一次。",
        "`auto-approve` 的升级白名单会按规则自动放行，不会弹面板；不需要写工作区之外时，改走允许的路径。",
      ].join("\n"),
      summary: "沙箱拒绝且无升级提示：提示带 sandbox_permissions 重试一次",
    };
  }
  return {
    text: [
      "刚才这次文件操作被沙箱拒绝（越界写只读文件系统，或等价的文件访问拒绝）。",
      "若确需写工作区之外：对同一操作加 `sandbox_permissions`（最小够用的更宽档，通常是 `danger-full-access`）与 `justification`（一句话说明为什么必须写），重试一次。",
      "`auto-approve` 的升级白名单会按规则自动放行，不会弹面板；不需要写工作区之外时，改走允许的路径。",
    ].join("\n"),
    summary: "沙箱拒绝且无升级提示：提示带 sandbox_permissions 重试一次",
  };
}

/**
 * 判定是否要补一条提示。
 * @param exec 工具调用面
 * @param result 工具结果面
 * @param options 归一后的判定选项
 * @returns 需要时给出提示，否则 null
 */
export function judge(
  exec: ToolExecLike,
  result: ToolResultLike,
  options: JudgeOptions,
): Hint | null {
  const family = familyOf(exec.name, options);
  if (family === undefined) return null;
  const text = resultText(result);
  // 层 1：宿主已经给了升级提示 → 不重复
  if (text.includes(ESCALATION_HINT_PREFIX)) return null;
  // 层 2：宿主常量标记 / 文件沙箱错误码 → 判据稳定，直接补
  if (text.includes(DENIAL_MARKER_PREFIX)) return hintFor(family);
  if (resultErrorCode(result) === FS_DENIED_CODE) return hintFor(family);
  // 层 3：结构化兜底（仅命令类；文件类没有 value 结构）
  if (family === "command" && structuredDenial(exec, result)) {
    return hintFor(family);
  }
  return null;
}
