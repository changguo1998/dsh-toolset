#!/usr/bin/env node
// scripts/gen-width-table.mts — 生成 src/app/layout/eaw-table.ts（宽度静态表）
//
// 数据源与规则：
//   EAW（UAX #11）来自 scripts/eaw-dump.py（Python unicodedata）；
//   emoji 属性来自 Node 正则 \p{Emoji} / \p{Emoji_Presentation}（UTS #51）。
//
// 生成三张扁平区间表（每两个数字一对 [lo, hi] 闭区间，按 lo 升序）：
//   EAW_WIDE_RANGES              EAW ∈ {W, F} —— 无歧义宽（CJK/全角/多数 emoji）→ 2 列
//   EAW_AMBIGUOUS_CONSERVATIVE   EAW = A 且落在 CONSERVATIVE_RANGES 内 —— 歧义字符在
//                                几何/符号/CJK/emoji 区可能被 CJK 字体按全角设计 → 2 列
//   EMOJI_CONSERVATIVE           emoji 保守集 → 2 列：EAW=N/A 但带 emoji 属性的字符
//                                （如 ❤ U+2764、🇨 U+1F1E8）在多数终端按 emoji 呈现
//                                （2 列），按 1 列会低估撑破窗口。
//                                判定：cp ≥ 0x2190 且（Emoji_Presentation 或
//                                （Emoji 且位于 emoji 密集区））—— 排除箭头区（↔ 等
//                                项目 UI 推荐符号，实测 1 列）与 ™/©/®（< 0x2190）。
//
// 由此，EAW=N 且无 emoji 属性的纯几何/装饰符号（如 ⬤ U+2B24、⬀ U+2B00）落到默认
// 1 列 —— 修复旧实现「整段区间按 2 列」的多留空格问题。
//
// 用法：node TUI/scripts/gen-width-table.mts   （或 npm run gen:width-table）
// 生成后请跑一遍项目格式化器（format TUI/src/app/layout/eaw-table.ts）——
// 数组换行密度由 prettier 统一，本脚本不重复实现其排版规则。

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptsDir, "..");

/** 歧义（A）字符的保守区间：这些范围内的 A 类按 2 列（启动探测可覆盖）。
 *  注意 0x2300-0x23FF 只取 emoji 呈现的两段（时钟 231A-231B、媒体控制 23E2 起）——
 *  中段的键盘/数学/APL 符号（⌘⌥⌫⌨⌈⌉ 等）实测终端 1 列，不纳入。 */
const CONSERVATIVE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x231a, 0x231b], // 时钟 emoji（⌚⌛）
  [0x23e2, 0x23ff], // 媒体控制/进度 emoji（⏩⏳ 等）
  [0x2600, 0x27bf], // 杂项符号 + Dingbats
  [0x2b00, 0x2bff], // 杂项符号与箭头
  [0x2e80, 0xa4cf], // CJK 部首/汉字/假名/谚文
  [0xac00, 0xd7a3], // Hangul 音节
  [0xf900, 0xfaff], // CJK 兼容表意
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角 ASCII/标点
  [0xffe0, 0xffe6], // 全角货币/竖线
  [0x1f000, 0x1faff], // emoji 全集
];

/** emoji 密集区：区内的 Emoji（含需 VS16 的）按 emoji 呈现保守计 2 列。
 *  与保守区间同口径细分——0x2300-0x23FF 只取 emoji 段，避免把 ⌨ U+2328（Emoji=Yes
 *  但终端按文本呈现 1 列）等键盘符号圈入。 */
const EMOJI_DENSE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x231a, 0x231b], // 时钟 emoji
  [0x23e2, 0x23ff], // 媒体控制/进度 emoji
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x1f000, 0x1faff],
];

function inRanges(
  cp: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
}

interface EawDump {
  unicode: string;
  wide: number[][];
  ambiguous: number[][];
}

const dump: EawDump = JSON.parse(
  execFileSync("python3", [path.join(scriptsDir, "eaw-dump.py")], {
    encoding: "utf8",
  }),
);

const isEmojiConserved = (cp: number): boolean => {
  if (cp < 0x2190) return false; // 排除 ©/®/™ 等（EAW=N，终端按 1 列）
  const ch = String.fromCodePoint(cp);
  if (/\p{Emoji_Presentation}/u.test(ch)) return true;
  return /\p{Emoji}/u.test(ch) && inRanges(cp, EMOJI_DENSE_RANGES);
};

/** 由判定函数收集连续区间 */
function buildRanges(pred: (cp: number) => boolean): number[][] {
  const out: number[][] = [];
  let start = -1;
  let prev = -1;
  for (let cp = 0; cp < 0x110000; cp++) {
    if (pred(cp)) {
      if (start < 0) start = cp;
      else if (cp !== prev + 1) {
        out.push([start, prev]);
        start = cp;
      }
      prev = cp;
    } else if (start >= 0) {
      out.push([start, prev]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, prev]);
  return out;
}

const wide = dump.wide;
const ambiguousConserved = buildRanges(
  (cp) => inRanges(cp, dump.ambiguous as ReadonlyArray<readonly [number, number]>) && inRanges(cp, CONSERVATIVE_RANGES),
);
const emojiConserved = buildRanges(isEmojiConserved);

function fmt(name: string, ranges: number[][], comment: string): string {
  const flat = ranges.map(([lo, hi]) => `0x${lo.toString(16)}, 0x${hi.toString(16)}`);
  const lines: string[] = [];
  // 每行 5 对（约 70 字符）：与 prettier 默认行宽兼容，重新生成不会产生格式化抖动
  for (let i = 0; i < flat.length; i += 5) {
    lines.push("  " + flat.slice(i, i + 5).join(", ") + ",");
  }
  return `/** ${comment} */\nexport const ${name}: readonly number[] = [\n${lines.join("\n")}\n];\n`;
}

const header = `// layout/eaw-table.ts — 字符宽度静态表（生成物，勿手改）
//
// 由 scripts/gen-width-table.mts 生成（EAW: Python unicodedata Unicode ${dump.unicode}；
// emoji 属性: Node \\p{Emoji} / \\p{Emoji_Presentation}）。
// 每两个数字为一对 [lo, hi] 闭区间，按 lo 升序；运行期二分查找。
// 判定顺序见 markdown.ts computeCharWidth：零宽 → 文本符号例外 → 本表三张 → 默认 1 列。

`;

const content =
  header +
  fmt("EAW_WIDE_RANGES", wide, "EAW ∈ {W, F}：无歧义宽字符（CJK/全角/多数 emoji），2 列") +
  "\n" +
  fmt(
    "EAW_AMBIGUOUS_CONSERVATIVE",
    ambiguousConserved,
    "EAW = A 且位于几何/符号/CJK/emoji 保守区间：可能被 CJK 字体按全角设计，保守 2 列（探测可覆盖）",
  ) +
  "\n" +
  fmt(
    "EMOJI_CONSERVATIVE",
    emojiConserved,
    "emoji 保守集（EAW=N/A 但带 emoji 属性，且 ≥ U+2190）：多数终端按 emoji 呈现 2 列，防低估撑破",
  );

const outPath = path.join(root, "src/app/layout/eaw-table.ts");
writeFileSync(outPath, content, "utf8");
console.log(
  `写入 src/app/layout/eaw-table.ts：W/F ${wide.length} 区间、A(保守) ${ambiguousConserved.length}、` +
    `emoji(保守) ${emojiConserved.length}；Unicode ${dump.unicode}`,
);
