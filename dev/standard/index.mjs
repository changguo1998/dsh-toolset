// dev/standard/index.mjs — 文档与注释标准检查器入口: 只报不改

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkPackage, checkTsconfig } from "./json.mjs";
import {
  anchorExists,
  classifyLink,
  resolveLink,
  targetExists,
} from "./links.mjs";
import {
  collectLinks,
  headings,
  maskMarkdown,
  tableIssues,
} from "./markdown.mjs";
import {
  ARCHIVE_PATTERNS,
  DOC_HOST_DIR,
  SYMBOLS,
  VARIANTS,
  isExemptLine,
  isSymbolExemptFile,
  isSymbolExemptLine,
  isTermExemptFile,
  isTermFalsePositive,
  loadGlossary,
} from "./rules.mjs";
import { collectComments } from "./ts-comments.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKIP_DIRS = new Set(["node_modules", "dist", "tmp", "archive"]);
/** 隐藏目录（`.git`、评审产物 `.pi-glla` 等）与产物目录一律不参与检查。 */
const skipDir = (name) => SKIP_DIRS.has(name) || name.startsWith(".");

const ALL = process.argv.includes("--all");
const STRICT = process.argv.includes("--strict");
const RULE_FILTER = (() => {
  const index = process.argv.indexOf("--rule");
  return index >= 0 ? process.argv[index + 1] : undefined;
})();
const MAX_PER_RULE = 20;
const hits = [];
const report = (rule, severity, file, line, message) =>
  hits.push({ rule, severity, file, line, message });

/** 递归收集文件（跳过依赖、产物与临时目录）。 */
function walk(dir, accept, out = []) {
  for (const name of readdirSync(dir)) {
    if (skipDir(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(name)) out.push(full);
  }
  return out;
}

const markdownFiles = walk(ROOT, (name) => name.endsWith(".md"))
  .map((file) => relative(ROOT, file))
  .filter((file) => !ARCHIVE_PATTERNS.some((pattern) => pattern.test(file)))
  .sort();
const tsFiles = walk(
  ROOT,
  (name) => name.endsWith(".ts") || name.endsWith(".mts"),
);
const packageFiles = tsFiles.length; // 仅用于摘要里的文件计数
void packageFiles;

const glossary = loadGlossary(ROOT);

/** 符号与变体检查（Markdown 正文与 `.ts` 注释）：行内代码与白名单符号不参与审查。 */
function checkSymbols(rule, file, line, text) {
  if (isSymbolExemptFile(file) || isSymbolExemptLine(text)) return;
  const prose = text.replace(/`+[^`]*`+/g, (m) => m.replace(/[^\n]/g, " "));
  const masked = Array.from(prose, (ch) =>
    SYMBOLS.includes(ch) ? " " : ch,
  ).join("");
  for (const [variant, replacement] of Object.entries(VARIANTS)) {
    if (prose.includes(variant))
      report(
        rule + ".variant",
        "error",
        file,
        line,
        `变体 \`${variant}\` 应写作 \`${replacement}\``,
      );
  }
  const emojis = new Set(masked.match(/\p{Extended_Pictographic}/gu) ?? []);
  for (const emoji of emojis) {
    report(
      rule + ".emoji",
      "error",
      file,
      line,
      `方框外出现 emoji \`${emoji}\`（改用白名单符号或文字）`,
    );
  }
}

/** 术语: 旧称命中；豁免行与「同时含替换后术语」的规则说明行。 */
function checkTerms(file, line, text, onlyInterface = false) {
  if (isExemptLine(text) || isTermExemptFile(file)) return;
  for (const row of glossary) {
    if (row.conditional) continue;
    if (onlyInterface && row.ruleId !== "term.interface") continue;
    const hit = row.from.find((name) => text.includes(name));
    if (hit === undefined || isTermFalsePositive(hit, text)) continue;
    const replacement = row.to.split(" / ")[0];
    if (replacement !== undefined && text.includes(replacement)) continue;
    const severity = "error";
    report(row.ruleId, severity, file, line, `旧称 \`${hit}\` → \`${row.to}\``);
  }
}

/** 数量断言: 只认「本仓 / 本项目」口径与「N 个包（TUI 与 M 个插件）」规范句式。 */
function checkCounts(file, line, text) {
  if (text.includes("审计") || text.includes("快照") || isTermExemptFile(file))
    return;
  for (const match of text.matchAll(/(\d+)\s*个包（?TUI 与 (\d+)\s*个插件/g)) {
    if (Number(match[1]) !== 34 || Number(match[2]) !== 33) {
      report(
        "count.packages",
        "error",
        file,
        line,
        `\`${match[0]}\` 应为 \`34 个包（TUI 与 33 个插件）\``,
      );
    }
  }
  for (const match of text.matchAll(
    /(?:本仓|本项目|仓库)(?:现有|现为|共有|有|的)?\s*(\d+)\s*个包(?!（?TUI)/g,
  )) {
    if (Number(match[1]) !== 34)
      report(
        "count.packages",
        "error",
        file,
        line,
        `\`${match[0]}\` 与实际的 34 个包不符`,
      );
  }
  for (const match of text.matchAll(
    /(?:本仓|本项目)(?:现有|现为|共有|有|的)?\s*(\d+)\s*个插件/g,
  )) {
    if (Number(match[1]) !== 33)
      report(
        "count.plugins",
        "error",
        file,
        line,
        `\`${match[0]}\` 与实际的 33 个插件不符`,
      );
  }
}

/** Markdown: 符号、术语、数量、断链、表格列数。 */
for (const file of markdownFiles) {
  const absolute = join(ROOT, file);
  const text = readFileSync(absolute, "utf8");
  const masked = maskMarkdown(text).split("\n");
  const isHost = file.startsWith(DOC_HOST_DIR);
  const isGlossary = file === "docs/GLOSSARY.md";
  for (let i = 0; i < masked.length; i += 1) {
    const line = masked[i] ?? "";
    checkSymbols("symbol", file, i + 1, line);
    if (isHost || isGlossary) continue;
    checkTerms(file, i + 1, line);
    checkCounts(file, i + 1, line);
  }
  if (isHost) continue;

  for (const link of collectLinks(text)) {
    const kind = classifyLink(link.target);
    if (kind === "external") continue;
    if (kind === "anchor") {
      if (!anchorExists(absolute, link.target.slice(1))) {
        report(
          "link.anchor",
          "warn",
          file,
          link.line,
          `本文锚点 \`${link.target}\` 不存在`,
        );
      }
      continue;
    }
    const {
      absolute: target,
      anchor,
      insideRepo,
    } = resolveLink(ROOT, absolute, link.target);
    if (!insideRepo) {
      report(
        "link.file",
        "error",
        file,
        link.line,
        `链接 \`${link.target}\` 指向仓库之外`,
      );
      continue;
    }
    if (!targetExists(target)) {
      report(
        "link.file",
        "error",
        file,
        link.line,
        `链接 \`${link.target}\` 的目标不存在`,
      );
      continue;
    }
    if (anchor !== undefined && !anchorExists(target, anchor)) {
      report(
        "link.anchor",
        "warn",
        file,
        link.line,
        `链接 \`${link.target}\` 的锚点不存在`,
      );
    }
  }

  for (const issue of tableIssues(text)) {
    report(
      "table.columns",
      "error",
      file,
      issue.line,
      `表格列数 ${issue.got} 与表头 ${issue.expected} 不一致`,
    );
  }
}

/** 顶层目录名与包名清单，供注释路径判定用。 */
const topLevel = new Set(
  readdirSync(ROOT).filter((name) => existsSync(join(ROOT, name))),
);
const pathToken =
  /(?:^|[\s(（`"'])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.(?:ts|mts|mjs|json|md|yml|sh))/g;
const buildNames = ["dist", "node_modules"];

/** `.ts`: 注释查符号 / 路径 / 数量 / 旧名，整行查界面旧称（命令描述与 help 文本也算现行文案）。 */
for (const absolute of tsFiles) {
  const file = relative(ROOT, absolute);
  const source = readFileSync(absolute, "utf8");
  const comments = collectComments(source);
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    checkTerms(file, i + 1, lines[i] ?? "", true);
  }
  for (const comment of comments) {
    checkSymbols("symbol", file, comment.line, comment.text);
    checkCounts(file, comment.line, comment.text);
    for (const match of comment.text.matchAll(pathToken)) {
      const token = match[1];
      const segments = token.split("/");
      const head = segments[0];
      if (
        buildNames.includes(head) ||
        head.startsWith("~") ||
        token.includes("://")
      )
        continue;
      // 占位示例路径（`TUI/src/x.ts`）不是真引用，不查
      if (
        segments.some((segment) => /^[xX]$/.test(segment)) ||
        /[<>]/.test(token)
      )
        continue;
      if (!topLevel.has(head)) {
        const shorthand = ["src", "tests", "demo", "bench", "scripts"].includes(
          head,
        );
        if (shorthand) {
          report(
            "comment.path-shorthand",
            "error",
            file,
            comment.line,
            `注释路径 \`${token}\` 应写成从仓库根算起的完整路径`,
          );
        }
        continue;
      }
      if (!existsSync(join(ROOT, token))) {
        report(
          "comment.path-missing",
          "error",
          file,
          comment.line,
          `注释路径 \`${token}\` 指向的文件不存在`,
        );
      }
    }
  }
}

/** 两个 JSON: `package.json` 与 `tsconfig.json`。 */
for (const name of readdirSync(ROOT)) {
  if (skipDir(name)) continue;
  const dir = join(ROOT, name);
  if (!statSync(dir).isDirectory()) continue;
  const pkg = join(dir, "package.json");
  if (existsSync(pkg)) {
    for (const issue of checkPackage(dir, pkg)) {
      report(
        "pkg.structure",
        "error",
        relative(ROOT, pkg),
        issue.line,
        issue.message,
      );
    }
  }
  const tsconfig = join(dir, "tsconfig.json");
  if (existsSync(tsconfig)) {
    for (const issue of checkTsconfig(dir, tsconfig)) {
      report(
        "tsconfig.structure",
        "error",
        relative(ROOT, tsconfig),
        issue.line,
        issue.message,
      );
    }
  }
}

/** 汇总: 按规则打印命中；退出码由错误数（`--strict` 时含警告）决定。 */
const filtered =
  RULE_FILTER === undefined
    ? hits
    : hits.filter((hit) => hit.rule === RULE_FILTER);
const byRule = new Map();
for (const hit of filtered) {
  const list = byRule.get(hit.rule) ?? [];
  list.push(hit);
  byRule.set(hit.rule, list);
}
const errors = filtered.filter((hit) => hit.severity === "error").length;
const warnings = filtered.filter((hit) => hit.severity === "warn").length;
const failing = RULE_FILTER !== undefined || STRICT ? filtered.length : errors;
const sorted = [...byRule.entries()].sort(([a], [b]) => a.localeCompare(b));
for (const [rule, list] of sorted) {
  const level = list[0]?.severity === "warn" ? "△" : "✗";
  process.stdout.write(`${level} ${rule}: ${list.length}\n`);
  for (const hit of ALL ? list : list.slice(0, MAX_PER_RULE)) {
    process.stdout.write(`    ${hit.file}:${hit.line} ${hit.message}\n`);
  }
  if (!ALL && list.length > MAX_PER_RULE) {
    process.stdout.write(
      `    … 另有 ${list.length - MAX_PER_RULE} 条（--all 全打印）\n`,
    );
  }
}
const mark = failing === 0 ? "✓" : "✗";
process.stdout.write(
  `${mark} check:docs ${failing === 0 ? "通过" : "失败"}${RULE_FILTER === undefined ? "" : `（只看 ${RULE_FILTER}）`}: ${markdownFiles.length} 篇现行 Markdown / ${tsFiles.length} 个 .ts, 规则 ${sorted.length} 项, 错误 ${errors} / 警告 ${warnings}\n`,
);
process.exitCode = failing === 0 ? 0 : 1;
