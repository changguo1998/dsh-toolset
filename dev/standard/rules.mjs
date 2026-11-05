// dev/standard/rules.mjs — 检查规则数据: 符号白名单与变体映射、术语表、界面旧称

import { readFileSync } from "node:fs";

/** 39 个允许符号（`AGENTS.md`「符号规范」）。 */
export const SYMBOLS = [
  "✓",
  "✗",
  "△",
  "→",
  "←",
  "↑",
  "↓",
  "↔",
  "↕",
  "↖",
  "↗",
  "↘",
  "↙",
  "▶",
  "◀",
  "▲",
  "▼",
  "▷",
  "◁",
  "▽",
  "⟸",
  "⟹",
  "⟺",
  "⇆",
  "⟳",
  "↻",
  "•",
  "◦",
  "○",
  "◌",
  "●",
  "◯",
  "■",
  "□",
  "◇",
  "◆",
  "ⓘ",
  "〜",
  "…",
];

/** 必须替换的变体 → 推荐符号（`AGENTS.md` 的固定映射）。 */
export const VARIANTS = {
  "✔": "✓",
  "✅": "✓",
  "☑": "✓",
  "🗸": "✓",
  "🗹": "✓",
  "✕": "✗",
  "✖": "✗",
  "✘": "✗",
  "❌": "✗",
  "🗙": "✗",
  "☒": "✗",
  "🗷": "✗",
  "⚠": "△",
  "➔": "→",
  "➜": "→",
  "➡": "→",
  "➠": "→",
  "➢": "→",
  "➣": "→",
  "⬅": "←",
};

/** 界面名七个唯一名称（`docs/GLOSSARY.md`「界面名称」）。 */
export const INTERFACE_NAMES = new Set([
  "状态列",
  "会话区",
  "回合区",
  "工具区",
  "状态行",
  "输入区",
  "提示行",
]);

/**
 * 条件型术语不自动判定，理由写在 `dev/standard/README.md`：
 * 「模块」在指层次时保留，「工具集」只在 `docs/host` 的宿主快照里保留。
 */
const CONDITIONAL_TERMS = new Set(["模块", "工具集", "收口"]);

/** 豁免行: 出现这些词的行允许引用旧称（首次出现写「原名」的口径）。 */
const EXEMPT_MARKERS = ["原名", "旧称", "历史对照", "不再使用"];

/**
 * 已知误配: 旧称恰好落在别的词里（如「夺回归属」里的「回归」），按上下文跳过。
 */
const FALSE_POSITIVES = {
  回归: ["夺回归属"],
};

/**
 * 术语与数量检查整文件豁免:
 * `docs/STATUS.md` 由用户择时更新（流程内不改），`docs/ARCHITECTURE-REUSE.md` 是审计快照。
 */
export const EXEMPT_FILES = new Set([
  "docs/STATUS.md",
  "docs/ARCHITECTURE-REUSE.md",
]);

/** 行豁免标记: 讨论字符本身的句子（例举码点、字符宽度）不按符号规范判。 */
const SYMBOL_LINE_MARKERS = ["U+", "码点", "字符"];

/** 符号检查整文件豁免: 符号表与变体映射的源码本身、宽度探针脚本、各包测试。 */
const SYMBOL_EXEMPT_PATTERNS = [
  /\/tests\//,
  /^symbol-normalizer\/src\//,
  /^TUI\/src\/app\/layout\/markdown\.ts$/,
  /^TUI\/scripts\/gen-width-table\.mts$/,
];

/** 该文件的符号命中是否整体豁免。 */
export function isSymbolExemptFile(file) {
  return SYMBOL_EXEMPT_PATTERNS.some((pattern) => pattern.test(file));
}

/** 该行的符号命中是否豁免（讨论字符本身）。 */
export function isSymbolExemptLine(line) {
  return SYMBOL_LINE_MARKERS.some((marker) => line.includes(marker));
}

/** 该旧称命中是否为已知误配。 */
export function isTermFalsePositive(name, text) {
  return (FALSE_POSITIVES[name] ?? []).some((snippet) =>
    text.includes(snippet),
  );
}

/** 该行是否豁免术语与数量检查（用户维护文档 / 审计快照）。 */
export function isTermExemptFile(file) {
  return EXEMPT_FILES.has(file);
}

/** 只查符号变体的目录（不参与术语 / 断链 / 表格检查）。 */
export const DOC_HOST_DIR = "docs/host/";

/** 归档目录: 一律不查。 */
export const ARCHIVE_PATTERNS = [
  /(^|\/)archive\//,
  /(^|\/)docs\/archived\//,
  /(^|\/)docs\/implementation\//,
];

/** 解析 `docs/GLOSSARY.md` 的「需要替换」表，得到旧称 → 应当使用。 */
export function loadGlossary(root) {
  const text = readFileSync(`${root}/docs/GLOSSARY.md`, "utf8");
  const section = sectionText(text, "## 需要替换");
  if (section === undefined) throw new Error("GLOSSARY 缺「需要替换」表");
  const byRow = [];
  for (const row of tableRows(section)) {
    const [rawFrom, rawTo, rawNote] = row;
    if (rawFrom === undefined || rawTo === undefined) continue;
    // 单元格里的「活动区 / Turn 区」是多个旧称，按 ` / ` 拆开
    const from = rawFrom
      .split(" / ")
      .map((s) => s.trim())
      .filter(Boolean);
    const to = rawTo.trim();
    const note = (rawNote ?? "").trim();
    const isInterface =
      from.some((name) => INTERFACE_NAMES.has(name)) ||
      /状态列|会话区|回合区|工具区|状态行|输入区|提示行/.test(to);
    const conditional = CONDITIONAL_TERMS.has(from[0]);
    byRow.push({
      from,
      to,
      note,
      isInterface,
      conditional,
      ruleId: isInterface ? "term.interface" : "term.replace",
    });
  }
  return byRow;
}

/** 行是否可豁免旧称（含「原名」「旧称」等标记）。 */
export function isExemptLine(line) {
  return EXEMPT_MARKERS.some((marker) => line.includes(marker));
}

/** 取某个 Markdown 小节正文（到下一个同级或更高级标题为止）。 */
function sectionText(text, heading) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return undefined;
  const end = lines.findIndex((line, i) => i > start && /^## |^# /.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

/** 解析小节内的表格行（跳过表头与分隔行，单元格已去 `|` 与首尾空白）。 */
function tableRows(section) {
  const rows = [];
  let started = false;
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (!started) {
      started = true; // 表头
      continue;
    }
    if (/^\|[:\-\s|]+\|$/.test(trimmed)) continue; // 分隔行
    rows.push(splitCells(trimmed));
  }
  return rows;
}

/** 按未转义的 `|` 切单元格。 */
export function splitCells(line) {
  const cells = line.split(/(?<!\\)\|/);
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells.map((cell) => cell.replace(/\\\|/g, "|").trim());
}
