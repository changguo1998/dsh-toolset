// src/app/layout/pipeline/flatten.ts — §6 摊平：已量好的 LayoutTree → Row[]
//
// 职责（追踪文档 T35-T38）：
//   - 逐 Leaf 取 wrapLeaf 行，按 prefix / suffix / align 展开成 Row；
//   - 代码 / 表格 / 工具按各自网格 / 行模型铺行；
//   - 空 Leaf（Gap）→ 空行（**空行唯一来源**）；step / 回合头 tail 铺满；
//   - 不变式（测试）：摊平总行数 === Σ节点 height；空行只能来自显式 Gap。

import type { FrameSegment } from "../../../renderer/screen.ts";
import { seg } from "../primitives.ts";
import { displayWidth, expandCodeTabs } from "../markdown.ts";
import { wrapLeaf, styledToSegments } from "./wrap.ts";
import type { Leaf, Node, StyledStr, StyledText } from "./ir.ts";
import { isLeaf } from "./ir.ts";
import {
  prefixVisibleOf,
  sepChar,
  sepStyle,
  suffixVisibleOf,
} from "./measure.ts";
import { fitCols, type TableAlign } from "../table.ts";
import type { Paragraph, Row } from "./ir.ts";

export interface FlattenOptions {
  /** 视口宽（prefix/suffix 的 minWidth 降级判定基准） */
  vw?: number;
}

type Seg = FrameSegment;

function rowW(segs: readonly Seg[]): number {
  return segs.reduce((s, x) => s + displayWidth(x.text), 0);
}

/** 单个文本叶 → Row[]（折行 + 前缀 / 后缀 / 悬挂 / 对齐 / tail） */
function flattenLeaf(node: Leaf, width: number, opts: FlattenOptions): Row[] {
  const prefixOn = prefixVisibleOf(node, opts.vw);
  const prefixW = prefixOn ? displayWidth(node.prefix!.text) : 0;
  const suffixOn = suffixVisibleOf(node, opts.vw);
  const suffixW = suffixOn ? displayWidth(node.suffix!.text) : 0;
  const bodyW = Math.max(1, width - prefixW - suffixW);
  const hanging = Math.max(0, node.hanging ?? 0);
  const rows = wrapLeaf(node.text, bodyW, {
    prefixW: 0,
    hanging,
    ...(node.balance === true ? { balance: true } : {}),
  });
  const maxBodyW = suffixOn ? Math.max(0, ...rows.map(rowW)) : 0;
  const prefixSegs: Seg[] = prefixOn
    ? [seg(node.prefix!.text, node.prefix!.style)]
    : [];
  const suffixSegs: Seg[] = suffixOn
    ? [seg(node.suffix!.text, node.suffix!.style)]
    : [];
  const out: Row[] = rows.map((line, index) => {
    // 悬挂缩进：续行（第 0 行之后）前导补 hanging 列空白
    const hangSegs: Seg[] =
      hanging > 0 && index > 0 ? [seg(" ".repeat(hanging))] : [];
    const padN = suffixOn ? Math.max(0, maxBodyW - rowW(line) - hanging) : 0;
    // 左缘装饰（prefix）每行同列；行级缩进交给「嵌套盒 + 展平补白」，不再用节点字段
    return {
      segments: [
        ...prefixSegs,
        ...hangSegs,
        ...line,
        ...(padN > 0 ? [filledSeg(fillOf(node), padN)] : []),
        ...suffixSegs,
      ],
      ...(node.rowKind === undefined ? {} : { rowKind: node.rowKind }),
    };
  });
  if (node.align && node.align !== "left") {
    for (const row of out) {
      const pad = width - rowW(row.segments);
      if (pad <= 0) continue;
      const leading = node.align === "right" ? pad : Math.floor(pad / 2);
      row.segments = [seg(" ".repeat(leading)), ...row.segments];
    }
  }
  return out;
}

/** 递归摊平已量好的树 */
export function flatten(
  tree: Node | Leaf,
  width: number,
  opts: FlattenOptions = {},
): Row[] {
  const rows = flattenRaw(tree, width, opts);
  // 压缩剪枝遮蔽：整块打灰。颜色统一改 `gray`（内容与行数不变）；code / table / tool
  // 的子树在 §5 measure 期才展开，故打灰放在摊平出口而不是结构期逐叶改色。
  if (tree.dim !== true) return rows;
  return rows.map((row) => ({
    ...row,
    segments: row.segments.map((segment) => dimSegment(segment)),
  }));
}

/** 段 → 打灰段（只改前景色，字形与其它样式保留） */
function dimSegment(segment: Seg): Seg {
  return {
    ...segment,
    style: { ...(segment.style ?? {}), fg: "gray" },
  };
}

function flattenRaw(
  tree: Node | Leaf,
  width: number,
  opts: FlattenOptions = {},
): Row[] {
  if (isLeaf(tree)) return flattenLeaf(tree, width, opts);
  // 带 prefix / suffix 的 Node：先递归摊平子项（拿到 width 统一的内容行），每行按本节点
  // 的 align 补空格到 width，再在前后加符号。符号**不向下继承**——子项各自摊平自身内容。
  if (tree.prefix !== undefined || tree.suffix !== undefined) {
    const pfx = prefixVisibleOf(tree, opts.vw) ? tree.prefix : undefined;
    const sffx = suffixVisibleOf(tree, opts.vw) ? tree.suffix : undefined;
    const pfxW = pfx ? displayWidth(pfx.text) : 0;
    const sffxW = sffx ? displayWidth(sffx.text) : 0;
    // 左缘 chrome 列（对话/session 面板竖线）不吃正文宽；活动面板竖线计宽
    const contentW = Math.max(1, width - pfxW - sffxW);
    let inner: Row[];
    if (tree.direction === "v") {
      inner = [];
      for (const ch of tree.children)
        inner.push(...flatten(ch, contentW, opts));
    } else {
      // h：子项按分配宽各摊一行区，逐行拼接
      inner = flattenH(tree, contentW, opts);
    }
    // 补白到 contentW：右/居中靠它定位，带 suffix 时靠它把右缘符号推到列尾；
    // 纯左对齐也要补——行宽稳定是渲染层区间 diff 的前提（不加会出现：正文追加一个字
    // 就抬高整块 auto 宽，令该块每一行都变宽、整段重写；见 renderer-diff 回归用例）
    return inner.map((r) => {
      const used = rowW(r.segments);
      const gap = Math.max(0, contentW - used);
      // 补白位置由本节点对齐决定：right → 补前面；center → 两侧均分；left → 补后面
      const lead =
        tree.align === "right" ? gap : tree.align === "center" ? gap >> 1 : 0;
      const trail = gap - lead;
      const fill = fillOf(tree);
      return {
        segments: [
          ...(lead > 0 ? [filledSeg(fill, lead)] : []),
          // prefix 与 suffix 同为「每行装饰」：容器逐行绘制（续行留空会让竖线断 /
          // 引用标记丢失），与 flattenLeaf 口径一致
          ...(pfx ? [seg(pfx.text, pfx.style)] : []),
          ...r.segments,
          ...(trail > 0 ? [filledSeg(fill, trail)] : []),
          ...(sffx ? [seg(sffx.text, sffx.style)] : []),
        ],
      };
    });
  }
  if (tree.direction === "v") {
    const out: Row[] = [];
    for (const child of tree.children) out.push(...flatten(child, width, opts));
    // 空容器也占一行（与 measure 的 Math.max(1, …) 同口径）
    if (out.length === 0) out.push({ segments: [] });
    return padWithFill(out, width, tree.fillWith);
  }
  // h：子项行按行号拼接（各子项已量好自身宽；每行补白到该子分配宽，fill 空格可见）
  return padWithFill(flattenH(tree, width, opts), width, tree.fillWith);
}

/** 补白样式：未设置 `fillWith` 时按单空格（无样式） */
function fillOf(node: { fillWith?: StyledStr }): StyledStr {
  const f = node.fillWith;
  return f === undefined || f.text === "" ? { text: " " } : f;
}

/** 生成 `count` 列的补白段（填充符按单列字符处理，宽字符请自行保证列宽） */
function filledSeg(fill: StyledStr, count: number): Seg {
  const [only] = styledToSegments([{ ...fill, text: fill.text.repeat(count) }]);
  return only ?? { text: "" };
}

/** 按 `fillWith` 补白到指定宽（未设置则不补） */
function padWithFill(rows: Row[], width: number, fill?: StyledStr): Row[] {
  if (fill === undefined || fill.text === "" || rows.length === 0) return rows;
  return rows.map((r) => {
    const gap = width - rowW(r.segments);
    if (gap <= 0) return r;
    return { ...r, segments: [...r.segments, filledSeg(fill, gap)] };
  });
}

/** h 容器摊平：逐子项按分配宽摊平，再按行号横向拼接，每子项补白到自身分配宽 */
function flattenH(tree: Node, width: number, opts: FlattenOptions): Row[] {
  const subMeta: { rows: Row[]; w: number }[] = tree.children.map((c) => {
    const cw = Math.max(1, c.width ?? width);
    return { rows: flatten(c, cw, opts), w: cw };
  });
  const h = Math.max(1, ...subMeta.map((m) => m.rows.length));
  const out: Row[] = [];
  const sep = tree.separator;
  for (let ri = 0; ri < h; ri++) {
    const rowSegs: Seg[] = [];
    let rowKind: string | undefined = tree.rowKind;
    for (const [ci, { rows, w }] of subMeta.entries()) {
      if (ci > 0 && sep !== undefined)
        rowSegs.push(seg(sepChar(sep), sepStyle(sep)));
      const line = rows[ri];
      if (line) {
        rowSegs.push(...line.segments);
        const used = rowW(line.segments);
        if (used < w) rowSegs.push(seg(" ".repeat(w - used)));
        if (rowKind === undefined) rowKind = line.rowKind;
      } else {
        // 该子项此行不足（行高取 max）→ 空格补齐占用列，保持右对齐
        rowSegs.push(seg(" ".repeat(w)));
      }
    }
    out.push({
      segments: rowSegs,
      ...(rowKind === undefined ? {} : { rowKind }),
    });
  }
  return out;
}

/**
 * 逐项摊平：对面板根（v 容器，每个顶层 child 恰对应一个 PaneItem）返回**按 child
 * 归属**的行数组——`result[i]` = 第 i 个 PaneItem 摊出的 Row[]（可为空）。
 *
 * 用途（§3 接线桥）：老渲染层按「段键 + 段内行」定位滚动 / 收集用户块首行号，新链路
 * 的 `Row[]` 只有扁平段落。由于面板根 v 容器的每个顶层 child 与 `PaneItem` 一一对应
 * （structure.toPaneTree 的构建方式），本函数把一次 `flatten` 拆成逐 child 的一次，
 * 使**每个 item 的段落边界精确可读**，且总行数与整树 `flatten` 逐字节一致（不变量：
 * Σ result[i].length === flatten(root).length）。
 *
 * - 对非 v 根（单 item 面板，或根即 item 子树）：返回 `[flatten(root)]` 单段；
 * - 对 v 根：逐 child 在 `width` 下摊平（顶层 child 占满面板宽，tail 铺满 / 前缀一致）。
 */
