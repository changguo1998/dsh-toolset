/**
 * src/launch.ts — 拉起的守门：命令白名单、脱管痕迹自检、`spawn` 参数面与 `cwd` 校验。
 *
 * 裁定（决策项 5）：只允许在**用户可见**的终端里**前台**运行 `fffdsh`，不做任意命令透传；
 * 任何脱管痕迹（`nohup` / `setsid` / `&` / `disown` / `bg` / `screen` / `tmux`）一律
 * `launch_forbidden`。正常路径下文本是常量，这里是纵深防御：一旦有人把参数面改宽，守卫仍生效。
 */

import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";

/** 提交给终端的唯一命令前缀（白名单；`spawn` 回执的 `cmd` 以它开头）。 */
export const LAUNCH_COMMAND = "fffdsh";

/** 启动参数值字符集与长度（provider / model / effort；防命令拼装注入）。 */
const LAUNCH_VALUE_RE = /^[A-Za-z0-9._/:/-]{1,64}$/;

/** 脱管痕迹（词边界匹配，避免 `background` 之类误伤）。 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bnohup\b/, label: "nohup" },
  { pattern: /\bsetsid\b/, label: "setsid" },
  { pattern: /(?:^|[\s;|])&(?:\s|$)/, label: "&（后台运行符）" },
  { pattern: /\bdisown\b/, label: "disown" },
  { pattern: /\bbg\b/, label: "bg" },
  { pattern: /\bscreen\b/, label: "screen" },
  { pattern: /\btmux\b/, label: "tmux" },
];

/** 命令文本自检结果。 */
export type LaunchGuard = { ok: true } | { ok: false; reason: string };

/** 自检一段准备提交的文本；命中任何脱管痕迹即拒。 */
export function checkForegroundText(text: string): LaunchGuard {
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      return {
        ok: false,
        reason: `命令文本含脱管痕迹「${label}」：只允许前台运行（用户必须能在终端里看到并接管）`,
      };
    }
  }
  return { ok: true };
}

/** `cwd` 校验：必须是绝对路径、存在、且是目录。 */
export async function checkCwd(
  cwd: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isAbsolute(cwd)) {
    return { ok: false, reason: `cwd 必须是绝对路径：${cwd}` };
  }
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) {
      return { ok: false, reason: `cwd 不是目录：${cwd}` };
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `cwd 不存在或不可访问（${cwd}）：${message}` };
  }
}

/** `spawn` 的合法参数（`target` 已随终端单层契约删除；`task` / `text` / `env` 从未存在）。 */
const SPAWN_KEYS: readonly string[] = [
  "cwd",
  "label",
  "claimTimeoutSec",
  "provider",
  "model",
  "effort",
];

/** 解析后的 `spawn` 参数。 */
export interface SpawnArgs {
  cwd?: string;
  label?: string;
  claimTimeoutSec?: number;
  /** 转发为 `fffdsh --provider <value>` */
  provider?: string;
  /** 转发为 `fffdsh --model <value>`（裸 id 或 provider/model，可带 `:effort`） */
  model?: string;
  /** 转发为 `fffdsh --effort <value>` */
  effort?: string;
}

/**
 * 由 spawn 参数构造提交给终端的命令。值已按 `LAUNCH_VALUE_RE` 校验（无空格 / 引号 /
 * shell 元字符），直接拼接即可；无参数时返回常量 `fffdsh`。
 */
export function buildLaunchCommand(args: {
  provider?: string;
  model?: string;
  effort?: string;
}): string {
  const parts = [LAUNCH_COMMAND];
  if (args.provider !== undefined) parts.push("--provider", args.provider);
  if (args.model !== undefined) parts.push("--model", args.model);
  if (args.effort !== undefined) parts.push("--effort", args.effort);
  return parts.join(" ");
}

/** 参数面解析结果（`invalid` 由动作层转 `invalid_params`）。 */
export type ParsedArgs<T> =
  { ok: true; value: T } | { ok: false; reason: string; next?: string };

/** 校验通用字符串参数（空串视为未给）。 */
export function optionalString(
  args: Record<string, unknown>,
  key: string,
): ParsedArgs<string | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, reason: `${key} 必须是字符串` };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  return { ok: true, value: trimmed };
}

/** 校验正整数字段（秒 / 毫秒都按「正整数」处理）。 */
export function positiveInt(
  args: Record<string, unknown>,
  key: string,
): ParsedArgs<number | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return { ok: false, reason: `${key} 必须是正整数` };
  }
  return { ok: true, value };
}

/** 校验布尔字段。 */
export function booleanArg(
  args: Record<string, unknown>,
  key: string,
): ParsedArgs<boolean | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "boolean") {
    return { ok: false, reason: `${key} 必须是布尔值` };
  }
  return { ok: true, value };
}

/**
 * 拒绝未知参数（含已删除的 `target` 与从未支持的 `task` / `text` / `env`）。
 * 逐条给出「该用谁」，避免模型反复试错。
 */
export function rejectUnknownKeys(
  args: Record<string, unknown>,
  allowed: readonly string[],
): ParsedArgs<true> {
  const extras = Object.keys(args).filter((key) => !allowed.includes(key));
  if (extras.length === 0) return { ok: true, value: true };
  const deleted = extras.includes("target");
  const hint = deleted
    ? "target 已随终端单层契约删除：spawn 一律新建终端（herdr_create），没有 pane / tab 两选一"
    : extras.some((key) => key === "task" || key === "text" || key === "prompt")
      ? "coagent 不转发任何对话内容：派任务用 session-channel 的 channel_delegate({to: session_id, task})"
      : `spawn 只接受 ${allowed.join(" / ")}`;
  return {
    ok: false,
    reason: `不支持的参数：${extras.join(", ")}`,
    next: hint,
  };
}

/** 校验启动参数值（provider / model / effort）：字符集与长度见 `LAUNCH_VALUE_RE`。 */
export function launchValueArg(
  args: Record<string, unknown>,
  key: "provider" | "model" | "effort",
): ParsedArgs<string | undefined> {
  const value = args[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, reason: `${key} 必须是字符串` };
  }
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!LAUNCH_VALUE_RE.test(trimmed)) {
    return {
      ok: false,
      reason: `${key} 只允许字母 / 数字与 . _ : / -，且不超过 64 字符`,
    };
  }
  return { ok: true, value: trimmed };
}

/** 解析 `spawn` 参数面（未知键、类型、cwd 由调用方另行校验）。 */
export function parseSpawnArgs(
  args: Record<string, unknown>,
): ParsedArgs<SpawnArgs> {
  const unknown = rejectUnknownKeys(args, SPAWN_KEYS);
  if (!unknown.ok) return unknown;

  const cwd = optionalString(args, "cwd");
  if (!cwd.ok) return cwd;
  const label = optionalString(args, "label");
  if (!label.ok) return label;
  const claimTimeoutSec = positiveInt(args, "claimTimeoutSec");
  if (!claimTimeoutSec.ok) return claimTimeoutSec;
  const provider = launchValueArg(args, "provider");
  if (!provider.ok) return provider;
  const model = launchValueArg(args, "model");
  if (!model.ok) return model;
  const effort = launchValueArg(args, "effort");
  if (!effort.ok) return effort;

  if (label.value !== undefined && label.value.length > 80) {
    return { ok: false, reason: "label 最长 80 个字符" };
  }

  return {
    ok: true,
    value: {
      cwd: cwd.value,
      label: label.value,
      claimTimeoutSec: claimTimeoutSec.value,
      provider: provider.value,
      model: model.value,
      effort: effort.value,
    },
  };
}
