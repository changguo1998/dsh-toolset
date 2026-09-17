// TUI/src/app/layout/fill.ts — Box 树摊平为 FrameRow[]（规范见 SPEC.md §6.5/§6.7）
//
// 通用摊平引擎：Paragraph/StyledText 折行→行内/式段→补白/对齐/valign，
// Box 递归 + separator。矩形来自 allocate 输出（rects: Map<Node, Rect>），
// 行内 markdown 复用 markdown.ts（wrapAssistantLine/wrapCodeLine），
// 结构分类在 build-box.ts 完成。

import type { Box, Node, Paragraph, Rect, StyledText } from "./box.ts";
import type {
  FrameRow,
  FrameSegment,
  FrameStyle,
} from "../../renderer/screen.ts";
import type { ColorName, ThemeId } from "../../renderer/theme.ts";
import {
  wrapAssistantLine,
  wrapCodeLine,
  wrapFrameSegments,
  displayWidth,
} from "./markdown.ts";
import { seg, rowWidth2 } from "./primitives.ts";

/** fill 上下文：主题（行内 markdown 着色调色板）+ 视口宽（装饰降级判定） */
export interface FillContext {
  themeId: ThemeId;
  /** 当前视口（内容区）列宽；prefix/suffix 的 minWidth 判定基准 */
  viewportWidth?: number;
}

/** fill 产出行：语义扩展（kind/blockId 供 foldDialogue/userInputJump 等） */
export interface ContentRow extends FrameRow {
  /** 来源 buffer 行类型（结构分类，buildBox 标注） */
  kind?: string;
  /** 逻辑块 id（同一用户消息/回复/tool 组共享；折叠/跳转定位用） */
  blockId?: number;
  /** 行级缩进（已并入 segments；冗余供快速读取） */
  indent?: number;
}

/** 节点 → 行元数据（buildBox 产出；fill 传播到每行） */
export type RowMeta = { kind?: string; blockId?: number; indent?: number };

/** 便捷：fill 整棵树到行数组（rects 由 allocate 输出，缺省每个节点=根 rect） */
export function fillToList(
  ctx: FillContext,
  node: Node,
  rect: Rect,
  rects?: Map<Node, Rect>,
  meta?: Map<Node, RowMeta>,
): ContentRow[] {
  const out: ContentRow[] = [];
  fill(ctx, node, rect, (row) => out.push(row), rects, meta);
  return out;
}

/** 递归摊平：节点 → 追加行（裁剪/滚动由上层处理） */
export function fill(
  ctx: FillContext,
  node: Node,
  rect: Rect,
  append: (row: ContentRow) => void,
  rects: Map<Node, Rect> = new Map(),
  meta?: Map<Node, RowMeta>,
): void {
  const r = rects.get(node) ?? rect;
  if (r.w <= 0 || r.h <= 0) return;
  if (node.kind === "text") return fillParagraph(ctx, node, r, append, meta);
  if (node.kind === "styled") return fillStyled(ctx, node, r, append, meta);
  fillBox(ctx, node, r, append, rects, meta);
}

// ---------------- Box ----------------

function fillBox(
  ctx: FillContext,
  box: Box,
  rect: Rect,
  append: (row: ContentRow) => void,
  rects: Map<Node, Rect>,
  meta?: Map<Node, RowMeta>,
): void {
  if (box.direction === "h") {
    // 横向：子项按各自 allocate 出的 x/w 绘制，逐行横向拼接（同 y 对齐）。
    // h 不画竖向分隔（竖线是叶子文本自带；SPEC §6.5）。
    // spacer（空文本 + 尺寸声明）只占横向容量，不产独立语义行。
    const isSpacer = (c: Node): boolean =>
      c.kind === "text" &&
      c.text === "" &&
      (c.width !== undefined || c.height !== undefined);
    const subs: ContentRow[][] = [];
    for (const child of box.children) {
      const r = rects.get(child) ?? rect;
      const buf: ContentRow[] = [];
      if (!isSpacer(child))
        fill(ctx, child, r, (row) => buf.push(row), rects, meta);
      subs.push(buf);
    }
    const maxRows = Math.max(
      1,
      ...box.children
        .map((c, i) => (isSpacer(c) ? 0 : subs[i]!.length))
        .concat(0),
    );
    // 内容子项（显式 spacer = 空文本 + 尺寸声明，无语义；空 body 仍算内容）
    const contentChildIdx = box.children.findIndex((c) => !isSpacer(c));
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
      // 合并行继承内容子项元数据（spacer 不产独立语义行）
      const meta =
        contentChildIdx >= 0 ? subs[contentChildIdx]![ri] : undefined;
      append({
        segments: segs,
        kind: meta?.kind,
        blockId: meta?.blockId,
        indent: meta?.indent,
      });
    }
    return;
  }
  // 纵向：子项行接续追加，separator 在子项间产 1 行横线
  for (let i = 0; i < box.children.length; i++) {
    const child = box.children[i]!;
    const r = rects.get(child) ?? { ...rect, h: rect.h };
    fill(ctx, child, r, append, rects, meta);
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

// ---------------- 装饰可见度 ----------------

/** 前缀在当视口宽是否可见（minWidth 降级） */
function prefixVisible(p: LeafLike, vw?: number): boolean {
  if (!p.prefix) return false;
  if (p.prefix.minWidth !== undefined && (vw ?? 0) < p.prefix.minWidth)
    return false;
  return true;
}

function suffixVisible(p: LeafLike, vw?: number): boolean {
  if (!p.suffix) return false;
  if (p.suffix.minWidth !== undefined && (vw ?? 0) < p.suffix.minWidth)
    return false;
  return true;
}

// ---------------- 公共叶子摊平：折行 → 装饰 → 对齐/valign ----------------

interface LeafLike {
  indent?: number;
  hanging?: number;
  /** 有无显式 height 声明（fill 补白仅在声明高度时生效；内容自然高不补） */
  hasHeight?: boolean;
  align?: "left" | "right" | "center";
  valign?: "top" | "center" | "bottom";
  prefix?: { text: string; style?: FrameStyle; minWidth?: number };
  suffix?: { text: string; style?: FrameStyle; minWidth?: number };
  tail?: { char: string; style?: FrameStyle };
  kind: string;
}

function decorateRows(
  p: LeafLike,
  rows: FrameSegment[][],
  rect: Rect,
  vw: number | undefined,
  rowMeta?: RowMeta,
  hasHeight = false,
): ContentRow[] {
  const prefixSegs: FrameSegment[] = prefixVisible(p, vw)
    ? [seg(p.prefix!.text, p.prefix!.style)]
    : [];
  const suffixSegs: FrameSegment[] = suffixVisible(p, vw)
    ? [seg(p.suffix!.text, p.suffix!.style)]
    : [];
  // suffix 块：正文按块最大行宽对齐（用户收缩块行尾竖线同列；SPEC §6.5）
  const maxBodyW =
    suffixSegs.length > 0 ? Math.max(...rows.map((r) => rowWidth2(r)), 0) : 0;
  const indent = p.indent ?? 0;
  const hanging = p.hanging ?? indent;
  let content: ContentRow[] = rows.map((line, ri) => {
    const padBody =
      suffixSegs.length > 0
        ? " ".repeat(Math.max(0, maxBodyW - rowWidth2(line)))
        : "";
    const rowSegs: FrameSegment[] = [
      ...prefixSegs,
      ...line,
      ...(padBody !== "" ? [seg(padBody)] : []),
      ...suffixSegs,
    ];
    // 悬挂续行缩进：首行缩进 indent，续行缩进 hanging（对齐正文起列）
    const lead = ri === 0 ? indent : hanging;
    const full: FrameSegment[] =
      lead > 0 ? [seg(" ".repeat(lead)), ...rowSegs] : rowSegs;
    return {
      segments: full,
      indent: ri === 0 ? indent : hanging,
      kind: rowMeta?.kind,
      blockId: rowMeta?.blockId,
    };
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
  // valign：仅显式声明高度时按 rect.h 补空白行（未声明 = 内容自然高，不补白）
  const fillRows =
    hasHeight && content.length < rect.h ? rect.h - content.length : 0;
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
  return content;
}

/** 节点是否声明了显式高度（valign 补白仅在声明高度时生效） */
function hasHeightDecl(p: { height?: unknown }): boolean {
  return p.height !== undefined;
}

// ---------------- Paragraph ----------------

function fillParagraph(
  ctx: FillContext,
  p: Paragraph,
  rect: Rect,
  append: (row: ContentRow) => void,
  meta?: Map<Node, RowMeta>,
): void {
  const prefixW = p.prefix ? displayWidth(p.prefix.text) : 0;
  const suffixW = p.suffix ? displayWidth(p.suffix.text) : 0;
  const bodyW = Math.max(1, rect.w - prefixW - suffixW);
  // tail 铺满行（空正文）：直接整行铺满
  if (p.tail && p.text === "") {
    const n = Math.max(1, rect.w);
    const m = meta?.get(p);
    append({
      segments: [seg(p.tail.char.repeat(n), p.tail.style ?? { fg: "border" })],
      indent: 0,
      kind: m?.kind,
      blockId: m?.blockId,
    });
    return;
  }
  // 与旧 wrapBufferLines 一致：assistant 正文整串交给解析器（跨 \n 不预拆，
  // 与 wrapAssistantLine/wrapCodeLine 的逐字符折行行为对齐）；plain 类走 StyledText。
  const rows: FrameSegment[][] = p.fillBg
    ? wrapCodeLine(p.text, bodyW)
    : wrapAssistantLine(p.text, bodyW, ctx.themeId);
  const content = decorateRows(
    p,
    rows,
    rect,
    ctx.viewportWidth,
    meta?.get(p),
    hasHeightDecl(p),
  );
  for (const row of content) append(row);
}

// ---------------- StyledText ----------------

function fillStyled(
  ctx: FillContext,
  p: StyledText,
  rect: Rect,
  append: (row: ContentRow) => void,
  meta?: Map<Node, RowMeta>,
): void {
  const prefixW = p.prefix ? displayWidth(p.prefix.text) : 0;
  const suffixW = p.suffix ? displayWidth(p.suffix.text) : 0;
  const bodyW = Math.max(1, rect.w - prefixW - suffixW);
  if (p.tail && p.segments.length === 0) {
    const n = Math.max(1, rect.w);
    const m = meta?.get(p);
    append({
      segments: [seg(p.tail.char.repeat(n), p.tail.style ?? { fg: "border" })],
      indent: 0,
      kind: m?.kind,
      blockId: m?.blockId,
    });
    return;
  }
  // 显式换行先在段内切分（每段独立折行；空行保留）
  const indent = p.indent ?? 0;
  const hanging = p.hanging ?? indent;
  const rows: FrameSegment[][] = splitAndWrapSegments(
    p.segments,
    bodyW,
    hanging,
  );
  const content = decorateRows(
    p,
    rows,
    rect,
    ctx.viewportWidth,
    meta?.get(p),
    hasHeightDecl(p),
  );
  for (const row of content) append(row);
}

/** 预样式段按 \n 切物理行，再逐段显示宽度折行（首行全宽/续行减 hanging） */
function splitAndWrapSegments(
  segs: FrameSegment[],
  width: number,
  hanging: number,
): FrameSegment[][] {
  const out: FrameSegment[][] = [];
  // 先按 \n 把段切成一串「物理行段」
  const lines: FrameSegment[][] = [[]];
  for (const s of segs) {
    const parts = s.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      const part = parts[i]!;
      if (part !== "")
        lines[lines.length - 1]!.push({ text: part, style: s.style });
    }
  }
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    if (line.length === 0) {
      out.push([]); // 空物理行
      continue;
    }
    const w = out.length === 0 ? width : Math.max(1, width - hanging);
    out.push(...wrapFrameSegments(line, w));
  }
  return out;
}

function emptyRow(): ContentRow {
  return { segments: [seg("")], indent: 0 };
}
