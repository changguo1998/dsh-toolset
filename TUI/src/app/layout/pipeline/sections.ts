// src/app/layout/pipeline/sections.ts — 第 1 步「接收」：块交付 → 节缓存
//
// 职责（口径见追踪文档「分节规则」「节内合并」「冻结 / 活跃 两套」）：
//   - 幂等合并：宿主两条线（持久线结算 / 实时线增量）重复交付同一块只入一次；
//   - 三张记账表：① 交付账（块键 → 已交付文本）② 工具参数累计（callId → 调用）
//     ③ 完成 / 中断标记（块键 / step 键）；
//   - 分节：用户输入 / notice / shell / step-start / 工具批结果到齐为边界，惰性开节（无空节）；
//   - 节内归并：按来源类型归并（`r1 a1 r2 a2` → reasoning = r1+r2、assistant = a1+a2），
//     顺序按各类型首次出现；归并不跨节。
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
  type ToolResult,
} from "./types.ts";

/** 节缓存状态（不可变；每次交付返回新状态，便于等价断言与快照） */
export interface SectionsState {
  /** 已封闭的节（append-only） */
  sections: readonly Section[];
  /** 当前可写节（惰性创建；不存在 = 下一块内容落地时才开节） */
  current?: Section;
  /** 待开节：下一块内容落地时先封闭当前节（工具批结果到齐 / step-start / 中断置位） */
  pendingOpen: boolean;
  /** step 元数据（`step-start` 记录，开节时取用：时间戳供 step 头显示） */
  stepMeta: ReadonlyMap<string, { time?: number }>;
  /** ① 交付账：块键 → 已交付文本 */
  delivered: ReadonlyMap<string, string>;
  /** ② 工具参数累计：callId → 调用（delta 累计后的终值） */
  toolArgs: ReadonlyMap<string, ToolCall>;
  /** ③ 完成标记：块键（结算整块已交付，后续增量 / 结算不再入账） */
  completed: ReadonlySet<string>;
  /** ③ 中断标记：step 键（结果可能永不到齐，不再等批结果） */
  interrupted: ReadonlySet<string>;
  /** 待结果的工具调用：callId 集合（清空的那一刻 = 批结果到齐 → 置 `pendingOpen`） */
  awaitingResults: ReadonlySet<string>;
  /** 定型信号（宿主 `assistant/message`）已送达的 step 键 */
  freezable: ReadonlySet<string>;
}

export function createSections(): SectionsState {
  return {
    sections: [],
    pendingOpen: false,
    stepMeta: new Map(),
    delivered: new Map(),
    toolArgs: new Map(),
    completed: new Set(),
    interrupted: new Set(),
    awaitingResults: new Set(),
    freezable: new Set(),
  };
}

/** 当前节是否已可冻结（封闭 + 定型信号已到）——帧边界用它决定冻结 */
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

/** 封闭当前节（置 `frozen`）——边界到达时调用 */
function close(
  state: SectionsState,
  current: Section,
): Pick<SectionsState, "sections" | "current" | "pendingOpen"> {
  return {
    sections: [
      ...state.sections,
      current.frozen ? current : { ...current, frozen: true },
    ],
    current: undefined,
    pendingOpen: false,
  };
}

/** 取当前节（必要时惰性开节）；`pendingOpen` 或有旧 turn/step 时先封闭 */
function ensure(
  state: SectionsState,
  turn: number,
  step: number,
): { state: SectionsState; current: Section } {
  let base = state;
  const existing = base.current;
  if (
    existing &&
    (base.pendingOpen || existing.turn !== turn || existing.step !== step)
  ) {
    base = { ...base, ...close(base, existing) };
  }
  const current = base.current;
  if (current) return { state: base, current };
  const time = base.stepMeta.get(stepKey(turn, step))?.time;
  const opened: Section = {
    turn,
    step,
    ...(time === undefined ? {} : { time }),
    items: [],
    frozen: false,
  };
  return { state: { ...base, current: opened }, current: opened };
}

/** 写回当前节（追加后必然是新内容 → 撤销冻结标记） */
function write(state: SectionsState, section: Section): SectionsState {
  return {
    ...state,
    current: section.frozen ? { ...section, frozen: false } : section,
  };
}

/** 节内按来源归并：同类型文本直拼，顺序按类型首次出现 */
function appendText(
  section: Section,
  source: Source,
  text: string,
  tone?: NoticeTone,
): Section {
  const items = [...section.items];
  const at = items.findIndex((item) => item.source === source);
  const found = at >= 0 ? items[at] : undefined;
  if (found === undefined) {
    items.push({
      source,
      text,
      ...(tone === undefined ? {} : { tone }),
    });
  } else {
    items[at] = {
      ...found,
      text: (found.text ?? "") + text,
      ...(tone === undefined ? {} : { tone }),
    };
  }
  return { ...section, items };
}

/** 工具条目（调用 / 结果同组）：不存在则新建 */
function toolItem(section: Section): {
  section: Section;
  item: Item;
  at: number;
} {
  const items = [...section.items];
  const at = items.findIndex((item) => item.source === "tool");
  const found = at >= 0 ? items[at] : undefined;
  if (found === undefined) {
    const fresh: Item = { source: "tool", calls: [], results: [] };
    items.push(fresh);
    return {
      section: { ...section, items },
      item: fresh,
      at: items.length - 1,
    };
  }
  return { section, item: found, at };
}

function writeToolItem(section: Section, at: number, item: Item): Section {
  const items = [...section.items];
  items[at] = item;
  return { ...section, items };
}

/** 文本块入账：返回「本次真正新增的文本」（空 = 重复交付，不入账） */
function acceptText(
  state: SectionsState,
  key: string,
  text: string,
  full: boolean,
): { state: SectionsState; accept: string } | undefined {
  if (state.completed.has(key)) return undefined;
  const delivered = state.delivered.get(key) ?? "";
  if (full) {
    // 整块结算：与已交付前缀对齐，只补缺失后缀（前缀不符 = 无法重写，丢弃）
    const accept =
      delivered === ""
        ? text
        : text.startsWith(delivered)
          ? text.slice(delivered.length)
          : "";
    const completed = new Set(state.completed);
    completed.add(key);
    const deliveredMap = new Map(state.delivered);
    deliveredMap.set(key, text);
    return {
      state: { ...state, completed, delivered: deliveredMap },
      accept,
    };
  }
  // 增量：已被累计文本覆盖（是前缀）则视为重复交付
  if (
    delivered !== "" &&
    text.length <= delivered.length &&
    delivered.startsWith(text)
  ) {
    return undefined;
  }
  const deliveredMap = new Map(state.delivered);
  deliveredMap.set(key, delivered + text);
  return { state: { ...state, delivered: deliveredMap }, accept: text };
}

function applyText(
  state: SectionsState,
  delivery: Extract<BlockDelivery, { kind: "text" }>,
): SectionsState {
  const key = blockKey(delivery.turn, delivery.step, delivery.index);
  const accepted = acceptText(
    state,
    key,
    delivery.text,
    delivery.full === true,
  );
  if (accepted === undefined || accepted.accept === "")
    return accepted?.state ?? state;
  const opened = ensure(accepted.state, delivery.turn, delivery.step);
  const section = appendText(opened.current, delivery.source, accepted.accept);
  return write(opened.state, section);
}

function applyToolCall(
  state: SectionsState,
  delivery: Extract<BlockDelivery, { kind: "tool-call" }>,
): SectionsState {
  // ② 工具参数累计：同 callId 的后续分片只追加未覆盖后缀（重复交付不入账）
  const previous = state.toolArgs.get(delivery.callId);
  const args =
    previous === undefined
      ? delivery.args
      : previous.args === delivery.args || previous.args.endsWith(delivery.args)
        ? previous.args
        : previous.args + delivery.args;
  const toolArgs = new Map(state.toolArgs);
  toolArgs.set(delivery.callId, {
    callId: delivery.callId,
    name: delivery.name,
    args,
  });
  const awaitingResults = state.interrupted.has(
    stepKey(delivery.turn, delivery.step),
  )
    ? state.awaitingResults
    : new Set(state.awaitingResults).add(delivery.callId);
  const opened = ensure(
    { ...state, toolArgs, awaitingResults },
    delivery.turn,
    delivery.step,
  );
  const target = toolItem(opened.current);
  const calls = [...(target.item.calls ?? [])];
  const at = calls.findIndex((call) => call.callId === delivery.callId);
  const call: ToolCall = { callId: delivery.callId, name: delivery.name, args };
  if (at >= 0) calls[at] = call;
  else calls.push(call);
  const item: Item = { ...target.item, calls };
  return write(opened.state, writeToolItem(target.section, target.at, item));
}

function applyToolResult(
  state: SectionsState,
  delivery: Extract<BlockDelivery, { kind: "tool-result" }>,
): SectionsState {
  const awaitingResults = new Set(state.awaitingResults);
  if (delivery.callId !== undefined) awaitingResults.delete(delivery.callId);
  // 结果先按「当前节的批」入账（同 callId 配对），**之后**才置待开节——否则结果会
  // 被 `ensure` 推到新节，与它的调用分离（批结果到齐的信号是给「下一块内容」的）。
  const opened = ensure(
    { ...state, awaitingResults },
    delivery.turn,
    delivery.step,
  );
  const target = toolItem(opened.current);
  const result: ToolResult = {
    ...(delivery.callId === undefined ? {} : { callId: delivery.callId }),
    ok: delivery.ok,
    detail: delivery.detail,
  };
  const results = [...(target.item.results ?? []), result];
  const item: Item = { ...target.item, results };
  const written = write(
    opened.state,
    writeToolItem(target.section, target.at, item),
  );
  // 批结果到齐（此前有待配对项）→ 下一块内容先封闭本节
  const batchDone =
    state.awaitingResults.size > 0 && awaitingResults.size === 0;
  return batchDone ? { ...written, pendingOpen: true } : written;
}

/** 交付一块：接收层的唯一入口（幂等；同块重复交付不改变节内容） */
export function applyDelivery(
  state: SectionsState,
  delivery: BlockDelivery,
): SectionsState {
  switch (delivery.kind) {
    case "text":
      return applyText(state, delivery);
    case "tool-call":
      return applyToolCall(state, delivery);
    case "tool-result":
      return applyToolResult(state, delivery);
    case "step-start": {
      const stepMeta = new Map(state.stepMeta);
      const key = stepKey(delivery.turn, delivery.step);
      stepMeta.set(
        key,
        delivery.time === undefined ? {} : { time: delivery.time },
      );
      const base = { ...state, stepMeta, pendingOpen: true };
      const existing = base.current;
      if (!existing) return base;
      return { ...base, ...close(base, existing) };
    }
    case "user":
    case "notice":
    case "shell": {
      const turn =
        delivery.kind === "user" ? delivery.turn : (state.current?.turn ?? 0);
      const step =
        delivery.kind === "user" ? delivery.step : (state.current?.step ?? 0);
      const sealed =
        state.current === undefined
          ? state
          : { ...state, ...close(state, state.current) };
      const source: Source =
        delivery.kind === "user"
          ? "user"
          : delivery.kind === "notice"
            ? "notice"
            : "shell";
      const tone = delivery.kind === "notice" ? delivery.tone : undefined;
      const item: Item = {
        source,
        text: delivery.text,
        ...(tone === undefined ? {} : { tone }),
      };
      const section: Section = {
        turn,
        step,
        items: [item],
        frozen: false,
      };
      // 自成节后置「待开节」：其后内容另起一节（与设计「notice 与用户消息同行为」一致）
      return {
        ...sealed,
        sections: [...sealed.sections, { ...section, frozen: true }],
        current: undefined,
        pendingOpen: false,
      };
    }
    case "interrupted": {
      const interrupted = new Set(state.interrupted);
      interrupted.add(stepKey(delivery.turn, delivery.step));
      // 不再等批结果（结果仍可到达并按 callId 配进本节）；不置待开节——中断后的结果
      // 正属于本节那批，置待开节会把它们推到新节，与调用分离。
      return { ...state, interrupted, awaitingResults: new Set() };
    }
    case "finalize": {
      const freezable = new Set(state.freezable);
      freezable.add(stepKey(delivery.turn, delivery.step));
      return { ...state, freezable };
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
