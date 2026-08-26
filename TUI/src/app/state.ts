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
  /** 无数据源时的占位符（模型/上下文长度/缓存命中率） */
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

/** /model 交互选择面板状态：选项列表 + 当前高亮索引 */
export interface PickerState {
  /** 可选模型（含当前模型补行） */
  options: PickerOption[];
  /** 当前高亮索引（0..options.length-1） */
  index: number;
}

/** 选择面板单个选项 */
export interface PickerOption {
  /** 纯 ASCII 展示文本，如 "deepseek/deepseek-chat" */
  label: string;
  /** 确认后应用的模型选择 */
  selection: ModelSelection;
  /** 是否为当前默认模型（行内标记 + 高亮） */
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
  if (!picker || picker.options.length === 0) return state;
  const index = Math.max(
    0,
    Math.min(picker.index + action.delta, picker.options.length - 1),
  );
  return { ...state, picker: { ...picker, index } };
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
