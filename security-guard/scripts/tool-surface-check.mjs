#!/usr/bin/env node
// scripts/tool-surface-check.mjs — 宿主工具面 vs security-guard 登记表 差异检查。
//
// 用途：宿主升版后跑一次，找出「security-guard 未登记、但携带路径/命令参数」的工具
// （这类工具会绕过敏感文件层 / 命令黑名单层，属需要关注的缺口）。
//
// 用法：
//   node scripts/tool-surface-check.mjs [--root <宿主安装树或 node_modules 的父目录>] [--json]
// 退出码：0 = 无「需关注」项（或找不到宿主目录）；1 = 有「需关注」项（可作门禁）。
//
// 口径说明：官方工具包的参数面没有统一机器可读的 schema 导出，这里用「在该工具包源文件里
// 是否出现路径/命令类键名」作启发式判定（保守：宁可多报，人工复核）。

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HIER = "node_modules";
const PKG_PREFIX = "@deepseek-ai/dsh-tool-";
const PATHISH = /\b(file_path|paths?|target|directory|dir)\b/;
const COMMANDISH =
  /\b(command|commandText|script|code|program|measureCmd|cmd)\b/;

/** 解析命令行参数（--root / --json）。 */
function parseArgs(argv) {
  const out = { root: undefined, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") out.root = argv[i + 1];
    else if (argv[i] === "--json") out.json = true;
  }
  return out;
}

/** 收集候选宿主目录（默认：环境变量 → 当前目录向上找 node_modules）。 */
function defaultRoots() {
  const roots = [];
  if (process.env.DSH_INSTALL) roots.push(process.env.DSH_INSTALL);
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    roots.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/** 在 root 下（限深度）找所有 @deepseek-ai/dsh-tool-<星号>/lib/index.js。 */
function findToolPackages(root, maxDepth = 8) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (entry.name === "@deepseek-ai") {
        for (const pkg of readdirSync(full, { withFileTypes: true })) {
          if (!pkg.isDirectory() || !pkg.name.startsWith("dsh-tool-")) continue;
          const idx = join(full, pkg.name, "lib", "index.js");
          try {
            if (statSync(idx).isFile())
              found.push({ pkg: pkg.name, file: idx });
          } catch {
            /* 跳过无 lib/index.js 的包 */
          }
        }
      }
      // 继续下钻（宿主的插件包常嵌在 @deepseek-ai/dsh/node_modules/@deepseek-ai/ 下）
      if (entry.name === HIER || depth < 6) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** 从工具包源文件里抽工具名（name: "x"）与「是否带路径/命令参数」。 */
function inspectPackage(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { names: [], pathish: false, commandish: false };
  }
  const names = new Set();
  for (const match of text.matchAll(/name:\s*"([a-z][a-z_0-9]*)"/g)) {
    names.add(match[1]);
  }
  return {
    names: [...names],
    pathish: PATHISH.test(text),
    commandish: COMMANDISH.test(text),
  };
}

/** 从 src/index.ts 文本解析 security-guard 的登记集合（文件会被格式化，故用宽松正则）。 */
function registryNames(srcPath) {
  const text = readFileSync(srcPath, "utf8");
  const pick = (re) => {
    const out = new Set();
    for (const m of text.matchAll(re)) out.add(m[1]);
    return out;
  };
  const fileTools = pick(/FILE_TOOLS\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/g);
  const fileToolNames = new Set(
    [...fileTools].flatMap((chunk) =>
      [...chunk.matchAll(/"([a-z][a-z_0-9]*)"/g)].map((m) => m[1]),
    ),
  );
  const pluginFile = new Set();
  const pluginFileBlock = /PLUGIN_FILE_TOOLS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(
    text,
  );
  if (pluginFileBlock) {
    for (const m of pluginFileBlock[1].matchAll(/^\s*([a-z][a-z_0-9]*):/gm)) {
      pluginFile.add(m[1]);
    }
  }
  const pluginCmd = new Set();
  const pluginCmdBlock = /PLUGIN_COMMAND_TOOLS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(
    text,
  );
  if (pluginCmdBlock) {
    for (const m of pluginCmdBlock[1].matchAll(/^\s*([a-z][a-z_0-9]*):/gm)) {
      pluginCmd.add(m[1]);
    }
  }
  const shell = new Set();
  const shellBlock = /SHELL_TOOLS\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/.exec(
    text,
  );
  if (shellBlock) {
    for (const m of shellBlock[1].matchAll(/"([a-z][a-z_0-9]*)"/g))
      shell.add(m[1]);
  }
  return {
    covered: new Set([...fileToolNames, ...pluginFile, ...pluginCmd, ...shell]),
  };
}

const args = parseArgs(process.argv.slice(2));
const here = dirname(fileURLToPath(import.meta.url));
const registry = registryNames(join(here, "..", "src", "index.ts"));

const roots = args.root === undefined ? defaultRoots() : [args.root];
let packages = [];
let usedRoot;
for (const root of roots) {
  const abs = resolve(root);
  const found = findToolPackages(abs);
  if (found.length > 0) {
    packages = found;
    usedRoot = abs;
    break;
  }
}

if (packages.length === 0) {
  console.log(
    "[tool-surface-check] 未找到宿主工具包（找过：" +
      roots.map((r) => resolve(r)).join(", ") +
      "）；用 --root <安装树> 指定，或设 DSH_INSTALL。",
  );
  process.exit(0);
}

const covered = [];
const needAttention = [];
const uncoveredPlain = [];
for (const pkg of packages) {
  const info = inspectPackage(pkg.file);
  for (const name of info.names) {
    if (registry.covered.has(name)) {
      covered.push(name);
      continue;
    }
    if (info.pathish || info.commandish) {
      needAttention.push({
        name,
        pkg: pkg.pkg,
        kind:
          info.pathish && info.commandish
            ? "path+command"
            : info.pathish
              ? "path"
              : "command",
      });
    } else {
      uncoveredPlain.push(name);
    }
  }
}

if (args.json) {
  console.log(
    JSON.stringify(
      { root: usedRoot, covered, needAttention, uncoveredPlain },
      null,
      2,
    ),
  );
} else {
  console.log(
    `[tool-surface-check] 宿主目录：${usedRoot}（${packages.length} 个 dsh-tool 包）`,
  );
  console.log(`已覆盖 ${covered.length}：${covered.sort().join(", ")}`);
  console.log(
    `需关注 ${needAttention.length}：` +
      (needAttention.length === 0
        ? "无"
        : needAttention
            .map((item) => `${item.name}（${item.kind}，${item.pkg}）`)
            .sort()
            .join(", ")),
  );
  console.log(
    `未覆盖但无路径/命令参数 ${uncoveredPlain.length}：${uncoveredPlain.sort().join(", ") || "无"}`,
  );
  if (needAttention.length > 0) {
    console.log(
      "→ 这些工具不受敏感文件层 / 命令黑名单层保护：按真实参数面登记进 FILE_TOOLS 或两张插件登记表（见 README「未登记工具」）。",
    );
  }
}

process.exit(needAttention.length > 0 ? 1 : 0);
