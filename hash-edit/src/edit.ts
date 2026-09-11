/**
 * edit：LINE:HASH 锚定编辑核心逻辑（纯函数，无 IO）。
 *
 * 四类编辑指令（行号均锚定「读取时的原始内容」，1 基）：
 * - set_line:      将单行替换为 new_text（new_text 可含换行，展开为多行；空串 = 该行变空行）
 * - replace_lines: 将闭区间 [start, end] 替换为 new_text（new_text="" 为纯删除，不保留空行）
 * - insert_after:  在锚点行之后插入 new_text 展开的行（new_text="" 为 no-op；锚末行 = 追加到文件尾）
 * - delete_line:   删除单行
 *
 * 校验顺序（全部针对读取快照，任一失败即整体拒绝、无半写）：
 * 1) malformed:        edits 为空 / 指令形状非法 / 锚点语法非法 / replace 的 end 先于 start
 * 2) out_of_range:     锚点行号超出文件行数
 * 3) stale_anchors:    任一锚点哈希与当前行内容不符（列出全部 stale 锚点，便于取新锚重试）
 * 4) overlapping_edits:两条指令作用于同一行（replace 按其闭区间占用）
 *
 * 应用：按锚点行升序对原始内容单次线性扫描拼接，指令之间互不干扰（多锚点串行编辑）。
 */

import {
  type Hashline,
  detectLineEnding,
  fileHash,
  hashLine,
  hashlines,
  parseLineAnchor,
  splitLines,
} from "./hashline.ts";

/** 编辑拒绝错误码（按校验顺序产生）。 */
export type EditErrorCode =
  "malformed" | "out_of_range" | "stale_anchors" | "overlapping_edits";

/** 失败锚点明细：锚点原文 + 行号；stale 时附 expected（锚点声称值）与 actual（文件当前值）。 */
export interface AnchorDetail {
  anchor: string;
  line?: number;
  expected?: string;
  actual?: string;
  reason: string;
}

/** 锚定编辑拒绝错误：code + details（stale 列出全部失败锚点，调用方可据此逐行取新锚点）。 */
export class AnchoredEditError extends Error {
  constructor(
    public readonly code: EditErrorCode,
    message: string,
    public readonly details: AnchorDetail[],
  ) {
    super(message);
    this.name = "AnchoredEditError";
  }
}

/** 编辑指令：判别联合，每条恰好一个变体键。 */
export type EditOp =
  | { set_line: { anchor: string; new_text: string } }
  | {
      replace_lines: {
        start_anchor: string;
        end_anchor: string;
        new_text: string;
      };
    }
  | { insert_after: { anchor: string; new_text: string } }
  | { delete_line: { anchor: string } };

/** 编辑结果（成功）：新内容 + 新锚点（供下一轮编辑直接取用）。 */
export interface EditSuccess {
  ok: true;
  content: string;
  line_count: number;
  file_hash: string;
  hashlines: Hashline[];
  /** 实际应用的指令（升序）：指令类型 + 锚点行号 + 产出行数。 */
  applied: Array<{ op: string; line: number; new_line_count: number }>;
}

type OpKind = "set" | "replace" | "insert" | "delete";

/** 归一化后的指令：占用原始内容的行区间 [first, last]（insert 为虚拟边界，不消费行）。 */
interface NormalizedOp {
  kind: OpKind;
  first: number;
  last: number;
  textLines: string[];
  /** 本条指令的全部锚点原文（用于错误明细）。 */
  anchors: string[];
}

const OP_VARIANTS: readonly string[] = [
  "set_line",
  "replace_lines",
  "insert_after",
  "delete_line",
];

/** new_text 展开为行列表（按 \r\n / \n 拆分；末尾换行会显式产生一个尾随空行）。 */
function splitNewText(text: string): string[] {
  return text.split(/\r\n|\n/);
}

/**
 * 解析单条指令：先用 `in` 窄化判别联合（TS 无法经字符串变量窄化），
 * 形状非法或锚点语法非法时抛 malformed（details 收集全部问题锚点）。
 */
function parseOp(
  op: EditOp,
  index: number,
  problems: AnchorDetail[],
): NormalizedOp {
  const keys = Object.keys(op);
  if (keys.length !== 1 || !OP_VARIANTS.includes(keys[0] ?? "")) {
    throw new AnchoredEditError(
      "malformed",
      `edits[${index}] must contain exactly one of: ${OP_VARIANTS.join(", ")}`,
      problems,
    );
  }
  const fail = (anchor: string, reason: string): never => {
    problems.push({ anchor, reason });
    throw new AnchoredEditError(
      "malformed",
      `edits[${index}]: ${reason} (anchor: ${anchor})`,
      problems,
    );
  };
  const parse = (anchor: string) => {
    const r = parseLineAnchor(anchor);
    return r.ok ? r.anchor : fail(anchor, "invalid LINE:HASH anchor");
  };

  if ("set_line" in op) {
    const item = op.set_line;
    const a = parse(item.anchor);
    return {
      kind: "set",
      first: a.line,
      last: a.line,
      textLines: splitNewText(item.new_text),
      anchors: [item.anchor],
    };
  }
  if ("replace_lines" in op) {
    const item = op.replace_lines;
    const start = parse(item.start_anchor);
    const end = parse(item.end_anchor);
    if (end.line < start.line) {
      problems.push({
        anchor: item.end_anchor,
        reason: "replace_lines end anchor precedes start anchor",
      });
      throw new AnchoredEditError(
        "malformed",
        `edits[${index}]: replace_lines end anchor precedes start anchor`,
        problems,
      );
    }
    // new_text="" 为纯删除（0 行）；其余按换行展开（至少 1 行）
    const textLines = item.new_text === "" ? [] : splitNewText(item.new_text);
    return {
      kind: "replace",
      first: start.line,
      last: end.line,
      textLines,
      anchors: [item.start_anchor, item.end_anchor],
    };
  }
  if ("insert_after" in op) {
    const item = op.insert_after;
    const a = parse(item.anchor);
    const textLines = item.new_text === "" ? [] : splitNewText(item.new_text);
    return {
      kind: "insert",
      first: a.line,
      last: a.line,
      textLines,
      anchors: [item.anchor],
    };
  }
  // "delete_line" in op（前置形状校验保证恰好一个变体键）
  const item = op.delete_line;
  const a = parse(item.anchor);
  return {
    kind: "delete",
    first: a.line,
    last: a.line,
    textLines: [],
    anchors: [item.anchor],
  };
}

/**
 * 对内容应用锚定编辑（纯函数：校验全部通过才返回新内容，否则抛 AnchoredEditError，
 * 内容保持原样）。返回新内容与全部新锚点（hashlines）。
 */
export function applyAnchoredEdits(
  content: string,
  edits: readonly EditOp[],
): EditSuccess {
  // 1) 形状与锚点语法校验（收集全部 malformed 问题后一次性拒绝）
  if (edits.length === 0) {
    throw new AnchoredEditError(
      "malformed",
      "edits must contain at least one edit",
      [],
    );
  }
  const problems: AnchorDetail[] = [];
  const ops = edits.map((op, i) => parseOp(op, i, problems));
  if (problems.length > 0) {
    throw new AnchoredEditError(
      "malformed",
      `malformed anchor(s): ${problems.map((d) => d.anchor).join(", ")}`,
      problems,
    );
  }

  // 2) 行号范围校验（针对原始内容行数）
  const lines = splitLines(content);
  const lineCount = lines.length;
  const outOfRange: AnchorDetail[] = [];
  for (const op of ops) {
    for (const anchor of op.anchors) {
      const line = anchorToLine(op, anchor);
      if (line > lineCount) {
        outOfRange.push({
          anchor,
          line,
          reason: `line ${line} is outside the file (${lineCount} lines)`,
        });
      }
    }
  }
  if (outOfRange.length > 0) {
    throw new AnchoredEditError(
      "out_of_range",
      `anchor line(s) outside the file: ${outOfRange.map((d) => d.anchor).join(", ")}`,
      outOfRange,
    );
  }

  // 3) 哈希校验：逐锚点核对当前行内容，任一不符即 stale（列出全部 stale 锚点）
  const stale: AnchorDetail[] = [];
  for (const op of ops) {
    for (const anchor of op.anchors) {
      const line = anchorToLine(op, anchor);
      const parsed = parseLineAnchor(anchor);
      if (!parsed.ok) continue; // 不可达：阶段 1 已拒绝
      const actual = hashLine(lines[line - 1] ?? "");
      if (actual !== parsed.anchor.hash) {
        stale.push({
          anchor,
          line,
          expected: parsed.anchor.hash,
          actual,
          reason: `stale anchor: content hash mismatch`,
        });
      }
    }
  }
  if (stale.length > 0) {
    throw new AnchoredEditError(
      "stale_anchors",
      `stale anchor(s), file changed since read: ${stale.map((d) => d.anchor).join(", ")}`,
      stale,
    );
  }

  // 4) 重叠校验：任一两条指令占用同一行即拒绝（按锚点行升序比较相邻指令）
  const sorted = [...ops].sort((a, b) => a.first - b.first);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev !== undefined && cur !== undefined && prev.last >= cur.first) {
      const details: AnchorDetail[] = [...prev.anchors, ...cur.anchors].map(
        (anchor) => ({
          anchor,
          reason: "edits overlap: both target the same line",
        }),
      );
      throw new AnchoredEditError(
        "overlapping_edits",
        `edits overlap: ${details.map((d) => d.anchor).join(", ")}`,
        details,
      );
    }
  }

  // 5) 应用：按锚点行升序单次线性扫描，拼接新内容
  const ending = detectLineEnding(content);
  const out: string[] = [];
  let cursor = 0; // 原始内容中下一个待消费的 0 基行号
  const applied: EditSuccess["applied"] = [];
  for (const op of sorted) {
    const start = op.first - 1; // 锚点/目标行的 0 基行号
    // insert_after 保留锚点行本身（先于插入内容输出），其余指令从锚点行起消费
    const keep = op.kind === "insert" ? start + 1 : start;
    out.push(...lines.slice(cursor, keep));
    cursor = op.last; // 下一待消费 0 基行号
    out.push(...op.textLines);
    applied.push({
      op: op.kind,
      line: op.first,
      new_line_count: op.textLines.length,
    });
  }
  out.push(...lines.slice(cursor));

  // 尾随换行：原文件（非空）以换行结尾则写回同样以换行结尾
  const trailing = content !== "" && content.endsWith("\n") ? ending : "";
  const next = out.join(ending) + trailing;
  return {
    ok: true,
    content: next,
    line_count: splitLines(next).length,
    file_hash: fileHash(next),
    hashlines: hashlines(next),
    applied,
  };
}

/** 取指令中某锚点对应的行号（replace_lines 的 start/end 锚点行号不同，其余为同一行）。 */
function anchorToLine(op: NormalizedOp, anchor: string): number {
  if (op.kind === "replace") {
    const idx = op.anchors.indexOf(anchor);
    return idx === 1 ? op.last : op.first;
  }
  return op.first;
}
