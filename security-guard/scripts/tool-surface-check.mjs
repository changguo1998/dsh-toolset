#!/usr/bin/env node
// scripts/tool-surface-check.mjs — 宿主工具面 vs security-guard 登记表 差异检查（2026-10-02 重写）。
//
// 用途：宿主升版后跑一次，找出「security-guard 未登记、但携带路径/命令参数」的工具
// （这类工具会绕过敏感文件层 / 命令黑名单层，属需要关注的缺口）。
//
// 用法：
//   node security-guard/scripts/tool-surface-check.mjs --root <dsh 包目录 | 安装树根> [--json]
//   DSH_INSTALL=<同上> node security-guard/scripts/tool-surface-check.mjs
// 退出码：0 = 无「需关注」项（可作门禁通过）；1 = 有「需关注」项；
//         2 = 用法 / 环境 / 口径错误（缺 --root、根下找不到 dsh-tool-* 包、键集单一来源解析失败）。
//
// 口径（对齐引擎，不再整包文本 grep）：
// 1) **逐工具**解析工具包源码的 `defineTool({ ... })`：
//    - `name: "x"` → 工具名；`name` 为计算值（`toolName` / `run.meta.name`）→ 计入「名称未解析」；
//    - `parameters` 对象字面量的键 = 工具参数键；`parameters.properties`（JSON-schema 形态）取其键；
//    - 第 2 层（参数值为对象时的键 / `items.properties` 数组元素键）也纳入 —— 与引擎
//      `unknownToolSensitiveKeys` 的键名启发深度一致（顶层 + 一层嵌套）。
// 2) **键集单一来源**：路径 / 命令 / 代码三类键与已登记工具名取自本包 `src/index.ts` 的
//    `UNKNOWN_TOOL_PATH_KEYS` / `UNKNOWN_TOOL_COMMAND_KEYS` / `UNKNOWN_TOOL_CODE_KEYS` /
//    `TOOL_SURFACE`（发布形态优先读已构建的 `dist/src/index.js`，`src` 作仓库内回退；
//    dist 早于 src 时改用 src 并提示，避免读到过期键集）——脚本不再自维护一份键表
//    （旧版两处键集互不一致）。两者都读不到 → **提示先 build 并 exit 2**，不静默当作无规则。
// 3) 计算值的 `name` 无法静态解析：单列「名称未解析」行；若其参数键命中 watched 键（如 `workflow`
//    的 `script`），同时计入「需关注」（宁可多报，人工复核）。
// 4) 默认根**不再回退** $HOME / 当前目录：缺 `--root` 与 `DSH_INSTALL` 时打印用法并 exit 2
//    （避免扫到仓库自身报噪声、也避免「静默绿」）；`--root` 指到 scope 层（其下直接是
//    `dsh-tool-*` 包目录，或 `@deepseek-ai` 目录）时给纠正提示并 exit 2 ——扫 scope 层会把
//    未挂载 / 其它版本的工具包也算进来，结果不可信。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE = [
  "用法：node security-guard/scripts/tool-surface-check.mjs --root <dsh 包目录 | 安装树根> [--json]",
  "      或设 DSH_INSTALL=<同上>；不再回退当前目录。",
  "      退出码：0 无「需关注」项 / 1 有「需关注」项 / 2 用法或环境错误。",
].join("\n");

/** schema 元键（逐工具解析参数键时要跳过的非参数键）。 */
const SCHEMA_META = new Set([
  "type",
  "required",
  "description",
  "default",
  "additionalProperties",
  "properties",
  "items",
  "enum",
  "oneOf",
  "anyOf",
  "allOf",
  "const",
  "schema",
  "output",
]);

/** 解析命令行参数（--root / --json）。 */
function parseArgs(argv) {
  const out = { root: undefined, rootGiven: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      out.root = argv[i + 1];
      out.rootGiven = true;
      i += 1;
    } else if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--help" || argv[i] === "-h") out.help = true;
    else out.unknown = argv[i];
  }
  return out;
}

/** 取文件修改时间（毫秒）；不存在/不可读返回 null。 */
function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** 是否目录 / 文件（不可读即 false）。 */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 字面量解析

/**
 * 从 open（`{` 的下标）配平到匹配的 `}`，跳过字符串 / 模板串 / 正则… 至少跳过字符串与注释；
 * 返回结束下标，失败返回 -1。
 */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/"))
        i += 1;
      i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 取对象字面量的**第 1 层**条目：`{ items: [{ key, valueText }], spread }`。
 * `key` 为标识符键或字符串键；`valueText` 为 `:` 之后到同层 `,` / `}` 之前的原文；
 * `spread` 标记同层出现 `...` 展开（键面不可静态判定）。
 */
function objectEntries(text, open, close) {
  const items = [];
  let spread = false;
  let depth = 0;
  let i = open;
  while (i < close) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < close) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      const raw = text.slice(start + 1, i);
      i += 1;
      // 字符串键：后面紧跟 `:` 才算键
      const after = text.slice(i, i + 40);
      const m = /^\s*:/.exec(after);
      if (depth === 1 && m !== null) {
        const valueStart = i + m[0].length;
        const valueEnd = findValueEnd(text, valueStart, close, 1);
        items.push({ key: raw, valueText: text.slice(valueStart, valueEnd) });
        i = valueEnd;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < close && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < close && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (
      depth === 1 &&
      ch === "." &&
      text[i + 1] === "." &&
      text[i + 2] === "."
    ) {
      spread = true;
      i += 3;
      continue;
    }
    if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < close && /[\w$]/.test(text[j])) j += 1;
      const ident = text.slice(i, j);
      const after = text.slice(j, j + 4);
      if (/^\s*\??:/.test(after) && !/^\s*\?/.test(after)) {
        const valueStart = j + /^\s*\??:/.exec(after)[0].length;
        const valueEnd = findValueEnd(text, valueStart, close, 1);
        items.push({ key: ident, valueText: text.slice(valueStart, valueEnd) });
        i = valueEnd;
        continue;
      }
      i = j;
      continue;
    }
    i += 1;
  }
  return { items, spread };
}

/** 找 `key:` 之后同层值的结束位置（同层 `,` 或对象结束）。 */
function findValueEnd(text, from, close, depth) {
  let i = from;
  let level = depth;
  while (i < close) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < close) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < close && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < close && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") level += 1;
    else if (ch === "}" || ch === "]" || ch === ")") {
      level -= 1;
      if (level < depth) return i;
    } else if (level === depth && ch === ",") return i;
    i += 1;
  }
  return close;
}

/** 取「一个对象字面量文本」的第 1 层条目（自动找首 `{` 与其配对 `}`）。 */
function literalEntries(text) {
  const open = text.indexOf("{");
  if (open < 0) return { items: [], spread: false };
  const close = matchBrace(text, open);
  if (close < 0) return { items: [], spread: false };
  return objectEntries(text, open, close);
}

/**
 * 取参数值里的**第 2 层**参数键（模拟引擎的键名启发深度）：
 * `properties` 子对象优先（JSON-schema 形态）→ `items`（数组元素，递归一层）→ 直接对象字面量的键。
 */
function nestedKeys(valueText, budget) {
  const out = new Set();
  const trimmed = valueText.trim();
  if (budget <= 0 || !trimmed.startsWith("{"))
    return { keys: out, spread: false };
  const { items, spread } = literalEntries(valueText);
  const byKey = new Map(items.map((e) => [e.key, e.valueText]));
  const props = byKey.get("properties");
  if (props !== undefined && props.trim().startsWith("{")) {
    const inner = literalEntries(props);
    for (const e of inner.items) out.add(e.key);
    return { keys: out, spread: spread || inner.spread };
  }
  const itemsValue = byKey.get("items");
  if (itemsValue !== undefined && itemsValue.trim().startsWith("{")) {
    const inner = nestedKeys(itemsValue, budget - 1);
    for (const key of inner.keys) out.add(key);
    return { keys: out, spread: spread || inner.spread };
  }
  // 直接对象字面量（cordis/schemastery 的对象子参数）
  for (const e of items) {
    if (SCHEMA_META.has(e.key)) continue;
    out.add(e.key);
  }
  return { keys: out, spread };
}

/**
 * 逐工具解析一个工具包源文件：返回
 * `[{ name?, nameExpr?, keys: string[], spread }]`（每个 `parameters` 块一条）。
 */
function parseTools(text) {
  const tools = [];
  const paramRe = /parameters\s*:\s*\{/g;
  let match;
  let cursor = 0;
  while ((match = paramRe.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchBrace(text, open);
    if (close < 0) continue;
    // 参数键：`parameters` 自身即键表；JSON-schema 形态取其 `properties`
    let entries = objectEntries(text, open, close);
    const props = entries.items.find((e) => e.key === "properties");
    if (props !== undefined && props.valueText.trim().startsWith("{")) {
      entries = literalEntries(props.valueText);
    }
    const keys = new Set();
    for (const entry of entries.items) {
      keys.add(entry.key);
      const nested = nestedKeys(entry.valueText, 2);
      for (const key of nested.keys) keys.add(key);
    }
    // 名字：本块之前最近的 `name: "x"`（不含其它 parameters 块内）
    const before = text.slice(cursor, open);
    const names = [...before.matchAll(/name\s*:\s*("([^"]*)"|'([^']*)')/g)];
    const exprs = [...before.matchAll(/name\s*:\s*([^\s,}\n][^,\n}]*)/g)];
    const last = names[names.length - 1];
    const tool = {
      keys: [...keys],
      spread: entries.spread,
      paramSpread: entries.spread,
    };
    const literalName = last === undefined ? undefined : (last[2] ?? last[3]);
    if (literalName !== undefined && /^[a-z][a-z_0-9]*$/.test(literalName)) {
      tool.name = literalName;
    } else {
      const expr = exprs[exprs.length - 1];
      tool.nameExpr =
        literalName !== undefined
          ? JSON.stringify(literalName)
          : expr === undefined
            ? "（未找到 name）"
            : expr[1].trim();
    }
    tools.push(tool);
    cursor = close;
  }
  return tools;
}

// ------------------------------------------------------- 键集 / 登记集的单一来源

/** 从 dist 模块读 TOOL_SURFACE（发布形态）。 */
function surfaceFromDist(mod) {
  const surface = mod.TOOL_SURFACE;
  if (
    surface === undefined ||
    !Array.isArray(surface.registered) ||
    !Array.isArray(surface.pathKeys) ||
    !Array.isArray(surface.commandKeys) ||
    !Array.isArray(surface.codeKeys) ||
    surface.pathKeys.length === 0 ||
    surface.commandKeys.length === 0 ||
    surface.registered.length === 0
  ) {
    return null;
  }
  return {
    registered: surface.registered,
    pathKeys: surface.pathKeys,
    commandKeys: surface.commandKeys,
    codeKeys: surface.codeKeys,
  };
}

/** 从 src/index.ts 文本解析同一份口径（仓库形态；登记表按 prettier 两空格缩进）。 */
function surfaceFromSource(text) {
  const listOf = (name) => {
    const m = new RegExp(
      `const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`,
    ).exec(text);
    return m === null
      ? null
      : [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  };
  const setOf = (name) => {
    const m = new RegExp(
      `${name}\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`,
    ).exec(text);
    return m === null
      ? null
      : [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  };
  const registryKeysOf = (name) => {
    const m = new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(text);
    return m === null
      ? null
      : [...m[1].matchAll(/^ {2}([a-z][a-z_0-9]*):/gm)].map((x) => x[1]);
  };
  const pathKeys = listOf("UNKNOWN_TOOL_PATH_KEYS");
  const commandKeys = listOf("UNKNOWN_TOOL_COMMAND_KEYS");
  const codeKeys = listOf("UNKNOWN_TOOL_CODE_KEYS");
  const registered = [
    ...(setOf("SHELL_TOOLS") ?? []),
    ...(setOf("RUN_CODE_TOOLS") ?? []),
    ...(setOf("FILE_TOOLS") ?? []),
    ...(registryKeysOf("PLUGIN_FILE_TOOLS") ?? []),
    ...(registryKeysOf("PLUGIN_COMMAND_TOOLS") ?? []),
  ];
  if (
    pathKeys === null ||
    commandKeys === null ||
    codeKeys === null ||
    registered.length === 0
  ) {
    return null;
  }
  return { registered, pathKeys, commandKeys, codeKeys };
}

/**
 * 载入口径来源：**dist 优先**（发布形态），`src` 作仓库内回退（dist 缺失 / 失效 / 比 src 旧时）；
 * 都解析不出 → 返回 null（调用方提示先 `npm run build` 并 exit 2，不静默用空键集）。
 */
async function loadSurface(pkgDir) {
  const distPath = join(pkgDir, "dist", "src", "index.js");
  const srcPath = join(pkgDir, "src", "index.ts");
  const distM = mtimeMs(distPath);
  const srcM = mtimeMs(srcPath);
  const distFirst = distM !== null && (srcM === null || distM >= srcM);
  const order = [];
  if (distFirst) order.push(["dist", distPath]);
  if (srcM !== null) order.push(["src", srcPath]);
  if (!distFirst && distM !== null) order.push(["dist", distPath]);
  for (const [origin, path] of order) {
    try {
      const surface =
        origin === "dist"
          ? surfaceFromDist(await import(pathToFileURL(path).href))
          : surfaceFromSource(readFileSync(path, "utf8"));
      if (surface !== null) {
        return {
          origin,
          path,
          fallbackFromStaleDist:
            origin === "src" && distM !== null && !distFirst,
          ...surface,
        };
      }
    } catch {
      /* 换下一个候选 */
    }
  }
  return null;
}

// ---------------------------------------------------------------- 宿主工具包发现

/** 收录一个 scope 目录（`@deepseek-ai`）下的 dsh-tool-* 包。 */
function collectScope(scopeDir, found) {
  let entries;
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("dsh-tool-")) continue;
    const file = join(scopeDir, entry.name, "lib", "index.js");
    if (isFile(file)) found.push({ pkg: entry.name, file });
  }
}

/**
 * 在 root 下找 `@deepseek-ai/dsh-tool-*` 包（只沿 `node_modules` 链下钻，限深 8，避免全树遍历）。
 * root 可以是：dsh 包目录（推荐指法）、安装树的 `node_modules` 目录、`@deepseek-ai` 父目录；
 * scope 层（`@deepseek-ai` 本身）由调用方先拦下给纠正提示。
 */
function findToolPackages(root, maxDepth = 8) {
  const found = [];
  const seen = new Set();
  const visit = (dir, depth) => {
    if (depth > maxDepth || seen.has(dir)) return;
    seen.add(dir);
    const scope =
      basename(dir) === "@deepseek-ai" ? dir : join(dir, "@deepseek-ai");
    if (isDir(scope)) {
      collectScope(scope, found);
      // 宿主插件包内嵌的 node_modules（如 <dsh>/node_modules/@deepseek-ai/dsh-tool-*/）
      let entries = [];
      try {
        entries = readdirSync(scope, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const nested = join(scope, entry.name, "node_modules");
        if (isDir(nested)) visit(nested, depth + 1);
      }
    }
    if (basename(dir).startsWith("dsh-tool-")) {
      const file = join(dir, "lib", "index.js");
      if (isFile(file)) found.push({ pkg: basename(dir), file });
    }
    const nested = join(dir, "node_modules");
    if (isDir(nested)) visit(nested, depth + 1);
  };
  visit(root, 0);
  return found;
}

/** scope 层判定：`@deepseek-ai` 目录，或直接含 `dsh-tool-*` 子目录的目录（--root 应指 dsh 包目录）。 */
function isScopeLayer(dir) {
  if (basename(dir) === "@deepseek-ai") return true;
  if (isDir(join(dir, "node_modules"))) return false;
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && entry.name.startsWith("dsh-tool-"),
    );
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------- 主流程

const args = parseArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, "..");

if (args.help === true) {
  console.log(USAGE);
  process.exit(0);
}
if (args.unknown !== undefined) {
  console.error(`[tool-surface-check] 未知参数：${args.unknown}`);
  console.error(USAGE);
  process.exit(2);
}
if (args.rootGiven === true && (args.root === undefined || args.root === "")) {
  console.error("[tool-surface-check] --root 缺值。");
  console.error(USAGE);
  process.exit(2);
}

const root = args.root ?? process.env.DSH_INSTALL;
if (root === undefined || root === "") {
  console.error(
    "[tool-surface-check] 缺少宿主目录：请用 --root <dsh 包目录 | 安装树根> 或设 DSH_INSTALL" +
      "（不再回退当前目录，避免扫到仓库自身）。",
  );
  console.error(USAGE);
  process.exit(2);
}

const absRoot = resolve(root);
const surface = await loadSurface(pkgDir);
if (surface === null) {
  console.error(
    `[tool-surface-check] 键集/登记集单一来源解析失败：${join(pkgDir, "dist", "src", "index.js")}（发布形态）` +
      `与 ${join(pkgDir, "src", "index.ts")}（仓库形态）都读不到可用口径。`,
  );
  console.error(
    "→ 先跑 `npm --prefix security-guard run build` 生成 dist；若已构建仍失败，检查引擎常量是否改名" +
      "（UNKNOWN_TOOL_PATH_KEYS / UNKNOWN_TOOL_COMMAND_KEYS / UNKNOWN_TOOL_CODE_KEYS / TOOL_SURFACE）。",
  );
  process.exit(2);
}

if (isScopeLayer(absRoot)) {
  console.error(
    `[tool-surface-check] --root 指到了 scope 层（${absRoot}）：其下直接是 dsh-tool-* 包目录。`,
  );
  console.error(
    "→ 请改指 **dsh 包目录**（其下含 node_modules/@deepseek-ai/dsh-tool-*），例如 " +
      ".../lib/node_modules/@deepseek-ai/dsh。",
  );
  console.error(
    "  扫 scope 层会把未挂载 / 其它版本的工具包也算进来、结果不可信，故直接退出（不静默绿）。",
  );
  console.error(USAGE);
  process.exit(2);
}

const packages = findToolPackages(absRoot);
if (packages.length === 0) {
  console.error(
    `[tool-surface-check] 未找到 dsh-tool-* 工具包（root：${absRoot}）。`,
  );
  console.error(
    "→ --root 要指 dsh 包目录（其下含 node_modules/@deepseek-ai/dsh-tool-*）或安装树根。",
  );
  console.error(USAGE);
  process.exit(2);
}

const registered = new Set(surface.registered);
const pathKeys = new Set(surface.pathKeys.map((k) => k.toLowerCase()));
const commandKeys = new Set(surface.commandKeys.map((k) => k.toLowerCase()));
const codeKeys = new Set(surface.codeKeys.map((k) => k.toLowerCase()));
/** 键类判定：path（敏感文件层）/ command（命令黑名单层）/ code（只做路径提取）。 */
const classOf = (key) => {
  const lower = key.toLowerCase();
  if (pathKeys.has(lower)) return "path";
  if (commandKeys.has(lower)) return "command";
  return codeKeys.has(lower) ? "code" : "";
};

const covered = new Set();
const uncoveredPlain = [];
const needAttention = [];
const unresolvedNames = [];
let toolCount = 0;

for (const pkg of packages) {
  let text = "";
  try {
    text = readFileSync(pkg.file, "utf8");
  } catch {
    continue;
  }
  for (const tool of parseTools(text)) {
    toolCount += 1;
    const watched = tool.keys.filter((key) => classOf(key) !== "");
    /** 命中键类标签（path / command / code 组合，如 `path+code`）。 */
    const kindOf = (keys) => {
      const classes = new Set(keys.map(classOf).filter((c) => c !== ""));
      return ["path", "command", "code"]
        .filter((c) => classes.has(c))
        .join("+");
    };
    if (tool.name === undefined) {
      const entry = {
        pkg: pkg.pkg,
        nameExpr: tool.nameExpr,
        keys: tool.keys,
        watched,
      };
      unresolvedNames.push(entry);
      // 名称解析不到但参数面命中 watched 键（如 workflow 的 script）→ 同样计入门禁（宁可多报）
      if (watched.length > 0) {
        needAttention.push({
          name: null,
          pkg: pkg.pkg,
          kind: kindOf(watched),
          keys: watched,
          note: `名称未解析（name: ${tool.nameExpr}）`,
        });
      }
      continue;
    }
    if (registered.has(tool.name)) {
      covered.add(tool.name);
      continue;
    }
    if (watched.length > 0) {
      needAttention.push({
        name: tool.name,
        pkg: pkg.pkg,
        kind: kindOf(watched),
        keys: watched,
      });
    } else if (tool.paramSpread) {
      // 顶层 `...` 展开：参数面不可静态判定 → 保守计入需关注（人工复核）
      needAttention.push({
        name: tool.name,
        pkg: pkg.pkg,
        kind: "参数面含展开",
        keys: [],
      });
    } else {
      uncoveredPlain.push({ name: tool.name, pkg: pkg.pkg });
    }
  }
}

const coveredList = [...covered].sort();
const attentionSorted = [...needAttention].sort((a, b) =>
  `${a.name ?? "\uffff"}${a.pkg}`.localeCompare(
    `${b.name ?? "\uffff"}${b.pkg}`,
  ),
);
const unresolvedSorted = [...unresolvedNames].sort((a, b) =>
  a.pkg.localeCompare(b.pkg),
);
const plainSorted = [...uncoveredPlain].sort((a, b) =>
  a.name.localeCompare(b.name),
);

/** 名字展示：名称未解析时给 `（名称未解析：<expr>）`。 */
const labelOf = (item) =>
  (item.name ?? "（名称未解析）") +
  `（${item.kind}，${item.pkg}${item.keys.length > 0 ? "：" + item.keys.join("/") : ""}）`;

if (args.json === true) {
  console.log(
    JSON.stringify(
      {
        root: absRoot,
        surfaceOrigin: surface.origin,
        surfacePath: surface.path,
        packages: packages.length,
        tools: toolCount,
        covered: coveredList,
        needAttention: attentionSorted,
        unresolvedNames: unresolvedSorted,
        uncoveredPlain: plainSorted,
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[tool-surface-check] 宿主目录：${absRoot}（${packages.length} 个 dsh-tool 包，解析出 ${toolCount} 个工具）`,
  );
  console.log(
    `[tool-surface-check] 键集/登记集来源：${surface.origin}（${surface.path}；逐工具解析 parameters，键名小写归一）` +
      (surface.fallbackFromStaleDist
        ? "　注意：dist 早于 src，已改用 src 解析，建议先 npm run build"
        : ""),
  );
  console.log(
    `已覆盖 ${coveredList.length}：${coveredList.join(", ") || "无"}`,
  );
  console.log(
    `需关注 ${attentionSorted.length}：` +
      (attentionSorted.length === 0
        ? "无"
        : attentionSorted.map(labelOf).join(", ")),
  );
  console.log(
    `名称未解析 ${unresolvedSorted.length}：` +
      (unresolvedSorted.length === 0
        ? "无"
        : unresolvedSorted
            .map(
              (item) =>
                `${item.pkg}（name: ${item.nameExpr}；参数键 ${item.keys.join("/") || "无"}）`,
            )
            .join(", ")),
  );
  console.log(
    `未覆盖但无路径/命令参数 ${plainSorted.length}：` +
      (plainSorted.length === 0
        ? "无"
        : plainSorted.map((item) => `${item.name}（${item.pkg}）`).join(", ")),
  );
  if (attentionSorted.length > 0) {
    console.log(
      "→ 这些工具不受敏感文件层 / 命令黑名单层保护：按真实参数面登记进 FILE_TOOLS 或两张插件登记表，" +
        '或先用 unknownToolPolicy: "check" 兜住（见 README「未登记工具」）。',
    );
  }
}

process.exit(attentionSorted.length > 0 ? 1 : 0);
