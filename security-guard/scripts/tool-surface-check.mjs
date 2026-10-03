#!/usr/bin/env node
// scripts/tool-surface-check.mjs — 宿主工具面 vs security-guard 登记表 差异检查（2026-10-02 重写）。
//
// 用途：宿主升版后跑一次，找出「security-guard 未登记、但携带路径/命令参数」的工具
// （这类工具会绕过敏感文件层 / 命令黑名单层，属需要关注的缺口）。
//
// **覆盖边界**：只扫 `@deepseek-ai/dsh-tool-*` 包。**不在面内**的三类：其它官方包（非 `dsh-tool-*` 命名，
// 已纳入面内 —— `dsh-tool-*` 无条件纳入；其它 `dsh-*` 官方包按内容判定（`lib/index.js` 含 `defineTool(`），如 `dsh-plan-mode` /
// `dsh-experimental-tool-agent-team`；仅含 `parameters:` 的包（含 MCP 客户端）**不纳入**并在摘要单列提示）、
// MCP 工具与第三方运行时注册的工具（宿主不可静态枚举）；
// 故**不提供** `--include-mcp` 之类开关（只会产生假覆盖率）——摘要**固定输出**这行边界（`--json` 的
// `boundary` 字段同内容 + 布尔字段 `coversMcpTools` / `exitZeroMeansFullCoverage`），`exit 0` **不等于**全覆盖。
//
// 用法：
//   node security-guard/scripts/tool-surface-check.mjs --root <dsh 包目录 | 安装树根> [--json]
//   DSH_INSTALL=<同上> node security-guard/scripts/tool-surface-check.mjs
// 退出码：0 = 无「需关注」项（可作门禁通过）；1 = 有「需关注」项；
//         2 = 用法 / 环境 / 口径错误（缺 --root、根下找不到含 defineTool( 的 @deepseek-ai/dsh-* 包、
//             键集单一来源解析失败）。
//
// 口径（对齐引擎，不再整包文本 grep）：
// 1) **逐工具**解析工具包源码的 `defineTool({ ... })`：
//    - `name: "x"` → 工具名；`name` 为计算值（`toolName` / `run.meta.name`）→ 计入「名称未解析」；
//    - `parameters` 对象字面量的键 = 工具参数键；`parameters.properties`（JSON-schema 形态）取其键；
//    - 递归下钻**上限 = 引擎的键深上限**（`TOOL_SURFACE.keyDepth`，即 `UNKNOWN_TOOL_KEY_DEPTH`；
//      顶层 → 数组元素键 → 其对象成员键 → 再一层数组元素键；数组经 `items` 透明、不额外消费深度）
//      ——脚本不再自维护深度数字；另设**分析步数上限**（`MAX_PARAM_KEY_STEPS`）防病态深层嵌套
//      把递归栈打爆、耗尽即停止下探。
// 2) **键集 + 键深单一来源**：路径 / 命令 / 代码三类键、已登记工具名与**键深上限**取自本包
//    `src/index.ts` 的 `UNKNOWN_TOOL_PATH_KEYS` / `UNKNOWN_TOOL_COMMAND_KEYS` /
//    `UNKNOWN_TOOL_CODE_KEYS` / `UNKNOWN_TOOL_KEY_DEPTH` / `TOOL_SURFACE`
//    （发布形态优先读已构建的 `dist/src/index.js`，`src` 作仓库内回退；dist 早于 src 时改用 src
//    并提示，避免读到过期口径）——脚本不再自维护一份键表（旧版两处键集互不一致）。
//    两者都读不到（含缺 `keyDepth`）→ **提示先 build 并 exit 2**，不静默当作无规则 / 无深度。
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
  "      0 仅指上述面内无「需关注」项：不覆盖仅含 parameters: 的包、",
  "      也不覆盖 MCP / 第三方运行时注册的工具。",
].join("\n");

/**
 * **覆盖边界**（固定一行输出；`--json` 的 `boundary` 字段同内容）：
 * 脚本扫宿主安装树里的 `@deepseek-ai/dsh-tool-*`（**无条件**）+ **其它 `@deepseek-ai/dsh-*` 包中
 * `lib/index.js` 含 `defineTool(` 的**（如 `dsh-plan-mode` / `dsh-schedule` / `dsh-experimental-tool-agent-team`）；
 * 仅含 `parameters:` 的包**不纳入**（摘要单列提示，`--json` 见 `parametersOnly`）。**仍在面外**：MCP / 第三方
 * 运行时注册的工具名（宿主不可静态枚举）与 profile 侧第三方插件，用 `unknownToolAllowlist`（如 `mcp__*`）或按真实参数面登记。
 *
 * 文案只供人读、措辞可能变：机器判**稳定语义**请用 `--json` 的布尔字段
 * `coversMcpTools: false` / `exitZeroMeansFullCoverage: false`，勿整串比对 `boundary`。
 */
const BOUNDARY =
  "扫 dsh-tool-* 包 + 其它含 defineTool( 的 @deepseek-ai/dsh-* 包（如 dsh-plan-mode / dsh-schedule）；" +
  "疑似注册面（含 tools.register( 或 parameters: 但无 defineTool(，如 MCP 客户端）与第三方运行时注册的工具不在面内（摘要单列），" +
  "需用 unknownToolAllowlist（如 mcp__*）或按真实参数面登记；exit 0 不等于全覆盖。";

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
 * 参数发现键深上限：**来自引擎单一来源** `TOOL_SURFACE.keyDepth`（此处只是载入前的占位缺省；
 * 载入失败会 `exit 2`，绝不会拿占位值继续跑）。与引擎 `UNKNOWN_TOOL_KEY_DEPTH` 同源。
 */
let paramKeyDepth = 3;

/**
 * 参数发现**分析步数**上限（防炸栈）：每个递归帧递减、耗尽即**停止下探**（不抛错）。
 * `items` 与数组同层（不吃键深），病态的深层嵌套源码同样能把递归栈打爆 —— 与引擎同款防护
 * （引擎侧为 `MAX_WALK_DEPTH = 64` 层嵌套 + `MAX_WALK_NODES` 节点上限）；脚本只分析已安装包的
 * schema 文本（非模型输入），故只保留防炸栈这一个上限。
 */
const MAX_PARAM_KEY_STEPS = 64;

/**
 * 取参数值里第 `level` 层起的参数键（模拟引擎的键名启发深度，上限 `paramKeyDepth`）：
 * `properties` 子对象优先（JSON-schema 形态）→ 其余直接对象字面量的键（cordis/schemastery）→
 * 每层再对**参数值**下钻一层（`level + 1`）；`items`（数组元素）**与数组同层**、递归时 `level` 不变，
 * 故 `children[].acceptance[].command` 这类两层嵌套能发现、再深一层即停（与引擎同口径）。
 * `budget` 为本次顶层调用的步数预算（省略即新建，递归时透传）：耗尽只**停止下探**、不抛错。
 */
function nestedKeys(valueText, level, budget = { left: MAX_PARAM_KEY_STEPS }) {
  const out = new Set();
  const trimmed = valueText.trim();
  if (budget.left <= 0 || level > paramKeyDepth || !trimmed.startsWith("{")) {
    return { keys: out, spread: false };
  }
  budget.left -= 1;
  const { items, spread } = literalEntries(valueText);
  const byKey = new Map(items.map((e) => [e.key, e.valueText]));
  let seenSpread = spread;
  const props = byKey.get("properties");
  const entries =
    props !== undefined && props.trim().startsWith("{")
      ? literalEntries(props).items
      : items.filter((e) => !SCHEMA_META.has(e.key));
  for (const e of entries) {
    out.add(e.key);
    const inner = nestedKeys(e.valueText, level + 1, budget);
    for (const key of inner.keys) out.add(key);
    seenSpread = seenSpread || inner.spread;
  }
  // 数组透明：`{ type: "array", items: { properties: {...} } }` 的 items 与数组同层
  const itemsValue = byKey.get("items");
  if (itemsValue !== undefined && itemsValue.trim().startsWith("{")) {
    const inner = nestedKeys(itemsValue, level, budget);
    for (const key of inner.keys) out.add(key);
    seenSpread = seenSpread || inner.spread;
  }
  return { keys: out, spread: seenSpread };
}

/**
 * 逐工具解析一个工具包源文件：返回
 * `[{ name?, nameExpr?, keys: string[], spread }]`（每个 `parameters` 块一条）。
 */
/**
 * 收集 `defineTool` 体内**深度 0** 的 `name:` 取值（字符串 / 注释感知：单双引号、模板串、行注释与块注释）。
 * 深度 ≥1（嵌套对象 / 数组里的 `name:`）一律忽略 —— 它们不是本工具的名字（BACKLOG「名称解析残余 (a)」）。
 * 返回按出现顺序的 `{ literal?: string, expr?: string }`（字面量给 `literal`，计算值给去空白的 `expr`）。
 */
function topLevelNameValues(slice) {
  const out = [];
  let depth = 0;
  // 切片自 `(` 之后开始：若形如 `{ ...`，先跳过多余的开括号（否则顶层键会被算成深度 1）
  const lead = /^\s*\{/.exec(slice);
  let i = lead === null ? 0 : lead[0].length;
  let state = null;
  /** 最近一次消费的**非空白**字符（判 `/` 是正则字面量还是除号）。 */
  let prev = "";
  while (i < slice.length) {
    const c = slice[i];
    const d = slice[i + 1];
    if (state === null) {
      if (c === "/" && d === "/") {
        state = "//";
        i += 2;
        continue;
      }
      if (c === "/" && d === "*") {
        state = "/*";
        i += 2;
        continue;
      }
      if (c === "/" && isRegexStart(prev, slice, i)) {
        // 正则字面量：整段跳过（不参与配平），避免 `/[)]/` 里的 `)` 造成深度漂移
        i = skipRegex(slice, i);
        prev = "/";
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        state = c;
        prev = c;
        i += 1;
        continue;
      }
      if (c === "{" || c === "[" || c === "(") {
        depth += 1;
        prev = c;
        i += 1;
        continue;
      }
      if (c === "}" || c === "]" || c === ")") {
        depth -= 1;
        prev = c;
        i += 1;
        continue;
      }
      if (
        depth === 0 &&
        slice.startsWith("name", i) &&
        /[\s:]/.test(slice[i + 4] ?? "") &&
        !/[A-Za-z0-9_$]/.test(prev)
      ) {
        const rest = slice.slice(i + 4);
        const lit = /^\s*:\s*("([^"]*)"|'([^']*)')/.exec(rest);
        if (lit !== null) {
          out.push({ literal: lit[2] ?? lit[3] });
          i += 4 + lit[0].length;
          prev = '"';
          continue;
        }
        const expr = /^\s*:\s*([^\s,}\n][^,\n}]*)/.exec(rest);
        if (expr !== null) {
          // 表达式取值：按括号配平跳到该表达式结束（`, ` 或所属对象收尾），避免内部括号影响深度
          const exprStart = i + 4 + expr[0].indexOf(expr[1]);
          const exprEnd = skipExpression(slice, exprStart);
          out.push({ expr: slice.slice(exprStart, exprEnd).trim() });
          i = exprEnd;
          prev = ")";
          continue;
        }
      }
      if (!/\s/.test(c)) prev = c;
      i += 1;
    } else if (state === "//") {
      if (c === "\n") state = null;
      i += 1;
    } else if (state === "/*") {
      if (c === "*" && d === "/") {
        state = null;
        i += 2;
        continue;
      }
      i += 1;
    } else {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === state) state = null;
      i += 1;
    }
  }
  return out;
}

/** `/` 是否可能是正则字面量起始（按前一个非空白字符启发式判定）。 */
function isRegexStart(prev, slice, at) {
  if (prev === "" || "([{!&|?:;,=+-*%<>~^".includes(prev)) return true;
  // 关键字回看：`return /re/`、`typeof /re/`、`case /re/`… 的 `/` 也是正则
  const head = slice.slice(0, at);
  const word = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(head);
  return (
    word !== null &&
    /^(return|typeof|case|in|of|instanceof|new|delete|void|do|else|yield|await)$/.test(
      word[1],
    )
  );
}

/** 跳过一个正则字面量（识别 `[...]` 字符类与 `\` 转义）；未闭合时保守停在换行。 */
function skipRegex(slice, start) {
  let i = start + 1;
  let inClass = false;
  while (i < slice.length) {
    const c = slice[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
    else if (c === "\n") return i;
    i += 1;
  }
  return i;
}

/**
 * 跳过一段表达式取值（`name: <expr>`）：按括号配平前进，遇到**相对深度 0** 的 `,` 或
 * 所属对象的收尾 `}` 即停；字符串 / 注释 / 正则同样跳过（避免内部符号扰乱深度）。
 */
/** `skipExpression` 用的「前一个非空白字符」计算（判 `/` 是否正则）。 */
function prevCharExpr(slice, at) {
  let j = at - 1;
  while (j >= 0) {
    const c = slice[j];
    if (/\s/.test(c)) {
      j -= 1;
      continue;
    }
    if (c === ")") {
      // 回看配对括号前的字符（`mk() /x/` 之类少见，保守取 `)`）
      return ")";
    }
    return c;
  }
  return "";
}

function skipExpression(slice, start) {
  let d = 0;
  let i = start;
  while (i < slice.length) {
    const c = slice[i];
    const d2 = slice[i + 1];
    if (c === '"' || c === "'" || c === "`") {
      i += 1;
      while (i < slice.length) {
        if (slice[i] === "\\") {
          i += 2;
          continue;
        }
        if (slice[i] === c) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "/" && d2 === "/") {
      const j = slice.indexOf("\n", i);
      i = j < 0 ? slice.length : j;
      continue;
    }
    if (c === "/" && d2 === "*") {
      const j = slice.indexOf("*/", i + 2);
      i = j < 0 ? slice.length : j + 2;
      continue;
    }
    if (c === "/" && isRegexStart(prevCharExpr(slice, i), slice, i)) {
      i = skipRegex(slice, i);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") d += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (d === 0) return i;
      d -= 1;
    } else if (c === "," && d === 0) return i;
    i += 1;
  }
  return i;
}

/**
 * 向前找**包住当前 `parameters` 块**的最近的 `defineTool(`：返回其对象体起点（`(` 之后的下标）；
 * 找不到（不在任何 `defineTool` 内）时返回 `undefined`（此时名称按「未找到」保守处理）。
 */
function enclosingDefineToolStart(text, from, open) {
  const head = text.slice(from, open);
  const found = [...head.matchAll(/defineTool\s*\(/g)];
  const last = found[found.length - 1];
  if (last === undefined) return undefined;
  const parenIndex = from + last.index + last[0].length - 1;
  const bodyStart = parenIndex + 1;
  const bodyEnd = matchBrace(text, parenIndex);
  return bodyEnd > open ? bodyStart : undefined;
}

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
      // 顶层键 = 第 1 层；参数值里的键从第 2 层起递归发现（上限 paramKeyDepth，来自引擎）
      const nested = nestedKeys(entry.valueText, 2);
      for (const key of nested.keys) keys.add(key);
    }
    // 名字只在**同一个 `defineTool({...})` 对象体内**解析（BACKLOG「名称误配」）：
    // 旧实现取「本块之前的整段文本」里的最近 `name:`，会误取体外字面量（如 slash 命令名 `plan`，
    // 或前置的 `name: "read"`），导致**取错名字甚至静默假阴性（exit 0）**。
    const bodyStart = enclosingDefineToolStart(text, cursor, open);
    const before = bodyStart === undefined ? "" : text.slice(bodyStart, open);
    // 只取**深度 0**（同一 defineTool 对象体顶层）的 `name:` —— 修「同体嵌套 name 顶替」
    // （如 `meta:{ name:"read" }` 会把工具报成已覆盖 read → exit 0 静默假阴性）
    const topNames = topLevelNameValues(before);
    const tool = {
      keys: [...keys],
      spread: entries.spread,
      paramSpread: entries.spread,
    };
    const last = topNames[topNames.length - 1];
    const literalName = last?.literal;
    if (literalName !== undefined && /^[a-z][a-z_0-9]*$/.test(literalName)) {
      tool.name = literalName;
    } else {
      tool.nameExpr =
        literalName !== undefined
          ? JSON.stringify(literalName)
          : last?.expr !== undefined
            ? last.expr
            : "（未找到 name）";
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
    !Number.isInteger(surface.keyDepth) ||
    surface.keyDepth < 1 ||
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
    keyDepth: surface.keyDepth,
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
  /** 键深上限（键名启发 / check 扫描同源）：`const UNKNOWN_TOOL_KEY_DEPTH = N;`。 */
  const keyDepthOf = () => {
    const m = /const\s+UNKNOWN_TOOL_KEY_DEPTH\s*=\s*(\d+)\s*;/.exec(text);
    return m === null ? null : Number(m[1]);
  };
  const keyDepth = keyDepthOf();
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
    keyDepth === null ||
    keyDepth < 1 ||
    registered.length === 0
  ) {
    return null;
  }
  return { registered, pathKeys, commandKeys, codeKeys, keyDepth };
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

/**
 * 收录一个 scope 目录（`@deepseek-ai`）下的 `dsh-*` 包，**按内容分类**：
 * - `lib/index.js` 里出现 `defineTool(` → 纳入扫描面（found）；
 * - 含 `tools.register(` 或 `parameters:` 而无 `defineTool(` → 记入 `parametersOnly`（「疑似注册面」；摘要单列提示，
 *   不纳入面 —— 避免噪声与假覆盖）；
 * - 两者都无 → 忽略（宿主里绝大多数包属此类）。
 */
function collectScope(scopeDir, found, parametersOnly, seenPkgs) {
  let entries;
  try {
    entries = readdirSync(scopeDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith("dsh-") || !isDir(join(scopeDir, entry.name)))
      continue;
    const file = join(scopeDir, entry.name, "lib", "index.js");
    if (!isFile(file)) continue;
    const text = readText(file);
    const inFace =
      entry.name.startsWith("dsh-tool-") || text.includes("defineTool(");
    // 同名多副本：**按内容择优**（含 defineTool( 的副本优先）——外层 stub 不得遮蔽内层真包
    if (inFace) {
      if (!found.some((f) => f.pkg === entry.name)) {
        found.push({ pkg: entry.name, file });
      }
      const i = parametersOnly.indexOf(entry.name);
      if (i >= 0) parametersOnly.splice(i, 1);
    } else if (
      (text.includes("tools.register(") || text.includes("parameters:")) &&
      !seenPkgs.has(entry.name) &&
      !found.some((f) => f.pkg === entry.name)
    ) {
      parametersOnly.push(entry.name);
    }
    seenPkgs.add(entry.name);
  }
}

/** 读文本文件（读不到按空串 —— 内容判定失败时不误纳入面）。 */
function readText(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * 在 root 下找 `@deepseek-ai/dsh-tool-*` 包（只沿 `node_modules` 链下钻，限深 8，避免全树遍历）。
 * root 可以是：dsh 包目录（推荐指法）、安装树的 `node_modules` 目录、`@deepseek-ai` 父目录；
 * scope 层（`@deepseek-ai` 本身）由调用方先拦下给纠正提示。
 */
function findToolPackages(root, maxDepth = 8) {
  const found = [];
  const parametersOnly = [];
  const seenPkgs = new Set();
  const seen = new Set();
  const visit = (dir, depth) => {
    if (depth > maxDepth || seen.has(dir)) return;
    seen.add(dir);
    const scope =
      basename(dir) === "@deepseek-ai" ? dir : join(dir, "@deepseek-ai");
    if (isDir(scope)) {
      collectScope(scope, found, parametersOnly, seenPkgs);
      // 宿主插件包内嵌的 node_modules（如 <dsh>/node_modules/@deepseek-ai/dsh-tool-*/）
      let entries = [];
      try {
        entries = readdirSync(scope, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!isDir(join(scope, entry.name))) continue;
        const nested = join(scope, entry.name, "node_modules");
        if (isDir(nested)) visit(nested, depth + 1);
      }
    }
    if (basename(dir).startsWith("dsh-") && isDir(dir)) {
      const name = basename(dir);
      const file = join(dir, "lib", "index.js");
      if (isFile(file)) {
        const text = readText(file);
        const inFace =
          name.startsWith("dsh-tool-") || text.includes("defineTool(");
        if (inFace && !found.some((f) => f.pkg === name)) {
          found.push({ pkg: name, file });
          const i = parametersOnly.indexOf(name);
          if (i >= 0) parametersOnly.splice(i, 1);
        } else if (
          !inFace &&
          (text.includes("tools.register(") || text.includes("parameters:")) &&
          !seenPkgs.has(name) &&
          !found.some((f) => f.pkg === name)
        ) {
          parametersOnly.push(name);
        }
        seenPkgs.add(name);
      }
    }
    const nested = join(dir, "node_modules");
    if (isDir(nested)) visit(nested, depth + 1);
  };
  visit(root, 0);
  return { found, parametersOnly };
}

/** scope 层判定：`@deepseek-ai` 目录，或直接含 `dsh-tool-*` 子目录的目录（--root 应指 dsh 包目录）。 */
function isScopeLayer(dir) {
  if (basename(dir) === "@deepseek-ai") return true;
  if (isDir(join(dir, "node_modules"))) return false;
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) => entry.name.startsWith("dsh-") && isDir(join(dir, entry.name)),
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
      "（UNKNOWN_TOOL_PATH_KEYS / UNKNOWN_TOOL_COMMAND_KEYS / UNKNOWN_TOOL_CODE_KEYS / " +
      "UNKNOWN_TOOL_KEY_DEPTH / TOOL_SURFACE）。",
  );
  process.exit(2);
}

// 参数发现深度与引擎**同源**（`TOOL_SURFACE.keyDepth`；缺失时上面已 exit 2，不会用占位值继续跑）
paramKeyDepth = surface.keyDepth;

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

const { found: packages, parametersOnly } = findToolPackages(absRoot);
if (packages.length === 0) {
  console.error(
    `[tool-surface-check] 未找到含工具定义的 @deepseek-ai/dsh-* 包（root：${absRoot}）。`,
  );
  console.error(
    "→ --root 要指 dsh 包目录（其下含 node_modules/@deepseek-ai/dsh-*）或安装树根。",
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
/** 面内包但**解析到 0 个工具**（动态构造，如 `parameters: normalized.spec`）——单列提示。 */
const zeroToolPackages = [];
let toolCount = 0;

for (const pkg of packages) {
  let text = "";
  try {
    text = readFileSync(pkg.file, "utf8");
  } catch {
    continue;
  }
  const parsedTools = parseTools(text);
  if (parsedTools.length === 0) zeroToolPackages.push(pkg.pkg);
  for (const tool of parsedTools) {
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
        boundary: BOUNDARY,
        // 稳定语义（勿整串比对上面的中文文案）：本脚本不覆盖 MCP 工具、exit 0 也不代表全覆盖
        // 语义：含 `tools.register(` 或 `parameters:` 但无 `defineTool(` 的「疑似注册面」包
        // （字段名 `parametersOnly` 为历史名、语义偏窄；新名见下，二者同值）
        parametersOnly: [...parametersOnly].sort(),
        suspectRegistryPackages: [...parametersOnly].sort(),
        zeroToolPackages: [...zeroToolPackages].sort(),
        coversMcpTools: false,
        exitZeroMeansFullCoverage: false,
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
    `[tool-surface-check] 宿主目录：${absRoot}（${packages.length} 个含工具定义的 @deepseek-ai/dsh-* 包，解析出 ${toolCount} 个工具）`,
  );
  if (parametersOnly.length > 0) {
    console.log(
      `[tool-surface-check] 另有 ${parametersOnly.length} 个包疑似注册面但无法静态解析（未见 defineTool(）` +
        `（含 MCP 客户端等运行时注册面）：${parametersOnly.slice(0, 6).join(" / ")}` +
        (parametersOnly.length > 6 ? " …" : ""),
    );
  }
  if (zeroToolPackages.length > 0) {
    console.log(
      `[tool-surface-check] 注意：${zeroToolPackages.length} 个面内包**解析到 0 个工具**（可能为动态构造（如 parameters: <变量>）` +
        `或非 defineTool 注册面（如 tools/execute 中间件）—— 其注册的工具看不见）：${zeroToolPackages.slice(0, 6).join(" / ")}` +
        (zeroToolPackages.length > 6 ? " …" : ""),
    );
  }
  console.log(
    `[tool-surface-check] 键集/登记集来源：${surface.origin}（${surface.path}；逐工具解析 parameters，键名小写归一，` +
      `参数发现深度上限 ${paramKeyDepth} 层（引擎 TOOL_SURFACE.keyDepth 单一来源，数组透明））` +
      (surface.fallbackFromStaleDist
        ? "　注意：dist 早于 src，已改用 src 解析，建议先 npm run build"
        : ""),
  );
  // 固定一行覆盖边界（不随结果变化）：扫不到 MCP / 第三方工具，exit 0 不等于全覆盖
  console.log(`[tool-surface-check] 覆盖边界：${BOUNDARY}`);
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
