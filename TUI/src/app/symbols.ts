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
 * 箭头家族（A→→、B→▶、C→⟸⟹⟺）按「域 × 家族」选型：族内其余候选走别名归一
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
  "↕",
  "↖",
  "↗",
  "↘",
  "↙",
  "▶",
  "◀",
  "▲",
  "▼",
  "▷", // 空心三角族四向代表（对应 ▶◀▲▼，族内归一；与实心族不互相归一，2026-11）
  "◁",
  "▽",
  "⟸",
  "⟹",
  "⟺",
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
  "✅": "✓", // 方框勾 emoji（绿底方框）→ 细线 ✓
  "☑": "✓", // 方框勾（U+2611）特例：带独立方框、并入未加框的勾（2026-11）
  "✕": "✗",
  "✖": "✗",
  "✘": "✗",
  "❌": "✗",
  "×": "✗",
  "🗙": "✗",
  "☒": "✗", // 方框叉（U+2612）特例：并入未加框的叉（2026-11）
  "🗷": "✗", // 方框叉（U+1F5F7，追加符号区 emoji）特例：并入未加框的叉（同 ☒，2026-11）
  "🗸": "✓", // 浅勾（U+1F5F8）→ 细线 ✓
  "🗹": "✓", // 方框勾（U+1F5F9，追加符号区 emoji）特例：并入未加框的勾（同 ☑，2026-11）
  "⚠": "△", // 警告三角：emoji 呈现为填色，与 ✓/✗ 细线风格不一致 → 换空心三角 △
  // 箭头家族 A（线条）：各方向与其同向的其它箭头归一到该向推荐（2026-11，参考右向）
  //   （U+2192 等；宽渲染环境用户可配置退 ASCII `->`）
  "➔": "→",
  "➜": "→",
  "➡": "→",
  "➠": "→", // 虚线三角头右箭头（U+27A0，方向一致）
  "➢": "→", // 立体上光右箭头（U+27A2，方向一致）
  "➣": "→", // 立体下光右箭头（U+27A3，方向一致）
  "⬅": "←",
  "⬆": "↑",
  "⬇": "↓",
  // 箭头家族 B（三角）：各方向与其同向的其它三角归一到该向代表（2026-11，参考右向 ▶ U+25B6）
  "▸": "▶",
  "►": "▶",
  "⏵": "▶",
  "⏩": "▶",
  "➤": "▶",
  "◂": "◀",
  "◄": "◀",
  "⏴": "◀",
  "⏪": "◀",
  "▴": "▲",
  "⏶": "▲",
  "▾": "▼",
  "⏷": "▼",
  "⏫": "▲", // 黑双上三角（U+23EB，双三角=数量修饰，同 ⏩→▶）
  "⏬": "▼", // 黑双下三角（U+23EC，同 ⏪→◀）
  // 箭头家族 C（双线/推导）：各方向双线归一到该向长双线代表（2026-11，参考右向
  //   ⟹ U+27F9）：⇒→⟹、⇐→⟸（U+27F8）、⇔→⟺（U+27FA，双向）
  "⇒": "⟹",
  "⇐": "⟸",
  "⇔": "⟺",
  // 信息域：圈 i 族归一到 ⓘ（U+24D8）；感叹/问号族 emoji 归一到 ASCII `!`/`?`；图形族（💡）不纳入
  ℹ: "ⓘ",
  "❗": "!",
  "❕": "!",
  "❓": "?", // 问号 emoji（U+2753）→ ASCII ?（同 ❗❕→!）
  "❔": "?", // 问号 emoji（U+2754）→ ASCII ?
  // 加减符号：归一到 ASCII `+` / `-`（优先推荐 ASCII；带圈数字用 `1)` 等文字序号，非归一）
  "➕": "+",
  "➖": "-",
  // 金额：全角 ￥/￠/￡/￦ 归一到半角 ¥/¢/£/₩（半角治理区外天然放行，无渲染异构）
  "￥": "¥",
  "￠": "¢", // 全角分（U+FFE0）→ 半角 ¢
  "￡": "£", // 全角镑（U+FFE1）→ 半角 £
  "￦": "₩", // 全角韩元（U+FFE6）→ 半角 ₩（同系列，2026-11）
  // 波浪：全角 ～（FF5E）归一到 U+301C 〜（2 列推荐）；1 列用 ASCII `~`（治理区外天然放行）
  "～": "〜",
  // 圆族 emoji 归一（2026-11：emoji 按「设计含色数」归类——单色填充一律实心，
  // 只有含内空腔/双色的算空心，如 ⭕ 圆环）：
  // 实心圆 emoji（⚪⚫🔴🔵🟠🟡🟢🟣🟤 均为纯色）→ ●；空心仅 ⭕（圆环）→ ○
  "⚪": "●",
  "⭕": "○",
  "⚫": "●",
  "🔴": "●",
  "🔵": "●",
  "🟠": "●",
  "🟡": "●",
  "🟢": "●",
  "🟣": "●",
  "🟤": "●",
  "⬤": "●", // 黑色大圆（U+2B24，文本几何：同 ● 仅大小=修饰）
  // 方块族（2026-11，空心代表 □ U+25A1 / 实心代表 ■ U+25FC）：尺寸/填充变体归一到代表
  //   emoji 中纯色 → ■（含 ⬜ 白大方、⬛ 黑大方、各色大方）；🔳🔲（方块按钮=带边框双色）→ □
  "▫": "□",
  "◻": "□",
  "🔳": "□", // 白底+深色边框（双色设计）→ 空心
  "🔲": "□", // 黑方块按钮（黑底+浅色边框，双色设计）→ 空心（2026-11 订正，同 🔳）
  "◽": "■", // 观感/渲染为实心 → 实心（2026-11 订正）
  "⬜": "■", // 纯白大方（单色）→ 实心
  "▪": "■",
  "◼": "■",
  "⬛": "■",
  "🟥": "■",
  "🟦": "■",
  "🟧": "■",
  "🟨": "■",
  "🟩": "■",
  "🟪": "■",
  "🟫": "■",
  // 菱形族（2026-11，◆ 实心 / ◇ 空心 为代表）：菱形 emoji + 文本尺寸变体归一到对应推荐符
  //   emoji 纯色（🔶🔸 橙、🔷🔹 蓝）→ ◆；文本空心变体 ⬦⬨ → ◇
  "🔷": "◆", // 大蓝实心菱形
  "🔹": "◆", // 小蓝实心菱形
  "🔶": "◆", // 大橙菱形（纯色 → 实心）
  "🔸": "◆", // 小橙菱形（纯色 → 实心）
  "⬥": "◆", // 中等实心菱形（U+2B25，文本变体）
  "⬧": "◆", // 中小实心菱形（U+2B27）
  "⬦": "◇", // 中等空心菱形（U+2B26，文本变体）
  "⬨": "◇", // 中小空心菱形（U+2B28）
  // 三角族（2026-11，▲▼ 为代表）：红色三角 emoji 归一到细线 ▲▼
  "🔺": "▲",
  "🔼": "▲",
  "🔻": "▼",
  "🔽": "▼",
  // 空心三角族（2026-11）：空心为独立一族（与实心 ▶◀▲▼ 不互相归一），
  //   族内尺寸/指针变体归一到该向代表：▷(25B7 右)/◁(25C1 左)/△(25B3 上)/▽(25BD 下)
  "▹": "▷",
  "▻": "▷",
  "◃": "◁",
  "◅": "◁",
  "▵": "△",
  "▿": "▽",
  "⌫": "",
};
/**
 * 已按「只看几何」拆分的别名（几何独立、不再归一 → 各自独立）：
 * - √（221A 根号，非勾形）：治理区外，自然放行
 * - 双线族（C）按方向归一（2026-11）：⇒→⟹、⇐→⟸、⇔→⟺（短双线 → 同向长双线代表）
 * - 空心三角族（2026-11）：▷◁△▽ 四向代表，族内变体（▹▻◃◅▵▿）归一到该向代表；
 *   空心/实心（▲▼◀▶）各成一族、不互相归一
 * - ◦（25E6 空心圆点）：空心/实心各成一族，◦ 为空心圆点族代表、已入默认白名单 → 放行
 * 特例（2026-11）：☑/☒（方框勾/方框叉）与 🗹/🗷（追加符号区方框勾/叉）虽带独立方框，
 *   不各自成族，而是并入对应的细线符号——✅☑🗹→✓、❌☒🗷→✗（「特殊情况，对应没有框的勾和叉」）。
 * 原则（2026-11 修订）：空心/实心 = 不同形状身份，各成一族、不互相归一；
 *   只归一修饰性差异（emoji 上色、粗细、大小、重复数量、内缀）。
 * emoji 形状按「设计含色数」归类（2026-11）：单色填充一律实心（含白/黑）；
 *   只有含内空腔或双色设计的算空心：
 *   圆族 ⚪⚫🔴…🟤→●、⬤（U+2B24 黑大圆，文本几何同 ● 仅大小）→●、⭕（圆环）→○；方块族 ▫◻🔳🔲→□、◽/⬜/▪◼⬛/各色大方→■；
 *   菱形族 🔶🔸🔷🔹⬥⬧→◆、⬦⬨（文本空心）→◇；三角族 🔺🔼→▲、🔻🔽→▼；
 *   空心三角族（文本几何 ▷◁△▽）四向代表入白名单、族内变体归一到代表（2026-11）。
 * 星标域（含 emoji ⭐）：无推荐代表，一律按警告处理、不归一。
 * 保留归一：×（乘号交叉线视为叉几何）、⏩⏫⏬（双三角=数量/速度修饰，⏫⏬ 归 ▲▼）、
 *           ⚠（警告三角 → 三角几何 △，空心↔空心同族）。
 */

/** 用户可配置项（tui.config.json `symbols`）。 */
export interface SymbolRulesConfig {
  /** 追加推荐字符（内置白名单之外的治理区放行符）。 */
  recommended?: string[];
  /** 别名映射追加（覆盖同键内置）。 */
  aliases?: Record<string, string>;
  /** 是否随下一条用户消息向模型发提醒（缺省 true）。 */
  warnModel?: boolean;
  /**
   * 同符号冷却时间窗（毫秒，缺省 10 分钟；显式 0 = 关闭时间维度）。
   * 某符号被反馈过一次后进入冷却，冷却期内不再对该符号反馈（2026-11 打破循环）。
   */
  cooldownMs?: number;
  /**
   * 同符号冷却 run 次数（缺省 3；显式 0 = 关闭次数维度）。
   * 反馈后的若干次模型 run 内不再反馈同一符号；与 cooldownMs 并存时两个维度都过期才解冻。
   */
  cooldownRuns?: number;
}

/** 内置默认冷却：时间 10 分钟 / run 次数 3（均可配置覆盖，传 0 关闭对应维度）。 */
export const DEFAULT_SYMBOL_COOLDOWN_MS = 10 * 60 * 1000;
export const DEFAULT_SYMBOL_COOLDOWN_RUNS = 3;

/** 解析后的完整规则（内置 + 配置合并）。 */
export interface ResolvedSymbolRules {
  recommendedSet: ReadonlySet<string>;
  aliases: Readonly<Record<string, string>>;
  warnModel: boolean;
  cooldownMs: number;
  cooldownRuns: number;
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
    cooldownMs: cfg?.cooldownMs ?? DEFAULT_SYMBOL_COOLDOWN_MS,
    cooldownRuns: cfg?.cooldownRuns ?? DEFAULT_SYMBOL_COOLDOWN_RUNS,
  };
}

/** 单向替换记录（展示层已替换的符号）。 */
export interface SymbolRemap {
  from: string;
  to: string;
}

/**
 * emoji 呈现起源的别名来源：展示层照常替换，但模型反馈按「先要求更换、再说明已替换」
 * 处理（2026-11）。勾/叉/警示/圆/方块等带色或 emoji 呈现的符号归入，细线变体不归入。
 */
const EMOJI_ORIGIN: ReadonlySet<string> = new Set([
  "✅",
  "❌",
  "🗸",
  "🗹",
  "🗷",
  "⚠",
  "⭕",
  "⚪",
  "⚫",
  "🔴",
  "🔵",
  "🟠",
  "🟡",
  "🟢",
  "🟣",
  "🟤",
  "🔳",
  "🔲",
  "⬛",
  "⬜",
  "🟥",
  "🟦",
  "🟧",
  "🟨",
  "🟩",
  "🟪",
  "🟫",
  "🔷",
  "🔹",
  "🔶",
  "🔸",
  "🔺",
  "🔼",
  "🔻",
  "🔽",
  "❗",
  "❕",
  "❓",
  "❔",
  "➕",
  "➖",
  "ℹ",
  "⏩",
  "⏵",
  "⏴",
  "⏪",
  "⏶",
  "⏷",
  "⏫",
  "⏬",
]);

/** 单次规范化的产出。 */
export interface NormalizeResult {
  /** 替换后的展示文本（无替代的符号保留原样）。 */
  text: string;
  /** 已替换次数（别名命中）。 */
  replacedCount: number;
  /** 替换明细（from → to，全部别名命中）。 */
  remaps: SymbolRemap[];
  /** 仅 emoji 起源的替换明细（模型反馈按「要求更换」列出）。 */
  emojiRemaps: SymbolRemap[];
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
  const emojiRemaps: SymbolRemap[] = [];
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
      if (EMOJI_ORIGIN.has(ch)) emojiRemaps.push({ from: ch, to: alias });
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
  return { text: out, replacedCount, remaps, emojiRemaps, unrecommended };
}
