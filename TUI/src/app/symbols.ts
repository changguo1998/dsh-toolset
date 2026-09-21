/**
 * 模型输出符号规范化（Symbol Normalizer）。
 *
 * 目标：把模型正文里的「不推荐符号」按规则治理——
 * 1. 有推荐替代（如变体叉 ✕/✖/✘/☒/❌ → 推荐 ✗）时，展示层替换为推荐符号；
 * 2. 无替代（白名单外的 emoji/特殊符号）时，记录待提醒集合（turn-end 后
 *    notice 给人 + followup 提醒模型，见 App 接入）。
 *
 * 判定顺序（每码点）：零宽跳过 → 别名映射替换 → 治理区(符号/emoji 区)内查
 * 推荐白名单（命中放行 / 未命中记提醒）→ 文字与常用标点放行 → 其余默认放行。
 * 集合均可用 tui.config.json `symbols` 段扩展（见 config.ts）。
 */

/** 治理区：只在这些符号/emoji 区段触发「白名单外」判定（文字/标点不算治理）。 */
const GOVERNED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2190, 0x21ff], // 箭头
  [0x2300, 0x23ff], // 杂项技术符号（⌚⏰⏳ 等）
  [0x2500, 0x27bf], // 框线/几何/杂项符号/Dingbats（✓✗⚠❤ 所在）
  [0x2b00, 0x2bff], // 杂项符号与箭头（⭐⬛ 等）
  [0x1f000, 0x1faff], // emoji 全集（区域指示符/表情/交通/补充象形/扩展-A）
  [0xffe0, 0xffe6], // 全角符号（￥｜ 等）
] as const;

function inRanges(
  cp: number,
  ranges: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/**
 * 内置推荐白名单（治理区内的放行符号）。
 * 箭头家族（A→→、B→▶、C→⟹）按「域 × 家族」选型：族内其余候选走别名归一
 * （见 DEFAULT_ALIASES）；家族 D（虚线/波浪箭头）明确不纳入，使用即提醒。
 * 注：箭头 A 的 ASCII 兜底（`->`）本就属放行的 ASCII；若终端把 → 渲染为 2 列
 * （Ambiguous 双呈现环境的宽渲染），建议在配置 recommended 里改用 `->`。
 */
export const DEFAULT_RECOMMENDED = [
  "✓",
  "✗",
  "△",
  "→",
  "←",
  "↑",
  "↓",
  "↔",
  "▶",
  "◀",
  "▲",
  "▼",
  "⟹",
  "•",
  "◦",
  "○",
  "●",
  "◯",
  "■",
  "□",
  "◇",
  "◆",
  "ⓘ",
  "〜",
  "…",
] as const;

/** 内置别名：变体/不推荐符号 → 推荐符号（同域家族内归一）。 */
export const DEFAULT_ALIASES: Readonly<Record<string, string>> = {
  "✔": "✓",
  "✅": "✓",
  "✕": "✗",
  "✖": "✗",
  "✘": "✗",
  "❌": "✗",
  "×": "✗",
  "🗙": "✗",
  "⚠": "△", // 警告三角：emoji 呈现为填色，与 ✓/✗ 细线风格不一致 → 换空心三角 △
  // 箭头家族 A（线条）：OTHER 风格归一到 →（U+2192；宽渲染环境用户可配置退 ASCII `->`）
  "➔": "→",
  "➜": "→",
  "➡": "→",
  // 箭头家族 B（三角）：族内其余归一到 ▶（U+25B6）
  "▸": "▶",
  "►": "▶",
  "⏵": "▶",
  "⏩": "▶",
  "➤": "▶",
  // 箭头家族 C（双线/推导）：同向右双线归一到 ⟹（U+27F9）；
  // 双向 ⇔、反向 ⇐ 因几何方向不同已拆分（不归一 → 使用即提醒）
  "⇒": "⟹",
  // 信息域：圈 i 族归一到 ⓘ（U+24D8）；感叹族 emoji 归一到 ASCII `!`；图形族（💡）不纳入
  ℹ: "ⓘ",
  "❗": "!",
  "❕": "!",
  // 加减符号：归一到 ASCII `+` / `-`（优先推荐 ASCII；带圈数字用 `1)` 等文字序号，非归一）
  "➕": "+",
  "➖": "-",
  // 金额：全角 ￥ 归一到半角 ¥（U+00A5 治理区外，天然放行无渲染异构）
  "￥": "¥",
  // 波浪：全角 ～（FF5E）归一到 U+301C 〜（2 列推荐）；1 列用 ASCII `~`（治理区外天然放行）
  "～": "〜",
  "⌫": "",
};
/**
 * 已按「只看几何」拆分的别名（几何独立、不再归一 → 各自独立）：
 * - ◦（25E6 空心圆点）/ ☑（2611 方框勾）/ ☒（2612 方框叉）：与 •/✓/✗ 几何不同 → 使用即提醒
 * - √（221A 根号，非勾形）：治理区外，自然放行
 * - ⇔（21D4 双向双线）/ ⇐（21D0 左向双线）：与 ⟹ 方向几何不同 → 使用即提醒
 * 保留归一：✅（白底方框勾视为勾实心变体）、×（乘号交叉线视为叉几何）、
 *           ⚠（警告三角视为三角几何）、⏩（双三角视为三角速度变体）
 */

/** 用户可配置项（tui.config.json `symbols`）。 */
export interface SymbolRulesConfig {
  /** 追加推荐字符（内置白名单之外的治理区放行符）。 */
  recommended?: string[];
  /** 别名映射追加（覆盖同键内置）。 */
  aliases?: Record<string, string>;
  /** 是否随下一条用户消息向模型发提醒（缺省 true）。 */
  warnModel?: boolean;
}

/** 解析后的完整规则（内置 + 配置合并）。 */
export interface ResolvedSymbolRules {
  recommendedSet: ReadonlySet<string>;
  aliases: Readonly<Record<string, string>>;
  warnModel: boolean;
}

/** 把配置合并到内置默认，产出最终规则。 */
export function resolveSymbolRules(
  cfg?: SymbolRulesConfig,
): ResolvedSymbolRules {
  const extra = cfg?.recommended ?? [];
  const recommended = new Set<string>([...DEFAULT_RECOMMENDED, ...extra]);
  const aliases = { ...DEFAULT_ALIASES, ...(cfg?.aliases ?? {}) };
  return {
    recommendedSet: recommended,
    aliases,
    warnModel: cfg?.warnModel ?? true,
  };
}

/** 单向替换记录（展示层已替换的符号）。 */
export interface SymbolRemap {
  from: string;
  to: string;
}

/** 单次规范化的产出。 */
export interface NormalizeResult {
  /** 替换后的展示文本（无替代的符号保留原样）。 */
  text: string;
  /** 已替换次数（别名命中）。 */
  replacedCount: number;
  /** 替换明细（from → to）。 */
  remaps: SymbolRemap[];
  /** 无替代的治理区外符号（去重，按出现顺序）。 */
  unrecommended: string[];
}

/** 文字/常用标点放行判定（汉字/假名/谚文/全角标点与英文拉丁字母等非治理对象）。 */
function isPassable(cp: number): boolean {
  if (cp < 0x2000) return true; // ASCII + Latin-1 补充/希腊/西里尔等字母制
  if (cp >= 0x2000 && cp <= 0x206f) return true; // 通用标点（含 …）
  if (cp >= 0x2e80 && cp <= 0xa4cf) return true; // 部首/汉字/假名/谚文/注音
  if (cp >= 0xac00 && cp <= 0xd7a3) return true; // Hangul 音节
  if (cp >= 0xf900 && cp <= 0xfaff) return true; // CJK 兼容表意
  if (cp >= 0x20000 && cp <= 0x2fffd) return true; // CJK 扩展 B+
  if (cp >= 0xfe10 && cp <= 0xfe4f) return true; // 竖排/兼容形式
  if (cp >= 0xff00 && cp <= 0xff60) return true; // 全角 ASCII/标点
  return false;
}

/** 是否为零宽/组合字符（不参与治理，原样透传）。 */
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
    cp === 0xfeff
  );
}

/** 逐字符规范化（对外主入口；纯函数、可按段调用）。 */
export function normalizeSymbols(
  text: string,
  rules: ResolvedSymbolRules,
): NormalizeResult {
  let out = "";
  let replacedCount = 0;
  const remaps: SymbolRemap[] = [];
  const unrecommended: string[] = [];
  const seen = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // 孤立代理项（跨段断裂）原样透传，不参与治理
    if (cp >= 0xd800 && cp <= 0xdfff) {
      out += ch;
      continue;
    }
    if (isZeroWidth(cp)) {
      out += ch;
      continue;
    }
    const alias = rules.aliases[ch];
    if (alias !== undefined) {
      out += alias;
      replacedCount++;
      remaps.push({ from: ch, to: alias });
      continue;
    }
    if (inRanges(cp, GOVERNED_RANGES)) {
      if (rules.recommendedSet.has(ch)) {
        out += ch;
      } else {
        out += ch; // 展示层保留原文，仅记提醒
        if (!seen.has(ch)) {
          seen.add(ch);
          unrecommended.push(ch);
        }
      }
      continue;
    }
    if (isPassable(cp)) {
      out += ch;
      continue;
    }
    out += ch; // 其他（默认放行）
  }
  return { text: out, replacedCount, remaps, unrecommended };
}
