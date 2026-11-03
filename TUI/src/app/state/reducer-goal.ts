// src/app/state/reducer-goal.ts — 纯 reducer 分组：目标、待办与目录刷新

import type { AppState, GoalEntry, GoalHistory } from "./types.ts";
import type { StateAction } from "./actions.ts";

export function reduceGoal(
  state: AppState,
  action: StateAction,
): AppState | undefined {
  switch (action.type) {
    case "goal-change": {
      // P2：goal 累积为会话历史（index 0 = 当前）——create/未知 id 入栈；edit/pause/
      // resume/complete/block 按 id 原位更新；clear 出栈（墓碑只带 ref，不再展示）
      const prev = state.goalBySession[action.sessionId] ?? [];
      let next: GoalHistory;
      if (action.operation === "clear") {
        next = prev.filter((e) => e.goal.id !== action.cleared.id);
      } else {
        const entry: GoalEntry = {
          operation: action.operation,
          goal: action.goal,
          ...(action.roundsStarted === undefined
            ? {}
            : { roundsStarted: action.roundsStarted }),
          ...(action.createdAt === undefined
            ? {}
            : { createdAt: action.createdAt }),
          ...(action.updatedAt === undefined
            ? {}
            : { updatedAt: action.updatedAt }),
        };
        const at = prev.findIndex((e) => e.goal.id === action.goal.id);
        next =
          at < 0
            ? [entry, ...prev]
            : prev.map((e, i) => (i === at ? entry : e));
      }
      return {
        ...state,
        goalBySession: { ...state.goalBySession, [action.sessionId]: next },
      };
    }
    case "goal-activation": {
      // goal 自动续轮开关：只存**原始边**（展示值直取**原始边**，不推导、不按相位门控——宿主在
      // 同一次提交里先发 activation 边、后发 goal/change，若在此落推导结果会丢边）。
      // 无 activation = 宿主该会话已无当前 goal → 清记录。进程本地态：不落 tui-state.json。
      const next = { ...state.goalActivationBySession };
      if (action.activation === undefined) {
        delete next[action.sessionId];
      } else {
        next[action.sessionId] = action.activation;
      }
      return { ...state, goalActivationBySession: next };
    }
    case "todo-write":
      // P2：todo 全量快照 last-write-wins，按 sessionId 隔离
      return {
        ...state,
        todoBySession: {
          ...state.todoBySession,
          [action.sessionId]: action.todos,
        },
      };
    case "agents-changed":
      // TUI#39：子代理目录全量快照 last-write-wins，按 sessionId 隔离（状态列 Agents 块）
      return {
        ...state,
        agentsBySession: {
          ...state.agentsBySession,
          [action.sessionId]: action.agents,
        },
      };
    case "model-selection":
      // 0.1.2-rc.1：会话内生效模型选择事件 → 落 state（状态行模型徽标可选读取）
      return {
        ...state,
        modelBySession: {
          ...state.modelBySession,
          [action.sessionId]: {
            provider: action.provider,
            model: action.model,
            reasoningEffort: action.reasoningEffort,
          },
        },
      };
    case "agent-preset":
      // P3：agent-preset/selected → 当前预设 latest-wins（会话隔离）
      return {
        ...state,
        presetBySession: {
          ...state.presetBySession,
          [action.sessionId]: action.preset,
        },
      };
    case "permission-catalog":
      // P4：权限预设目录（ctx.permissionPresets.names）——P7 移除状态列 Mode 块后
      // 暂无渲染消费方（保留槽位）
      return { ...state, permissionOptions: action.names };
    case "agent-preset-catalog":
      // P4：agent 预设目录 id 列表（ctx.agentPresets.list）——同上（原 Mode 块 preset 可选项）
      return { ...state, presetOptions: action.ids };
    case "jobs-changed":
      // P3：jobs 快照 last-write-wins（adapter events.subscribe 推送 + 打开时刷新）
      return { ...state, jobs: action.jobs };
    default:
      return undefined;
  }
}
