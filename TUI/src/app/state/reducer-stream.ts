// src/app/state/reducer-stream.ts — 纯 reducer 分组：流式内容、通知与排队

import { virtTick } from "../layout.ts";
import type { AppState } from "./types.ts";
import {
  appendNotice,
  appendNoticeLines,
  appendShellLines,
  appendStream,
  appendThinking,
  clearBuffer,
  setAgentStatus,
} from "./updates.ts";
import type { StateAction } from "./actions.ts";

export function reduceStream(
  state: AppState,
  action: StateAction,
): AppState | undefined {
  switch (action.type) {
    case "append":
      return appendStream(state, action.text, "assistant", action.time);
    case "user-line":
      // 用户行（条目 16 段 C2：只记写状态事实——行本体由交付进节缓存）
      return appendStream(state, action.text, "user");
    case "queued-push":
      // 排队消息登记（不合并、不写 buffer）：显示由布局层按 queued 渲染，
      // 核心认领后由 queued-claim / queued-claim-steer 转入历史流；kind 缺省 followup
      return {
        ...state,
        queued: [
          ...state.queued,
          { text: action.text, kind: action.kind ?? "followup" },
        ],
      };
    case "queued-claim":
    case "queued-claim-steer": {
      // TUI#43：按类型认领——回合开始认领**最早一条** followup；step 边界认领**全部**
      // steer（宿主 `inbox.claim("next-step")` 一次摘走整批 pending，见
      // `dsh-agent-loop` 的 claim）。这一批在界面上合成**一个**用户块（原文用换行连接，
      // 不加空行），与宿主一次注入的整批内容对齐。
      if (action.type === "queued-claim-steer") {
        const steers = state.queued.filter((q) => q.kind === "steer");
        if (steers.length === 0) return state;
        const rest = state.queued.filter((q) => q.kind !== "steer");
        return appendStream(
          { ...state, queued: rest },
          steers.map((q) => q.text).join("\n"),
          "user",
        );
      }
      const idx = state.queued.findIndex((q) => q.kind === "followup");
      if (idx < 0) return state;
      const item = state.queued[idx]!;
      const rest = [
        ...state.queued.slice(0, idx),
        ...state.queued.slice(idx + 1),
      ];
      // #4：steer 认领＝插队送达（留白 + 上一条输入打「被 steer 续接」标）与用户块本体
      // 都由 App 的交付带进节缓存（`queued: "steer"` / `spaceBefore`），本地只出队 +
      // 记状态事实（剔除计数，与 `user-line` 同口径）
      return appendStream({ ...state, queued: rest }, item.text, "user");
    }
    case "queued-clear":
      return { ...state, queued: [] };
    case "thinking":
      return appendThinking(state, action.text, action.time);
    case "virt-tick": {
      // 运行中闪烁时间驱动：虚拟速度按指数衰减回落、虚拟总 token 按衰减中的
      // 速度持续积分（无数据时闪烁频率渐降到最低而不断）；速率窗口同步衰减
      return { ...state, runVirt: virtTick(state.runVirt, action.time) };
    }
    case "notice":
      if (action.lines && action.lines.length > 0)
        return appendNoticeLines(state, action.lines, action.tone);
      return appendNotice(state, action.text, action.error, action.tone);
    case "shell-lines":
      return appendShellLines(state, action.lines);
    case "clear-buffer":
      return clearBuffer(state);
    case "agent-status":
      // 外部活动兜底：审批/问答打开保持等待交互(黄△)；thinking/tool 视为
      // 进行中(黄●/○)；idle 不改状态色
      return {
        ...setAgentStatus(state, action.status),
        inputStatus:
          state.approval || state.question
            ? "waiting"
            : action.status === "thinking" || action.status === "tool"
              ? "running"
              : state.inputStatus,
      };
    default:
      return undefined;
  }
}
