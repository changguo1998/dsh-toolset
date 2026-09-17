// TUI/src/app/layout/build-box.ts — buffer 内容 → Box 内容树（规范见 DESIGN.md §6）
//
// width 无关的结构分类与聚合（advisor 定案）：
//  - tool 分组/折叠、fence 状态注解、step 头识别在 buildBox
//  - 折行/右对齐/step 虚线展开/逐行装饰（竖线）在 fill（经 prefix/suffix/
//    tail/minWidth 声明）
// 产出 BuildBoxResult：内容 Box 树 + 行元数据（kind/blockId），供 measure/
// allocate/fill 管线消费。不依赖 layout.ts（共享规则走 content-rules.ts）。

import type { Box, Node } from "./box.ts";
import { v, h, text, styled, spacer } from "./box.ts";
import type { Buffer, BufferKind } from "../state.ts";
import type { ColorName, ThemeId } from "../../renderer/theme.ts";
import {
  TOOL_MAX_GROUPS,
  TOOL_MORE,
  TOOL_CONT_INDENT,
  USER_MIN_LEFT_GUTTER,
  isToolCall,
  isToolResult,
  NOTICE_TONE_COLOR,
  renderToolText,
  renderToolNameLine,
} from "./content-rules.ts";

/** 行元数据（fill 传播到 ContentRow） */
export interface RowMeta {
  kind?: BufferKind;
  blockId?: number;
}

/** buildBox 产物：内容树 + 行元数据映射 */
export interface BuildBoxResult {
  /** 对话区内容树（v 容器；user/assistant/separator/plain） */
  dialogue: Box;
  /** 活动区内容树（v 容器；thinking/tool/notice/非 final assistant） */
  activity: Box;
  /** 节点 → 行元数据（buildBox 标注；fill 传播） */
  meta: Map<Node, RowMeta>;
}

/** buildBox 输入上下文（width 无关） */
export interface BuildBoxOptions {
  themeId: ThemeId;
  /** 用户/助手右缘留白（assistantMaxBodyWidth 的 gutter；固定配置非 width 相关） */
  gutter?: number;
}

let nextBlockId = 0;
function freshBlockId(): number {
  nextBlockId += 1;
  return nextBlockId;
}

/** 工具调用行样式段（首词黄 + 其余原色；折行由 fill 做） */
function toolCallSegs(line: string) {
  return renderToolNameLine(line);
}

/** 工具结果/辅助行样式段（✓ 绿 / ✗ tone / 原样） */
function toolLineSegs(line: string, tone?: string) {
  if (tone !== undefined) {
    const color = NOTICE_TONE_COLOR[tone as keyof typeof NOTICE_TONE_COLOR];
    return [{ text: line, style: { fg: color } }];
  }
  return renderToolText(line);
}

/**
 * 把 buffer 分类为对话/活动两棵内容树。
 *
 * 分类逻辑 = 现 wrapBufferLines 的结构平移：
 *  - assistant：final → dialogue、非 final → activity；fence 跨行状态注解
 *  - tool：连续 run 分组 + TOOL_MAX_GROUPS 折叠 + step 头
 *  - user：整块右对齐（h[spacer(fill), styled]）+ 右缘竖线（suffix, minWidth）
 *  - thinking：prefix 紫竖线（minWidth）、空行跳过
 *  - notice：tone 着色
 *  - separator/plain：对话区
 */
export function buildBox(
  buffer: Buffer,
  opts: BuildBoxOptions,
): BuildBoxResult {
  const meta = new Map<Node, RowMeta>();
  const dialogueLeaves: Node[] = [];
  const activityLeaves: Node[] = [];
  // fence 跨行状态（结构注解：fence 内行 → fillBg 代码块）
  let inFence = false;
  // tool 连续 run 缓冲（flushToolRun 时分组/折叠/step）
  const toolRun: { line: { text: string; tone?: string }; meta: RowMeta }[] =
    [];
  const flushToolRun = (): void => {
    if (toolRun.length === 0) return;
    // 分组：无状态符号前缀行 = 调用（新组起点）
    const groups: { text: string; tone?: string }[][] = [[]];
    for (const item of toolRun) {
      if (isToolCall(item.line.text) && groups[groups.length - 1]!.length > 0)
        groups.push([]);
      groups[groups.length - 1]!.push(item.line);
    }
    const visible = groups.slice(-TOOL_MAX_GROUPS);
    const hasMore = groups.length > TOOL_MAX_GROUPS;
    if (hasMore) {
      const id = freshBlockId();
      const more = styled([
        { text: TOOL_MORE, style: { fg: NOTICE_TONE_COLOR.log } },
      ]);
      meta.set(more, { kind: "tool", blockId: id });
      activityLeaves.push(more);
    }
    for (const group of visible) {
      const bid = freshBlockId();
      for (let li = 0; li < group.length; li++) {
        const l = group[li]!;
        // step 头：虚线整行（tail 铺满）
        const stepM = /^step (\d+)$/.exec(l.text);
        let node: Node;
        if (stepM) {
          node = styled([{ text: `╌╌ step ${stepM[1]} ` }], {
            tail: { char: "╌" },
          });
        } else {
          const isCall = li === 0 && isToolCall(l.text);
          const isResult = isToolResult(l.text);
          // 调用/结果行：wrapToolCallText 折行语义（首行全宽、续行 hanging 缩进）
          node = styled(
            isCall || isResult
              ? toolCallSegs(l.text)
              : toolLineSegs(l.text, l.tone),
            {
              // 折行缩进语义由 fill 处理；这里声明悬挂缩进让测量/折宽一致
              ...(isCall || isResult ? { hanging: TOOL_CONT_INDENT } : {}),
            },
          );
        }
        meta.set(node, { kind: "tool", blockId: bid });
        activityLeaves.push(node);
      }
    }
    toolRun.length = 0;
  };

  for (const line of buffer) {
    const rowMeta: RowMeta = { kind: line.kind, blockId: freshBlockId() };
    if (line.kind === "tool") {
      toolRun.push({
        line: { text: line.text, tone: line.tone },
        meta: rowMeta,
      });
      continue;
    }
    if (toolRun.length > 0) flushToolRun();
    if (line.kind === "thinking") {
      // 空思考行跳过（流式增量换行锚点）
      if (line.text === "") continue;
      const node = styled([{ text: line.text }], {
        prefix: {
          text: "┃",
          style: { fg: "brightMagenta" },
          minWidth: USER_MIN_LEFT_GUTTER + 2,
        },
      });
      meta.set(node, rowMeta);
      activityLeaves.push(node);
      continue;
    }
    if (line.kind === "user") {
      // 整块右对齐 + 右缘竖线：h([spacer(fill), styled(文本, suffix 竖线)])
      const body = styled([{ text: line.text }], {
        suffix: {
          text: "┃",
          style: { fg: "brightRed" },
          minWidth: USER_MIN_LEFT_GUTTER + 2,
        },
      });
      const gutter = opts.gutter ?? USER_MIN_LEFT_GUTTER;
      // 右缘保底留白 gutter 列：其中 1 列已被右竖线（suffix）占用 → 剩余 gutter-1
      const block = h([
        spacer({ width: { mode: "fill", min: Math.max(0, gutter - 1) } }),
        body,
      ]);
      meta.set(body, rowMeta);
      meta.set(block, rowMeta);
      dialogueLeaves.push(block);
      continue;
    }
    if (line.kind === "assistant") {
      const target = line.final ? dialogueLeaves : activityLeaves;
      // 含显式换行的单条行：旧 wrapBufferLines 的 FENCE_RE 对整串不匹配（^…$ 需整行），
      // 整段交 wrapAssistantLine 解析；fill 的 Paragraph 按 \n 拆物理行。直接产单节点。
      if (line.text.includes("\n")) {
        const body = text(line.text, {
          prefix: {
            text: "┃",
            style: { fg: "brightBlue" },
            minWidth: USER_MIN_LEFT_GUTTER + 2,
          },
        });
        meta.set(body, rowMeta);
        target.push(line.final ? finalSpace(body, opts, meta, rowMeta) : body);
        continue;
      }
      // 空正文行：旧「块内空行竖线连排」动态决定是否挂竖线——空行先产无竖线纯空；
      // （buildBox 不做块级连排后处理，此为空行最简等价，对照测试覆盖常规场景）
      if (line.text === "") {
        const blank = text("", {});
        meta.set(blank, rowMeta);
        target.push(blank);
        continue;
      }
      // 单行（无内部换行）：fence 开关行隐藏并切换跨行状态；正文按状态渲染
      const fence = /^ {0,3}(\`\`\`+|~~~+)[ \t]*([\w.+-]*)[ \t]*$/.exec(
        line.text,
      );
      if (fence && fence[1]!.length >= 3) {
        if (inFence) {
          inFence = false;
        } else {
          inFence = true;
          const lang = fence[2] ?? "";
          if (lang) {
            const langNode = styled([{ text: lang, style: { italic: true } }]);
            meta.set(langNode, rowMeta);
            target.push(langNode);
          }
        }
        continue;
      }
      const body = text(line.text, {
        ...(inFence ? { fillBg: true } : {}),
        prefix: {
          text: "┃",
          style: { fg: "brightBlue" },
          minWidth: USER_MIN_LEFT_GUTTER + 2,
        },
      });
      meta.set(body, rowMeta);
      target.push(line.final ? finalSpace(body, opts, meta, rowMeta) : body);
      continue;
    }
    if (line.kind === "notice") {
      const tone = line.tone;
      const style =
        tone !== undefined
          ? { style: { fg: NOTICE_TONE_COLOR[tone] as ColorName } }
          : {};
      const node = styled([{ text: line.text }], style);
      // 空文本不舍弃（notice 空行可能保留语义）
      meta.set(node, rowMeta);
      activityLeaves.push(node);
      continue;
    }
    // separator / plain → 对话区
    if (line.kind === "separator") {
      const node = styled([], {
        tail: { char: "╌", style: { fg: "border" } },
      });
      meta.set(node, rowMeta);
      dialogueLeaves.push(node);
      continue;
    }
    const node = styled([{ text: line.text }]);
    meta.set(node, rowMeta);
    dialogueLeaves.push(node);
  }
  if (toolRun.length > 0) flushToolRun();

  // 结构后处理（advisor：buildBox 内做，避免生产期 fill 后清理）：
  // 1) 尾部 assistant 空行删除
  let dialogue: Node[] = dialogueLeaves;
  dialogue = trimTrailingAssistantBlanks(dialogue, meta);
  // 2) user → assistant 之间插空行
  dialogue = spaceUserAssistant(dialogue, meta);
  // 3) 块内空行竖线连排（旧 wrapBufferLines：同 kind 块内空行补左右竖线）
  dialogue = lineUpBlockBars(dialogue, meta, opts);

  return {
    dialogue: v(dialogue),
    activity: v(activityLeaves),
    meta,
  };
}

/** final assistant 正文：h([body, spacer(fixed gutter-1)]) 右缘留白 */
function finalSpace(
  body: Node,
  opts: BuildBoxOptions,
  meta: Map<Node, RowMeta>,
  rowMeta: RowMeta,
): Node {
  const gutter = opts.gutter ?? USER_MIN_LEFT_GUTTER;
  // 右缘留白 gutter 列，其中 1 列已被左竖线（prefix）占用 → 其余 gutter-1 留白
  const block = h([
    body,
    spacer({ width: { mode: "fixed", cols: Math.max(0, gutter - 1) } }),
  ]);
  meta.set(block, rowMeta);
  return block;
}

/** 节点叶文本（text 原样；styled 段拼接；box 取首递归） */
function nodePlainText(n: Node): string {
  if (n.kind === "text") return (n as { text: string }).text;
  if (n.kind === "styled")
    return (n as { segments: { text: string }[] }).segments
      .map((s) => s.text)
      .join("");
  // box：取第一个非 spacer 子项递归（h 右缘留白 / v 容器）
  for (const c of (n as { children: Node[] }).children) {
    const t = nodePlainText(c);
    if (t !== "") return t;
  }
  return "";
}

/** 模型回复尾部空行删除（wrapBufferLines 后处理 → buildBox 结构层） */
function trimTrailingAssistantBlanks(
  nodes: Node[],
  meta: Map<Node, RowMeta>,
): Node[] {
  const out = [...nodes];
  let hasBodyAfter = false;
  for (let i = out.length - 1; i >= 0; i--) {
    const n = out[i]!;
    const m = meta.get(n);
    if (m?.kind !== "assistant") continue;
    const t = nodePlainText(n);
    if (!hasBodyAfter && t === "") {
      out.splice(i, 1);
    } else if (t !== "") {
      hasBodyAfter = true;
    }
  }
  return out;
}

/** 块内空行竖线连排：空 user/assistant 行若「块内」（其后有同 kind，且中间
 * 无 plain/separator）则补竖线（旧 wrapBufferLines 的 last-pass loop）。
 * 竖线通过给空行段挂 prefix/suffix 表达（fill 时 render）；窄列降级同步竖线阈值。 */
function lineUpBlockBars(
  nodes: Node[],
  meta: Map<Node, RowMeta>,
  opts: BuildBoxOptions,
): Node[] {
  const gutter = opts.gutter ?? USER_MIN_LEFT_GUTTER;
  // viewport 遮罩由 fill minWidth 决定；此处仅决定「是否属于块内」（语义标记）
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const m = meta.get(n);
    const k = m?.kind;
    if (k !== "user" && k !== "assistant") continue;
    if (nodePlainText(n) !== "") continue; // 有内容不是空行
    // 其后还有同 kind 才算块内空行（跨 plain/separator 停）
    let sameAfter = false;
    for (let j = i + 1; j < nodes.length; j++) {
      const nx = meta.get(nodes[j]!);
      if (nx?.kind === k) {
        sameAfter = true;
        break;
      }
      if (nx?.kind === "plain" || nx?.kind === "separator") break;
    }
    if (!sameAfter) continue;
    // 给空行挂竖线（h 内 body 为可寻址；此处对 text/styled 直接改 prefix/suffix）
    if (n.kind === "text") {
      const t = n as { prefix?: unknown; suffix?: unknown };
      if (k === "assistant") {
        t.prefix = {
          text: "┃",
          style: { fg: "brightBlue" },
          minWidth: gutter + 2,
        };
      } else {
        t.suffix = {
          text: "┃",
          style: { fg: "brightRed" },
          minWidth: gutter + 2,
        };
      }
    }
  }
  return nodes;
}

/** user 块与之后 assistant/正文之间空一行（纯布局，不写状态） */
function spaceUserAssistant(nodes: Node[], meta: Map<Node, RowMeta>): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    const curKind = meta.get(n)?.kind;
    const lastKind = last ? meta.get(last)?.kind : undefined;
    if (last && lastKind === "user" && curKind === "assistant") {
      const blank = styled([{ text: "" }]);
      meta.set(blank, { kind: "plain" });
      out.push(blank);
    }
    out.push(n);
  }
  return out;
}
