// TUI/src/app/state/panels.ts — 面板 / 输入历史 / 滚动 的 action 实现

import type { QuestionItem } from "../adapter/dsh.ts";
import {
  pickerFilterColumn,
  pickerFilterText,
  pickerVisibleModels,
  pickerVisibleProviders,
} from "../picker-filter.ts";
import { activeAtToken } from "../file-mention.ts";
import { completeCommandInput } from "../commands.ts";
import type {
  AppState,
  CompletionState,
  InputHistoryEntry,
  InputMode,
  QuestionPanelItem,
} from "./types.ts";
import type { StateAction } from "./actions.ts";

// TUI/src/app/state/panels.ts — 面板 / 输入历史 / 滚动 的 action 实现

export function recomputeCompletion(
  state: AppState,
  text: string,
  cursor: number,
  mode: InputMode,
): CompletionState | null {
  const command = completeCommandInput(text, state.registryCommands, mode);
  if (command) {
    return { kind: "command", items: command.items, index: command.index };
  }
  if (
    !state.fileMentionAvailable ||
    (mode !== "steer" && mode !== "followup")
  ) {
    return null;
  }
  const token = activeAtToken(text, cursor);
  if (!token) return null;
  return { kind: "file", items: [], index: 0, token };
}

/**
 * 文件候选回填（异步）：只认**仍是同一 token** 的回填——请求期间用户继续输入（token
 * 变化）或已切到命令候选 / 收起面板时，迟到的结果直接丢弃，面板内容恒与当前 token 一致。
 */
export function fillFileCompletion(
  state: AppState,
  action: Extract<StateAction, { type: "completion-data" }>,
): AppState {
  const c = state.completion;
  if (!c || c.kind !== "file") return state;
  if (
    c.token.prefix !== action.token.prefix ||
    c.token.query !== action.token.query ||
    c.token.quoted !== action.token.quoted
  ) {
    return state;
  }
  return { ...state, completion: { ...c, items: action.items, index: 0 } };
}

export function setInput(
  state: AppState,
  action: Extract<StateAction, { type: "input" }>,
): AppState {
  const cursor = Math.max(0, Math.min(action.cursor, action.text.length));
  // 输入变更的单一漏斗点：候选随文本同步重算（非命令 token 输入自动得到 null → 面板收起）
  // 输入历史（TUI#34）：用户手动编辑 → 退出翻看态（游标归零），
  // 并把编辑后的文本存为**新草稿**，保证下一次 ↑ 仍能回到它（不丢用户正在写的内容）
  return {
    ...state,
    inputText: action.text,
    inputCursor: cursor,
    inputHistoryCursor: 0,
    inputHistoryDraft: action.text,
    inputHistoryDraftMode: state.inputMode,
    completion: recomputeCompletion(
      state,
      action.text,
      cursor,
      state.inputMode,
    ),
  };
}

/** 输入历史上限（超出丢最旧）。200 条对进程内数组无感知成本。 */
const INPUT_HISTORY_MAX = 200;

/** 是否处于输入历史翻看态（显式给游标：App 侧按键分派用「下一游标」判定，避免提前改状态）。 */
export function isInputHistoryBrowseAt(
  state: AppState,
  cursor: number,
): boolean {
  return state.inputHistory.length > 0 && cursor > 0;
}

/** 提交入栈：空串不入栈、与栈顶完全相同（文本 + 模式）不入栈、超上限丢最旧（原数组不改）。 */
export function inputHistoryPush(
  history: readonly InputHistoryEntry[],
  entry: InputHistoryEntry,
): readonly InputHistoryEntry[] {
  if (entry.text === "") return history;
  const last = history[history.length - 1];
  if (
    last !== undefined &&
    last.text === entry.text &&
    last.mode === entry.mode
  )
    return history;
  const next = [...history, entry];
  return next.length > INPUT_HISTORY_MAX
    ? next.slice(next.length - INPUT_HISTORY_MAX)
    : next;
}

/**
 * 输入历史 reducer（BACKLOG TUI#34）：
 * - push：提交时入栈（空串 / 相邻重复不入栈），并复位翻看态（游标归零、草稿清空）；
 * - prev：上翻（进入翻看时先保存当前草稿**与其模式**）；到最早一条停住（游标夹到长度）；
 * - next：下翻；越过最新条目 → 退出翻看并**恢复进入前的草稿与模式**。
 *
 * **模式随条目恢复**（真机缺陷修复 2026-09-27）：条目保存提交时的 `InputMode`，回溯时
 * 一并写回 `inputMode`——否则 `/agents` 这类 slash 提交回溯后变成普通输入
 * （提示符 `>` + 文本 `agents`，提交语义也变了）；`$` shell、`<` steer 同理。
 * 输入区文本与游标同步更新（文本尾 = 光标位），候选按「新文本 + 新模式」重算。
 */
export function reduceInputHistory(
  state: AppState,
  action: Extract<StateAction, { type: "input-history" }>,
): AppState {
  /** 恢复一条历史（文本 + 模式）或草稿；游标置 0 表示退出翻看 */
  const restore = (
    inputText: string,
    inputMode: InputMode,
    inputHistoryCursor: number,
  ): AppState => {
    const inputCursor = inputText.length;
    return {
      ...state,
      inputText,
      inputCursor,
      inputMode,
      inputHistoryCursor,
      completion: recomputeCompletion(state, inputText, inputCursor, inputMode),
    };
  };
  if (action.action === "push") {
    return {
      ...state,
      inputHistory: inputHistoryPush(state.inputHistory, {
        text: state.inputText.trim(),
        mode: state.inputMode,
      }),
      inputHistoryCursor: 0,
      inputHistoryDraft: "",
      inputHistoryDraftMode: "steer",
    };
  }
  const len = state.inputHistory.length;
  if (len === 0) return state;
  const cur = state.inputHistoryCursor;
  if (action.action === "prev") {
    const target = Math.min(cur + 1, len);
    const entry = state.inputHistory[len - target]!;
    const firstEnter = cur === 0;
    return {
      ...restore(entry.text, entry.mode, target),
      inputHistoryDraft: firstEnter ? state.inputText : state.inputHistoryDraft,
      inputHistoryDraftMode: firstEnter
        ? state.inputMode
        : state.inputHistoryDraftMode,
    };
  }
  // next（下翻）
  if (cur === 0) return state; // 已不在翻看态
  const target = cur - 1;
  if (target === 0) {
    // 回到最新条目之下 → 恢复进入前的草稿（文本 + 模式）并退出翻看
    return restore(state.inputHistoryDraft, state.inputHistoryDraftMode, 0);
  }
  const entry = state.inputHistory[len - target]!;
  return {
    ...restore(entry.text, entry.mode, target),
    inputHistoryDraft: state.inputHistoryDraft,
    inputHistoryDraftMode: state.inputHistoryDraftMode,
  };
}

export function moveCursor(
  state: AppState,
  action: Extract<StateAction, { type: "move-cursor" }>,
): AppState {
  const cursor = Math.max(
    0,
    Math.min(state.inputCursor + action.delta, state.inputText.length),
  );
  return { ...state, inputCursor: cursor };
}

/** statusPanel 焦点移动：在选项内 clamp（↑/↓）。 */
export function moveStatusPanel(
  state: AppState,
  action: Extract<StateAction, { type: "status-panel-move" }>,
): AppState {
  const p = state.statusPanel;
  if (!p || p.options.length === 0) return state;
  const index = Math.max(
    0,
    Math.min(p.options.length - 1, p.index + action.delta),
  );
  if (index === p.index) return state;
  return { ...state, statusPanel: { ...p, index } };
}

/** 命令补全面板焦点移动：在可视候选数内 clamp（↑/↓，不循环；max=回合区可容纳的候选数） */
export function moveCompletion(
  state: AppState,
  action: Extract<StateAction, { type: "completion-move" }>,
): AppState {
  const c = state.completion;
  if (!c || c.items.length === 0) return state;
  const visible = Math.max(
    1,
    Math.min(c.items.length, action.max ?? c.items.length),
  );
  const index = Math.max(0, Math.min(c.index + action.delta, visible - 1));
  return { ...state, completion: { ...c, index } };
}

/** statusPanel 空格预选：焦点行 id 写入 selected（同值再按取消）；避免误提交。 */
export function selectStatusPanel(state: AppState): AppState {
  const p = state.statusPanel;
  if (!p || p.options.length === 0) return state;
  const id = p.options[p.index]!.id;
  const selected = p.selected === id ? null : id;
  return { ...state, statusPanel: { ...p, selected } };
}

/**
 * picker 高亮移动：在 0..options.length-1 内 clamp（上下键导航）。
 */
export function movePicker(
  state: AppState,
  action: Extract<StateAction, { type: "picker-move" }>,
): AppState {
  const picker = state.picker;
  if (!picker) return state;
  // 分区各自的列表独立 clamp：
  // phase0=provider 列, phase1=model 列, phase2=thinking 列
  // 前两列按**可见列表**（筛选排序后）clamp —— 与渲染同源, 见 picker-filter.ts
  if (picker.phase === 0) {
    const providers = pickerVisibleProviders(picker);
    if (providers.length === 0) return state;
    const pi = Math.max(
      0,
      Math.min(picker.providerIndex + action.delta, providers.length - 1),
    );
    if (pi === picker.providerIndex) return state;
    // model 列跟随星号（selectedProvider），不随 > 焦点切换（见 selectPicker）
    return { ...state, picker: { ...picker, providerIndex: pi } };
  }
  if (picker.phase === 1) {
    const models = pickerVisibleModels(picker);
    if (models.length === 0) return state;
    const mi = Math.max(
      0,
      Math.min(picker.modelIndex + action.delta, models.length - 1),
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
export function selectPicker(state: AppState): AppState {
  const picker = state.picker;
  if (!picker) return state;
  if (picker.phase === 0) {
    const v = pickerVisibleProviders(picker)[picker.providerIndex];
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
    const v = pickerVisibleModels(picker)[picker.modelIndex];
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

/**
 * 筛选词整体替换（当前焦点列）：词变 → 可见列表变 → 焦点行按**值**保持
 * （原焦点项仍在可见列表内则跟随其新下标, 否则回落 0 = 匹配度最高项）；
 * 星号选中不动（筛选只改显示与焦点, Enter 语义不变）。effort 列不筛 → 无操作。
 */
export function filterPicker(
  state: AppState,
  action: Extract<StateAction, { type: "picker-filter" }>,
): AppState {
  const picker = state.picker;
  if (!picker) return state;
  const col = pickerFilterColumn(picker.phase);
  if (!col) return state;
  if (pickerFilterText(picker) === action.text) return state;
  if (col === "provider") {
    const before = pickerVisibleProviders(picker)[picker.providerIndex];
    const next = { ...picker, providerFilter: action.text };
    const at =
      before === undefined ? -1 : pickerVisibleProviders(next).indexOf(before);
    return { ...state, picker: { ...next, providerIndex: at >= 0 ? at : 0 } };
  }
  const before = pickerVisibleModels(picker)[picker.modelIndex];
  const next = { ...picker, modelFilter: action.text };
  const at =
    before === undefined ? -1 : pickerVisibleModels(next).indexOf(before);
  return { ...state, picker: { ...next, modelIndex: at >= 0 ? at : 0 } };
}

/** Tab 循环切换三列焦点区（efforts 为空时切到 thinking 列仍为灰色提示） */
export function tabPicker(state: AppState): AppState {
  const picker = state.picker;
  if (!picker) return state;
  const phase = ((picker.phase + 1) % 3) as 0 | 1 | 2;
  return { ...state, picker: { ...picker, phase, effortIndex: 0 } };
}

/** 左右方向键切换三列焦点区（clamp 不循环：左到头/右到尾保持不动） */
export function phasePicker(
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
export function setPickerEfforts(
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

/** 兜底项语义标记（BACKLOG TUI#5）：选项文案命中即并入「自定义回答」。
 *  TUI 不调模型，只做可判定规则；对提问方的约定见 TUI/docs/SPEC.md（§7 问答面板）。 */
const FALLBACK_OPTION_MARKERS = [
  "自定义",
  "其它",
  "其他",
  "例外",
  "以上都不是",
  "都不对",
] as const;

/** 是否为兜底类选项（标签命中语义标记；纯函数，供归一与单测共用）。 */
export function isFallbackOption(label: string): boolean {
  return FALLBACK_OPTION_MARKERS.some((m) => label.includes(m));
}

/** 打开问答面板：把一次 ask() 的整批题转为交互状态（无题则不变）。
 *  TUI#5：兜底类预设（「其它」等）并入「自定义回答」——从预设列表摘除（不再作为
 *  可标记项、也无空回退选中），原文记为自定义项解释文字（`customHint`），
 *  须输入文字才算作答；无命中时列表与行为不变。 */
export function openQuestion(
  state: AppState,
  action: {
    type: "question-open";
    id: string;
    questions: QuestionItem[];
    /** 问题前正文（3.2.10；缺省空串 = 不显示来源段） */
    source?: string | undefined;
  },
): AppState {
  if (action.questions.length === 0) return state;
  const items: QuestionPanelItem[] = action.questions.map((q) => {
    const raw = q.options ?? [];
    const merged = raw.filter((o) => isFallbackOption(o.label));
    return {
      id: q.id,
      question: q.question,
      header: q.header,
      detail: q.detail,
      options: raw.filter((o) => !isFallbackOption(o.label)),
      ...(merged.length === 0
        ? {}
        : {
            customHint: merged
              .map((o) =>
                o.description ? `${o.label}（${o.description}）` : o.label,
              )
              .join("、"),
          }),
      multiSelect: q.multiSelect ?? false,
      intent: q.intent
        ? { kind: "plan-review", approve: q.intent.approve }
        : undefined,
      optionIndex: 0,
      selected: [],
      custom: "",
      // 焦点窗缺省 options：与分窗前 ↑/↓ 直接移项的既有手感一致（BACKLOG 3.2.1）
      focus: "options",
      descScroll: 0,
    };
  });
  // 移除 unused first 引用（自定义兑底项始终存在，列表总长度 = options.length + 1）
  return {
    ...state,
    question: {
      id: action.id,
      items,
      itemIndex: 0,
      // 问题前正文（3.2.10）：面板期间展示在描述窗顶部，来源由 App 从节模型取
      // （`lastTextOfSources`，条目 7 选项 1）
      source: action.source ?? "",
    },
    // 问答面板打开 = 等待用户决策（黄△）
    inputStatus: "waiting",
  };
}

/** Tab 切焦点窗（BACKLOG 3.2.1）：desc <-> options，按题独立记忆 */
export function focusQuestionWindow(state: AppState): AppState {
  const panel = state.question;
  if (!panel) return state;
  const item = panel.items[panel.itemIndex];
  if (!item) return state;
  const items = [...panel.items];
  items[panel.itemIndex] = {
    ...item,
    focus: item.focus === "desc" ? "options" : "desc",
  };
  return { ...state, question: { ...panel, items } };
}

/** 描述窗逐行滚动（↑/↓，焦点在描述窗时）：clamp 到 [0, max]（max 由 App 按折行算定） */
export function scrollQuestionDesc(
  state: AppState,
  delta: 1 | -1,
  max: number,
): AppState {
  const panel = state.question;
  if (!panel) return state;
  const item = panel.items[panel.itemIndex];
  if (!item) return state;
  const next = Math.max(0, Math.min(item.descScroll + delta, Math.max(0, max)));
  if (next === item.descScroll) return state;
  const items = [...panel.items];
  items[panel.itemIndex] = { ...item, descScroll: next };
  return { ...state, question: { ...panel, items } };
}

/** 审批描述窗逐行滚动（BACKLOG 3.2.1；max 由 App 按折行算定） */
export function scrollApproval(
  state: AppState,
  delta: 1 | -1,
  max: number,
): AppState {
  const next = Math.max(
    0,
    Math.min(state.approvalScroll + delta, Math.max(0, max)),
  );
  if (next === state.approvalScroll) return state;
  return { ...state, approvalScroll: next };
}

/** 列表高亮移动：↑/↓ 在 0..options.length（末位为“自定义回答”兑底项）内 clamp */
export function moveQuestion(
  state: AppState,
  action: { type: "question-move"; delta: number },
): AppState {
  const panel = state.question;
  if (!panel) return state;
  const item = panel.items[panel.itemIndex];
  if (!item) return state;
  const max = item.options.length; // 末位 = 自定义兑底项
  const next = Math.max(0, Math.min(item.optionIndex + action.delta, max));
  if (next === item.optionIndex) return state;
  const items = [...panel.items];
  // 移项即离开自定义项编辑：退出编辑态（TUI#35；custom 文本保留，仅光标消失）
  items[panel.itemIndex] = { ...item, optionIndex: next, customCaret: null };
  return { ...state, question: { ...panel, items } };
}

/** 第 n/m 题导航：左右切换题目（clamp 不循环），每题重置于列表首项 */
export function navQuestion(
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

/** 标记/取消标记高亮选项（空格）：单选替换（同时清掉自定义文本，二选一互斥）、多选 toggle */
export function selectQuestionOption(state: AppState): AppState {
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
    : { ...item, selected: [label], custom: "", customCaret: null }; // 单选选预设即覆盖自定义
  return { ...state, question: { ...panel, items } };
}

/** 自定义回答文本 + 编辑光标（BACKLOG TUI#35：在光标处插入/删除；null = 未编辑态）。
 *  单选时输入会清空已选预设（二选一互斥）。 */
export function setQuestionCustom(
  state: AppState,
  text: string,
  caret: number | null,
): AppState {
  const panel = state.question;
  if (!panel) return state;
  const items = [...panel.items];
  const item = items[panel.itemIndex];
  if (!item) return state;
  items[panel.itemIndex] = item.multiSelect
    ? { ...item, custom: text, customCaret: caret }
    : {
        ...item,
        custom: text,
        customCaret: caret,
        selected: text === "" ? item.selected : [],
      };
  return { ...state, question: { ...panel, items } };
}

/** 自定义回答光标左右移动（BACKLOG TUI#35）：仅编辑态生效（未编辑态由按键路由切题），
 *  越界 clamp 后无变化即返回原状态。 */
export function moveCustomCaret(state: AppState, delta: 1 | -1): AppState {
  const panel = state.question;
  if (!panel) return state;
  const item = panel.items[panel.itemIndex];
  if (!item || item.customCaret === undefined || item.customCaret === null)
    return state;
  const caret = Array.from(item.custom).length;
  const next = Math.min(Math.max(item.customCaret + delta, 0), caret);
  if (next === item.customCaret) return state;
  const items = [...panel.items];
  items[panel.itemIndex] = { ...item, customCaret: next };
  return { ...state, question: { ...panel, items } };
}

/**
 * 按 delta 滚动：正数上滚（delta>0 暂停跟随），负数下滚；滚回底部恢复跟随。
 * scrollOffset 语义 = 距底部多少行。
 *
 * `maxOffset` 为当前内容/窗口下真正可滚动的上限（App 从上一帧 FrameScrollReport 取）。
 * 偏移必须收敛到它：渲染层只做显示侧 clamp，状态里若留着越界偏移（连续上滚越顶、
 * `End` 跳到顶部、窗口变高/内容变短），此后下滚要先"还债"——按了没反应，看起来假死。
 * 因此这里先收敛当前偏移再叠加 delta；缺省无上限（调用方未提供时行为不变）。
 */
export function scrollBy(
  state: AppState,
  delta: number,
  maxOffset: number = Number.MAX_SAFE_INTEGER,
): AppState {
  const cur = Math.min(state.scrollOffset, Math.max(0, maxOffset));
  if (delta > 0) {
    return {
      ...state,
      followBottom: false,
      scrollOffset: Math.min(cur + delta, Math.max(0, maxOffset)),
    };
  }
  const next = Math.max(0, cur + delta);
  return {
    ...state,
    scrollOffset: next,
    followBottom: next === 0 ? true : state.followBottom,
  };
}
