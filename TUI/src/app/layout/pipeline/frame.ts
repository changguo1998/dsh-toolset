// src/app/layout/pipeline/frame.ts — 批 5 接管接缝：新流水线 → 两 pane 内容行
//
// 职责：把节缓存（第 1 步产物）经 box / pane / 行三层做成 `ContentRow[]`，与旧路径
// `buildTopRegion` 里 `dialogueWindow + buildContentRows` 的那一段**同口径**：
//   - 渐进窗口按**回合**丢弃更早的节（替换按行丢弃），`dropped` = 被丢的回合数；
//   - 行身份 `seq`：有宿主事件号用事件号，否则按节 + box 顺序发**合成序号**
//     （稳定：同一 box 在后续帧里拿到同一序号），使旧锚点模型（`dialogueSpans` /
//     `indexToAnchor`）继续可用；
//   - 顶部「更早回复已折叠」占位行仍由调用方插入（`dropped > 0`）。
//
// 内容来源唯一：`state.pipeline`（App 注入）优先；未注入时 `sectionsOf` 按 `state.buffer`
// 重放一份（测试 / 嵌入用法）。

import type { RenderOptions, RenderedPane } from "./rows.ts";
import { renderPane } from "./rows.ts";
import { buildPanes } from "./panes.ts";
import { allSections, type SectionsState } from "./sections.ts";
import { buildBoxes } from "./boxes.ts";
import { turnGroupStarts } from "../../layout.ts";
import { sectionsFromBuffer } from "./replay.ts";
import type { Section } from "./types.ts";
import type { ContentRow } from "../fill.ts";
import type { BufferLine } from "../../state.ts";

export interface PipelineFrameOptions {
  /** 会话区可用宽 */
  dialogueTextW: number;
  /** 回合区可用宽 */
  activityTextW: number;
  /** 渐进窗口：物化的尾部回合组数（旧口径 `DIALOGUE_KEEP_REPLIES`） */
  windowGroups: number;
  /** 活动区档位 / 紧凑 / 主题 / gutter 等（透传第 4 步） */
  render: RenderOptions;
  /** 符号替换（symbol-normalizer 服务；缺省原文透传） */
  normalize?: (text: string) => string;
  /** 压缩剪枝遮蔽事件号 */
  shadowedSeqs?: ReadonlySet<number>;
}

export interface PipelineContent {
  dialogue: ContentRow[];
  activity: ContentRow[];
  /** 被窗口丢掉的回合数（> 0 → 调用方插顶部占位行） */
  dropped: number;
  /** 会话区每段行数 + 段键（第 ⑤ 步定位：位置 = 段键 + 段内行） */
  dialogueCounts: readonly number[];
  dialogueKeys: readonly string[];
  /** 会话区各用户块首行行号（**未含占位行**，调用方按 `dropped` 加偏移）——跳转目标 */
  dialogueUserRows: readonly number[];
  /** 回合区每段行数（页滚上限用） */
  activityCounts: readonly number[];
}

/**
 * 回合组起点（节下标）。分组口径与旧路径**同一个函数**（`turnGroupStarts`）：
 * 先把节序列还原成「旧口径的缓冲行类型序列」（每节 = step 头 + 条目行），
 * 再套用既有分组算法——这样窗口粒度与旧路径逐组一致，不会各解释一套。
 */
export function sectionGroupStarts(sections: readonly Section[]): {
  starts: number[];
  midSection: boolean[];
} {
  const kinds: { kind: string; final?: boolean }[] = [];
  const owner: number[] = [];
  const firstLine: number[] = [];
  sections.forEach((section, index) => {
    if (section.items.length === 0) return;
    firstLine[index] = kinds.length;
    // step 头（旧口径是工具行）；独立自足节（用户 / notice / shell）没有 step 头
    if (section.standalone !== true) {
      kinds.push({ kind: "tool" });
      owner.push(index);
    }
    for (const block of buildBoxes(section)) {
      const final = section.final === true;
      for (const box of block.children) {
        if (box.kind === "content" && box.shape === "tool") {
          for (const _call of box.batch?.calls ?? []) {
            kinds.push({ kind: "tool" });
            owner.push(index);
          }
          for (const _result of box.batch?.results ?? []) {
            kinds.push({ kind: "tool" });
            owner.push(index);
          }
          continue;
        }
        const kind =
          box.source === "reasoning"
            ? "thinking"
            : box.source === "user"
              ? "user"
              : "assistant";
        kinds.push({
          kind,
          ...(kind === "assistant" && final ? { final: true } : {}),
        });
        owner.push(index);
      }
    }
  });
  const starts: number[] = [];
  const midSection: boolean[] = [];
  for (const line of turnGroupStarts(kinds)) {
    const section = owner[line] ?? 0;
    if (starts[starts.length - 1] === section) continue;
    starts.push(section);
    midSection.push(line > (firstLine[section] ?? line));
  }
  return { starts, midSection };
}

/**
 * 渐进窗口（按**回合组**丢弃更早的节）：组起点见 `sectionGroupStarts`；保留尾部
 * `groups` 组对应的节，返回被丢的节数（> 0 → 调用方插「更早回复已折叠」占位行）。
 */
export function windowSections(
  sections: readonly Section[],
  groups: number,
): { kept: Section[]; dropped: number; suppressFirstHead: boolean } {
  const keep = Math.max(1, Math.floor(groups));
  const { starts, midSection } = sectionGroupStarts(sections);
  if (starts.length <= keep) {
    return { kept: [...sections], dropped: 0, suppressFirstHead: false };
  }
  const at = starts.length - keep;
  const from = starts[at]!;
  return {
    kept: sections.slice(from),
    dropped: from,
    // 窗口起点落在节中间（旧路径按行切）：该节的 step 头已被切掉，不能再补
    suppressFirstHead: midSection[at] === true,
  };
}

/** 合成行序号：按 box 身份发号（稳定；与宿主事件号区间错开） */
const synthetic = new WeakMap<object, number>();
const SYNTHETIC_BASE = 1_000_000_000;
let syntheticNext = 0;

/** 行身份：优先宿主事件号，否则合成 */
export function rowSeq(box: { seqs?: readonly number[] }): number {
  const host = box.seqs?.[0];
  if (host !== undefined) return host;
  const key = box as object;
  const hit = synthetic.get(key);
  if (hit !== undefined) return hit;
  syntheticNext += 1;
  const seq = SYNTHETIC_BASE + syntheticNext;
  synthetic.set(key, seq);
  return seq;
}

/** 给出行缓冲补上行身份（旧锚点模型用） */
function withSeq(rows: readonly ContentRow[], seq: number): ContentRow[] {
  return rows.map((row) => (row.seq === undefined ? { ...row, seq } : row));
}

/**
 * 节缓存 → 两 pane 内容行（含渐进窗口）。
 * 顺序：窗口（按回合）→ box/pane（含档位与符号替换）→ 行（含宽度与装饰）→ 行身份。
 */
export function pipelineContent(
  state: SectionsState,
  options: PipelineFrameOptions,
): PipelineContent {
  const { kept, dropped, suppressFirstHead } = windowSections(
    allSections(state),
    options.windowGroups,
  );
  let panes = buildPanes(kept, {
    level: options.render.activityLevel ?? "think",
    declaredSteps: [...state.stepMeta.keys()],
    stepTimes: state.stepMeta,
    turnTimes: state.turnMeta,
    ...(suppressFirstHead ? { suppressFirstHead: true } : {}),
    ...(dropped > 0 ? { leadingSeparator: false } : {}),
    ...(options.normalize === undefined
      ? {}
      : { normalize: options.normalize }),
    ...(options.shadowedSeqs === undefined
      ? {}
      : { shadowedSeqs: options.shadowedSeqs }),
  });
  const dialogue = renderPane(panes.dialogue, "dialogue", options.render);
  const activity = renderPane(panes.activity, "activity", {
    ...options.render,
    width: options.activityTextW,
  });
  return {
    dialogue: seqRows(panes.dialogue, dialogue),
    activity: seqRows(panes.activity, activity),
    dropped,
    dialogueCounts: dialogue.counts,
    dialogueKeys: dialogue.keys,
    dialogueUserRows: dialogue.userRows,
    activityCounts: activity.counts,
  };
}

/** 逐项给行补身份（与 `pane` 项一一对应；边界项用相邻内容项的序号） */
function seqRows(
  items: readonly { kind: string; box?: { seqs?: readonly number[] } }[],
  rendered: RenderedPane,
): ContentRow[] {
  const out: ContentRow[] = [];
  let index = 0;
  for (const item of items) {
    const count = rendered.counts[index] ?? 0;
    index += 1;
    if (count === 0) continue;
    const slice = rendered.rows.slice(out.length, out.length + count);
    const seq =
      item.box === undefined
        ? -1
        : rowSeq(item.box as { seqs?: readonly number[] });
    out.push(...(seq === -1 ? slice : withSeq(slice, seq)));
  }
  return out;
}

/**
 * 节缓存来源：App 注入的（`state.pipeline`）优先；未注入（测试 / 嵌入用法）时按
 * `state.buffer` 重放一份——按缓冲身份 memo，重放只在内容整体替换后发生。
 */
let replayEntry:
  { lines: readonly BufferLine[]; value: SectionsState } | undefined;

export function sectionsOf(state: {
  pipeline?: SectionsState;
  buffer: Parameters<typeof sectionsFromBuffer>[0];
}): SectionsState {
  if (state.pipeline !== undefined) return state.pipeline;
  // 命中判据 = **逐行对象身份**相同（不是数组身份）：缓冲是就地改的——流式续写、
  // `final` 打标、回合号回填都会**换掉行对象**（见追踪文档 R4），只比数组身份会拿到
  // 过期节缓存（旧帧的分隔线 / 用户行在画面里消失）
  const buffer = state.buffer;
  const hit = replayEntry;
  if (
    hit !== undefined &&
    hit.lines.length === buffer.length &&
    hit.lines.every((line, index) => line === buffer[index])
  )
    return hit.value;
  const value = sectionsFromBuffer(buffer);
  replayEntry = { lines: [...buffer], value };
  return value;
}

/** 渐进窗口的回合组总数（窗口上限判据：还有更早回合可物化吗） */
export function sectionGroupCount(sections: SectionsState): number {
  return sectionGroupStarts(allSections(sections)).starts.length;
}
