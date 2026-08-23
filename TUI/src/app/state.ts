// src/app/state.ts — 状态模型 + 纯 reducer
//
// buffer 持有会话文本行（无界，超出 SCROLLBACK_MAX 裁剪旧行）。
// 滚动状态：followBottom 跟随底部；scrollOffset = 上滚的行单位偏移。

import type { ApprovalItem, AgentStatus, SessionMeta } from "./adapter/dsh.ts";

/** scrollback 行数上限（纯物理上限；DESIGN:2000 行） */
export const MAX_BUFFER_LINES = 2000;

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
    agentStatus: "idle",
  };
}

/**
 * 追加流式文本。语义：
 *  - 文本中的第一个段落（不含换行符）合并到 buffer 末行（流式续写）
 *  - 换行之后的段落各自新开一行
 *  - 若文本以换行结尾，末尾出现一个空行
 */
export function appendStream(state: AppState, text: string): AppState {
  const buffer = state.buffer.length ? [...state.buffer] : [];
  const parts = text.split("\n");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i === 0 && buffer.length > 0) {
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
  const buffer = state.buffer.length ? [...state.buffer] : [];
  buffer.push(text);
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  return { ...state, buffer };
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
    case "input":
      return setInput(state, action);
    case "move-cursor":
      return moveCursor(state, action);
    case "scroll":
      return scrollBy(state, action.delta);
    case "scroll-to-bottom":
      return { ...state, followBottom: true, scrollOffset: 0 };
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
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "input"; text: string; cursor: number }
  | { type: "move-cursor"; delta: number }
  | { type: "scroll"; delta: number }
  | { type: "scroll-to-bottom" };

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
