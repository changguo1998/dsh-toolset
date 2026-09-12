/**
 * 确定性派生程序（单一程序源）：行数/字节统计、section 标题、top-N 关键行、固定切片索引。
 *
 * 同一份 JS 源码在两种环境执行（保证「同一输入文本 → 同一摘要 JSON」）：
 *  1. 宿主 code-runtime 沙箱（worker-thread 后端）：程序体为 async 函数体，
 *     通过全局绑定 input 取数据（await input.text()）；
 *  2. code-runtime 缺失时的 node:vm 进程内回落（见 VmSandbox）。
 *
 * 约束（见 DESIGN.md「确定性」一节）：无时间/随机/环境依赖；纯函数；
 * 仅用标准语法（无 import/require/动态构造器）；输出为可无损 JSON 的纯数据。
 */

export const SUMMARY_VERSION = 1;

/** 摘要统计块。 */
export interface SummaryStats {
  bytes: number;
  chars: number;
  lines: number;
  maxLineLen: number;
  avgLineLen: number;
}

/** section 标题条目。 */
export interface HeadingEntry {
  line: number;
  level: number;
  text: string;
}

/** 关键行条目（已截断到单行上限）。 */
export interface KeyLineEntry {
  line: number;
  text: string;
}

/** 切片索引条目：行范围 + 字符范围（供回读 spill 文件）+ 首行预览 + 指纹。 */
export interface SliceEntry {
  index: number;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  preview: string;
  fnv: string;
}

/** 派生摘要的 JSON 结构（沙箱返回值）。 */
export interface SummaryJson {
  version: number;
  textFnv: string;
  stats: SummaryStats;
  headings: HeadingEntry[];
  keyLines: KeyLineEntry[];
  slices: SliceEntry[];
}

/**
 * 单一派生程序源（code-runtime / node:vm 共用）。
 * 以 async 函数体形式提供：`await input.text(0)` 取完整输出文本，最终 `return` 摘要 JSON。
 * 绑定调用必须至少传一个参数：宿主 worker-thread code-runtime 的 decodeWorkerJson 把空参数
 * 列表判为非法（`input.length === 0` → undefined → "binding arguments must be lossless JSON"），
 * 零参数调用在真实宿主上必然失败（node:vm 回落无此限制，故测试需模拟严格编解码）。
 * 注意：不要在本字符串中引入 import/require/eval/动态构造器/宿主全局（除注入的 input 与 TextEncoder）。
 */
export const SUMMARY_PROGRAM = `
// 参数 0 仅为满足宿主「绑定参数必须是非空无损 JSON」约束，绑定实现忽略该值
const text = String(await input.text(0));

// FNV-1a 32 位指纹：纯 JS 确定性散列（沙箱内无 crypto 模块可用）
function fnv1a32(buf) {
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// 统计：字节数 / 字符数 / 行数 / 最长行 / 平均行长
const bytes = new TextEncoder().encode(text);
const lines = text.split("\\n");
let maxLineLen = 0;
let totalLineLen = 0;
for (let i = 0; i < lines.length; i++) {
  const len = lines[i].length;
  if (len > maxLineLen) maxLineLen = len;
  totalLineLen += len;
}
const stats = {
  bytes: bytes.length,
  chars: text.length,
  lines: lines.length,
  maxLineLen: maxLineLen,
  avgLineLen: lines.length > 0 ? Math.round(totalLineLen / lines.length) : 0
};

// section 标题：markdown 一级到六级标题行，截断到前 40 条
const headings = [];
const headingRe = /^\\s{0,3}(#{1,6})\\s+(.{1,120})$/;
for (let i = 0; i < lines.length && headings.length < 40; i++) {
  const m = headingRe.exec(lines[i]);
  if (m !== null) {
    headings.push({ line: i + 1, level: m[1].length, text: m[2].trim() });
  }
}

// 关键行：错误/异常类关键词命中，截断到前 20 条、单行 160 字符
const keyLines = [];
const keyRe = /(error|fail(?:ed|ure)?|fatal|panic|exception|traceback|denied|refused|timed?\\s*out|segfault|no such file|permission denied|core dumped|killed|out of memory)/i;
for (let i = 0; i < lines.length && keyLines.length < 20; i++) {
  const l = lines[i].trim();
  if (l.length === 0 || l.length > 400) continue;
  if (keyRe.test(l)) {
    keyLines.push({ line: i + 1, text: l.length > 160 ? l.slice(0, 160) + "\\u2026" : l });
  }
}

// 切片索引：按行均匀切分为 sliceCount 片，每片记录行范围/字符范围/首行预览/指纹
const sliceCount = 16;
const n = lines.length;
const charOffset = new Array(n + 1);
charOffset[0] = 0;
for (let i = 0; i < n; i++) {
  charOffset[i + 1] = charOffset[i] + lines[i].length + 1; // +1 为换行符
}
const slices = [];
if (n > 0) {
  const per = Math.max(1, Math.ceil(n / sliceCount));
  for (let s = 0; s * per < n; s++) {
    const start = s * per;
    const end = Math.min(n, start + per);
    const startChar = charOffset[start];
    // 末行无换行时 charOffset 会多计 1，收敛到文本长度
    const endChar = Math.min(charOffset[end], text.length);
    const first = lines[start].trim();
    slices.push({
      index: s,
      startLine: start + 1,
      endLine: end,
      startChar: startChar,
      endChar: endChar,
      preview: first.slice(0, 80),
      fnv: fnv1a32(new TextEncoder().encode(text.slice(startChar, endChar)))
    });
  }
}

return {
  version: 1,
  textFnv: fnv1a32(bytes),
  stats: stats,
  headings: headings,
  keyLines: keyLines,
  slices: slices
};
`;

/** 校验沙箱返回值形状（code-runtime 的 value 是未类型化的 JSON）。 */
export function validateSummary(value: unknown): SummaryJson {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("派生程序返回非对象");
  }
  const v = value as Record<string, unknown>;
  const stats = v.stats as Record<string, unknown> | undefined;
  const ok =
    v.version === SUMMARY_VERSION &&
    typeof v.textFnv === "string" &&
    typeof stats === "object" &&
    stats !== null &&
    typeof stats.bytes === "number" &&
    typeof stats.lines === "number" &&
    Array.isArray(v.headings) &&
    Array.isArray(v.keyLines) &&
    Array.isArray(v.slices);
  if (!ok) throw new Error("派生程序返回结构不合法");
  return value as SummaryJson;
}
