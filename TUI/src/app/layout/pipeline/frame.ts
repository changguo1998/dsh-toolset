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
// 内容来源唯一：`state.pipeline`（App 注入）。未注入时 `sectionsOf` 返回**空节**——条目 16
// 段 C1 已剥离「无 sink 回退」；需要按缓冲重放的调用方（测试 / 嵌入用法）显式用
// `replay.ts` 的 `sectionsFromLocal()` 或 `tests/helpers/frameWithLocalReplay.ts` 的包装。

import type { RenderOptions } from "./rows.ts";
import { renderPaneNew } from "./rows.ts";
import { createSections } from "./sections.ts";
import { allSections, type SectionsState } from "./sections.ts";
import { toolUnits } from "./tool-units.ts";
import { splitOldSectionsIndexed } from "./split.ts";
import { parse } from "./parse.ts";
import { route, shadowedBlockIds } from "./route.ts";
import { turnGroupStarts } from "../../layout.ts";
import type { EventGroup, UserRowInfo } from "./ir.ts";
import type { Section } from "./types.ts";
import type { ContentRow } from "../fill.ts";

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
  /** P1 用户块首行符号解析（会话态；info 缺省 = 无状态不显符号） */
  userSym?: (info?: UserRowInfo) => { text: string; fg?: string } | undefined;
}

export interface PipelineContent {
  dialogue: ContentRow[];
  activity: ContentRow[];
  /** 被窗口丢掉的**首个节的节下标**（> 0 → 有更早内容未物化，调用方插顶部占位行）：
   *  只当布尔用；「丢了几组」请用 `sectionGroupCount` 与窗口组数之差（空节 / 无法成组的
   *  节会计入本值但不计组） */
  dropped: number;
  /** 会话区每段行数 + 段键（第 ⑤ 步定位：位置 = 段键 + 段内行） */
  dialogueCounts: readonly number[];
  dialogueKeys: readonly string[];
  /** 会话区各用户块首行行号（**未含占位行**，调用方按 `dropped` 加偏移）——跳转目标 */
  dialogueUserRows: readonly number[];
  /** 回合区每段行数（页滚上限用） */
  activityCounts: readonly number[];
  /** 回合区段键（与 `activityCounts` 齐——活动区「节键 + 行偏移」视口定位用） */
  activityKeys: readonly string[];
}

/**
 * 回合组起点（节下标）。分组口径与旧路径**同一个函数**（`turnGroupStarts`）：
 * 先把节序列还原成「旧口径的缓冲行类型序列」（每节 = step 头 + 条目行），再套用既有分组
 * 算法——这样窗口粒度与旧路径逐组一致，不会各解释一套。
 *
 * 行类型序列直接由 `section.items` 推导（旧实现走 `boxes.buildBoxes` 的细分盒子，但同一
 * 条目的各细分块 kind 恒相同，故「一细分块一行」与「一条目一行」给出**同一 kind 序列**，
 * 分组边界因此不变；工具批仍按 `toolUnits` 计行，保持与摊平产行同口径）。
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
    const final = section.final === true;
    // step 头（旧口径是工具行）；独立自足节（用户 / notice / shell）没有 step 头
    if (section.standalone !== true) {
      kinds.push({ kind: "tool" });
      owner.push(index);
    }
    for (const item of section.items) {
      // 工具批：逻辑行 = 名字 / 参数 / 结果，逐行计 kind（与摊平产行同口径，否则窗口错行）
      if (
        item.source === "tool" &&
        (item.calls !== undefined || item.results !== undefined)
      ) {
        for (const _unit of toolUnits({
          calls: item.calls ?? [],
          results: item.results ?? [],
        })) {
          kinds.push({ kind: "tool" });
          owner.push(index);
        }
        continue;
      }
      // 空文本条目本就不产行（旧 `textParts` 同口径）
      if ((item.text ?? "") === "") continue;
      const kind =
        item.source === "reasoning"
          ? "thinking"
          : item.source === "user"
            ? "user"
            : "assistant";
      kinds.push({
        kind,
        ...(kind === "assistant" && final ? { final: true } : {}),
      });
      owner.push(index);
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
): {
  kept: Section[];
  dropped: number;
  suppressFirstHead: boolean;
  /** 首保留旧节的原始下标（供 split 全量后的窗口过滤） */
  from: number;
} {
  const keep = Math.max(1, Math.floor(groups));
  const { starts, midSection } = sectionGroupStarts(sections);
  if (starts.length <= keep) {
    return {
      kept: [...sections],
      dropped: 0,
      suppressFirstHead: false,
      from: 0,
    };
  }
  const at = starts.length - keep;
  const from = starts[at]!;
  return {
    kept: sections.slice(from),
    dropped: from,
    // 窗口起点落在节中间（旧路径按行切）：该节的 step 头已被切掉，不能再补
    suppressFirstHead: midSection[at] === true,
    from,
  };
}

/** 合成行序号基数（与宿主事件号区间错开） */
const SYNTHETIC_BASE = 1_000_000_000;

/**
 * 合成行序号：由**稳定段键**（节身份 + 节内 box 序号）派生（FNV-1a 双轮 → 48 位，低于
 * `Number.MAX_SAFE_INTEGER`），**不依赖对象身份**——重放 / 渐进扩窗 / 会话切换后同一逻辑行
 * 拿到同一身份，且与进程外的历史无关（旧实现用 WeakMap + 全局自增：节对象每次写入都被换成
 * 副本，段键与行号每帧都在换）。
 */
export function syntheticSeq(segKey: string): number {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b1;
  for (let i = 0; i < segKey.length; i++) {
    const c = segKey.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ((c << 5) + c + i), 0x85ebca6b) >>> 0;
  }
  return SYNTHETIC_BASE + (h1 % 0x1000000) * 0x1000000 + (h2 % 0x1000000);
}

/**
 * 节缓存 → 两 pane 内容行（含渐进窗口）。
 * 顺序：窗口（按回合）→ §1 分节（split）→ §2 解析（parse）→ §3 分流（route）→
 * §4 结构（buildTrees）→ §5 测量 → §6 摊平（flatten）→
 * 逐 item 行归属（renderPaneNew 的槽位切片）→ 帧层 ContentRow[]。
 */
export function pipelineContent(
  state: SectionsState,
  options: PipelineFrameOptions,
): PipelineContent {
  const all = allSections(state);
  // 窗口**只切历史** `state.sections`；`state.current`（流活节）无条件保留——否则当前回合
  // 内容随历史窗口/滚动被裁。`liveSectionIds` = 来自 current 的分节 id（每帧重排、不入缓存）。
  const { dropped, suppressFirstHead, from } = windowSections(
    state.sections,
    options.windowGroups,
  );
  // §1 分节：**对全量 split 得稳定 id**（段键跨窗口内容不重编号）；过滤 = 历史节按旧节窗口
  // 边界 `from` 保留、current（历史数组之后）恒保留。扩窗只多物化、不改已保留节 id。
  const historyLen = state.sections.length;
  const liveSectionIds = new Set<string>();
  const sections = splitOldSectionsIndexed(all)
    .filter(({ old, section }) => {
      const idx = all.indexOf(old);
      if (idx >= historyLen) {
        liveSectionIds.add(section.id);
        return true;
      }
      return idx >= from;
    })
    .map(({ section }) => section);
  const groups: EventGroup[] = sections.map((s) => ({
    provenance: s,
    blocks: parse(s),
    ...(s.calls !== undefined ? { calls: s.calls } : {}),
    ...(s.results !== undefined ? { results: s.results } : {}),
  }));
  const { session, turn } = route(groups, {
    activityShow: options.render.activityShow,
    activityCompact: options.render.activityCompact,
    declaredSteps: [...state.stepMeta.keys()],
    stepTimes: state.stepMeta,
    turnTimes: state.turnMeta,
    ...(suppressFirstHead ? { suppressFirstHead: true } : {}),
    ...(options.normalize === undefined
      ? {}
      : { normalize: options.normalize }),
  });
  // 压缩剪枝遮蔽（`state.shadowedSeqs` 是唯一真源）：命中的节 → 块 id 集 → 结构层整块打灰
  const shadowedIds = shadowedBlockIds(groups, state.shadowedSeqs);
  // §4-§7：对话 / 活动各以自身宽测量摊平并组装成 ContentRow[]
  const dialogue = renderPaneNew(session, "dialogue", {
    width: options.dialogueTextW,
    vw: options.dialogueTextW,
    ...(options.render.gutter === undefined
      ? {}
      : { gutter: options.render.gutter }),
    ...(options.userSym === undefined ? {} : { userSym: options.userSym }),
    ...(options.normalize === undefined
      ? {}
      : { normalize: options.normalize }),
    ...(shadowedIds.size === 0 ? {} : { shadowedIds }),
    liveSectionIds,
  });
  const activity = renderPaneNew(turn, "activity", {
    width: options.activityTextW,
    vw: options.activityTextW,
    ...(options.render.gutter === undefined
      ? {}
      : { gutter: options.render.gutter }),
    ...(options.userSym === undefined ? {} : { userSym: options.userSym }),
    ...(options.normalize === undefined
      ? {}
      : { normalize: options.normalize }),
    ...(options.render.activityCompact === undefined
      ? {}
      : { activityCompact: options.render.activityCompact }),
    ...(shadowedIds.size === 0 ? {} : { shadowedIds }),
    liveSectionIds,
  });
  return {
    dialogue: dialogue.rows,
    activity: activity.rows,
    dropped,
    dialogueCounts: dialogue.counts,
    dialogueKeys: dialogue.keys,
    dialogueUserRows: dialogue.userRows,
    activityCounts: activity.counts,
    activityKeys: activity.keys,
  };
}

/**
 * 节缓存来源：App 注入的 `state.pipeline` 优先；未注入（测试 / 嵌入用法）时按 `state.local`
 * 重放一份（条目 16 段 C1：实现已搬进 `replay.ts` 的显式助手 `sectionsFromLocal()`，这里保留
 * 调用；等下表文件都带上自己的包装后再删这一行，只留 `pipeline`）。
 *
 */
export function sectionsOf(state: {
  pipeline?: SectionsState;
  local: unknown;
}): SectionsState {
  return state.pipeline ?? createSections();
}

/** 渐进窗口的回合组总数（窗口上限判据：还有更早回合可物化吗） */
export function sectionGroupCount(sections: SectionsState): number {
  return sectionGroupStarts(allSections(sections)).starts.length;
}
