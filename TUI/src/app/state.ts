// src/app/state.ts — 状态模型 + 纯 reducer
//
// buffer 持有会话文本行（无界，超出 SCROLLBACK_MAX 裁剪旧行）。
// 滚动状态：followBottom 跟随底部；scrollOffset = 上滚的行单位偏移。

import type { ApprovalItem, AgentStatus, SessionMeta } from "./adapter/dsh.ts";
import type { ModelSelection } from "./adapter/dsh.ts";

/** scrollback 行数上限（纯物理上限；DESIGN:2000 行） */
export const MAX_BUFFER_LINES = 2000;

/** 系统状态区各字段：time/cwd/git 由 StatusTicker 合并节流读取，其余为占位 */
export interface SystemStatus {
  time: string;
  cwd: string;
  git: string;
  /** 无数据源时的占位符（上下文长度/缓存命中率；model 默认占位、切换会话模型后更新） */
  model: string;
  contextLen: string;
  cacheHit: string;
}

/** turn 分隔线（横线占位；实际宽度由历史区换行决定） */
export const TURN_SEPARATOR = "────────";

export interface AppState {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  /** 会话纯文本行（未换行，展示时才按列宽切分） */
  buffer: string[];
  /** 是否跟随底部 */
  followBottom: boolean;
  /** 上滚偏移（行） */
  scrollOffset: number;
  inputText: string;
  inputCursor: number;
  approval: ApprovalItem | null;
  agentStatus: AgentStatus;
  systemStatus: SystemStatus;
  /** 模型交互选择模式（/model 无参进入；null = 未激活） */
  picker: PickerState | null;
}

/** /model 交互选择面板状态：三列列表（provider/model/effort）+ 高亮索引 */
export interface PickerState {
  /** 去重后的 provider 列表 */
  providers: string[];
  /** provider 列高亮索引 */
  providerIndex: number;
  /** 每个 provider 的模型列表（model 列随 provider 动态调整） */
  providerModels: Record<string, string[]>;
  /** 当前高亮 provider 的模型列表（跟随 provider 切换） */
  models: string[];
  /** model 列高亮索引 */
  modelIndex: number;
  /** 当前高亮模型的思考等级选项（id/name；非思考模型为空） */
  efforts: { id: string; name: string }[];
  /** thinking 列高亮索引 */
  effortIndex: number;
  /** 焦点区：0=provider 列，1=model 列，2=thinking 列（Tab 循环切换三列同屏） */
  phase: 0 | 1 | 2;
  /** 待提交选中（各列星号标记；Enter 提交它，独立于焦点箭头） */
  selectedProvider?: string;
  selectedModel?: string;
  selectedEffort?: string;
  /** 当前生效选择（各列浅绿显示） */
  current?: ModelSelection;
}

/** 选择面板单个选项 */
export interface PickerOption {
  /** 纯 ASCII 展示文本，如 "deepseek/deepseek-chat" */
  label: string;
  /** 确认后应用的模型选择 */
  selection: ModelSelection;
  /** 是否为当前会话模型（行内标记 + 高亮） */
  current: boolean;
}

export function initialState(): AppState {
  return {
    sessions: [],
    activeSessionId: null,
    buffer: [],
    followBottom: true,
    scrollOffset: 0,
    inputText: "",
    inputCursor: 0,
    approval: null,
    picker: null,
    agentStatus: "idle",
    systemStatus: {
      time: "—",
      cwd: "—",
      git: "—",
      model: "—",
      contextLen: "—",
      cacheHit: "—",
    },
  };
}

/**
 * 追加流式文本。语义：
 *  - 文本中的第一个段落（不含换行符）合并到 buffer 末行（流式续写）
 *  - 换行之后的段落各自新开一行
 *  - 若文本以换行结尾，末尾出现一个空行
 *  - 末行为 turn 分隔线时不合并（分隔线是硬边界，下个 turn 另起一行）
 */
export function appendStream(state: AppState, text: string): AppState {
  const buffer = state.buffer.length ? [...state.buffer] : [];
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (
      i === 0 &&
      buffer.length > 0 &&
      buffer[buffer.length - 1] !== TURN_SEPARATOR
    ) {
      if (part !== "") buffer[buffer.length - 1] += part;
    } else {
      buffer.push(part);
    }
  }
  // scrollback 上限裁剪
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  return { ...state, buffer };
}

/**
 * 追加一条命令通知(notice)：独立成行，不并入 buffer 末行(与流式 append 不同)。
 * 用于 slash 命令的提示/结果文本(绝不进入模型历史，仅 UI 展示)。
 */
export function appendNotice(state: AppState, text: string): AppState {
  // 多行 notice 拆成多行 buffer，否则 wrapLine 把 \n 当普通字符(宽1)会让列宽对不齐，
  // 字词在中间被截断(例如 /quit 在 i 与 t 之间换行)。
  const buffer = state.buffer.length ? [...state.buffer] : [];
  for (const line of text.split("\n")) buffer.push(line);
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  return { ...state, buffer };
}

/**
 * turn 结束：往 buffer 追加分隔线，让对话历史每个 turn 之间可见分隔。
 * 空 buffer 或末尾已是分隔线时不追加（避免孤立/重复分隔）。
 */
export function appendTurnSeparator(state: AppState): AppState {
  if (state.buffer.length === 0) return state;
  const last = state.buffer[state.buffer.length - 1];
  if (last === TURN_SEPARATOR) return state;
  const buffer = [...state.buffer, TURN_SEPARATOR];
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  return { ...state, buffer };
}

/** 合并更新系统状态区（StatusTicker 每 tick 调用；缺失字段保持原值） */
export function setSystemStatus(
  state: AppState,
  status: Partial<SystemStatus>,
): AppState {
  return { ...state, systemStatus: { ...state.systemStatus, ...status } };
}

/** 清空显示缓冲(本地 /clearscreen，别名 /cls)——只清 UI，不动会话上下文。 */
export function clearBuffer(state: AppState): AppState {
  return { ...state, buffer: [], scrollOffset: 0, followBottom: true };
}

/** 追加 agent 状态 */
export function setAgentStatus(state: AppState, status: AgentStatus): AppState {
  return { ...state, agentStatus: status };
}

export function setApproval(
  state: AppState,
  approval: ApprovalItem | null,
): AppState {
  return { ...state, approval };
}

export function setSessions(
  state: AppState,
  sessions: SessionMeta[],
): AppState {
  const active =
    state.activeSessionId &&
    sessions.some((s) => s.id === state.activeSessionId)
      ? state.activeSessionId
      : (sessions[0]?.id ?? null);
  return { ...state, sessions, activeSessionId: active };
}

/** 针对 buffer 做一次只读操作（Reducer 模式入口），返回新的不改动原对象 */
export function reduceState(state: AppState, action: StateAction): AppState {
  switch (action.type) {
    case "append":
      return appendStream(state, action.text);
    case "notice":
      return appendNotice(state, action.text);
    case "clear-buffer":
      return clearBuffer(state);
    case "agent-status":
      return setAgentStatus(state, action.status);
    case "approval":
      return setApproval(state, action.approval);
    case "sessions":
      return setSessions(state, action.sessions);
    case "picker-open":
      return { ...state, picker: action.picker };
    case "picker-move":
      return movePicker(state, action);
    case "picker-tab":
      return tabPicker(state);
    case "picker-phase":
      return phasePicker(state, action);
    case "picker-select":
      return selectPicker(state);
    case "picker-efforts":
      return setPickerEfforts(
        state,
        action as {
          type: "picker-efforts";
          efforts: { id: string; name: string }[];
          effortIndex?: number;
        },
      );
    case "picker-close":
      return { ...state, picker: null };
    case "input":
      return setInput(state, action);
    case "move-cursor":
      return moveCursor(state, action);
    case "scroll":
      return scrollBy(state, action.delta);
    case "scroll-to-bottom":
      return { ...state, followBottom: true, scrollOffset: 0 };
    case "turn-end":
      return appendTurnSeparator(state);
    case "status":
      return setSystemStatus(state, action.status);
    default:
      return state;
  }
}

export type StateAction =
  | { type: "append"; text: string }
  | { type: "notice"; text: string }
  | { type: "clear-buffer" }
  | { type: "agent-status"; status: AgentStatus }
  | { type: "approval"; approval: ApprovalItem | null }
  | { type: "picker-open"; picker: PickerState }
  | { type: "picker-move"; delta: number }
  | { type: "picker-tab" }
  | { type: "picker-phase"; delta: 1 | -1 }
  | { type: "picker-select" }
  | {
      type: "picker-efforts";
      efforts: { id: string; name: string }[];
      /** 非 0 时代表预设高亮等级（模型行自带等级时的默认选中），匹配不到回退 0 */
      effortIndex?: number;
    }
  | { type: "picker-close" }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "input"; text: string; cursor: number }
  | { type: "move-cursor"; delta: number }
  | { type: "scroll"; delta: number }
  | { type: "scroll-to-bottom" }
  | { type: "turn-end" }
  | { type: "status"; status: Partial<SystemStatus> };

function setInput(
  state: AppState,
  action: Extract<StateAction, { type: "input" }>,
): AppState {
  const cursor = Math.max(0, Math.min(action.cursor, action.text.length));
  return { ...state, inputText: action.text, inputCursor: cursor };
}

function moveCursor(
  state: AppState,
  action: Extract<StateAction, { type: "move-cursor" }>,
): AppState {
  const cursor = Math.max(
    0,
    Math.min(state.inputCursor + action.delta, state.inputText.length),
  );
  return { ...state, inputCursor: cursor };
}

/**
 * picker 高亮移动：在 0..options.length-1 内 clamp（上下键导航）。
 */
function movePicker(
  state: AppState,
  action: Extract<StateAction, { type: "picker-move" }>,
): AppState {
  const picker = state.picker;
  if (!picker) return state;
  // 分区各自的列表独立 clamp：
  // phase0=provider 列, phase1=model 列, phase2=thinking 列
  if (picker.phase === 0) {
    if (picker.providers.length === 0) return state;
    const pi = Math.max(
      0,
      Math.min(
        picker.providerIndex + action.delta,
        picker.providers.length - 1,
      ),
    );
    if (pi === picker.providerIndex) return state;
    // 切换 provider 时 model 列同步为该 provider 的模型列表并重置高亮
    const models = picker.providerModels[picker.providers[pi]!] ?? [];
    return {
      ...state,
      picker: { ...picker, providerIndex: pi, models, modelIndex: 0 },
    };
  }
  if (picker.phase === 1) {
    if (picker.models.length === 0) return state;
    const mi = Math.max(
      0,
      Math.min(picker.modelIndex + action.delta, picker.models.length - 1),
    );
    if (mi === picker.modelIndex) return state;
    return { ...state, picker: { ...picker, modelIndex: mi } };
  }
  // thinking 焦点区：在 efforts 内 clamp；无等级时忽略方向键
  if (picker.efforts.length === 0) return state;
  const ei = Math.max(
    0,
    Math.min(picker.effortIndex + action.delta, picker.efforts.length - 1),
  );
  if (ei === picker.effortIndex) return state;
  return { ...state, picker: { ...picker, effortIndex: ei } };
}

/**
 * 选择面板「选中」：把当前 phase 焦点行值写入对应列的选中字段（星号标记），
 * 与焦点箭头（位置指示）分离。Enter 提交的是各列选中值。
 */
function selectPicker(state: AppState): AppState {
  const picker = state.picker;
  if (!picker) return state;
  if (picker.phase === 0) {
    const v = picker.providers[picker.providerIndex];
    if (!v) return state;
    return {
      ...state,
      picker: { ...picker, selectedProvider: v },
    };
  }
  if (picker.phase === 1) {
    const v = picker.models[picker.modelIndex];
    if (!v) return state;
    return { ...state, picker: { ...picker, selectedModel: v } };
  }
  // phase 2：effort 区，仅列表非空时标记
  if (picker.efforts.length === 0) return state;
  const v = picker.efforts[picker.effortIndex];
  if (!v) return state;
  return { ...state, picker: { ...picker, selectedEffort: v.id } };
}

/** Tab 循环切换三列焦点区（efforts 为空时切到 thinking 列仍为灰色提示） */
function tabPicker(state: AppState): AppState {
  const picker = state.picker;
  if (!picker) return state;
  const phase = ((picker.phase + 1) % 3) as 0 | 1 | 2;
  return { ...state, picker: { ...picker, phase, effortIndex: 0 } };
}

/** 左右方向键切换三列焦点区（clamp 不循环：左到头/右到尾保持不动） */
function phasePicker(
  state: AppState,
  action: Extract<StateAction, { type: "picker-phase" }>,
): AppState {
  const picker = state.picker;
  if (!picker) return state;
  const phase = Math.max(0, Math.min(picker.phase + action.delta, 2)) as
    0 | 1 | 2;
  if (phase === picker.phase) return state;
  return { ...state, picker: { ...picker, phase } };
}

/** 替换当前高亮模型的思考等级选项（异步加载完成后下发） */
function setPickerEfforts(
  state: AppState,
  action: {
    type: "picker-efforts";
    efforts: { id: string; name: string }[];
    effortIndex?: number;
  },
): AppState {
  const picker = state.picker;
  if (!picker) return state;
  const preset = action.effortIndex ?? 0;
  const effortIndex =
    preset > 0 && preset < action.efforts.length
      ? preset
      : preset >= action.efforts.length && action.efforts.length > 0
        ? action.efforts.length - 1
        : 0; // 预设越界时回退末尾/0
  return {
    ...state,
    picker: { ...picker, efforts: action.efforts, effortIndex },
  };
}
/**
 * 按 delta 滚动：正数上滚（delta>0 暂停跟随），负数下滚；滚回底部恢复跟随。
 * scrollOffset 语义 = 距底部多少行。
 */
export function scrollBy(state: AppState, delta: number): AppState {
  if (delta > 0) {
    return {
      ...state,
      followBottom: false,
      scrollOffset: state.scrollOffset + delta,
    };
  }
  const next = Math.max(0, state.scrollOffset + delta);
  return {
    ...state,
    scrollOffset: next,
    followBottom: next === 0 ? true : state.followBottom,
  };
}
