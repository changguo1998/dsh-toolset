// src/app/state/reducer-tool.ts — 纯 reducer 分组：工具过程与回合内输出

import {
  TOKEN_CALIB_ALPHA,
  TOKEN_CALIB_MAX,
  TOKEN_CALIB_MIN,
} from "../layout.ts";
import {
  codeDispatchLine,
  commandErrorLine,
  commandRunLine,
  hookLine,
  retryStartedLine,
  stepHeaderLine,
  subagentLine,
  toolCallLine,
  toolResultLine,
  workflowLine,
} from "../layout/tool-line.ts";
import type { AppState } from "./types.ts";
import { appendNotice, appendToolLine } from "./updates.ts";
import type { StateAction } from "./actions.ts";

export function reduceTool(
  state: AppState,
  action: StateAction,
): AppState | undefined {
  switch (action.type) {
    case "tool-call":
      // 工具调用：紧凑工具行（○ <name> <summary> 由 tool-line.ts 组装），不进模型历史。
      // #7 起 step 分割线在 step/start 已画，工具行不再插分组头。
      return appendToolLine(
        state,
        toolCallLine(action.name, action.summary),
        undefined,
        {
          keepLineBreaks: true,
        },
      );
    case "tool-result":
      // 工具结果：✓ 成功 / ✗ 失败（失败红色，tone=error）
      return appendToolLine(
        state,
        toolResultLine(action.ok, action.detail, action.meta),
        action.ok ? undefined : "error",
      );
    case "compaction": {
      // 长会话压缩 toast：start/end 提示；P8：压缩期间把该会话标记为活跃
      const raw = action.sessionId ?? state.activeSessionId;
      const sid = typeof raw === "string" && raw !== "" ? raw : undefined;
      let flags = state.compactingBySession;
      if (sid !== undefined) {
        flags = { ...flags };
        if (action.phase === "start") flags[sid] = true;
        else delete flags[sid];
      }
      return appendNotice(
        { ...state, compactingBySession: flags },
        action.phase === "start" ? "正在压缩上下文..." : "压缩完成",
        false,
        action.phase === "start" ? "info" : "success",
      );
    }
    case "retry":
      // 模型重试 toast：第 attempt/max 次 + 退避 + 失败码（黄色，表进行中）
      return appendNotice(
        state,
        `重试 ${action.attempt}/${action.max} (${(action.delayMs / 1000).toFixed(1)}s): ${action.code}` +
          (action.message ? " " + action.message : ""),
        false,
        "warn",
      );
    case "usage": {
      // 阶段 1：入状态（阶段 2 状态行 contextLen/cacheHit 从 state.usage 读取）。
      // P5 估算校准：usage 真值（output，每 step 一次）与本 step 估算累计对比，
      // 比例经 EMA 平滑并 clamp 后写入 tokenCalib，供后续 run 校正启发式估算；
      // 本 step 累计清零（真值已消费）。provider 未报 usage（output<=0）不校准。
      const est = state.stepEstTokens;
      const tokenCalib =
        est > 0 && action.output > 0
          ? Math.min(
              TOKEN_CALIB_MAX,
              Math.max(
                TOKEN_CALIB_MIN,
                TOKEN_CALIB_ALPHA * (action.output / est) +
                  (1 - TOKEN_CALIB_ALPHA) * state.tokenCalib,
              ),
            )
          : state.tokenCalib;
      return {
        ...state,
        stepEstTokens: 0,
        tokenCalib,
        usage: {
          input: action.input,
          output: action.output,
          cacheRead: action.cacheRead,
          ...(action.contextWindow === undefined
            ? {}
            : { contextWindow: action.contextWindow }),
        },
        // TUI#9：本会话累计 = 逐次 usage 事件求和（事件每次调用即真值，无需另采）
        usageTotals: {
          input: state.usageTotals.input + action.input,
          output: state.usageTotals.output + action.output,
          cacheRead: state.usageTotals.cacheRead + action.cacheRead,
        },
      };
    }
    case "step":
      // #7：step/start **即画真分割线** `hh:mm:ss ⇆N #M`（其后思考/工具/正文都归入该步；
      // 每步都画，含首个 step 与无工具调用的 step）；step/end 关组。
      if (action.phase === "start") {
        // step 0 = 宿主在首个 step/start 之前的占位（「尚未声明任何 step」）→ **不落头行**：
        // 落了会被回放反解成「step 0 已声明」并画出 `╌╌ ⇆N #0 ╌╌` 假头（BACKLOG #21）
        if (action.step === 0) return state;
        // P6：时间取事件时间；mock/合成事件缺 time 时回退当前时刻
        const time = action.time ?? Date.now();
        return {
          ...appendToolLine(
            state,
            stepHeaderLine(action.step, time, action.turn),
            undefined,
            {
              time,
            },
          ),
          stepGroup: {
            sessionId: action.sessionId,
            step: action.step,
            time,
          },
        };
      }
      return { ...state, stepGroup: null };
    case "subagent":
      // B4：subagent 行（`@ <label> <os|ct>`，append-only 不配对不折叠）入 buffer，不进模型历史
      return appendToolLine(
        state,
        subagentLine(action.label, action.mode),
        "info",
      );
    case "compaction-summary": {
      // B5：压缩摘要仅 toast（`压缩完成：<text 首行>`；空摘要给占位）+ 每会话保留最近一条原始载荷（raw，不改写）
      const toast = action.text
        ? "压缩完成：" + action.text.split("\n")[0]
        : "压缩完成（无摘要）";
      return appendNotice(
        {
          ...state,
          compactionBySession: {
            ...state.compactionBySession,
            [action.sessionId]: { raw: action.raw, text: action.text },
          },
        },
        toast,
        false,
        "success",
      );
    }
    case "workflow":
      // P3：workflow 运行行（run-start/agent-start/agent-end 为回合区行，append-only）；
      // run-end 折叠为 toast（携 stopReason detail）。不参与 step 分组（独立运行大动作）。
      if (action.phase === "run-end") {
        return appendNotice(
          state,
          "workflow 结束" + (action.detail ? " (" + action.detail + ")" : ""),
          false,
          "success",
        );
      }
      return appendToolLine(
        state,
        workflowLine(action.phase, action.label, action.detail),
        action.phase === "agent-end" ? "success" : "info",
      );
    case "command":
      // P3：命令执行流——run 低调灰行；done 成功静默（结果由命令自身 notice 呈现，避免重复），
      // 失败红行（✗ /name: text）。append-only 不保留历史命令状态。
      if (action.phase === "done") {
        if (action.ok !== false) return state;
        return appendToolLine(
          state,
          commandErrorLine(action.name, action.text ?? ""),
          "error",
        );
      }
      return appendToolLine(state, commandRunLine(action.name), "log");
    case "code-dispatch":
      // P3：run_code 内子派发——start 灰行；settle 成功静默降噪（子调用多，避免刷屏），
      // 失败红行（✗ <name>）。
      if (action.phase === "settle") {
        if (action.ok) return state;
        return appendToolLine(state, "✗ " + action.name, "error");
      }
      return appendToolLine(
        state,
        codeDispatchLine(action.name, action.summary),
        "log",
      );
    case "hook":
      // P3：hooks 协议事件——invoked 灰行；result 按是否通过着色（失败红）。
      return appendToolLine(
        state,
        hookLine(action.phase, action.point, action.decision, action.ok),
        action.phase === "result" && !action.ok ? "error" : "log",
      );
    case "schedule":
      // P3：schedule 提醒——仅 dispatch 到点提示（create/delete 降噪，无用户可见价值）。
      if (action.operation !== "dispatch") return state;
      return appendNotice(state, "计划提醒触发", false, "log");
    case "compaction-prune":
      // P3：压缩剪枝计数 toast（co tool-result pruner 剪除的节点数/千分 token 启发值）
      return appendNotice(
        state,
        "压缩：已剪除 " +
          action.nodeCount +
          " 个节点 (~" +
          action.tokenCount +
          " tok)",
        false,
        "log",
      );
    case "feedback":
      // P3：feedback/record 确认（/feedback 命令落库后回读）
      return appendNotice(state, "反馈已记录", false, "success");
    case "retry-started":
      // P3：llm/retry-started 启动行（↻ 灰行）——与 retry toast 互补：启动可见 + 失败原因 toast
      return appendToolLine(state, retryStartedLine(action.attempt), "log");
    default:
      return undefined;
  }
}
