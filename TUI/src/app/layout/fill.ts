// TUI/src/app/layout/fill.ts — Box 树摊平为 FrameRow[]（规范见 SPEC.md §6.5/§6.7）
//
// 通用摊平引擎：Paragraph 折行→行内解析→补白/对齐/valign，Box 递归 +
// separator。矩形来自 allocate 输出（rects: Map<Node, Rect>），行内解析
// 复用 markdown.ts（wrapAssistantLine/wrapCodeLine 已含块级分类），
// 结构分类在 build-box.ts 完成。

import type { Box, Node, Paragraph, Rect } from "./box.ts";
import type { FrameRow, FrameSegment } from "../../renderer/screen.ts";
import type { ColorName, ThemeId } from "../../renderer/theme.ts";
import { wrapAssistantLine, wrapCodeLine, displayWidth } from "./markdown.ts";
import { seg, rowWidth2 } from "./primitives.ts";

/** fill 上下文：主题（行内 markdown 着色调色板） */
export interface FillContext {
  themeId: ThemeId;
}

/** fill 产出行：可选语义扩展（kind 供 foldDialogue/userInputJump 等行级操作） */
export interface ContentRow extends FrameRow {
  /** 来源 buffer 行类型（结构分类，buildBox 标注） */
  kind?: string;
  /** 行级缩进（已并入 segments；冗余供快速读取） */
  indent?: number;
}

/** 便捷：fill 整棵树到行数组（rects 由 allocate 输出，缺省每个节点=根 rect） */
export function fillToList(
  ctx: FillContext,
  node: Node,
  rect: Rect,
  rects?: Map<Node, Rect>,
): ContentRow[] {
  const out: ContentRow[] = [];
  fill(ctx, node, rect, (row) => out.push(row), rects);
  return out;
}

/** 递归摊平：节点 → 追加行（裁剪/滚动由上层处理） */
export function fill(
  ctx: FillContext,
  node: Node,
  rect: Rect,
  append: (row: ContentRow) => void,
  rects: Map<Node, Rect> = new Map(),
): void {
  if (rect.w <= 0 || rect.h <= 0) return;
  if (node.kind === "text") return fillParagraph(ctx, node, rect, append);
  fillBox(ctx, node, rect, append, rects);
}

// ---------------- Box ----------------

function fillBox(
  ctx: FillContext,
  box: Box,
  rect: Rect,
  append: (row: ContentRow) => void,
  rects: Map<Node, Rect>,
): void {
  if (box.direction === "h") {
    // 横向：子项按各自 allocate 出的 x/w 绘制，逐行横向拼接（同 y 对齐）。
    // h 不画竖向分隔（竖线是叶子文本自带；SPEC §6.5）。
    const subs: ContentRow[][] = [];
    for (const child of box.children) {
      const r = rects.get(child) ?? rect;
      const buf: ContentRow[] = [];
      fill(ctx, child, r, (row) => buf.push(row), rects);
      subs.push(buf);
    }
    const maxRows = Math.max(1, ...subs.map((s) => s.length));
    for (let ri = 0; ri < maxRows; ri++) {
      let segs: FrameSegment[] = [];
      for (let ci = 0; ci < box.children.length; ci++) {
        const child = box.children[ci]!;
        const r = rects.get(child) ?? rect;
        const off = Math.max(0, r.x - rect.x);
        // 子项横向偏移：当前已拼宽度 < off 时补前缀空格
        const cur = rowWidth2(segs);
        if (cur < off) segs.push(seg(" ".repeat(off - cur)));
        const line = subs[ci]![ri];
        const lineW = line ? rowWidth2(line.segments) : 0;
        if (line && lineW > 0) {
          segs.push(...line.segments);
        } else {
          // 子项该行无可见内容（空段/spacer/缺行）：补齐到其右缘（保持横向结构）
          const target = off + Math.max(0, r.w);
          const c2 = rowWidth2(segs);
          if (c2 < target) segs.push(seg(" ".repeat(target - c2)));
        }
      }
      append({ segments: segs });
    }
    return;
  }
  // 纵向：子项行接续追加，separator 在子项间产 1 行横线
  for (let i = 0; i < box.children.length; i++) {
    const child = box.children[i]!;
    const r = rects.get(child) ?? { ...rect, h: rect.h };
    fill(ctx, child, r, append, rects);
    if (box.separator && i < box.children.length - 1) {
      append(separatorRow(box.separator.char, box.separator.color, rect.w));
    }
  }
}

function separatorRow(
  char: string | undefined,
  color: ColorName | undefined,
  w: number,
): ContentRow {
  const c = char ?? "╌";
  return {
    segments: [seg(c.repeat(Math.max(1, w)), { fg: color ?? "border" })],
  };
}

// ---------------- Paragraph ----------------

function fillParagraph(
  ctx: FillContext,
  p: Paragraph,
  rect: Rect,
  append: (row: ContentRow) => void,
): void {
  const prefixW = p.prefix ? displayWidth(p.prefix.text) : 0;
  const suffixW = p.suffix ? displayWidth(p.suffix.text) : 0;
  const bodyW = Math.max(1, rect.w - prefixW - suffixW);
  // tail 铺满行（空正文）：直接整行铺满
  if (p.tail && p.text === "") {
    const n = Math.max(1, rect.w);
    append({
      segments: [seg(p.tail.char.repeat(n), p.tail.style ?? { fg: "border" })],
      indent: 0,
    });
    return;
  }
  // 显式换行先分行（每段独立解析；空行保留为空段）
  const paragraphs = p.text.split("\n");
  // 解析：fillBg → 代码块灰底补齐；否则普通（含块级分类 + 行内 markdown）
  const rows: FrameSegment[][] = paragraphs.flatMap((para) =>
    p.fillBg
      ? wrapCodeLine(para, bodyW)
      : wrapAssistantLine(para, bodyW, ctx.themeId),
  );
  // 挂 prefix / suffix，逐行重复
  const prefixSegs: FrameSegment[] = p.prefix
    ? [seg(p.prefix.text, p.prefix.style)]
    : [];
  const suffixSegs: FrameSegment[] = p.suffix
    ? [seg(p.suffix.text, p.suffix.style)]
    : [];
  let content: ContentRow[] = rows.map((line) => {
    const rowSegs: FrameSegment[] = [...prefixSegs, ...line, ...suffixSegs];
    const indent = p.indent ?? 0;
    const full: FrameSegment[] =
      indent > 0 ? [seg(" ".repeat(indent)), ...rowSegs] : rowSegs;
    return { segments: full, indent };
  });
  // tail：非空正文时行尾补 char 到 rect.w
  if (p.tail) {
    content = content.map((row) => {
      const w = rowWidth2(row.segments);
      const pad = Math.max(0, rect.w - w);
      if (pad <= 0) return row;
      return {
        ...row,
        segments: [
          ...row.segments,
          seg(p.tail!.char.repeat(pad), p.tail!.style ?? { fg: "border" }),
        ],
      };
    });
  }
  // align：右/中对齐按 rect.w 计算行内偏移（仅 fixed/fill 宽时有效）
  if (p.align && p.align !== "left" && rect.w > 0) {
    content = content.map((row) => {
      const w = rowWidth2(row.segments);
      const pad = rect.w - w;
      if (pad <= 0) return row;
      const leading = p.align === "right" ? pad : Math.floor(pad / 2);
      return { ...row, segments: [seg(" ".repeat(leading)), ...row.segments] };
    });
  }
  // valign：自身行数 < rect.h 时补空白行（vertical fill）
  const fillRows = content.length < rect.h ? rect.h - content.length : 0;
  if (fillRows > 0) {
    if (p.valign === "bottom") {
      content = [...Array(fillRows).fill(emptyRow()), ...content];
    } else if (p.valign === "center") {
      const top = Math.floor(fillRows / 2);
      content = [
        ...Array(top).fill(emptyRow()),
        ...content,
        ...Array(fillRows - top).fill(emptyRow()),
      ];
    } else {
      content = [...content, ...Array(fillRows).fill(emptyRow())];
    }
  }
  for (const row of content) append(row);
}

function emptyRow(): ContentRow {
  return { segments: [seg("")], indent: 0 };
}
