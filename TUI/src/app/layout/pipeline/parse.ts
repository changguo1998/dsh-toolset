// src/app/layout/pipeline/parse.ts — §2 解析：Section（一次模型交互）→ Block[]
//
// 职责（追踪文档 T18-T22）：把 Section 的两个纯文本槽位——reasoning 与 body.text——
// 里的格式控制字符（块级 `#`/`|`/`>`/`-`/围栏，行内 `**`/`` ` ``/`\*`）消费成结构化
// 块序列 Block[]，全部摊开成一条序列（各块带 source）。**不做宽度 / pane / 主题色 /
// 压缩**；块级分类与行内解析只在这一段各发生一次，后续任何阶段不得再按正则猜块类型。
//
// 口径：
//   - reasoning 与 assistant/system 走 markdown 块级+行内分类；
//   - user 逐字原文（不做 markdown 结构拆分，整段保留）；
//   - notice / shell / 工具辅助行整段原文（单 Paragraph + tone 着色），不分类；
//   - 原创文本不复制到块里，用 span: [start, end] 回引所属槽位（Section.reasoning /
//     Section.body.text）的原文区间（含控制字符；[inclusive, exclusive)）。
//   - 块 id = `<section-id>:<块序号>`；只冻结 Block（freezeBlock），Node/Leaf 可变。
//
// 形态契约（结构层据此渲染，见 TUI/docs/SPEC.md §3 与实测）：
//   - 引用行显示 `┃>`  前缀（`┃` 由结构层前缀、`>` 由结构层加在文本前）；
//     本层 Quote 子块的正文文本**不含** `>` 标记。
//   - 列表显示 `┃• ` / `┃1. ` / `┃[x] `（`┃` 与 marker 均由结构层加），本层 List.item
//     正文 Paragraph 不含 marker。
//   - 标题显示 `┃标题`（`#` 剥掉、bold + brightCyan，本层已加样式）。
//   - 分隔线显示 `┃────…`（rule 在 flatten 铺满；本层产一个尾随铺满标记的 Paragraph）。

import { isTableStart, parseTableAt, type TableAlign } from "../table.ts";
import { parseInlineMarkdown } from "../markdown.ts";
import { NOTICE_TONE_COLOR } from "../content-rules.ts";
import type { NoticeTone } from "../../adapter/types.ts";
import type {
  Block,
  BlockSource,
  Code,
  List,
  Paragraph,
  Quote,
  Section,
  StyledStr,
  StyledText,
  Table,
} from "./ir.ts";
import { freezeBlock } from "./ir.ts";

// ---------------- 块级分类正则（唯一分类处） ----------------

/** 围栏开关行：最多 3 空格缩进 + 3 个以上反引号 / 波浪号 + 可选语言 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w.+-]*)[ \t]*$/;
/** 引用行（最多 3 空格缩进 + `>`） */
const QUOTE_RE = /^ {0,3}>/;
/** 列表项行（`-`/`*`/`+` 或有序 `1.`/`1)`，后接空白或行尾） */
const LIST_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
/** 列表项的缩进续行（更深的空白开头的非空行，归属上一个列表项） */
const LIST_CONT_RE = /^\s{2,}\S/;
/** 标题：行首 1-6 个 `#` 后跟空格 */
const HEADING_RE = /^[ \t]*(#{1,6})[ \t]+(.+)$/;
/** 分隔线：三个以上 - / * / _ */
const RULE_RE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
/** 任务列表项：`- [ ]` / `- [x]`（捕获 勾选态 与 正文） */
const TASK_RE = /^ {0,3}[-*+][ \t]+\[([ xX])\][ \t]+(.+)$/;
/** 普通列表项（捕获 完整前缀含尾随空白 与 正文） */
const LIST_ITEM_RE = /^ {0,3}((?:[-*+]|\d{1,9}[.)])[ \t]+)(.*)$/;

/** 标题强调色（与正文同口径） */
const HEADING_FG = "brightCyan" as const;

/** 行（含在槽位原文本中的起始偏移） */
interface Line {
  text: string;
  /** 该行首字符在槽位原文本中的偏移 */
  start: number;
}

/** 槽位按 `\n` 切成行并记录起始偏移（含空行） */
function linesOf(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const line of text.split("\n")) {
    out.push({ text: line, start });
    start += line.length + 1;
  }
  return out;
}

/** 一行的结束偏移（[inclusive, exclusive)：下一行首减 1（剔除换行）或文本末） */
function endOf(lines: readonly Line[], index: number, text: string): number {
  return index + 1 < lines.length ? lines[index + 1]!.start - 1 : text.length;
}

/** 把 FrameSegment 样式段反解成 StyledStr（控制字符已消费；段为行内 markdown 产物） */
function styledOf(text: string): StyledText {
  return parseInlineMarkdown(text).map((s): StyledStr => {
    const out: StyledStr = { text: s.text };
    const st = s.style;
    if (st === undefined) return out;
    if (st.bold === true) out.bold = true;
    if (st.italic === true) out.italic = true;
    if (st.underline === true) out.underline = true;
    if (st.strike === true) out.strike = true;
    // 行内代码由 markdown.ts 以语义色 `bg: "code"` 表达（FrameStyle 无 code 字段）
    if (st.bg === "code") out.code = true;
    // FrameStyle.fg 可为语义色名或 hex；StyledStr.color 只收语义色名（parseInlineMarkdown 不产 hex）
    const fg = st.fg;
    if (fg !== undefined && fg !== "blue" && !fg.startsWith("#")) {
      // 运行时已排除 hex（# 前缀）；TS 不按 startsWith 收窄模板字面量，此处显式收窄
      out.color = fg as StyledStr["color"];
    } else if (fg === "blue" && st.underline === true) {
      out.link = s.text;
    }
    return out;
  });
}

/**
 * 解析主入口：reasoning 与 body 槽位各分类一次，全部摊成一条 Block[]。
 * 工具调用（calls）是结构化数据，不经此解析器（显示形态由 route/structure 组合）。
 */
export function parse(section: Section): Block[] {
  const blocks: Block[] = [];
  let n = 0;
  const idOf = (): string => `${section.id}:${n++}`;
  if (section.reasoning !== undefined && section.reasoning !== "") {
    const r = classifyMarkdown("reasoning", section.reasoning, idOf);
    blocks.push(...dropTrailingEmpty(r));
  }
  const body = section.body;
  if (body !== undefined && body.text !== "") {
    const source = body.source;
    if (
      source === "user" ||
      source === "notice" ||
      source === "shell" ||
      source === "tool"
    ) {
      // 整段原文，不做 markdown 分类；notice/工具辅助行按 tone 着色
      const toneColor =
        body.tone !== undefined && source !== "user"
          ? (NOTICE_TONE_COLOR[body.tone as NoticeTone] as StyledStr["color"])
          : undefined;
      const styled: StyledText = [
        {
          text: body.text,
          ...(toneColor === undefined ? {} : { color: toneColor }),
        },
      ];
      blocks.push(
        freezeBlock<Paragraph>({
          kind: "paragraph",
          source,
          id: idOf(),
          span: [0, body.text.length],
          text: styled,
          // 用户块的运行时态透传（P1 首行符号 / 排队竖线颜色素材）
          ...(source === "user" && section.user !== undefined
            ? { user: section.user }
            : {}),
        }),
      );
    } else {
      const mb = classifyMarkdown(source, body.text, idOf);
      blocks.push(...dropTrailingEmpty(mb));
    }
  }
  return withSeqs(blocks, section.seqs);
}

/** 去掉 markdown 槽位尾部的空 Paragraph（来自尾部换行锚点；整段内部空行保留） */
function dropTrailingEmpty(blocks: Block[]): Block[] {
  const out = [...blocks];
  while (
    out.length > 0 &&
    out[out.length - 1]!.kind === "paragraph" &&
    (out[out.length - 1] as Paragraph).rule !== true &&
    (out[out.length - 1] as Paragraph).text.every((s) => s.text === "")
  ) {
    out.pop();
  }
  return out;
}

/** 给块树补宿主事件号（重建 + 重新冻结；seqs 供接线桥取行身份） */
function withSeqs(blocks: Block[], seqs: readonly number[]): Block[] {
  if (seqs.length === 0) return blocks;
  const one = (b: Block): Block => {
    switch (b.kind) {
      case "paragraph":
      case "code":
        return freezeBlock({ ...b, seqs });
      case "quote":
        return freezeBlock({
          ...(b as Extract<Block, { kind: "quote" }>),
          seqs,
          children: (b as Extract<Block, { kind: "quote" }>).children.map(one),
        });
      case "list":
        return freezeBlock({
          ...(b as Extract<Block, { kind: "list" }>),
          seqs,
          items: (b as Extract<Block, { kind: "list" }>).items.map(
            one,
          ) as Extract<Block, { kind: "list" }>["items"],
        });
      case "table": {
        const t = b as Extract<Block, { kind: "table" }>;
        return freezeBlock({
          ...t,
          seqs,
          header: t.header.map(one) as unknown as typeof t.header,
          rows: t.rows.map((r) => r.map(one)) as unknown as typeof t.rows,
        });
      }
    }
  };
  return blocks.map(one);
}

/** markdown 槽位的块级分类（source = reasoning / assistant / system） */
function classifyMarkdown(
  source: "reasoning" | "assistant" | "system",
  text: string,
  idOf: () => string,
): Block[] {
  const lines = linesOf(text);
  const N = lines.length;
  const blocks: Block[] = [];
  let i = 0;
  const spanOf = (l0: number, l1: number): [number, number] => [
    lines[l0]!.start,
    endOf(lines, l1, text),
  ];
  const paragraph = (
    span: [number, number],
    text0: StyledText,
    extra: Partial<Paragraph> = {},
  ): Paragraph =>
    freezeBlock<Paragraph>({
      kind: "paragraph",
      source,
      id: idOf(),
      span,
      text: text0,
      ...extra,
    });

  while (i < N) {
    const line = lines[i]!.text;
    // 1) 围栏
    const fence = FENCE_RE.exec(line);
    if (fence !== null) {
      const open = line.trimStart().startsWith("~") ? "~" : "`";
      const rows: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < N; j++) {
        const inner = lines[j]!.text;
        const innerLang = FENCE_RE.exec(inner);
        if (innerLang !== null && inner.trimStart().startsWith(open)) {
          closed = true;
          break;
        }
        rows.push(inner);
      }
      const code: Code = {
        kind: "code",
        source,
        id: idOf(),
        span: spanOf(i, closed ? j : N - 1),
        lang: fence[2] ?? "",
        rows,
        closed,
      };
      blocks.push(freezeBlock(code));
      i = closed ? j + 1 : N;
      continue;
    }
    // 2) 表格（表头 + 分隔行成对）
    if (i + 1 < N && isTableStart(line, lines[i + 1]!.text)) {
      const parsed = parseTableAt(
        lines.map((ln) => ln.text),
        i,
      );
      if (parsed !== null) {
        const { table, end } = parsed;
        const cell = (c: string): Paragraph =>
          paragraph(spanOf(i, end - 1), styledHeadingNormal_cell(c));
        const tableBlock: Table = {
          kind: "table",
          source,
          id: idOf(),
          span: spanOf(i, end - 1),
          header: table.header.map(cell),
          aligns: table.aligns,
          rows: table.rows.map((r) => r.map(cell)),
        };
        blocks.push(freezeBlock(tableBlock));
        i = end;
        continue;
      }
    }
    // 3) 引用（连续引用行）
    if (QUOTE_RE.test(line)) {
      const run: string[] = [];
      const startL = i;
      while (i < N && QUOTE_RE.test(lines[i]!.text)) {
        run.push(lines[i]!.text.replace(/^ {0,3}>\s?/, ""));
        i += 1;
      }
      const children: Block[] = run.map((ln) =>
        paragraph(spanOf(startL, i - 1), styledOf(ln)),
      );
      const quote: Quote = {
        kind: "quote",
        source,
        id: idOf(),
        span: spanOf(startL, i - 1),
        children,
      };
      blocks.push(freezeBlock(quote));
      continue;
    }
    // 4) 列表（连续列表项 + 缩进续行）
    if (LIST_RE.test(line)) {
      const startL = i;
      const items: Block[] = [];
      let ordered = false;
      while (i < N) {
        const cur = lines[i]!.text;
        const task = TASK_RE.exec(cur);
        if (task !== null) {
          ordered = false;
          const checked = task[1]!.toLowerCase() === "x";
          const bodyText = styledOf(task[2]!);
          // 勾选：正文删除线
          const text0: StyledText = checked
            ? bodyText.map((s) => ({ ...s, strike: true }))
            : bodyText;
          items.push(paragraph(spanOf(startL, i), text0));
          i += 1;
          // 后续缩进续行并入上一项
          while (i < N && LIST_CONT_RE.test(lines[i]!.text)) {
            appendToParagraph(
              items[items.length - 1] as Paragraph,
              "\n" + lines[i]!.text.trimStart(),
            );
            i += 1;
          }
          continue;
        }
        const listItem = LIST_ITEM_RE.exec(cur);
        if (listItem !== null) {
          const marker = listItem[1]!;
          ordered = /^\d|^[a-zA-Z]/.test(marker.trimStart());
          const bodyText = styledOf(listItem[2]!);
          items.push(paragraph(spanOf(startL, i), bodyText));
          const itemMarker = marker.replace(/[ \t]+$/, "");
          void itemMarker;
          i += 1;
          while (i < N && LIST_CONT_RE.test(lines[i]!.text)) {
            appendToParagraph(
              items[items.length - 1] as Paragraph,
              "\n" + lines[i]!.text.trimStart(),
            );
            i += 1;
          }
          continue;
        }
        break;
      }
      const list: List = {
        kind: "list",
        source,
        id: idOf(),
        span: spanOf(startL, i - 1),
        ordered,
        marker: "",
        items,
      };
      blocks.push(freezeBlock(list));
      continue;
    }
    // 5) 标题 / 分隔线 / 普通段（收集连续非结构行）
    {
      const run: { idx: number; text: string }[] = [];
      while (i < N) {
        const cur = lines[i]!.text;
        if (
          FENCE_RE.test(cur) ||
          (i + 1 < N && isTableStart(cur, lines[i + 1]!.text)) ||
          QUOTE_RE.test(cur) ||
          LIST_RE.test(cur)
        )
          break;
        run.push({ idx: i, text: cur });
        i += 1;
      }
      // 逐行分类：标题 / 分隔线 / 普通（span = 该行自身原文区间）
      for (const { idx, text: ln } of run) {
        const heading = HEADING_RE.exec(ln);
        if (heading !== null) {
          const styled = styledOf(heading[2]!).map((s) => ({
            text: s.text,
            color: HEADING_FG,
            bold: true,
            ...(s.code === true ? { code: true } : {}),
            // 行内其余样式从 styledOf 已带，仅覆盖 color/bold
          }));
          blocks.push(paragraph(spanOf(idx, idx), styled));
          continue;
        }
        if (RULE_RE.test(ln)) {
          // 分隔线：tail 铺满标记（结构层据此产出铺满线）
          blocks.push(
            paragraph(spanOf(idx, idx), [], { rule: true } as Paragraph),
          );
          continue;
        }
        blocks.push(paragraph(spanOf(idx, idx), styledOf(ln)));
      }
    }
  }
  return blocks;
}

/** 单元格段落：行内解析（header/数据格都是 Paragraph；列宽/加粗在测量/摊平做） */
function styledHeadingNormal_cell(cellText: string): StyledText {
  return styledOf(cellText);
}

/** 往现有 Paragraph 的文本末尾追加内容（缩进续行并入上一列表项正文） */
function appendToParagraph(p: Paragraph, suffix: string): void {
  const last = p.text[p.text.length - 1];
  if (last !== undefined) {
    p.text[p.text.length - 1]!.text += suffix;
  } else {
    p.text.push({ text: suffix });
  }
}
