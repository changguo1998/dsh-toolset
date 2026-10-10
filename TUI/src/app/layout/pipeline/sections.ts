// src/app/layout/pipeline/sections.ts — 第 1 步「接收」：块交付 → 节缓存
//
// 职责（口径见追踪文档「分节规则」「节内合并」「冻结 / 活跃 两套」）：
//   - 幂等：带 `seq` 的交付按事件号去重；不带 seq 的文本按「已入账文本」重对账；
//   - 三张记账表：① 交付账（块键 → 已入账文本）② 工具调用归属与待配对（callId → 节 /
//     待结果集合）③ 中断与定型标记（step 键）；
//   - 分节：用户输入 / notice / shell / 回合结束 / 工具批结果到齐为边界，惰性开节（无空节）；
//   - 节内归并：按来源类型归并（`r1 a1 r2 a2` → reasoning = r1+r2、assistant = a1+a2），
//     顺序按各类型首次出现；归并不跨节。
//
// 与文档的两处口径细化（实现即口径，追踪文档已同步）：
//   1) **增量只来自实时线**，结算线按块投递 `full`：两条线交叉时不会重复入账；
//   2) 迟到交付（两线无序 / 恢复重放）按 (turn, step) **回写原节**，不另开新节——
//      否则同一 step 的正文会被拆到两节（内容错序 + 重复 step 头）。
//
// 本层**不碰宽度**、不插任何分隔内容（空行 / step 头 / 回合分隔线都由第 3 步推导）。

import type { NoticeTone } from "../../adapter/types.ts";
import {
  blockKey,
  stepKey,
  type BlockDelivery,
  type Item,
  type Section,
  type Source,
  type ToolCall,
} from "./types.ts";

/** 节缓存状态（不可变；每次交付返回新状态，便于等价断言与快照） */
export interface SectionsState {
  /** 已封闭的节（append-only；迟到交付回写时替换其中的元素并撤销冻结） */
  sections: readonly Section[];
  /** 当前可写节（惰性创建；不存在 = 下一块内容落地时才开节） */
  current?: Section;
  /** 待封闭：下一块内容落地时先封闭当前节（工具批结果到齐 / 回合结束置位） */
  pendingOpen: boolean;
  /** step 元数据（`step-start` 记录，开节时取用：时间戳供 step 头显示） */
  stepMeta: ReadonlyMap<string, { time?: number }>;
  /** ① 交付账：块键 → 已入账文本 */
  delivered: ReadonlyMap<string, string>;
  /** 事件号去重（宿主持久线的交付都带 `seq`；实时线增量不带、由交付账对账） */
  seenSeqs: ReadonlySet<number>;
  /** 最近一次带 (turn, step) 的交付（notice / shell 等无归属交付沿用，避免 0/0 假节） */
  lastScope: { turn: number; step: number };
  /** ② 待结果工具调用：step 键 → callId 集合（空集 = 该 step 的批已到齐） */
  awaiting: ReadonlyMap<string, ReadonlySet<string>>;
  /** ② 调用归属：callId → 节下标（-1 = 当前节）；结果据此回到调用所在节（批不拆） */
  callOwner: ReadonlyMap<string, number>;
  /** ② 工具参数累计：callId → 调用（整块与增量交叉时按此对账） */
  toolArgs: ReadonlyMap<string, ToolCall>;
  /** ② 已收到整块参数的调用（其后的增量分片一律忽略，避免拼接损坏） */
  completedCalls: ReadonlySet<string>;
  /** ② 已有结果的调用（结果早于调用时，登记调用不再等结果） */
  resolved: ReadonlySet<string>;
  /** ③ 中断标记：step 键（结果可能永不到齐，不再等批结果） */
  interrupted: ReadonlySet<string>;
  /** ③ 定型信号（宿主 `assistant/message`）已送达的 step 键 */
  freezable: ReadonlySet<string>;
  /** 压缩剪枝遮蔽的宿主事件号（box 层按交集打灰；内容与行数不变） */
  shadowedSeqs: ReadonlySet<number>;
  /** 回合元数据：turn → 开始时间（分隔线显示用；App 的 turn-begin 是真源） */
  turnMeta: ReadonlyMap<string, number | undefined>;
  /** 回合世代计数：每次 `turn-end` +1；用户条目在交付时记下当时的世代（`Item.generation`），
   *  `turn-end` 只标记**本世代**的用户块（既不依赖回合号匹配，也不回溯更早的块） */
  turnEnds: number;
}

export function createSections(): SectionsState {
  return {
    sections: [],
    pendingOpen: false,
    stepMeta: new Map(),
    delivered: new Map(),
    seenSeqs: new Set(),
    lastScope: { turn: 0, step: 0 },
    awaiting: new Map(),
    callOwner: new Map(),
    toolArgs: new Map(),
    completedCalls: new Set(),
    resolved: new Set(),
    interrupted: new Set(),
    freezable: new Set(),
    shadowedSeqs: new Set(),
    turnMeta: new Map(),
    turnEnds: 0,
  };
}

/** 当前节是否已可冻结（定型信号已到）——帧边界用它决定冻结 */
export function currentFrozen(state: SectionsState): boolean {
  const current = state.current;
  if (!current) return false;
  return state.freezable.has(stepKey(current.turn, current.step));
}

/**
 * 帧边界冻结：封闭节在封闭时即定型（`frozen: true`），此处只需处理仍有新内容的当前节
 * ——定型信号（`assistant/message`）到达且之后无追加时置位。
 */
export function freezeAtFrameBoundary(state: SectionsState): SectionsState {
  const current = state.current;
  if (!current || current.frozen) return state;
  if (!currentFrozen(state)) return state;
  return { ...state, current: { ...current, frozen: true } };
}

/** 交付目标：当前节，或（迟到交付）已封闭节的下标 */
type Target =
  | { on: "current"; section: Section }
  | { on: "closed"; at: number; section: Section };

function close(section: Section): Section {
  return section.frozen ? section : { ...section, frozen: true };
}

function sealedOf(state: SectionsState, section: Section): SectionsState {
  return {
    ...state,
    sections: [...state.sections, close(section)],
    current: undefined,
    pendingOpen: false,
  };
}

/** 写回目标节（迟到回写会撤销该节冻结——内容变了，派生缓存须失效） */
function write(
  state: SectionsState,
  target: Target,
  section: Section,
): SectionsState {
  if (target.on === "current") {
    return {
      ...state,
      current: section.frozen ? { ...section, frozen: false } : section,
    };
  }
  const sections = [...state.sections];
  sections[target.at] = { ...section, frozen: false };
  return { ...state, sections };
}

function sameScope(section: Section, turn: number, step: number): boolean {
  return section.turn === turn && section.step === step;
}

/**
 * 取交付目标：
 *   1) `pendingOpen` 且有当前节 → 先封闭（边界语义）；
 *   2) 已存在同 (turn, step) 的节（封闭节 → 迟到回写；当前节 → 就地写）；
 *   3) 其余 → 开新节（当前节 scope 不同则先封闭）。
 * 开节即消费 `pendingOpen`；已在头上的同类 step-start 不会重复切节。
 */
function target(
  state: SectionsState,
  turn: number,
  step: number,
  continuation = true,
): { state: SectionsState; target: Target } {
  let base = state;
  const existing = base.current;
  // 边界先于迟到回写：待封闭（批结果到齐 / 回合结束）时下一块内容另起新节，即使
  // scope 相同——否则同一 step 的批后正文会被写回批所在节
  const boundary = existing !== undefined && base.pendingOpen;
  if (boundary) base = sealedOf(base, existing);
  const current = base.current;
  if (current && sameScope(current, turn, step)) {
    return { state: base, target: { on: "current", section: current } };
  }
  // 回写更早的节**只对续写**（同一块的后续增量 / 同一工具调用的后续交付）：新内容必须
  // 按**到达顺序**落在当前节之后——否则「reasoning → notice → assistant」里后到的正文会
  // 回写进 notice 之前的那一节，notice 被排到正文后面（BACKLOG「同 step 内 notice 与正文
  // 的到达顺序丢失」）
  const at =
    boundary || !continuation
      ? -1
      : base.sections.findIndex(
          (section) =>
            sameScope(section, turn, step) && section.standalone !== true,
        );
  if (at >= 0) {
    const section = base.sections[at]!;
    return { state: base, target: { on: "closed", at, section } };
  }
  if (current) base = sealedOf(base, current);
  const time = base.stepMeta.get(stepKey(turn, step))?.time;
  const opened: Section = {
    turn,
    step,
    ...(time === undefined ? {} : { time }),
    items: [],
    frozen: false,
  };
  return {
    state: { ...base, current: opened, pendingOpen: false },
    target: { on: "current", section: opened },
  };
}

/** 条目事件号累积（去重；遮蔽判定用） */
function withSeq(item: Item, seq: number | undefined): Item {
  if (seq === undefined || item.seqs?.includes(seq) === true) return item;
  return { ...item, seqs: [...(item.seqs ?? []), seq] };
}

/** 节内按来源归并：同类型文本直拼，顺序按类型首次出现 */
function appendText(
  section: Section,
  source: Source,
  text: string,
  tone?: NoticeTone,
  seq?: number,
  generation?: number,
  block?: number,
  settle?: boolean,
): Section {
  const items = [...section.items];
  const mergeable = (item: Item): boolean =>
    item.source === source &&
    item.calls === undefined &&
    item.results === undefined;
  // 同来源合并**只对文本项**（工具批与文本走不同渲染分支），且**只并同块的流式续写**：
  // 跨块合并会把「正文甲 → 工具调用 → 正文乙」粘成一条（BACKLOG「同一步内『工具调用
  // 前后的正文』被粘成一行」）；无块身份的路径（notice / shell / user）保持原样
  // `settle`（step 级结算，交付 `index < 0`）**不是新块**而是「本 step 已流出正文的整块
  // 结算」→ 并入该来源**最后一条**文本条目；否则同一逻辑块的流出前缀与结算文本会被拆成
  // 两个条目 / 两个框（代码块、表格还会被从中间劈开分别解析）
  let at = -1;
  if (settle === true) {
    for (let i = items.length - 1; i >= 0; i--) {
      if (mergeable(items[i]!)) {
        at = i;
        break;
      }
    }
  } else {
    at = items.findIndex((item) => mergeable(item) && item.block === block);
  }
  const found = at >= 0 ? items[at] : undefined;
  if (found === undefined) {
    items.push(
      withSeq(
        {
          source,
          text,
          ...(tone === undefined ? {} : { tone }),
          ...(generation === undefined ? {} : { generation }),
          ...(block === undefined ? {} : { block }),
        },
        seq,
      ),
    );
  } else {
    items[at] = withSeq(
      {
        ...found,
        text: (found.text ?? "") + text,
        ...(tone === undefined ? {} : { tone }),
        // 世代按「首次交付」记（同一条目内的流式续写不刷新世代）
        ...(found.generation === undefined && generation !== undefined
          ? { generation }
          : {}),
      },
      seq,
    );
  }
  return { ...section, items };
}

/** 节内该来源最后一条**文本**条目的文本（工具批不算） */
function lastTextIn(section: Section, source: Source): string | undefined {
  for (let i = section.items.length - 1; i >= 0; i--) {
    const item = section.items[i]!;
    if (item.source !== source) continue;
    if (item.calls !== undefined || item.results !== undefined) continue;
    return item.text ?? "";
  }
  return undefined;
}

/** 工具条目（调用 / 结果同组）：不存在则新建，返回其下标 */
function toolAt(section: Section): { items: Item[]; at: number; item: Item } {
  const items = [...section.items];
  // 只复用**已是工具批**的条目：辅助行（subagent / hook 的 `source: "tool"` 文本）没有
  // calls / results，复用会给它挂上批 → 渲染走批分支、文本整条消失（BACKLOG「同节内
  // 『辅助行 → 工具调用』顺序会让辅助行消失」）。与 `appendText` 的排除判据对称。
  const at = items.findIndex(
    (item) =>
      item.source === "tool" &&
      (item.calls !== undefined || item.results !== undefined),
  );
  const found = at >= 0 ? items[at] : undefined;
  if (found !== undefined) return { items, at, item: found };
  const fresh: Item = { source: "tool", calls: [], results: [] };
  items.push(fresh);
  return { items, at: items.length - 1, item: fresh };
}

/**
 * 文本对账：返回「本次真正新增的文本」（空 = 重复交付 / 无法回写）。
 *   - `full`（整块）：与已入账文本前缀对齐，只补缺失后缀；
 *   - 增量：已含该片段（后缀重复）→ 空；新片段以已入账文本开头（累计式）→ 补后缀；否则追加。
 */
function reconcile(previous: string, text: string, full: boolean): string {
  if (previous === "") return text;
  if (text === previous) return "";
  if (full) {
    if (text.startsWith(previous)) return text.slice(previous.length);
    return ""; // 与已入账不符：append-only 设备无法回写，保留既有内容
  }
  if (previous.startsWith(text)) return ""; // 已覆盖（旧线前缀重放）
  if (previous.endsWith(text)) return ""; // 已覆盖（尾部重放）
  if (text.startsWith(previous)) return text.slice(previous.length); // 累计式
  return text;
}

function record(
  delivered: Map<string, string>,
  key: string,
  previous: string,
  accept: string,
): void {
  delivered.set(key, previous + accept);
}

function applyText(
  state: SectionsState,
  delivery: Extract<BlockDelivery, { kind: "text" }>,
): SectionsState {
  const key = blockKey(delivery.turn, delivery.step, delivery.index);
  const delivered = new Map(state.delivered);
  const next = {
    ...state,
    delivered,
    lastScope: { turn: delivery.turn, step: delivery.step },
  };
  // 续写判据看**该来源在该节是否已有同块的文本条目**（不能只看交付账：交付账按
  // `turn:step:index` 记、不含来源，reasoning 与 assistant 用同一 index 时会误判成续写）
  const home = state.sections.find(
    (section) =>
      section.turn === delivery.turn &&
      section.step === delivery.step &&
      section.standalone !== true,
  );
  const continuing =
    delivery.index < 0 ||
    (home?.items.some(
      (item) =>
        item.source === delivery.source && item.block === delivery.index,
    ) ??
      false);
  const located = target(next, delivery.turn, delivery.step, continuing);
  // step 级结算（`index < 0`）与该来源**已在屏上的最后一条文本**对账：交付账按块键记，
  // 结算另有其键（`…:-1`），拿它当 `previous` 会把整块文本重复并进上一条
  const settle = delivery.index < 0;
  const previous = settle
    ? (lastTextIn(located.target.section, delivery.source) ?? "")
    : (state.delivered.get(key) ?? "");
  const accept = reconcile(previous, delivery.text, delivery.full === true);
  record(delivered, key, previous, accept);
  if (accept === "") return located.state;
  const section = appendText(
    located.target.section,
    delivery.source,
    accept,
    delivery.tone,
    delivery.seq,
    next.turnEnds,
    delivery.index,
    settle,
  );
  return write(located.state, located.target, section);
}

/** 工具参数增量对账：已含该分片 / 累计式分片 / 新分片三式 */
function reconcileArgs(previous: string, args: string): string {
  if (previous.endsWith(args)) return previous;
  if (previous.startsWith(args)) return previous;
  if (args.startsWith(previous)) return args;
  return previous + args;
}

function applyToolCall(
  state: SectionsState,
  delivery: Extract<BlockDelivery, { kind: "tool-call" }>,
): SectionsState {
  const sk = stepKey(delivery.turn, delivery.step);
  const previous = state.toolArgs.get(delivery.callId)?.args;
  const full = delivery.full === true;
  const args =
    previous === undefined || previous === ""
      ? delivery.args
      : full
        ? delivery.args // 整块：以整块为准（append-only 设备不回写更短内容）
        : state.completedCalls.has(delivery.callId)
          ? previous // 已有整块参数：忽略其后的增量分片（拼接会损坏 args）
          : reconcileArgs(previous, delivery.args);
  const toolArgs = new Map(state.toolArgs);
  toolArgs.set(delivery.callId, {
    callId: delivery.callId,
    name: delivery.name,
    args,
  });
  const completedCalls = full
    ? new Set(state.completedCalls).add(delivery.callId)
    : state.completedCalls;

  const awaiting = new Map(state.awaiting);
  const waiting = new Set(awaiting.get(sk) ?? []);
  if (!state.resolved.has(delivery.callId) && !state.interrupted.has(sk)) {
    waiting.add(delivery.callId);
  }
  awaiting.set(sk, waiting);

  const located = target(
    {
      ...state,
      toolArgs,
      completedCalls,
      awaiting,
      lastScope: { turn: delivery.turn, step: delivery.step },
    },
    delivery.turn,
    delivery.step,
    state.toolArgs.has(delivery.callId) || state.callOwner.has(delivery.callId),
  );
  const owner = located.target.on === "current" ? -1 : located.target.at;
  const callOwner = new Map(state.callOwner);
  callOwner.set(delivery.callId, owner);
  const slot = toolAt(located.target.section);
  const calls = [...(slot.item.calls ?? [])];
  const at = calls.findIndex((call) => call.callId === delivery.callId);
  const call: ToolCall = { callId: delivery.callId, name: delivery.name, args };
  if (at >= 0) calls[at] = call;
  else calls.push(call);
  const section: Section = {
    ...located.target.section,
    items: withItem(
      slot.items,
      slot.at,
      withSeq({ ...slot.item, calls }, delivery.seq),
    ),
  };
  return write({ ...located.state, callOwner }, located.target, section);
}

function withItem(items: readonly Item[], at: number, item: Item): Item[] {
  const next = [...items];
  next[at] = item;
  return next;
}

function applyToolResult(
  state: SectionsState,
  delivery: Extract<BlockDelivery, { kind: "tool-result" }>,
): SectionsState {
  const sk = stepKey(delivery.turn, delivery.step);
  const awaiting = new Map(state.awaiting);
  const waiting = new Set(awaiting.get(sk) ?? []);
  // 配对键：显式 callId 优先；否则按到达顺序消费本 step 第一个待配对调用
  const callId = delivery.callId ?? [...waiting][0];
  if (callId !== undefined) waiting.delete(callId);
  awaiting.set(sk, waiting);
  const batchDone = callId !== undefined && waiting.size === 0;

  // 结果回到调用所在节（批不拆）；调用未知（结果早于调用）→ 落在当前节
  const owner = callId === undefined ? undefined : state.callOwner.get(callId);
  const located =
    owner !== undefined && owner >= 0 && state.sections[owner] !== undefined
      ? {
          state,
          target: {
            on: "closed",
            at: owner,
            section: state.sections[owner]!,
          } as Target,
        }
      : target(state, delivery.turn, delivery.step);

  const resolved =
    callId === undefined ? state.resolved : new Set(state.resolved).add(callId);
  const slot = toolAt(located.target.section);
  const results = [...(slot.item.results ?? [])];
  results.push({
    ...(callId === undefined ? {} : { callId }),
    ok: delivery.ok,
    detail: delivery.detail,
  });
  const section: Section = {
    ...located.target.section,
    items: withItem(
      slot.items,
      slot.at,
      withSeq({ ...slot.item, results }, delivery.seq),
    ),
  };
  const written = write(
    {
      ...located.state,
      awaiting,
      resolved,
      lastScope: { turn: delivery.turn, step: delivery.step },
    },
    located.target,
    section,
  );
  // 批结果到齐 → 下一块内容先封闭本节（结果自身已入账，不会被推走）
  return batchDone && written.current !== undefined
    ? { ...written, pendingOpen: true }
    : written;
}

/** 回合结束：封闭当前节 + 给该回合最后一个 assistant 节打「最终总结」标记 */
/** 回合结束原因 → 用户块终态符号（与 `state.ts` 的 `markUserBlockStatus` 同口径） */
function userStatusOfReason(
  reason: string | undefined,
): "success" | "failure" | "aborted" | undefined {
  if (reason === "completed") return "success";
  if (reason === "aborted") return "aborted";
  if (reason === "error") return "failure";
  return undefined;
}

function applyTurnEnd(
  state: SectionsState,
  turn: number,
  reason?: string,
): SectionsState {
  const sealed =
    state.current === undefined ? state : sealedOf(state, state.current);
  const sections = [...sealed.sections];
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i]!;
    if (section.turn !== turn) continue;
    if (!section.items.some((item) => item.source === "assistant")) continue;
    sections[i] = { ...section, final: true };
    break;
  }
  // 用户块终态（条目 7 批 B1）：落到**该回合最后一个用户条目的最后一个用户 item** ——
  // 符号渲染不再回查 buffer。已有终态不覆盖（同 `markUserBlockStatus`）
  const status = userStatusOfReason(reason);
  if (status !== undefined) {
    // 本世代的用户条目（上一次 `turn-end` 之后交付、尚无终态、非 steer 续接块）：
    // **不按回合号匹配**——用户块由 App 在发送时按本地预测回合号交付（`index.ts` 的
    // `sendUserText`），宿主的 `turn-end` 带它自己的号；恢复会话后两者不同步时精确匹配
    // 永远落空，用户块会一直停在 `?`（BACKLOG「用户块终态符号始终是 `?`」）。也不能改成
    // 「往回合号之外回溯最后一个未定态块」：上一个以 interrupted / max-tokens / blocked
    // 收尾的回合**不落终态**（设计如此），回溯会把它误标成本回合的 ✓。
    for (let i = sections.length - 1; i >= 0; i--) {
      const section = sections[i]!;
      const at = section.items.findIndex(
        (item) =>
          item.source === "user" &&
          item.userStatus === undefined &&
          item.steerContinued !== true &&
          item.generation === sealed.turnEnds,
      );
      if (at < 0) continue;
      const items = [...section.items];
      items[at] = { ...items[at]!, userStatus: status };
      sections[i] = { ...section, items };
      break;
    }
  }
  // 世代推进：本回合的用户块（不论是否落成终态）就此消费，后续 `turn-end` 不再回头标它
  return {
    ...sealed,
    sections,
    pendingOpen: false,
    turnEnds: sealed.turnEnds + 1,
  };
}

/** 交付一块：接收层的唯一入口（幂等） */
export function applyDelivery(
  state: SectionsState,
  delivery: BlockDelivery,
): SectionsState {
  // 事件号去重：宿主持久线交付都带 seq（同一事件重放只入一次）
  const seq = "seq" in delivery ? delivery.seq : undefined;
  if (seq !== undefined) {
    if (state.seenSeqs.has(seq)) return state;
    state = { ...state, seenSeqs: new Set(state.seenSeqs).add(seq) };
  }
  switch (delivery.kind) {
    case "text":
      return applyText(state, delivery);
    case "tool-call":
      return applyToolCall(state, delivery);
    case "tool-result":
      return applyToolResult(state, delivery);
    case "step-start": {
      const key = stepKey(delivery.turn, delivery.step);
      const stepMeta = new Map(state.stepMeta);
      stepMeta.set(
        key,
        delivery.time === undefined ? {} : { time: delivery.time },
      );
      const next = {
        ...state,
        stepMeta,
        lastScope: { turn: delivery.turn, step: delivery.step },
      };
      const current = next.current;
      // 幂等 / 迟到：同一 (turn, step) 已有节或已有内容 → 只记元数据，不切节
      if (!current || sameScope(current, delivery.turn, delivery.step))
        return next;
      if (
        next.sections.some((section) =>
          sameScope(section, delivery.turn, delivery.step),
        )
      ) {
        return next;
      }
      return sealedOf(next, current);
    }
    case "step-summary": {
      // P9：恢复会话的 step 概要行——独立成节、不带条目（渲染只看 `stepSummary`）
      const sealed =
        state.current === undefined ? state : sealedOf(state, state.current);
      const section: Section = {
        turn: delivery.turn,
        step: delivery.step,
        items: [],
        frozen: false,
        standalone: true,
        stepSummary: delivery.text,
      };
      return {
        ...sealed,
        sections: [...sealed.sections, section],
        lastScope: { turn: delivery.turn, step: delivery.step },
      };
    }
    case "user":
    case "notice":
    case "shell": {
      const scope =
        delivery.kind === "user"
          ? { turn: delivery.turn, step: delivery.step }
          : state.lastScope;
      const sealed =
        state.current === undefined ? state : sealedOf(state, state.current);
      const source: Source =
        delivery.kind === "user"
          ? "user"
          : delivery.kind === "notice"
            ? "notice"
            : "shell";
      const tone = delivery.kind === "notice" ? delivery.tone : undefined;
      // notice 排版参数（条目 7 选项 1）：/help 的悬挂缩进与紧凑豁免随交付进节模型
      const hanging = delivery.kind === "notice" ? delivery.hanging : undefined;
      const section: Section = {
        turn: scope.turn,
        step: scope.step,
        items: [
          {
            source,
            text: delivery.text,
            ...(tone === undefined ? {} : { tone }),
            ...(hanging === undefined ? {} : { hanging }),
            ...(delivery.kind === "notice" && delivery.noCompact === true
              ? { noCompact: true }
              : {}),
            // 行号透传（App 本地用户交付带 seq）：旧路径兜底用；批 B1 起终态 / steer
            // 标记都随条目走，不再依赖它回查 buffer
            ...(delivery.seq === undefined ? {} : { seqs: [delivery.seq] }),
            // 恢复路径按缓冲行原样透传的终态与「被 steer 续接」标记（批 B1）
            ...(delivery.kind === "user" && delivery.status !== undefined
              ? { userStatus: delivery.status }
              : {}),
            ...(delivery.kind === "user" && delivery.steerContinued === true
              ? { steerContinued: true }
              : {}),
            // 回合世代（用户块终态的作用域门，见 `Item.generation`）：自成节，交付即定代
            ...(delivery.kind === "user" ? { generation: state.turnEnds } : {}),
          },
        ],
        frozen: false,
        standalone: true,
        // steer 插队送达：与上一条输入之间留空行（第 3 步按此插 blank，旧口径同款留白）
        ...(delivery.kind === "user" &&
        (delivery.queued === "steer" || delivery.spaceBefore === true)
          ? { steer: true }
          : {}),
      };
      // 自成节（封闭态）：其后内容另起一节——与设计「notice 与用户消息同行为」一致
      return {
        ...sealed,
        sections: [...sealed.sections, close(section)],
        current: undefined,
        pendingOpen: false,
        lastScope: scope,
      };
    }
    case "turn-end":
      return applyTurnEnd(
        { ...state, lastScope: { turn: delivery.turn, step: delivery.step } },
        delivery.turn,
        delivery.reason,
      );
    case "user-flag": {
      // 批 B1：steer 认领 → **上一条**用户输入置「被续接」（永久 `←` 符号）。
      // 用户节是独立自足节（立即可封闭）→ 从已封闭节往前找最后一条用户条目
      if (delivery.steerContinued !== true) return state;
      const sections = [...state.sections];
      for (let i = sections.length - 1; i >= 0; i--) {
        const section = sections[i]!;
        const at = section.items.findIndex((item) => item.source === "user");
        if (at < 0) continue;
        const item = section.items[at]!;
        if (item.steerContinued !== true) {
          const items = [...section.items];
          items[at] = { ...item, steerContinued: true };
          sections[i] = { ...section, items };
        }
        return { ...state, sections };
      }
      return state;
    }
    case "interrupted": {
      const sk = stepKey(delivery.turn, delivery.step);
      const interrupted = new Set(state.interrupted).add(sk);
      // 不再等批结果（结果仍可到达并按 callId 配进本节）；不置待封闭——中断后的结果正属本节
      const awaiting = new Map(state.awaiting);
      awaiting.set(sk, new Set());
      return { ...state, interrupted, awaiting };
    }
    case "finalize": {
      const freezable = new Set(state.freezable).add(
        stepKey(delivery.turn, delivery.step),
      );
      return { ...state, freezable };
    }
    case "turn-start": {
      const key = String(delivery.turn);
      const turnMeta = new Map(state.turnMeta);
      // 首次登记的时间（turn-begin 的 now）即分隔线显示时间；后到的宿主 turn/start
      // 只回填回合号，不覆盖时间。首次登记时没有时间（恢复路径）→ 记 undefined
      // （线画纯虚线）；后到的时间可以补上（宿主 turn/start 带来真实时间）
      if (
        !turnMeta.has(key) ||
        (turnMeta.get(key) === undefined && delivery.time !== undefined)
      )
        turnMeta.set(key, delivery.time);
      return { ...state, turnMeta };
    }
    case "shadow": {
      const shadowedSeqs = new Set(state.shadowedSeqs);
      for (const seq of delivery.seqs) shadowedSeqs.add(seq);
      return { ...state, shadowedSeqs };
    }
  }
}

/** 按序交付多块（等价于逐个 applyDelivery；供重放器 / 测试用） */
export function applyAll(
  state: SectionsState,
  deliveries: readonly BlockDelivery[],
): SectionsState {
  let next = state;
  for (const delivery of deliveries) next = applyDelivery(next, delivery);
  return next;
}

/** 全部节（含当前节）——读取用 */
export function allSections(state: SectionsState): readonly Section[] {
  return state.current === undefined
    ? state.sections
    : [...state.sections, state.current];
}

/** 取节内某来源的条目（测试与后续批次读取用） */
export function itemOf(section: Section, source: Source): Item | undefined {
  return section.items.find((item) => item.source === source);
}

/**
 * 按节序取**最后一条**匹配来源的非空文本（条目 7 选项 1：生产读侧不再回查
 * `state.buffer`——`/copy` 的最后回复、`/council` 与问答面板的来源都取自此）。
 * 多来源按「节序 → 节内条目序」的先后取最后一条（问答面板的「上文」= 最近一段正文，
 * 正文与用户块都可能成为来源）。
 */
export function lastTextOfSources(
  state: SectionsState,
  sources: readonly Source[],
): string | undefined {
  const list = allSections(state);
  for (let i = list.length - 1; i >= 0; i--) {
    const items = list[i]!.items;
    for (let j = items.length - 1; j >= 0; j--) {
      const item = items[j]!;
      if (!sources.includes(item.source)) continue;
      const text = item.text ?? "";
      if (text.trim() !== "") return text;
    }
  }
  return undefined;
}

/** 最后一个含该来源文本的**节**里，该来源各条目文本按序拼接（`/copy` 的「完整最后回复」：
 *  条目的块身份只管渲染分段，复制要的是整条回复——同 step 内被 notice 隔开的多块也算一条，
 *  与「节内正文按序合并」的既有口径一致） */
export function joinedLastTextBySource(
  state: SectionsState,
  source: Source,
): string | undefined {
  const list = allSections(state);
  // 先定**最后一个含该来源文本的 (turn, step)**，再取该 scope 下所有节的该来源文本按序拼接：
  // 同一步的回复会被 notice / 工具批按到达顺序切成多节，但它们同属「最后一条回复」
  let scope: { turn: number; step: number } | undefined;
  for (let i = list.length - 1; i >= 0 && scope === undefined; i--) {
    const section = list[i]!;
    const has = section.items.some(
      (item) => item.source === source && (item.text ?? "").trim() !== "",
    );
    if (has) scope = { turn: section.turn, step: section.step };
  }
  if (scope === undefined) return undefined;
  const texts = list
    .filter(
      (section) => section.turn === scope.turn && section.step === scope.step,
    )
    .flatMap((section) => section.items)
    .filter((item) => item.source === source)
    .map((item) => item.text ?? "")
    .filter((text) => text.trim() !== "");
  return texts.length > 0 ? texts.join("") : undefined;
}

/** 单来源版（`/copy` = assistant、`/council` = user） */
export function lastTextBySource(
  state: SectionsState,
  source: Source,
): string | undefined {
  return lastTextOfSources(state, [source]);
}
