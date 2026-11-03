// src/app/state/reducer-input.ts — 纯 reducer 分组：输入区与光标

import type { AppState } from "./types.ts";
import { statusFor } from "./updates.ts";
import type { StateAction } from "./actions.ts";
import {
  reduceInputHistory,
  moveCursor,
  recomputeCompletion,
  setInput,
} from "./panels.ts";

export function reduceInput(
  state: AppState,
  action: StateAction,
): AppState | undefined {
  switch (action.type) {
    case "input":
      return setInput(state, action);
    case "input-mode":
      // 模式决定命令 token 语义（slash 模式文本无前导 `/`）：切换即重算候选
      return {
        ...state,
        inputMode: action.mode,
        completion: recomputeCompletion(
          state,
          state.inputText,
          state.inputCursor,
          action.mode,
        ),
      };
    case "input-status":
      // 活跃守卫：agent 非 idle 时绿/红结果不暴露（压回黄），空闲后才显示结果色
      return { ...state, inputStatus: statusFor(state, action.status) };
    case "input-history":
      return reduceInputHistory(state, action);
    case "move-cursor":
      return moveCursor(state, action);
    default:
      return undefined;
  }
}
