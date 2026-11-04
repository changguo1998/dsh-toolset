// TUI/src/app/state/reducer-turn.ts — 纯 reducer 分组：回合边界与模式

import { emptyRunVirt, VIRT_SPEED_MIN } from "../layout.ts";
import type { AppState } from "./types.ts";
import type { StateAction } from "./actions.ts";

export function reduceTurn(
  state: AppState,
  action: StateAction,
): AppState | undefined {
  switch (action.type) {
    case "pipeline-state":
      // 注入节缓存 = 内容单源（条目 16 段 C2 后这是**唯一**内容来源）
      return { ...state, pipeline: action.pipeline };
    case "turn-begin": {
      // 回合开始：内容归节缓存（回合分隔线由 `turn-start` 交付驱动），本地**无内容行可画**；
      // 非打印字符剔除计数按回合清零（turn-end 时警告后不复用旧值）。
      // run 边界 = 两次用户输入之间（见 runVirt 注释）：仅用户输入开启的回合
      // （clearActivity=true，含排队消息被认领）才重置虚拟状态与本 step 累计；
      // 核心自发的回合（goal 轮次/定时唤醒，clearActivity=false）属同一 run，保留。
      // 回合区本地行（notice / 工具行）一并清掉（否则底部 toast 挂着上一回合的提示）。
      const clearActivity = action.clearActivity ?? true;
      return {
        ...state,
        strippedChars: 0,
        stepEstTokens: 0,
        ...(clearActivity
          ? {
              runVirt: emptyRunVirt(),
              local: state.local.filter(
                (l) => l.kind !== "notice" && l.kind !== "tool",
              ),
              activityScroll: 0,
              activityTop: null,
            }
          : {}),
      };
    }
    case "turn-number":
      // 条目 16 段 C2：缓冲不再承载回合分隔线行（分隔线是节缓存的内容），本地无事可做
      return state;
    case "clear-stripped":
      return { ...state, strippedChars: 0 };
    case "turn-end": {
      // 回合结束（条目 16 段 C2）：定型（finalize）与回合结束（turn-end）信号由宿主事件
      // 投进节缓存，本地只剩状态事实——置成功色（绿）与虚拟速度下限。
      // 虚拟总 token **不清零**（run 边界 = 两次用户输入之间，到下次用户输入
      // turn-begin clearActivity=true 时才重置），lastTime/速率窗口保持。
      // 用户块终态符号（✓/■/✗）由节模型按 reason 打标（`sections.ts`）
      return {
        ...state,
        inputStatus: "success",
        runVirt: { ...state.runVirt, speed: VIRT_SPEED_MIN },
      };
    }
    case "mode": {
      // P2：模式徽标按 sessionId 隔离（plan/sandbox/permission 三合一，缺省省略）
      const current = state.modeBySession[action.sessionId] ?? {};
      const updated =
        action.kind === "plan"
          ? { ...current, plan: action.value as "on" | "off" }
          : action.kind === "sandbox"
            ? { ...current, sandbox: action.value }
            : { ...current, permission: action.value };
      return {
        ...state,
        modeBySession: {
          ...state.modeBySession,
          [action.sessionId]: updated,
        },
      };
    }
    default:
      return undefined;
  }
}
