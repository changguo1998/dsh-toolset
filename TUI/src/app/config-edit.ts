// src/app/config-edit.ts — /config 命令的纯逻辑（解析 / 点路径 / 值校验 / 格式化，无副作用）
//
// 编辑动作本身经 adapter 交给宿主 config-editor（`configEditor.edit()`：完整候选值校验 →
// 原子写 profile patch → 与 profile 变更 / HMR 串行 → 经 Loader 立即应用）；本模块只做
// 决策与文本，便于单测。
//
// 值校验落地在 `change` 回调里（`configEditor.edit()` 在写盘前调用它）：抛错即中止，
// profile patch 保持原样。宿主的 `resolveConfig(fiber.runtime, next)` 只对**声明了运行时
// schema** 的插件生效（`runtime.Config` 为标准 schema）；本仓插件都按契约把 `Config` 写成
// TS 类型别名（无运行时 schema），故 TUI 侧用「已知键类型表 + 既有值类别兜底」补位。

import { isDeepStrictEqual } from "node:util";
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

// ---------- 写入前值校验 ----------

/** 配置值的 JSON 类别（`other` = 不是可写入的 JSON 值，正常 CLI 路径不可达） */
export type ConfigValueKind =
  "number" | "string" | "boolean" | "array" | "object" | "null" | "other";

/** 已知键的期望类型：单类别，或字符串枚举 */
export type ConfigKeyType =
  | { kind: "number" | "boolean" | "string" | "array" | "object" }
  | { kind: "enum"; values: readonly string[] };

/**
 * 已知键类型表（键 = `条目 id + 点路径`）。宿主对无运行时 schema 的插件不做任何类型校验，
 * 故这里给「类型写错会污染插件运行期」的键补一道闸门。
 *
 * 收录口径：只登记**本仓自己声明**的键（`tui`，与 `DshTuiConfig` 同源）与真机验收暴露的
 * `output-compress` 键；表外键交给「既有值类别兜底」（见 `validateConfigSetValue`）。
 * 有运行时 schema 的插件由宿主 `resolveConfig` 校验，**不要**再登记（否则 TUI 判断会盖过
 * 权威 schema）；新增键 = 表里加一行。
 * 漂移风险：插件改字段类型 / 改名后本表不会自动跟随（类型错误 = 误拒合法值，可见且可改）；
 * 权威修法是各插件导出运行时 schema（跨包，另行立项）。
 */
export const CONFIG_KEY_TYPES: Readonly<Record<string, ConfigKeyType>> = {
  "tui.cwd": { kind: "string" },
  "tui.approvalTimeoutMs": { kind: "number" },
  "tui.provider": { kind: "string" },
  "tui.model": { kind: "string" },
  "tui.reasoningEffort": { kind: "string" },
  "tui.theme": { kind: "enum", values: ["dark", "light"] },
  "tui.messageGutter": { kind: "number" },
  "tui.toolBootstrap": { kind: "boolean" },
  "output-compress.sessionDir": { kind: "string" },
  "output-compress.minBytes": { kind: "number" },
  "output-compress.maxSourceBytes": { kind: "number" },
};

/** 校验失败（App 侧据此用「值校验失败：」而非「编辑失败：」前缀） */
export class ConfigValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValueError";
  }
}

/** 值的 JSON 类别（非 JSON 值 → `other`；CLI 只产出 JSON 六类，故该分支仅防御性存在） */
export function configValueKind(value: unknown): ConfigValueKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "other";
  }
}

/** `!!js` 表达式在 config 里的占位形态（`{ __jsExpr: "…" }`）：类型未知，不参与类别比对 */
function isJsExpression(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value["__jsExpr"] === "string" &&
    Object.keys(value).length === 1
  );
}

/** 读点路径上的既有值：路径任一层缺失 / 不是对象 → `found:false` */
export function readConfigPath(
  config: Record<string, unknown> | undefined,
  path: readonly string[],
): { found: boolean; value?: unknown } {
  let cursor: unknown = config;
  for (const key of path) {
    if (!isPlainObject(cursor) || !Object.hasOwn(cursor, key)) {
      return { found: false };
    }
    cursor = cursor[key];
  }
  return { found: true, value: cursor };
}

/**
 * 写入前的值校验：类型表命中 → 按表判定（含字符串枚举）；表外键 → 用既有值
 * （本行 override 优先，其次 inherited）的类别做一致性判断；两处都无信息 → 放行。
 * `layers` 传 `[current, inherited]`，即宿主 `change(current, inherited)` 的两个入参。
 */
export function validateConfigSetValue(
  id: string,
  path: readonly string[],
  value: unknown,
  layers: readonly (Record<string, unknown> | undefined)[],
): { ok: true } | { ok: false; reason: string } {
  const key = `${id}.${path.join(".")}`;
  const kind = configValueKind(value);
  if (kind === "other") {
    return { ok: false, reason: `${key} 的值不是可写入的 JSON 值` };
  }
  const declared = CONFIG_KEY_TYPES[key];
  if (declared !== undefined) {
    if (declared.kind === "enum") {
      if (kind !== "string" || !declared.values.includes(value as string)) {
        return {
          ok: false,
          reason: `${key} 只接受 ${declared.values.join(" / ")}，收到 ${formatConfigValue(value)}`,
        };
      }
      return { ok: true };
    }
    if (kind !== declared.kind) {
      return {
        ok: false,
        reason: `${key} 期望 ${declared.kind}，收到 ${kind}（${formatConfigValue(value)}）`,
      };
    }
    return { ok: true };
  }
  for (const layer of layers) {
    const hit = readConfigPath(layer, path);
    if (!hit.found) continue;
    // null / `!!js` 表达式 / 非 JSON 的既有值不提供类型信息
    if (isJsExpression(hit.value)) return { ok: true };
    const existing = configValueKind(hit.value);
    if (existing === "null" || existing === "other") return { ok: true };
    if (existing !== kind) {
      return {
        ok: false,
        reason: `${key} 既有值的类型是 ${existing}，不接受 ${kind}（${formatConfigValue(value)}）`,
      };
    }
    return { ok: true };
  }
  return { ok: true };
}

/**
 * 宿主写回归一化的触发条件：候选值与本层 inherited 全等时，`configEditor.edit()` 会删掉本行
 * `config`，并在行内只剩 id / name 时**连整行（含注释）一起删除**（`dsh-config-editor` 的
 * `edit()` 里 `isDeepStrictEqual(next, inherited)` 分支）。TUI 只能预判并提示，无法阻止。
 */
export function configsEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return isDeepStrictEqual(a, b);
}
