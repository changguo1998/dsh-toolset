// src/prune.ts — pruned 模式：语言无关的智能裁剪。
// 预算 = min(maxLines, maxTokens*4 字符)；保留头部约 2/3 + 尾部约 1/3，
// 切点吸附到最近的边界行（空行 / 分隔线 / Markdown 标题 / 闭合括号行 / 顶层语句结束），
// 中间插入一行省略标记。文件本身在预算内时 truncated=false 返回全文。

/** token 估算：4 字符 ≈ 1 token（近似口径）。 */
export const CHARS_PER_TOKEN = 4;

/** pruned 默认预算。 */
export const DEFAULT_MAX_LINES = 200;
export const DEFAULT_MAX_TOKENS = 4000;

/** pruned 选项（缺省取 DEFAULT_*）。 */
export interface PruneOptions {
  maxLines?: number;
  maxTokens?: number;
}

/** 裁剪输出结果（不含 path，由 digest 层补全）。 */
export interface PruneOutcome {
  totalLines: number;
  truncated: boolean;
  keptHead: number;
  keptTail: number;
  elidedLines: number;
  estimatedTokens: number;
  text: string;
}

/**
 * 裁剪文本：
 * 1. 行数与字符数都在预算内 → 全文返回（truncated=false）；
 * 2. 否则内容行预算 = maxLines - 1（1 行留给省略标记），token 预算更紧时按字符/行比例削减；
 * 3. 头部 2/3、尾部 1/3 分配内容行；
 * 4. 切点各向文件中部方向最多移动 5 行吸附到边界行；
 * 5. 组装 头部 + 省略标记 + 尾部。
 */
export function pruneText(text: string, opts: PruneOptions = {}): PruneOutcome {
  // 1) 解析预算
  const maxLines = Math.max(2, opts.maxLines ?? DEFAULT_MAX_LINES);
  const maxTokens = Math.max(2, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
  const charBudget = maxTokens * CHARS_PER_TOKEN;
  // 2) 分行（空串 = 0 行）
  const lines = text.length > 0 ? text.split("\n") : [];
  const totalLines = lines.length;
  // 3) 双预算内 → 全文
  if (totalLines <= maxLines && text.length <= charBudget) {
    return {
      totalLines,
      truncated: false,
      keptHead: totalLines,
      keptTail: 0,
      elidedLines: 0,
      estimatedTokens: estimateTokens(text),
      text,
    };
  }
  // 4) 内容行预算；token 预算更紧时按文件平均字符/行比例折算行数
  let contentBudget = Math.max(1, maxLines - 1);
  if (text.length > charBudget) {
    const byTokens = Math.max(
      1,
      Math.floor((charBudget * totalLines) / Math.max(1, text.length)),
    );
    contentBudget = Math.max(1, Math.min(contentBudget, byTokens));
  }
  // 5) 头部 2/3、尾部 1/3（各至少 1 行）
  const headBudget = Math.max(1, Math.floor((contentBudget * 2) / 3));
  const tailBudget = Math.max(1, contentBudget - headBudget);
  // 6) 名义切点（0 基）：头部保留 [0, headEnd)，尾部保留 [tailStart, totalLines)
  let headEnd = Math.min(headBudget, Math.max(0, totalLines - tailBudget - 1));
  let tailStart = Math.max(headEnd + 1, totalLines - tailBudget);
  // 7) 切点吸附：headEnd 向前（文件开头方向）、tailStart 向后（文件末尾方向）各至多 5 行
  headEnd = snapCut(lines, headEnd, -1);
  tailStart = snapCut(lines, tailStart, 1);
  // 8) 组装：头部 + 省略标记 + 尾部
  const head = lines.slice(0, headEnd);
  const tail = lines.slice(tailStart);
  const elidedCount = Math.max(0, tailStart - headEnd - 1);
  const marker = `... [${elidedCount} 行已省略，共 ${totalLines} 行] ...`;
  const outText = [...head, marker, ...tail].join("\n");
  return {
    totalLines,
    truncated: true,
    keptHead: headEnd,
    keptTail: tail.length,
    elidedLines: elidedCount,
    estimatedTokens: estimateTokens(outText),
    text: outText,
  };
}

/**
 * 边界行判定：空行、Markdown 标题/分隔线、任意缩进的闭合括号行、
 * 缩进为 0 且以语句结束符（; } ] )）结束的行。
 */
export function isBoundaryLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === "") return true;
  if (/^#{1,6}\s/.test(trimmed)) return true; // Markdown 标题
  if (/^-{3,}\s*$/.test(trimmed)) return true; // 分隔线
  if (/^\s*[}\])](?:\s*;)?\s*(?:\/\/.*)?$/.test(line)) return true; // 闭合括号行
  if (indentOf(line) === 0 && /\S.*[;}\])](\s*\/\/.*)?$/.test(line))
    return true; // 顶层语句结束
  return false;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** 切点吸附：沿 dir 方向（-1 向文件开头 / +1 向文件末尾）最多 5 行寻找边界行，找不到保持原切点。 */
function snapCut(lines: string[], pos: number, dir: 1 | -1): number {
  for (let d = 1; d <= 5; d += 1) {
    const idx = pos + dir * d;
    const line = lines[idx];
    if (line !== undefined && isBoundaryLine(line)) return idx;
  }
  return pos;
}

/** token 估算：ceil(字符数 / 4)。 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
