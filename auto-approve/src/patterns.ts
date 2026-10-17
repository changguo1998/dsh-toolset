/**
 * 文本 / 路径 / 参数面的归一化纯函数（无状态、可单测）。
 *
 * 归一化口径（决策 1 补充 ②）: 命令折叠空白、去首尾引号; 路径展开 `~` / `$HOME` /
 * `${HOME}`、折叠 `//`、相对路径按会话 cwd 解析、去末尾除根以外的 `/`。
 * **不做** 正则层面的转义或重构 —— 规则作者自己写正则。
 */

import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

/** 命令原文归一：折叠连续空白、去首尾空白与成对引号。 */
export function normalizeCommand(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1).trim();
    }
  }
  return text;
}

/** 路径归一（`home` 可注入，测试用）。 */
export function normalizePath(raw: string, cwd?: string, home = homedir()): string {
  let text = raw.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      text = text.slice(1, -1).trim();
    }
  }
  text = text.replace(/\$\{HOME\}/g, home).replace(/\$HOME\b/g, home);
  if (text === "~") text = home;
  else if (text.startsWith("~/")) text = `${home}${text.slice(1)}`;
  if (!isAbsolute(text)) text = resolve(cwd ?? process.cwd(), text);
  text = text.replace(/\/{2,}/g, "/");
  text = normalize(text);
  if (text.length > 1 && text.endsWith(sep)) text = text.slice(0, -1);
  return text;
}

/** 从升级审批理由里取目标模式（`escalate sandbox to <mode>: <justification>`）。 */
export function parseEscalationTarget(reason: string | undefined): string | undefined {
  if (typeof reason !== "string") return undefined;
  const match = /^escalate sandbox to ([A-Za-z0-9_-]+):/.exec(reason.trim());
  return match?.[1];
}

/** 参数对象化：字符串尝试 `JSON.parse`，失败保留原串。 */
export function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 取字符串参数（按候选键顺序，命中第一个非空字符串）。 */
export function pickString(
  args: unknown,
  keys: readonly string[],
): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** 取字符串数组参数（数组里的字符串元素，或单值转单元素数组）。 */
export function pickStringArray(
  args: unknown,
  keys: readonly string[],
): readonly string[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return [];
  }
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return [value];
    if (Array.isArray(value)) {
      const strings = value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      );
      if (strings.length > 0) return strings;
    }
  }
  return [];
}

/** 路径类参数键（与 `security-guard` 的登记口径同源：官方文件工具 + 本仓插件读工具）。 */
export const PATH_KEYS: readonly string[] = [
  "file_path",
  "path",
  "target",
  "file",
  "root",
  "paths",
];

/** 命令类参数键（`bash` / `pwsh` / `shell`）。 */
export const COMMAND_KEYS: readonly string[] = ["command", "script"];

/** 工具名匹配：精确，或 `*` 结尾的前缀通配。 */
export function toolMatches(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
  return false;
}

/** 工具名是否命中任一模式。 */
export function matchesAnyTool(
  patterns: readonly string[],
  toolName: string,
): boolean {
  return patterns.some((pattern) => toolMatches(pattern, toolName));
}

/** 取目标模式列表里是否包含某档（空列表 = 不限定）。 */
export function modeAllowed(
  to: readonly string[],
  target: string | undefined,
): boolean {
  if (to.length === 0) return true;
  return target !== undefined && to.includes(target);
}
