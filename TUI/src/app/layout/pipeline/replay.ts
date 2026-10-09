// src/app/layout/pipeline/replay.ts — 会话恢复：已有行 → 节缓存
//
// 恢复（`--resume` / 历史折叠）时没有逐块事件可放，但有状态层已归一化的行。本模块按
// **旧口径的行类型**把它们重放成节（与 `frame.ts` 的 `sectionGroupStarts` 恰好相反：
// 那边把节还原成行类型序列，这边把行还原成节），供新流水线在恢复后继续按节增量接收事件。
//
// 口径：
//   - `separator`（回合分隔线）→ 回合 +1；
//   - step 头（`kind = "step"` 或工具行里的 `hh:mm:ss #N`）→ step 边界；
//   - `user` / `notice` / `shell` → 独立自足节；
//   - `thinking` → reasoning 条目；工具行 → 工具批（调用行按 `名字 摘要` 拆、结果行按
//     `✓/✗` 判定，配对交给接收层的到达顺序口径）；其余 → 正文条目；
//   - `final` 正文 → 定型信号 + 回合结束（该节即回合总结节 → 会话区归属）。
// 恢复不到的瞬态内容不造占位（reasoning 只在实时线，恢复后自然缺失）。

import type { BufferLine } from "../../state.ts";
import { isToolCall } from "../content-rules.ts";
import {
  createSections,
  applyDelivery,
  type SectionsState,
} from "./sections.ts";
import type { BlockDelivery } from "./types.ts";

/** step 头文本（`hh:mm:ss #N` / `#N`）→ step 号；非 step 头返回 undefined */
export function stepOf(text: string): number | undefined {
  const match = /(?:^|\s)#(\d+)\s*$/.exec(text.trim());
  return match === null ? undefined : Number(match[1]);
}

/** 工具结果行（`✓ …` / `✗ …`）→ 成功标志；非结果行返回 undefined */
function resultOf(text: string): boolean | undefined {
  if (text.startsWith("✓")) return true;
  if (text.startsWith("✗")) return false;
  return undefined;
}

interface Scope {
  turn: number;
  step: number;
}

/** 行 → 块交付（顺序投递；step 头与分隔线在调用方处理） */
export function deliveryOfLine(
  line: BufferLine,
  scope: Scope,
  index: number,
): BlockDelivery | undefined {
  const text = line.text;
  switch (line.kind) {
    case "user":
      return {
        kind: "user",
        turn: scope.turn,
        step: scope.step,
        text,
        // 行号透传：恢复后的用户块符号解析与旧路径同源（回查 buffer 行）
        ...(line.seq === undefined ? {} : { seq: line.seq }),
      };
    case "notice":
      return {
        kind: "notice",
        text,
        ...(line.tone === undefined ? {} : { tone: line.tone }),
      };
    case "shell":
      return { kind: "shell", text };
    case "thinking":
      return {
        kind: "text",
        turn: scope.turn,
        step: scope.step,
        index,
        source: "reasoning",
        text,
      };
    case "tool": {
      const ok = resultOf(text);
      if (ok !== undefined) {
        return {
          kind: "tool-result",
          turn: scope.turn,
          step: scope.step,
          ok,
          detail: text.replace(/^[✓✗]\s?/, ""),
        };
      }
      if (!isToolCall(text)) return undefined; // 辅助行（无状态前缀）：恢复时不上屏
      const [name, ...rest] = text.split(" ");
      return {
        kind: "tool-call",
        turn: scope.turn,
        step: scope.step,
        callId: "replay:" + scope.turn + ":" + scope.step + ":" + index,
        name: name ?? "",
        // 摘要按原始串存回：`summarizeToolArguments` 对非 JSON 原样返回 → 渲染回同一行
        args: rest.join(" "),
        full: true,
      };
    }
    default:
      return {
        kind: "text",
        turn: scope.turn,
        step: scope.step,
        index,
        source: "assistant",
        text,
        full: true,
      };
  }
}

/** 已有行 → 节缓存（恢复路径；顺序与行序一致） */
export function sectionsFromBuffer(
  lines: readonly BufferLine[],
): SectionsState {
  let state = createSections();
  const scope: Scope = { turn: 1, step: 0 };
  const indexByScope = new Map<string, number>();
  // 定型 + 回合结束在**整块 final 结束时**补：final 块可能多行（正文 + 代码 + 表格），
  // 逐行补会把后续行挤进新节（会话区归属丢失）
  let pendingFinal: Scope | undefined;
  const flushFinal = (): void => {
    if (pendingFinal === undefined) return;
    const done = pendingFinal;
    pendingFinal = undefined;
    state = applyDelivery(state, {
      kind: "finalize",
      turn: done.turn,
      step: done.step,
    });
    state = applyDelivery(state, {
      kind: "turn-end",
      turn: done.turn,
      step: done.step,
    });
  };
  // 文本类行按「同 kind 连续块」聚合后一次投递（块文本语义：节内直拼，须带换行）
  let run:
    | { kind: BufferLine["kind"]; tone?: BufferLine["tone"]; text: string[] }
    | undefined;
  const flushRun = (): void => {
    if (run === undefined) return;
    const block = run;
    run = undefined;
    const key = scope.turn + ":" + scope.step;
    const index = indexByScope.get(key) ?? 0;
    indexByScope.set(key, index + 1);
    const delivery = deliveryOfLine(
      {
        text: block.text.join("\n"),
        kind: block.kind,
        ...(block.tone === undefined ? {} : { tone: block.tone }),
      },
      scope,
      index,
    );
    if (delivery !== undefined) state = applyDelivery(state, delivery);
  };
  const isTextKind = (kind: BufferLine["kind"]): boolean =>
    kind === "assistant" || kind === "thinking" || kind === "plain";
  for (const line of lines) {
    if (
      !isTextKind(line.kind) ||
      !(line.kind === "assistant" && line.final === true)
    ) {
      // final 块与非文本行都要先冲刷文本 run（final 的定型在整块结束时补）
      if (
        !isTextKind(line.kind) ||
        run === undefined ||
        run.kind !== line.kind
      ) {
        flushRun();
      }
      if (!(line.kind === "assistant" && line.final === true)) flushFinal();
    }
    if (line.kind === "separator") {
      flushRun();
      scope.turn += 1;
      scope.step = 0;
      // 分隔线行 = 回合边界：补交付 turn-start（turnMeta 时间源），与实时路径同构——
      // 帧层的回合分隔线以「该回合被 turn-begin 交付过」为准（见 panes leading 条件）。
      // 历史分隔线行缺时间（理论不该发生）→ 以重放时刻兜底，仅影响该线显示时间
      state = applyDelivery(state, {
        kind: "turn-start",
        turn: scope.turn,
        time: line.time ?? Date.now(),
      });
      continue;
    }
    const header = line.kind === "step" ? stepOf(line.text) : undefined;
    const toolHeader =
      line.kind === "tool" && stepOf(line.text) !== undefined
        ? stepOf(line.text)
        : undefined;
    if (header !== undefined || toolHeader !== undefined) {
      scope.step = header ?? toolHeader ?? scope.step + 1;
      state = applyDelivery(state, {
        kind: "step-start",
        turn: scope.turn,
        step: scope.step,
        ...(line.time === undefined ? {} : { time: line.time }),
      });
      continue;
    }
    if (isTextKind(line.kind)) {
      if (run !== undefined && run.kind === line.kind) {
        run.text.push(line.text);
      } else {
        flushRun();
        run = {
          kind: line.kind,
          ...(line.tone === undefined ? {} : { tone: line.tone }),
          text: [line.text],
        };
      }
      if (line.kind === "assistant" && line.final === true) {
        pendingFinal = { ...scope };
      }
      continue;
    }
    const key = scope.turn + ":" + scope.step;
    const index = indexByScope.get(key) ?? 0;
    indexByScope.set(key, index + 1);
    const delivery = deliveryOfLine(line, scope, index);
    if (delivery !== undefined) state = applyDelivery(state, delivery);
    if (line.kind === "assistant" && line.final === true) {
      // 该节即回合总结节（会话区归属）：定型与回合结束在整块结束时补（见 flushFinal）
      pendingFinal = { ...scope };
    }
  }
  flushRun();
  flushFinal();
  return state;
}
