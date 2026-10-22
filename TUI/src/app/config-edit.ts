// src/app/config-edit.ts — /config 命令的纯逻辑（解析 / 点路径 / 格式化，无副作用）
//
// 编辑动作本身经 adapter 交给宿主 config-editor（`configEditor.edit()`：完整候选值校验 →
// 原子写 profile patch → 与 profile 变更 / HMR 串行 → 经 Loader 立即应用）；本模块只做
// 决策与文本，便于单测。

import type { ConfigEntrySummary } from "./adapter/types.ts";

/** 一条 `/config` 命令的决策结果（App 侧据此调 adapter 与 notice） */
export type ConfigCommandDecision =
  | { kind: "list" }
  | { kind: "show"; id: string }
  | { kind: "set"; id: string; path: readonly string[]; value: unknown }
  | { kind: "unset"; id: string; path: readonly string[] }
  | { kind: "usage"; reason: string };

/** 用法提示（缺参 / 未知子命令时原样给用户） */
export const CONFIG_USAGE =
  "用法：/config [list | show <id> | set <id> <key>=<value> | unset <id> <key>]" +
  "（key 支持点路径 a.b.c；value 先按 JSON 解析，解析失败按字符串）";

/** 键路径里禁止出现的段：原型链相关名字一律拒绝（配置值是普通对象，防污染） */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** 切出首个空白分隔的 token 与其余部分（无空白时 rest 为空串） */
function splitFirst(text: string): [string, string] {
  const at = text.search(/\s/);
  if (at < 0) return [text, ""];
  return [text.slice(0, at), text.slice(at).trim()];
}

/** 解析点路径 `a.b.c` → `["a","b","c"]`；空段 / 保留名 → 原因文本 */
export function parseConfigKeyPath(
  key: string,
): { ok: true; path: string[] } | { ok: false; reason: string } {
  const trimmed = key.trim();
  if (trimmed === "") return { ok: false, reason: "键不能为空" };
  const path = trimmed.split(".");
  for (const segment of path) {
    if (segment === "")
      return { ok: false, reason: `键路径含空段：${trimmed}` };
    if (FORBIDDEN_KEYS.has(segment)) {
      return { ok: false, reason: `键路径不能用保留名 ${segment}` };
    }
  }
  return { ok: true, path };
}

/** 值解析：先按 JSON（`true` / `42` / `[1,2]` / `{"a":1}` / `"text"`），失败按原串。
 *  空串保持空串（不落成 undefined）。 */
export function parseConfigValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

/**
 * 解析 `/config ...` 整行（含前导 `/config`）→ 决策。
 * 空参 = 列表；子命令缺参 / 未知子命令 / `key=value` 不合法一律回 `usage`（带原因）。
 */
export function parseConfigCommand(line: string): ConfigCommandDecision {
  const arg = line.replace(/^\/[a-z][a-z0-9_-]*/i, "").trim();
  if (arg === "") return { kind: "list" };
  const [sub, rest] = splitFirst(arg);
  switch (sub.toLowerCase()) {
    case "list": {
      if (rest !== "") {
        return { kind: "usage", reason: `list 不接受参数：${rest}` };
      }
      return { kind: "list" };
    }
    case "show": {
      if (rest === "" || rest.split(/\s+/).length > 1) {
        return {
          kind: "usage",
          reason: `show 需要一个条目 id：${CONFIG_USAGE}`,
        };
      }
      return { kind: "show", id: rest };
    }
    case "set": {
      const [id, assignment] = splitFirst(rest);
      if (id === "" || assignment === "") {
        return {
          kind: "usage",
          reason: `set 需要「条目 id」与「key=value」：${CONFIG_USAGE}`,
        };
      }
      const eq = assignment.indexOf("=");
      if (eq <= 0) {
        return {
          kind: "usage",
          reason: `set 的赋值要写成 key=value：${assignment}`,
        };
      }
      const path = parseConfigKeyPath(assignment.slice(0, eq));
      if (!path.ok) return { kind: "usage", reason: path.reason };
      return {
        kind: "set",
        id,
        path: path.path,
        value: parseConfigValue(assignment.slice(eq + 1)),
      };
    }
    case "unset": {
      const [id, key] = splitFirst(rest);
      if (id === "" || key === "" || key.split(/\s+/).length > 1) {
        return {
          kind: "usage",
          reason: `unset 需要「条目 id」与「键」：${CONFIG_USAGE}`,
        };
      }
      const path = parseConfigKeyPath(key);
      if (!path.ok) return { kind: "usage", reason: path.reason };
      return { kind: "unset", id, path: path.path };
    }
    default:
      return {
        kind: "usage",
        reason: `未知子命令 ${sub}：${CONFIG_USAGE}`,
      };
  }
}

/** 点路径改写的结果：失败带原因（App 侧包成 `编辑失败：…`） */
export type ConfigEditResult =
  { ok: true; config: Record<string, unknown> } | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 不可变点路径写入：沿路径逐层浅拷贝，缺失的中间层建成空对象；
 * 中间层已存在但不是普通对象 → 拒绝（不静默覆盖标量）。
 */
export function setConfigPath(
  base: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): ConfigEditResult {
  if (path.length === 0) return { ok: false, reason: "键路径为空" };
  const out: Record<string, unknown> = { ...base };
  let cursor = out;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const child = cursor[key];
    if (child === undefined) {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
      continue;
    }
    if (!isPlainObject(child)) {
      const at = path.slice(0, i + 1).join(".");
      return { ok: false, reason: `键 ${at} 不是对象，无法写入子键` };
    }
    const copy = { ...child };
    cursor[key] = copy;
    cursor = copy;
  }
  cursor[path[path.length - 1]!] = value;
  return { ok: true, config: out };
}

/**
 * 不可变点路径删除：路径不存在 → 原样返回 `changed:false`；中间层不是对象同样视为不存
 * 在（不改写标量）；删除是浅拷贝路径，不修改传入对象。
 */
export function deleteConfigPath(
  base: Record<string, unknown>,
  path: readonly string[],
): { ok: true; config: Record<string, unknown>; changed: boolean } {
  if (path.length === 0) return { ok: true, config: base, changed: false };
  const out: Record<string, unknown> = { ...base };
  let cursor = out;
  for (let i = 0; i < path.length - 1; i++) {
    const child = cursor[path[i]!];
    if (!isPlainObject(child))
      return { ok: true, config: base, changed: false };
    const copy = { ...child };
    cursor[path[i]!] = copy;
    cursor = copy;
  }
  const last = path[path.length - 1]!;
  if (!Object.hasOwn(cursor, last)) {
    return { ok: true, config: base, changed: false };
  }
  delete cursor[last];
  return { ok: true, config: out, changed: true };
}

/** 值的一行文本（JSON 优先；无法序列化时退 String） */
export function formatConfigValue(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** `/config`（列表）正文：每行「id  name  override: 键…」 */
export function formatConfigEntries(
  entries: readonly ConfigEntrySummary[],
): string {
  if (entries.length === 0) {
    return "（无可编辑条目：profile 直属行里没有唯一 id 的条目）";
  }
  const lines = ["插件条目（config-editor 可编辑集合）："];
  for (const entry of entries) {
    const keys = Object.keys(entry.override);
    const name = entry.name === "" ? "" : `  ${entry.name}`;
    lines.push(
      `  ${entry.id}${name}  override: ${keys.length === 0 ? "-" : keys.join(", ")}`,
    );
  }
  lines.push("（/config show <id> 看生效值；set / unset 改写 profile patch）");
  return lines.join("\n");
}

/** `/config show <id>` 正文：override 与 inherited 分节列出 */
export function formatConfigDetail(entry: ConfigEntrySummary): string {
  const lines = [
    `${entry.id}${entry.name === "" ? "" : `  ${entry.name}`}`,
    "override（本行 patch 显式值）：",
  ];
  const overrideKeys = Object.keys(entry.override);
  if (overrideKeys.length === 0) lines.push("  （无）");
  else {
    for (const key of overrideKeys) {
      lines.push(`  ${key}: ${formatConfigValue(entry.override[key])}`);
    }
  }
  lines.push("inherited（去掉本行 override 后的值）：");
  const inheritedKeys = Object.keys(entry.inherited);
  if (inheritedKeys.length === 0) lines.push("  （无）");
  else {
    for (const key of inheritedKeys) {
      lines.push(`  ${key}: ${formatConfigValue(entry.inherited[key])}`);
    }
  }
  return lines.join("\n");
}
