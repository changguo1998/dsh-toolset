// src/app/state.ts — 状态模型 + 纯 reducer
//
// buffer 持有会话文本行（无界，超出 SCROLLBACK_MAX 裁剪旧行）。
// 滚动状态：followBottom 跟随底部；scrollOffset = 上滚的行单位偏移。

import type {
  ApprovalItem,
  AgentStatus,
  SessionMeta,
  QuestionItem,
  SessionInfo,
  HistoryMessage,
} from "./adapter/dsh.ts";
import type { ModelSelection } from "./adapter/dsh.ts";
import { DEFAULT_THEME, type ThemeId } from "../renderer/theme.ts";

/** scrollback 行数上限（纯物理上限；DESIGN:2000 行） */
export const MAX_BUFFER_LINES = 2000;

/** thinking/reasoning 最大显示行数默认值（可经 initialState 配置，超出折叠） */
export const DEFAULT_THINKING_MAX_LINES = 4;

/** 用户块左缘/回复右缘对称留空默认列数（可经 initialState 配置，交错布局用） */
export const DEFAULT_MESSAGE_GUTTER = 4;

/** 输入栏临时模式（$ shell / / slash；提交后自动回退 normal，不再有 Esc 回退） */
export type InputMode = "normal" | "shell" | "slash";

/** 输入栏状态色：绿=成功等待 / 黄=进行中 / 红=失败等待 */
export type InputStatus = "success" | "running" | "failure";

/** 缓冲行类型:用户输出靠右缩进展示,模型正文靠左;思考行限高,完成后清除 */
export type BufferKind =
  "user" | "assistant" | "thinking" | "notice" | "separator" | "plain";

/** 缓冲行:纯文本 + 类型标记(展示时决定缩进/配色) */
export interface BufferLine {
  text: string;
  kind: BufferKind;
}

export type Buffer = BufferLine[];

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

/** 历史会话面板阶段：列表加载 → 列表 → 会话加载 → 浏览 → 错误（任一阶段可关闭） */
export type HistoryPhase =
  "loading-list" | "list" | "loading-view" | "view" | "resuming" | "error";

/** /history 历史会话面板状态（只读浏览；list 与 view 两阶段） */
export interface HistoryPanelState {
  phase: HistoryPhase;
  /** 会话列表（newest-first；list 阶段填充） */
  records: SessionInfo[];
  /** 列表高亮索引 */
  index: number;
  /** view 阶段浏览的会话 id */
  currentId?: string;
  /** view 阶段归一化消息列表 */
  messages: HistoryMessage[];
  /** view 阶段滚动行偏移（渲染层按可视高度 clamp） */
  scroll: number;
  /** error 阶段错误消息 */
  error?: string;
  /** resume 切换的目标会话 id（resuming 阶段）；成功后清空 */
  pendingResume?: string;
}

export interface AppState {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  /** 会话纯文本行（未换行，展示时才按列宽切分） */
  buffer: Buffer;
  /** 是否跟随底部 */
  followBottom: boolean;
  /** 上滚偏移（行） */
  scrollOffset: number;
  inputText: string;
  inputCursor: number;
  /** 输入模式（符号代表模式；提交后自动回退 normal） */
  inputMode: InputMode;
  /** 上次提交所用模式（提示符左字符符号来源；提交时记录，回退 normal 不影响） */
  lastSubmitMode: InputMode;
  /** 输入状态色（绿=成功等待 / 黄=进行中 / 红=失败等待） */
  inputStatus: InputStatus;
  approval: ApprovalItem | null;
  agentStatus: AgentStatus;
  systemStatus: SystemStatus;
  /** 主题（默认 dark=fffdark；/theme 运行时切换，仅当前会话） */
  themeId: ThemeId;
  /** thinking/reasoning 最大显示行数（渲染折叠用，默认 4） */
  thinkingMaxLines: number;
  /** 用户块左缘/回复右缘对称留空列数（交错布局，默认 4，可配置） */
  messageGutter: number;
  /** 模型交互选择模式（/model 无参进入；null = 未激活） */
  picker: PickerState | null;
  /** 问答面板（userQuestions 提问；null = 未激活） */
  question: QuestionPanelState | null;
  /** /history 历史会话面板（只读浏览 + resume 切换）；null = 未打开 */
  history: HistoryPanelState | null;
  /** 当前会话标题（resume 后由 surface 首条用户消息生成；新会话为（新会话）） */
  sessionTitle: string;
}

/** /model 交互选择面板状态：三列列表（provider/model/effort）+ 高亮索引 */
export interface PickerState {
  /** 去重后的 provider 列表 */
  providers: string[];
  /** provider 列高亮索引 */
  providerIndex: number;
  /** 每个 provider 的模型列表（model 列随 provider 动态调整） */
  providerModels: Record<string, string[]>;
  /** 选中 provider（星号）的模型列表（跟随星号移动，不随 > 焦点切换） */
  models: string[];
  /** model 列高亮索引 */
  modelIndex: number;
  /** 选中模型（星号）的思考等级选项（id/name；非思考模型为空） */
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
/** 选择面板单个选项 */
export interface PickerOption {
  /** 纯 ASCII 展示文本，如 "deepseek/deepseek-chat" */
  label: string;
  /** 确认后应用的模型选择 */
  selection: ModelSelection;
  /** 是否为当前会话模型（行内标记 + 高亮） */
  current: boolean;
}

/** 问答面板单题交互状态 */
export interface QuestionPanelItem {
  id: string;
  question: string;
  /** 待审计划正文（plan-review intent 展示用） */
  detail?: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  intent?: { kind: "plan-review"; approve: string };
  /** 列表高亮索引：0..options.length（=options.length 表示高亮在“自定义回答”兜底项） */
  optionIndex: number;
  /** 已选选项 label（单选最多 1 项；多选可多项） */
  selected: string[];
  /** 自定义回答文本 */
  custom: string;
}

/** 问答面板整体状态（一次 ask() = 一批题；每屏显示一题，第 n/m 题导航） */
export interface QuestionPanelState {
  /** 面板 id（question 事件 id，answerQuestion/cancelQuestion 用它） */
  id: string;
  items: QuestionPanelItem[];
  /** 当前显示题号（0-based） */
  itemIndex: number;
}

export function initialState(
  themeId: ThemeId = DEFAULT_THEME,
  opts?: { thinkingMaxLines?: number; messageGutter?: number },
): AppState {
  const thinkingMaxLines =
    opts?.thinkingMaxLines === undefined
      ? DEFAULT_THINKING_MAX_LINES
      : Math.max(1, Math.floor(opts.thinkingMaxLines));
  const messageGutter =
    opts?.messageGutter === undefined
      ? DEFAULT_MESSAGE_GUTTER
      : Math.max(0, Math.floor(opts.messageGutter));
  return {
    sessions: [],
    activeSessionId: null,
    sessionTitle: "（新会话）",
    buffer: [],
    followBottom: true,
    scrollOffset: 0,
    inputText: "",
    inputCursor: 0,
    inputMode: "normal",
    lastSubmitMode: "normal",
    inputStatus: "success",
    approval: null,
    picker: null,
    question: null,
    history: null,
    agentStatus: "idle",
    themeId,
    systemStatus: {
      time: "—",
      cwd: "—",
      git: "—",
      model: "—",
      contextLen: "—",
      cacheHit: "—",
    },
    thinkingMaxLines,
    messageGutter,
  };
}

/**
 * 追加流式文本。语义：
 *  - 文本中的第一个段落（不含换行符）合并到 buffer 末行（流式续写）
 *  - 换行之后的段落各自新开一行
 *  - 若文本以换行结尾，末尾出现一个空行
 *  - 末行为 turn 分隔线时不合并（分隔线是硬边界，下个 turn 另起一行）
 */
export function appendStream(
  state: AppState,
  text: string,
  kind: BufferKind = "assistant",
): AppState {
  // 正文流先清掉遗留的思考行（思考完成后消失，不留屏外历史）。
  const buffer = (state.buffer.length ? [...state.buffer] : []).filter(
    (l) => kind === "thinking" || l.kind !== "thinking",
  );
  const parts = text.split("\n");
  const lastIndex = buffer.length - 1;
  const last = buffer[lastIndex];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // 首个段落合并进末尾同类行(流式续写)；不合并时不产生中间状态
    if (i === 0 && last && last.kind === kind && last.kind !== "separator") {
      if (part !== "") buffer[lastIndex] = { ...last, text: last.text + part };
    } else {
      buffer.push({ text: part, kind });
    }
  }
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  return { ...state, buffer };
}

/**
 * 追加一条命令通知(notice)：独立成行，不并入 buffer 末行(与流式 append 不同)。
 * 用于 slash 命令的提示/结果文本(绝不进入模型历史，仅 UI 展示)。
 */
export function appendNotice(
  state: AppState,
  text: string,
  error = false,
): AppState {
  // 多行 notice 拆成多行 buffer，否则 wrapLine 把 \n 当普通字符(宽1)会让列宽对不齐，
  // 字词在中间被截断(例如 /quit 在 i 与 t 之间换行)。
  const buffer = state.buffer.length ? [...state.buffer] : [];
  for (const line of text.split("\n"))
    buffer.push({ text: line, kind: "notice" });
  if (buffer.length > MAX_BUFFER_LINES)
    buffer.splice(0, buffer.length - MAX_BUFFER_LINES);
  // 失败标记(error notice，如未知 slash 命令 fail-close)→ 输入栏失败色(红)；
  // agent 仍活跃时保持黄（活跃守卫），绿/红仅空闲时暴露
  return {
    ...state,
    buffer,
    inputStatus: error ? statusFor(state, "failure") : state.inputStatus,
  };
}

/**
 * 追加模型思考行。复用流式续写(并入末尾 thinking 行)语义；正文/turn 结束时
 * 由 appendStream / appendTurnSeparator 统一清除(思考完成后即消失)。
 */
export function appendThinking(state: AppState, text: string): AppState {
  return appendStream(state, text, "thinking");
}

/** 任务进行中(黄)权威：agent 活跃期间不接受绿/红结果覆盖，绿/红仅空闲时暴露 */
function statusFor(state: AppState, fallback: InputStatus): InputStatus {
  return state.agentStatus === "idle" ? fallback : "running";
}

/** 清掉遗留 thinking 行（turn-end 兜底；正文到达时 appendStream 已清） */
export function clearThinkingLines(state: AppState): AppState {
  if (!state.buffer.some((l) => l.kind === "thinking")) return state;
  return {
    ...state,
    buffer: state.buffer.filter((l) => l.kind !== "thinking"),
  };
}

/**
 * turn 开始：清掉上一轮遗留思考行后，在历史末尾追加分隔线，让每个回合之间可见分隔。
 * 空 buffer 或末尾已是分隔线时不追加（避免孤立/重复分隔）。由 `turn-begin` 触发。
 */
export function appendTurnSeparator(state: AppState): AppState {
  let buffer = state.buffer.length ? [...state.buffer] : [];
  buffer = buffer.filter((l) => l.kind !== "thinking");
  if (buffer.length === 0) return { ...state, buffer };
  const last = buffer[buffer.length - 1];
  if (last && last.kind === "separator" && last.text === TURN_SEPARATOR)
    return { ...state, buffer };
  buffer.push({ text: TURN_SEPARATOR, kind: "separator" });
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
    case "user-line":
      return appendStream(state, action.text, "user");
    case "thinking":
      return appendThinking(state, action.text);
    case "notice":
      return appendNotice(state, action.text, action.error);
    case "clear-buffer":
      return clearBuffer(state);
    case "agent-status":
      // 外部活动兜底：thinking/tool 视为进行中(黄)；idle 不改状态色
      return {
        ...setAgentStatus(state, action.status),
        inputStatus:
          action.status === "thinking" || action.status === "tool"
            ? "running"
            : state.inputStatus,
      };
    case "approval":
      return setApproval(state, action.approval);
    case "sessions":
      return setSessions(state, action.sessions);
    case "picker-open":
      // 面板打开保留输入模式；仅真实 Esc（主输入态或关闭面板）才重置为 normal
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
    case "question-open":
      return openQuestion(state, action);
    case "question-move":
      return moveQuestion(state, action);
    case "question-nav":
      return navQuestion(state, action);
    case "question-select":
      return selectQuestionOption(state);
    case "question-custom":
      return setQuestionCustom(state, action.text);
    case "question-close":
      return { ...state, question: null };
    case "history-open":
      return {
        ...state,
        history: {
          phase: "loading-list",
          records: [],
          index: 0,
          messages: [],
          scroll: 0,
        },
      };
    case "history-list":
      // 面板已关闭则丢弃过期结果（异步竞态守卫）
      if (!state.history) return state;
      return {
        ...state,
        history: {
          ...state.history,
          phase: "list",
          records: action.records,
          index: 0,
          error: undefined,
        },
      };
    case "history-list-error":
      if (!state.history) return state;
      return {
        ...state,
        history: { ...state.history, phase: "error", error: action.error },
      };
    case "history-move": {
      if (!state.history || state.history.phase !== "list") return state;
      const hmv = state.history;
      const next = Math.max(
        0,
        Math.min(hmv.records.length - 1, hmv.index + action.delta),
      );
      return { ...state, history: { ...hmv, index: next } };
    }
    case "history-open-view": {
      if (!state.history || state.history.phase !== "list") return state;
      const hov = state.history;
      const rec = hov.records[hov.index];
      if (!rec) return state;
      return {
        ...state,
        history: { ...hov, phase: "loading-view", currentId: rec.id },
      };
    }
    case "history-view":
      if (!state.history || state.history.phase !== "loading-view")
        return state;
      return {
        ...state,
        history: {
          ...state.history,
          phase: "view",
          currentId: action.id,
          messages: action.messages,
          scroll: 0,
          error: undefined,
        },
      };
    case "history-view-error":
      if (!state.history || state.history.phase !== "loading-view")
        return state;
      return {
        ...state,
        history: { ...state.history, phase: "error", error: action.error },
      };
    case "history-scroll": {
      if (!state.history || state.history.phase !== "view") return state;
      const hsc = state.history;
      return {
        ...state,
        history: { ...hsc, scroll: Math.max(0, hsc.scroll + action.delta) },
      };
    }
    case "history-back": {
      if (!state.history || state.history.phase !== "view") return state;
      const hbk = state.history;
      return {
        ...state,
        history: {
          ...hbk,
          phase: "list",
          currentId: undefined,
          messages: [],
          scroll: 0,
        },
      };
    }
    case "history-resume":
      return state.history
        ? {
            ...state,
            history: {
              ...state.history,
              phase: "resuming",
              pendingResume: action.id,
              error: undefined,
            },
          }
        : state;
    case "history-resume-error":
      // 会话陈旧则丢弃（面板已关闭/已切换目标）
      if (
        !state.history ||
        state.history.phase !== "resuming" ||
        state.history.pendingResume !== action.id
      ) {
        return state;
      }
      return {
        ...state,
        history: {
          ...state.history,
          phase: "error",
          error: action.error,
          pendingResume: undefined,
        },
      };
    case "history-resume-ok":
      // 会话陈旧则丢弃（面板已关闭/已切换目标）
      if (
        !state.history ||
        state.history.phase !== "resuming" ||
        state.history.pendingResume !== action.id
      ) {
        return state;
      }
      return {
        ...state,
        activeSessionId: action.id,
        sessionTitle: action.title,
        history: null,
        buffer: action.rows as BufferLine[],
        followBottom: true,
        scrollOffset: 0,
      };
    case "history-close":
      return { ...state, history: null };
    case "session-identify":
      return {
        ...state,
        activeSessionId: action.id,
        sessionTitle: action.title,
      };
    case "input":
      return setInput(state, action);
    case "input-mode":
      return { ...state, inputMode: action.mode };
    case "last-submit-mode":
      return { ...state, lastSubmitMode: action.mode };
    case "input-status":
      // 活跃守卫：agent 非 idle 时绿/红结果不暴露（压回黄），空闲后才显示结果色
      return { ...state, inputStatus: statusFor(state, action.status) };
    case "move-cursor":
      return moveCursor(state, action);
    case "scroll":
      return scrollBy(state, action.delta);
    case "scroll-to-bottom":
      return { ...state, followBottom: true, scrollOffset: 0 };
    case "turn-begin":
      // 回合开始：先画分隔线(空历史/已画则跳过)，再进入新回合内容
      return appendTurnSeparator(state);
    case "turn-end":
      // 回合结束：不再画分隔线(下个回合 begin 时画)；清遗留思考行(兜底)；置成功色(绿)
      return { ...clearThinkingLines(state), inputStatus: "success" };
    case "status":
      return setSystemStatus(state, action.status);
    case "set-theme":
      return { ...state, themeId: action.themeId };
    default:
      return state;
  }
}

export type StateAction =
  | { type: "append"; text: string }
  | { type: "user-line"; text: string }
  | { type: "thinking"; text: string }
  | { type: "notice"; text: string; error?: boolean }
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
  | { type: "question-open"; id: string; questions: QuestionItem[] }
  | { type: "question-move"; delta: 1 | -1 }
  | { type: "question-nav"; delta: 1 | -1 }
  | { type: "question-select" }
  | { type: "question-custom"; text: string }
  | { type: "question-close" }
  | { type: "history-open" }
  | { type: "history-list"; records: SessionInfo[] }
  | { type: "history-list-error"; error: string }
  | { type: "history-move"; delta: number }
  | { type: "history-open-view" }
  | { type: "history-view"; id: string; messages: HistoryMessage[] }
  | { type: "history-view-error"; error: string }
  | { type: "history-resume"; id: string }
  | { type: "history-resume-error"; id: string; error: string }
  | {
      type: "history-resume-ok";
      id: string;
      title: string;
      rows: { text: string; kind: "user" | "assistant" }[];
    }
  | { type: "history-scroll"; delta: number }
  | { type: "history-back" }
  | { type: "history-close" }
  | { type: "session-identify"; id: string; title: string }
  | { type: "sessions"; sessions: SessionMeta[] }
  | { type: "input"; text: string; cursor: number }
  | { type: "input-mode"; mode: InputMode }
  | { type: "last-submit-mode"; mode: InputMode }
  | { type: "input-status"; status: InputStatus }
  | { type: "move-cursor"; delta: number }
  | { type: "scroll"; delta: number }
  | { type: "scroll-to-bottom" }
  | { type: "turn-begin" }
  | { type: "turn-end" }
  | { type: "status"; status: Partial<SystemStatus> }
  | { type: "set-theme"; themeId: ThemeId };

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
    // model 列跟随星号（selectedProvider），不随 > 焦点切换（见 selectPicker）
    return { ...state, picker: { ...picker, providerIndex: pi } };
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
    if (v === picker.selectedProvider) {
      // 幂等：重选同一 provider 不重置 model/思考等级列
      return { ...state, picker: { ...picker, selectedProvider: v } };
    }
    // 星号移到新 provider：model 列跟随选中 provider，旧 model 选中失效
    // （effort 列表由 App 重载；思考等级星号保留，新列表中存在才显示）
    const models = picker.providerModels[v] ?? [];
    return {
      ...state,
      picker: {
        ...picker,
        selectedProvider: v,
        models,
        modelIndex: 0,
        selectedModel: undefined,
        efforts: [],
        effortIndex: 0,
      },
    };
  }
  if (picker.phase === 1) {
    const v = picker.models[picker.modelIndex];
    if (!v) return state;
    // 思考等级星号保留（跨模型沿用，如当前 reasoningEffort），effort 列表由 App 重载
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

/** 打开问答面板：把一次 ask() 的整批题转为交互状态（无题则不变） */
function openQuestion(
  state: AppState,
  action: { type: "question-open"; id: string; questions: QuestionItem[] },
): AppState {
  if (action.questions.length === 0) return state;
  const items: QuestionPanelItem[] = action.questions.map((q) => ({
    id: q.id,
    question: q.question,
    header: q.header,
    detail: q.detail,
    options: q.options ?? [],
    multiSelect: q.multiSelect ?? false,
    intent: q.intent
      ? { kind: "plan-review", approve: q.intent.approve }
      : undefined,
    optionIndex: 0,
    selected: [],
    custom: "",
  }));
  // 移除 unused first 引用（自定义兑底项始终存在，列表总长度 = options.length + 1）
  return {
    ...state,
    question: {
      id: action.id,
      items,
      itemIndex: 0,
    },
  };
}

/** 列表高亮移动：↑/↓ 在 0..options.length（末位为“自定义回答”兑底项）内 clamp */
function moveQuestion(
  state: AppState,
  action: { type: "question-move"; delta: 1 | -1 },
): AppState {
  const panel = state.question;
  if (!panel) return state;
  const item = panel.items[panel.itemIndex];
  if (!item) return state;
  const max = item.options.length; // 末位 = 自定义兑底项
  const next = Math.max(0, Math.min(item.optionIndex + action.delta, max));
  if (next === item.optionIndex) return state;
  const items = [...panel.items];
  items[panel.itemIndex] = { ...item, optionIndex: next };
  return { ...state, question: { ...panel, items } };
}

/** 第 n/m 题导航：左右切换题目（clamp 不循环），每题重置于列表首项 */
function navQuestion(
  state: AppState,
  action: { type: "question-nav"; delta: 1 | -1 },
): AppState {
  const panel = state.question;
  if (!panel) return state;
  const next = Math.max(
    0,
    Math.min(panel.itemIndex + action.delta, panel.items.length - 1),
  );
  if (next === panel.itemIndex) return state;
  const items = [...panel.items];
  items[next] = { ...items[next]!, optionIndex: 0 };
  return { ...state, question: { ...panel, itemIndex: next, items } };
}

/** 选中/取消选中高亮选项：单选替换（同时清掉自定义文本，二选一互斥）、多选 toggle */
function selectQuestionOption(state: AppState): AppState {
  const panel = state.question;
  if (!panel) return state;
  const items = [...panel.items];
  const item = items[panel.itemIndex];
  if (!item) return state;
  const label = item.options[item.optionIndex]?.label;
  if (!label) return state; // 高亮在自定义兑底项（无 label）时空格无效
  items[panel.itemIndex] = item.multiSelect
    ? {
        ...item,
        selected: item.selected.includes(label)
          ? item.selected.filter((s) => s !== label)
          : [...item.selected, label],
      }
    : { ...item, selected: [label], custom: "" }; // 单选选预设即覆盖自定义
  return { ...state, question: { ...panel, items } };
}

/** 自定义回答文本（每次键入全量替换）；单选时输入会清空已选预设（二选一互斥） */
function setQuestionCustom(state: AppState, text: string): AppState {
  const panel = state.question;
  if (!panel) return state;
  const items = [...panel.items];
  const item = items[panel.itemIndex];
  if (!item) return state;
  items[panel.itemIndex] = item.multiSelect
    ? { ...item, custom: text }
    : { ...item, custom: text, selected: text === "" ? item.selected : [] };
  return { ...state, question: { ...panel, items } };
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
