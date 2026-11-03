// src/app/state/reducer-panel.ts — 纯 reducer 分组：面板与弹窗

import type { AppState } from "./types.ts";
import {
  focusApproval,
  setApproval,
  setApprovalHint,
  setSessions,
  toggleApprovalWindow,
  statusFor,
} from "./updates.ts";
import type { StateAction } from "./actions.ts";
import {
  fillFileCompletion,
  filterPicker,
  focusQuestionWindow,
  moveCompletion,
  moveCustomCaret,
  movePicker,
  moveQuestion,
  moveStatusPanel,
  navQuestion,
  openQuestion,
  phasePicker,
  recomputeCompletion,
  scrollApproval,
  scrollQuestionDesc,
  selectPicker,
  selectQuestionOption,
  selectStatusPanel,
  setPickerEfforts,
  setQuestionCustom,
  tabPicker,
} from "./panels.ts";

export function reducePanel(
  state: AppState,
  action: StateAction,
): AppState | undefined {
  switch (action.type) {
    case "approval":
      return setApproval(state, action.approval, action.deadline ?? null);
    case "approval-focus":
      return focusApproval(state, action.focus);
    case "approval-tab":
      return toggleApprovalWindow(state);
    case "approval-no-timeout":
      // 用户已操作 → 隐藏倒计时（BACKLOG 3.3.5；真正的计时停止在 adapter 侧）
      return state.approval && state.approvalDeadline !== null
        ? { ...state, approvalDeadline: null }
        : state;
    case "approval-hint":
      return setApprovalHint(state, action.text);
    case "sessions":
      return setSessions(state, action.sessions);
    case "picker-open":
      // 面板打开保留输入模式；仅真实 Esc（主输入态或关闭面板）才重置为默认 steer
      return { ...state, picker: action.picker };
    case "picker-move":
      return movePicker(state, action);
    case "picker-tab":
      return tabPicker(state);
    case "picker-phase":
      return phasePicker(state, action);
    case "picker-select":
      return selectPicker(state);
    case "picker-filter":
      return filterPicker(state, action);
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
    case "status-panel-open":
      return { ...state, statusPanel: action.panel };
    case "status-panel-move":
      return moveStatusPanel(state, action);
    case "status-panel-select":
      return selectStatusPanel(state);
    case "status-panel-close":
      return { ...state, statusPanel: null };
    case "completion-move":
      return moveCompletion(state, action);
    case "completion-close":
      return { ...state, completion: null };
    case "completion-data":
      return fillFileCompletion(state, action);
    case "file-mention-available":
      return { ...state, fileMentionAvailable: action.available };
    case "command-catalog":
      return {
        ...state,
        registryCommands: action.commands,
        completion: recomputeCompletion(
          { ...state, registryCommands: action.commands },
          state.inputText,
          state.inputCursor,
          state.inputMode,
        ),
      };
    case "question-open":
      return openQuestion(state, action);
    case "question-move":
      return moveQuestion(state, action);
    case "question-nav":
      return navQuestion(state, action);
    case "question-select":
      return selectQuestionOption(state);
    case "question-custom":
      return setQuestionCustom(state, action.text, action.caret ?? null);
    case "custom-caret":
      return moveCustomCaret(state, action.delta);
    case "question-focus":
      return focusQuestionWindow(state);
    case "question-desc-scroll":
      return scrollQuestionDesc(state, action.delta, action.max);
    case "approval-scroll":
      return scrollApproval(state, action.delta, action.max);
    case "question-close": {
      // 关闭问答面板：按 agent 活跃度恢复（运行中/上次结果），不再等待交互
      const next = { ...state, question: null };
      return { ...next, inputStatus: statusFor(next, "success") };
    }
    case "approval-policy":
      // C 阶段：当前审批策略按 sessionId latest-wins（approval/policy 事件源=宿主 setPolicy）；
      // 无对应会话事件时保留旧值（切会话读对应 policyBySession 键）
      return {
        ...state,
        policyBySession: {
          ...state.policyBySession,
          [action.sessionId]: action.policy,
        },
      };
    case "jobs-panel-open":
      return { ...state, jobsPanel: { index: 0 } };
    case "jobs-panel-move": {
      // 上下移动高亮行（clamp 到列表范围）
      const size = state.jobs.length;
      if (size === 0) return state;
      const index = Math.max(
        0,
        Math.min(size - 1, action.focus + action.delta),
      );
      return { ...state, jobsPanel: { index } };
    }
    case "jobs-panel-page": {
      // PgUp/PgDn 整页移动（页高由调用方按活动区可视行数给出；与 command-panel-page 同口径）
      const size = state.jobs.length;
      if (size === 0 || !state.jobsPanel) return state;
      const step = Math.max(1, action.page) * action.delta;
      const index = Math.max(
        0,
        Math.min(size - 1, state.jobsPanel.index + step),
      );
      return { ...state, jobsPanel: { index } };
    }
    case "jobs-panel-close":
      return { ...state, jobsPanel: null };
    case "command-panel-open":
      // 打开共享列表面板：先置 loading，数据经 command-panel-data 到达后填充
      return {
        ...state,
        commandPanel: {
          kind: action.kind,
          index: 0,
          rows: [],
          loading: true,
        },
      };
    case "command-panel-move": {
      const panel = state.commandPanel;
      if (!panel || panel.rows.length === 0) return state;
      const index = Math.max(
        0,
        Math.min(panel.rows.length - 1, panel.index + action.delta),
      );
      return { ...state, commandPanel: { ...panel, index } };
    }
    case "command-panel-page": {
      // PgUp/PgDn 整页移动（页高由调用方按活动区可视行数给出）
      const panel = state.commandPanel;
      if (!panel || panel.rows.length === 0) return state;
      const step = Math.max(1, action.page) * action.delta;
      const index = Math.max(
        0,
        Math.min(panel.rows.length - 1, panel.index + step),
      );
      return { ...state, commandPanel: { ...panel, index } };
    }
    case "command-panel-close":
      return { ...state, commandPanel: null };
    case "command-panel-data": {
      // 数据 last-write-wins：仅当前面板 kind 一致时写入（挡迟到数据覆盖新面板）
      const panel = state.commandPanel;
      if (!panel || panel.kind !== action.kind) return state;
      return {
        ...state,
        commandPanel: {
          kind: panel.kind,
          index: Math.max(
            0,
            Math.min(panel.index, Math.max(0, action.rows.length - 1)),
          ),
          rows: action.rows,
          ...(action.error === undefined ? {} : { error: action.error }),
        },
      };
    }
    default:
      return undefined;
  }
}
