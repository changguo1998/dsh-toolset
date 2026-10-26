// src/app/layout/pipeline/split.ts — §1 分节：旧节缓存 → 新一次模型交互 Section[]
//
// 职责（追踪文档 T16-T17）：
//   - `splitSections(SectionsState) → Section[]`：把旧节缓存（`sections.ts` 的事件累积
//     产物）按模型推理边界分组，产出新一次模型交互 `Section`（ir.ts）——同一次推理的
//     思考 / 正文 / 工具声明并进同一条 Section；层级 session > turn > step > section。
//   - `replaySections(HistoryRow[]) → Section[]`：恢复路径，历史行按模型交互边界直接产
//     新 Section（不再经旧节缓存）。
//
// 口径：
//   - 旧节 = 一个 step 的一次推理 + 其间工具批的归属容器；正文 / 源不同会切新交互：
//     文本来源（assistant / tool 辅助行 / notice / shell / user）更换即断开一次模型交互
//     （旧渲染按条目来源分流，来源决定 pane / 样式 / 活动档位，合并会丢来源）——
//     思考与工具批归属其所在的那一次交互；
//   - reasoning 条目 → `reasoning` 槽；文本条目 → `body` 槽（按来源归并、换行拼接）；
//     工具批（calls/results）→ 结构化槽位；节上元数据透传。

import { allSections, type SectionsState } from "./sections.ts";
import { sectionsFromBuffer } from "./replay.ts";
import type { HistoryRow } from "../../state.ts";
import type {
  Section as OldSection,
  Item,
  ToolCall,
  ToolResult,
} from "./types.ts";
import type { BlockSource, Section, UserRowInfo } from "./ir.ts";

/** 一次交互的累积单元：正文文本（单来源）+ 该交互的思考 / 工具批 */
interface Group {
  source?: BlockSource;
  reasoning: string[];
  texts: string[];
  tone?: Item["tone"];
  noCompact?: boolean;
  userStatus?: "success" | "failure" | "aborted";
  steerContinued?: boolean;
  queued?: "followup" | "steer";
  userActive?: boolean;
  injected?: boolean;
  generation?: number;
  calls: ToolCall[];
  results: ToolResult[];
  seqs: Set<number>;
}

function freshGroup(): Group {
  return {
    reasoning: [],
    texts: [],
    calls: [],
    results: [],
    seqs: new Set<number>(),
  };
}

/** 旧节条目 → 一次模型交互 Group 序列（断点 = 文本来源更换） */
function groupsOf(old: OldSection): Group[] {
  const groups: Group[] = [];
  const last = (): Group | undefined => groups[groups.length - 1];
  for (const item of old.items) {
    if (item.source === "reasoning") {
      // 思考并入当前交互（尚无交互则新起一个纯思考交互）
      let g = last();
      if (g === undefined) {
        g = freshGroup();
        groups.push(g);
      }
      if (item.text !== undefined) g.reasoning.push(item.text);
      for (const seq of item.seqs ?? []) g.seqs.add(seq);
      continue;
    }
    if (item.calls !== undefined || item.results !== undefined) {
      // 工具批归属当前交互（尚无交互则新起一个纯批交互）
      let g = last();
      if (g === undefined) {
        g = freshGroup();
        groups.push(g);
      }
      if (item.calls !== undefined) g.calls.push(...item.calls);
      if (item.results !== undefined) g.results.push(...item.results);
      for (const seq of item.seqs ?? []) g.seqs.add(seq);
      continue;
    }
    const source: BlockSource = item.source;
    let g = last();
    if (g === undefined || (g.source !== undefined && g.source !== source)) {
      g = freshGroup();
      groups.push(g);
    }
    g.source = source;
    if (g.texts.length === 0) {
      if (item.tone !== undefined) g.tone = item.tone;
      if (item.noCompact === true) g.noCompact = true;
      if (source === "user") {
        if (item.userStatus !== undefined) g.userStatus = item.userStatus;
        if (item.steerContinued === true) g.steerContinued = true;
        if ("queued" in item)
          g.queued = (item as { queued?: "followup" | "steer" }).queued;
        if (item.injected === true) g.injected = true;
        if (item.generation !== undefined) g.generation = item.generation;
      }
    }
    if (item.text !== undefined) g.texts.push(item.text);
    for (const seq of item.seqs ?? []) g.seqs.add(seq);
  }
  return groups;
}

/** Group → 新一次模型交互 Section（无任何内容时返回 undefined） */
function groupToSection(
  group: Group,
  old: OldSection,
  id: string,
): Section | undefined {
  const bodyText = group.texts.filter((t) => t !== "").join("\n");
  const calls = group.calls;
  const results = group.results;
  if (
    group.reasoning.length === 0 &&
    bodyText === "" &&
    calls.length === 0 &&
    results.length === 0
  )
    return undefined;
  return {
    id,
    turn: old.turn,
    step: old.step,
    ...(old.time === undefined ? {} : { time: old.time }),
    seqs: [...group.seqs],
    ...(group.reasoning.length > 0
      ? { reasoning: group.reasoning.join("\n") }
      : {}),
    ...(bodyText === "" || group.source === undefined
      ? {}
      : {
          body: {
            source: group.source,
            text: bodyText,
            ...(group.tone !== undefined ? { tone: group.tone } : {}),
            ...(group.noCompact === true ? { noCompact: true } : {}),
          },
        }),
    ...(calls.length > 0 ? { calls } : {}),
    ...(results.length > 0 ? { results } : {}),
    ...(group.userStatus !== undefined ? { status: group.userStatus } : {}),
    ...(old.final === true ? { final: true } : {}),
    ...(old.history === true ? { history: true } : {}),
    ...(old.standalone === true ? { standalone: true } : {}),
    ...(old.steer === true ? { steer: true } : {}),
    // 用户块运行时态（P1 符号素材）：user 来源恒挂（空态也挂 → 解析器回退 `?`，
    // 与旧链路对每个用户行都调解析器并回退 `?` 的口径一致）
    ...(group.source === "user" ? { user: sourceUserInfo(group) ?? {} } : {}),
  };
}

/** 从 user 来源的 group 提炼 UserRowInfo（全空 → undefined） */
function sourceUserInfo(group: Group): UserRowInfo | undefined {
  const out: UserRowInfo = {};
  if (group.userStatus !== undefined) out.status = group.userStatus;
  if (group.steerContinued === true) out.steerContinued = true;
  if (group.queued !== undefined) out.queued = group.queued;
  if (group.userActive === true) out.active = true;
  // 至少一项才产（否则无状态）
  if (
    out.status === undefined &&
    out.steerContinued !== true &&
    out.queued === undefined &&
    out.active !== true
  )
    return undefined;
  return out;
}

/** §1 分节主入口：旧节缓存 → 新一次模型交互 Section[]（按到达顺序） */
export function splitSections(state: SectionsState): Section[] {
  return splitOldSections(allSections(state));
}

/**
 * §1 分节（对旧节数组；接线桥在渐进窗口后只分保留段时用）。
 * 含运行态 post-pass：最新「无终态、非排队、非续接」的用户节标记 active。
 */
export function splitOldSections(
  oldSections: readonly OldSection[],
): Section[] {
  const out: Section[] = [];
  const ordinal = new Map<string, number>();
  for (const old of oldSections) {
    for (const group of groupsOf(old)) {
      const key = `${old.turn}:${old.step}`;
      const n = ordinal.get(key) ?? 0;
      ordinal.set(key, n + 1);
      const section = groupToSection(group, old, `${key}:${n}`);
      if (section !== undefined) out.push(section);
    }
  }
  // 运行态 post-pass：活跃块只看「最后一条用户输入」——从尾向前找**最后一个用户节**，
  // 仅当它未终态/未排队/未续接时置 active；否则（已有更晚用户节或最后节已终态）不置，
  // 更早的未终态节永不跟随运行状态。
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const s = out[i]!;
    const u = s.user;
    if (u === undefined) continue;
    if (
      u.status !== undefined ||
      u.queued !== undefined ||
      u.steerContinued === true
    )
      break;
    out[i] = { ...s, user: { ...u, active: true } };
    break;
  }
  return out;
}

/**
 * indexed 变体：还返回每条新节的**来源旧节**，供接线桥「split 全量定稳定 id 后再按旧节
 * 窗口边界过滤」——解决段键跨窗口内容不稳定（共享节扩窗后不再被重编号）。
 * id 基于**全量**顺序的 ordinal（每 (turn:step) 从 0 数），扩窗不改变其值。
 */
export function splitOldSectionsIndexed(
  oldSections: readonly OldSection[],
): { section: Section; old: OldSection }[] {
  const out: { section: Section; old: OldSection }[] = [];
  const ordinal = new Map<string, number>();
  const push = (section: Section | undefined, old: OldSection): void => {
    if (section !== undefined) out.push({ section, old });
  };
  for (const old of oldSections) {
    for (const group of groupsOf(old)) {
      const key = `${old.turn}:${old.step}`;
      const n = ordinal.get(key) ?? 0;
      ordinal.set(key, n + 1);
      push(groupToSection(group, old, `${key}:${n}`), old);
    }
  }
  // 活跃块 post-pass（与 splitOldSections 同口径，作用于 .section）
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const s = out[i]!.section;
    const u = s.user;
    if (u === undefined) continue;
    if (
      u.status !== undefined ||
      u.queued !== undefined ||
      u.steerContinued === true
    )
      break;
    out[i] = { ...out[i]!, section: { ...s, user: { ...u, active: true } } };
    break;
  }
  return out;
}

/** §1 恢复路径：历史行 → 新一次模型交互 Section[]（经旧节缓存重放，历史节带 `history`） */
export function replaySections(rows: readonly HistoryRow[]): Section[] {
  return splitSections(sectionsFromBuffer(rows, { history: true }));
}
