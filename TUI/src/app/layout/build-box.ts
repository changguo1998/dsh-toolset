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
import { hasCellPipe, isTableStart, parseTableAt, tableBox } from "./table.ts";
import type { Buffer, BufferKind, BufferLine } from "../state.ts";
import type { ColorName, ThemeId } from "../../renderer/theme.ts";
import type { FrameSegment, FrameStyle } from "../../renderer/index.ts";
import {
  TOOL_CONT_INDENT,
  USER_MIN_LEFT_GUTTER,
  isToolCall,
  isStepHeader,
  NOTICE_TONE_COLOR,
  renderToolText,
  renderToolNameLine,
} from "./content-rules.ts";
import { measure, allocate } from "./measure.ts";
import { fillToList, type ContentRow } from "./fill.ts";
import { displayWidth } from "./markdown.ts";
import { truncateToWidth } from "./primitives.ts";

/** 行元数据（fill 传播到 ContentRow） */
export interface RowMeta {
  kind?: BufferKind;
  blockId?: number;
  /** 来源 buffer 行号（窗口切片时为绝对行号 = lineOffset + 切片内下标；调试/分组口径） */
  line?: number;
  /** 来源 buffer 行的**稳定序号**（语义锚点身份；filter/裁剪后行下标会平移而序号不变） */
  seq?: number;
  /** 排队中的用户消息（未发出；渲染层据此把右缘竖线画成灰色） */
  queued?: boolean;
}

/** buildBox 产物：内容树 + 行元数据映射 */
export interface BuildBoxResult {
  /** 内容树根（对话区 v 容器；确定性引用） */
  root: Box;
  /** 两 pane 内容树（dialogue 对话区 / activity 活动区） */
  panes: {
    dialogue: Box;
    activity: Box;
  };
  /** 对话区内容树（v 容器；user/assistant/separator/plain） */
  dialogue: Box;
  /** 活动区内容树（v 容器；thinking/tool/notice/非 final assistant） */
  activity: Box;
  /** 节点 → 行元数据（buildBox 标注；fill 传播） */
  meta: Map<Node, RowMeta>;
  /** 同 meta（advisor 定名；二者引用一致） */
  metadata: Map<Node, RowMeta>;
}

/** buildBox 输入上下文（除 width 外均与宽度无关） */
export interface BuildBoxOptions {
  themeId: ThemeId;
  /** 用户/助手右缘留白（assistantMaxBodyWidth 的 gutter；固定配置非 width 相关） */
  gutter?: number;
  /** 内容区可用宽：仅 markdown 表格需要（列宽是跨行约束，须构建期算死）；
   *  缺省则表格按普通文本行渲染（宽未知，见 buildContentRows 调用点） */
  width?: number;
  /** 活动 pane 可用宽（横向排列两 pane 不同宽；缺省 = width）。
   *  仅影响活动区（非 final assistant）markdown 表格的构建期列宽 */
  activityWidth?: number;
  /** buffer 切片在原始 buffer 中的起始行号（渐进窗口按尾部切片时传入，
   *  使 RowMeta.line 保持绝对行号；缺省 0 = 未切片） */
  lineOffset?: number;
  /** 活动区紧凑模式（SPEC §6.8 状态 2，`/verbose off`）：每条目压成 1 行 + 行尾省略号
   *  （内部换行折叠为空格；宽度按活动 pane 宽，扣该条目前缀占列）。缺省 false=完整折行 */
  activityCompact?: boolean;
  /** P1：用户块**首行**左侧状态符号（2 列前缀 = 符号 + 1 空格；由 layout 依会话状态算定）。
   *  返回 undefined = 该行不显示符号（非用户块 / 排队块 / 无状态）。 */
  userStatus?: (
    line: BufferLine,
  ) => { text: string; fg?: ColorName } | undefined;
}

/**
 * 紧凑模式：把一条活动区条目压成单行文本（内部换行折叠为空格，超宽按显示宽截断
 * + 行尾省略号）。宽度预算为活动 pane 可用宽扣除该条目前缀占列数。
 */
function compactActivityLine(
  text: string,
  paneWidth: number,
  prefixCols = 0,
): string {
  const one = text.replace(/\s*\n+\s*/g, " ").trimEnd();
  const w = Math.max(1, paneWidth - prefixCols);
  if (displayWidth(one) <= w) return one;
  return truncateToWidth(one, Math.max(1, w - 1)) + "…";
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
 * 分类逻辑（按内容类型分流）：
 *  - assistant：final → dialogue、非 final → activity；fence 跨行状态注解
 *  - tool：连续 run 分组 + step 头（不按组数折叠：只受活动 pane 可视行数约束）
 *  - user：整块右对齐（h[spacer(fill), styled]）+ 右缘竖线（suffix, minWidth）
 *  - thinking：prefix 紫竖线（minWidth）、空行跳过
 *  - notice：tone 着色
 *  - separator/plain：对话区
 */
export function buildBox(
  buffer: Buffer,
  opts: BuildBoxOptions,
): BuildBoxResult {
  // 块 id 计数器：每次 buildBox 调用内局部，保证纯函数/确定性
  let nextBlockId = 0;
  const freshBlockId = (): number => {
    nextBlockId += 1;
    return nextBlockId;
  };
  const meta = new Map<Node, RowMeta>();
  const dialogueLeaves: Node[] = [];
  const activityLeaves: Node[] = [];
  const gutter = opts.gutter ?? USER_MIN_LEFT_GUTTER;
  const width = opts.width;
  // 紧凑模式（/verbose off）：活动 pane 条目压单行——宽度取活动 pane 可用宽
  // （横向两 pane 不同宽；纵向 activityWidth 缺省 = width），前缀占列由各分支自扣
  const compact = opts.activityCompact === true;
  const actPaneW = opts.activityWidth ?? width ?? 0;
  /** 活动区条目文本：紧凑模式压单行 + 行尾省略号（prefixCols = 该条目前缀占列） */
  const actText = (s: string, prefixCols = 0): string =>
    compact ? compactActivityLine(s, actPaneW, prefixCols) : s;
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
    // 不按组数折叠：历史只受「活动 pane 可视行数」约束（超出部分可上滚回看），
    // 见 buildTopRegion 的 act 切片——折叠点 = pane 高，而非固定组数
    for (const group of groups) {
      const bid = freshBlockId();
      for (let li = 0; li < group.length; li++) {
        const l = group[li]!;
        // step 头：虚线整行（tail 铺满）；缓冲文本为 `hh:mm:ss #N`（P6）
        const isStep = isStepHeader(l.text);
        if (isStep) {
          // step 分割行吸收前文拖尾空活动行（notice/thinking 换行锚点等）——
          // 对齐 legacy：分割行前积的视觉空行直接吞掉，不渲染
          absorbActivityBlank(activityLeaves);
        }
        let node: Node;
        if (isStep) {
          node = styled([{ text: `╌╌ ${l.text} ` }], {
            tail: { char: "╌" },
          });
        } else {
          const isCall = li === 0 && isToolCall(l.text);
          // 调用行：首词染黄（renderToolNameLine）；结果行：✓绿/✗tone；其余辅助行原色。
          // 折行统一悬挂缩进（首行全宽、续行 TOOL_CONT_INDENT，与 wrapToolCallText 一致）；
          // 紧凑模式：条目压单行（工具行无前缀占列）
          const segs2 = isCall
            ? toolCallSegs(actText(l.text))
            : toolLineSegs(actText(l.text), l.tone);
          node = styled(segs2, { hanging: TOOL_CONT_INDENT });
        }
        meta.set(node, { kind: "tool", blockId: bid });
        activityLeaves.push(node);
      }
    }
    toolRun.length = 0;
  };

  // 索引循环：markdown 表格需按行前瞻（连续表格行合并为一个 Box 子树）
  const lineOffset = opts.lineOffset ?? 0;
  for (let li = 0; li < buffer.length; li++) {
    const line = buffer[li]!;
    const rowMeta: RowMeta = {
      kind: line.kind,
      blockId: freshBlockId(),
      line: lineOffset + li,
      seq: line.seq,
      ...(line.queued ? { queued: true } : {}),
    };
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
      // 紧凑模式：单行（扣 ┃ 前缀 1 列）
      const node = styled([{ text: actText(line.text, 1) }], {
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
      // 整块右对齐 + 右缘竖线：h([spacer(fill), 内容])
      // 排队中（尚未发出）的右缘竖线改灰色：与已发出的用户块（亮红）区分
      // P1/P7：首行左侧状态符号**独立成格**（固定 2 列 = 符号 + 1 空格）与正文并排——
      // 符号不参与正文换行，故正文首行与续行同列（不再出现"续行与符号对齐"）；符号只在
      // 首行可见（h 合并时其余行按空格补齐该格，缩进不塌）。左侧留白同步扣掉符号宽，
      // 正文绝对起列不因符号而变。
      const sym = opts.userStatus?.(line);
      const symW = 2; // 符号 + 1 空格
      const body = styled([{ text: line.text }], {
        suffix: {
          text: "┃",
          style: { fg: line.queued ? "gray" : "brightRed" },
          minWidth: USER_MIN_LEFT_GUTTER + 2,
        },
      });
      const content: Node = sym
        ? h([
            styled(
              [
                {
                  text: sym.text,
                  ...(sym.fg ? { style: { fg: sym.fg } } : {}),
                },
                { text: " " },
              ],
              { width: { mode: "fixed", cols: symW } },
            ),
            body,
          ])
        : body;
      // 右缘保底留白 gutter 列：其中 1 列已被右竖线（suffix）占用 → 其余 gutter-1 留白；
      // 有符号时符号格已占 2 列，左侧留白再扣 2（正文列与无符号时一致）
      const block = h([
        spacer({
          width: {
            mode: "fill",
            min: Math.max(0, gutter - 1 - (sym ? symW : 0)),
          },
        }),
        content,
      ]);
      markSubtree(block, meta, rowMeta);
      dialogueLeaves.push(block);
      continue;
    }
    if (line.kind === "assistant") {
      const target = line.final ? dialogueLeaves : activityLeaves;
      // 含显式换行的单条行：旧 FENCE_RE 对整串不匹配（^…$ 需整行），
      // 整段交 wrapAssistantLine 解析；fill 的 Paragraph 按 \n 拆物理行。直接产单节点。
      if (line.text.includes("\n")) {
        const body = text(line.final ? line.text : actText(line.text, 1), {
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
      // markdown 表格（fence 外）：表头行 + 分隔行成对时（O(1) 预筛）收集连续表格行，
      // 构建期降级为固定宽 Box 子树（列宽是跨行约束，SPEC §3.2）。可用宽未知时不识别。
      // 紧凑模式（活动 pane 条目压单行）不建表——表格天然多行，与「每条目 1 行」冲突
      if (!inFence && width !== undefined && !(compact && !line.final)) {
        const next = buffer[li + 1];
        if (
          next !== undefined &&
          next.kind === "assistant" &&
          isTableStart(line.text, next.text)
        ) {
          const texts = [line.text, next.text];
          for (let j = li + 2; j < buffer.length; j++) {
            const l = buffer[j]!;
            if (l.kind !== "assistant" || !hasCellPipe(l.text)) break;
            texts.push(l.text);
          }
          const parsed = parseTableAt(texts, 0);
          // 宽度预算：final 行让出右缘 gutter（与正文同口径；表格自带左缘竖线列）；
          // 非 final（活动 pane）在横向排列下用活动 pane 自身宽度
          const paneWidth = line.final ? width : (opts.activityWidth ?? width);
          const budget = paneWidth - (line.final ? gutter - 1 : 0);
          const box = parsed
            ? tableBox(parsed.table, budget, opts.themeId)
            : null;
          if (parsed && box) {
            markSubtree(box, meta, rowMeta);
            target.push(box);
            li += parsed.end - 1; // 表格各行已并入本节点（循环再自增 1）
            continue;
          }
        }
      }
      const body = text(line.final ? line.text : actText(line.text, 1), {
        ...(inFence ? { fillBg: true, width: { mode: "fill" } } : {}),
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
      // 悬垂缩进（/help 双列表格）：折行续行停靠 hanging 列（描述列起点），
      // 对齐工具行的悬挂机制；普通 notice 不设 hanging → 续行顶格。
      // 紧凑模式：条目压单行 → 悬垂缩进无意义（不设 hanging）
      // 紧凑模式默认把条目压成 1 行；noCompact 行（/help）豁免——保持完整折行 + 悬垂缩进
      const keepFull = compact && line.noCompact === true;
      const node = styled(
        [{ text: compact && !keepFull ? actText(line.text) : line.text }],
        {
          ...style,
          ...((!compact || keepFull) && line.hanging !== undefined
            ? { hanging: line.hanging }
            : {}),
        },
      );
      // 空文本不舍弃（notice 空行可能保留语义）
      meta.set(node, rowMeta);
      activityLeaves.push(node);
      continue;
    }
    if (line.kind === "step") {
      // P9：恢复会话的 step 概要行（`╌╌ 22:31:05 #3 ╌╌ read ×2, bash ×1`）——
      // 形制与 P6 实时 step 头一致：`╌╌ ` 前缀 + 文本 + 1 空格，尾部 `╌` 铺满
      const node = styled([{ text: `╌╌ ${line.text} ` }], {
        tail: { char: "╌" },
      });
      meta.set(node, rowMeta);
      dialogueLeaves.push(node);
      continue;
    }
    // separator / plain → 对话区
    if (line.kind === "separator") {
      const node = styled([], {
        tail: { char: "╌" }, // legacy：turn 分隔线无样式（默认前景）
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
  // 3) 块内空行竖线连排（legacy 行为：同 kind 块内空行补左右竖线）
  dialogue = lineUpBlockBars(dialogue, meta, opts);

  const dialogueBox = v(dialogue);
  const activityBox = v(activityLeaves);
  return {
    root: dialogueBox,
    panes: { dialogue: dialogueBox, activity: activityBox },
    dialogue: dialogueBox,
    activity: activityBox,
    meta,
    metadata: meta,
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

/** step 分割行前吸收前文拖尾空行（对齐旧的空行吸收语义）：
 *  仅当活动区末尾是「纯空文本节点」（fill 后必单空行）或「文本以换行结尾的
 *  节点」（fill 拆物理行后末行必空，如 notice/thinking 拖尾换行锚点）时，
 *  剥掉其尾部换行（正文保留，仅尾空行不渲染——旧实现在折行后精确 pop 的
 *  正是该空行，宽度无关的结构层等价于"移除拖尾换行"）。 */
function absorbActivityBlank(leaves: Node[]): void {
  while (leaves.length > 0) {
    const last = leaves[leaves.length - 1]!;
    if (nodePlainText(last) === "") {
      leaves.pop();
      continue;
    }
    // 剥掉尾随换行：仅修改节点文本（不重建节点，保持 meta 引用有效）。
    // 若剥离后节点只剩空文本（如 notice 文本恰为单个换行），继续向上吸收，
    // 否则该节点仍产视觉空行——对齐旧实现连续 pop 空行的循环语义。
    if (stripTrailingNewline(last)) {
      if (nodePlainText(last) === "") {
        leaves.pop();
        continue;
      }
      return;
    }
    break;
  }
}

/** 剥掉节点文本尾部的一个（或连续的）换行；无拖尾换行返回 false */
function stripTrailingNewline(n: Node): boolean {
  if (n.kind === "text") {
    const t0 = (n as { text: string }).text;
    const t1 = t0.replace(/\n+$/, "");
    if (t1 === t0) return false;
    (n as { text: string }).text = t1;
    return true;
  }
  if (n.kind === "styled") {
    const segs = (n as { segments: { text: string; style?: FrameStyle }[] })
      .segments;
    const last = segs.at(-1);
    if (!last) return false;
    const t1 = last.text.replace(/\n+$/, "");
    if (t1 === last.text) return false;
    last.text = t1;
    if (segs.length > 1 && last.text === "") segs.pop(); // 空尾段收起
    return true;
  }
  return false;
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

/** 递归给子树全部节点挂同一行元数据：表格各叶子须共享 kind/blockId，
 *  否则 fill 后各行元数据缺失（回复组折叠/块内判定会把它当不同块）。 */
function markSubtree(node: Node, meta: Map<Node, RowMeta>, m: RowMeta): void {
  meta.set(node, m);
  if (node.kind === "box")
    for (const c of node.children) markSubtree(c, meta, m);
}

/** 模型回复尾部空行删除（旧后处理 → buildBox 结构层） */
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
 * 无 plain/separator）则补竖线（legacy last-pass loop）。
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

/** 内容行分组（排版层对外输出；上层做视口裁剪/滚动） */
export interface ContentPanes {
  dialogue: ContentRow[];
  activity: ContentRow[];
}

/**
 * 排版层统一入口（共享适配器）：buffer → 对话/活动两 pane 摊平行。
 *
 * 管线 = buildBox（宽度无关结构分类）→ measure/allocate（宽先于高）→
 * fill（折行/装饰，元数据经 metadata 传播）。高度取极大值摊平（不补白行），
 * 行数裁剪/滚动由消费方（buildTopRegion / userInputJump）负责；cutover 时
 * 调用点只换这里（legacy 旧函数曾承担同一职责）。
 */
export function buildContentRows(
  buffer: Buffer,
  opts: BuildBoxOptions,
  width: number,
  /** 活动 pane 可用宽（横向排列时与对话 pane 不同宽；缺省与 width 相同） */
  activityWidth?: number,
): ContentPanes {
  const w = Math.max(1, width);
  const aw = Math.max(1, activityWidth ?? width);
  // 可用宽随上下文交给 buildBox：markdown 表格列宽是跨行约束，须构建期算死
  const built = buildBox(buffer, { ...opts, width: w, activityWidth: aw });
  const fillPane = (pane: Box, paneW: number): ContentRow[] => {
    const rect = { x: 0, y: 0, w: paneW, h: 1_000_000 };
    const st = measure(pane, { maxW: paneW });
    const rects = allocate(st, rect);
    return fillToList(
      { themeId: opts.themeId, viewportWidth: paneW },
      pane,
      rect,
      rects,
      built.metadata,
    );
  };
  return {
    dialogue: fillPane(built.panes.dialogue, w),
    activity: fillPane(built.panes.activity, aw),
  };
}
