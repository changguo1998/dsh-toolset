// tests/helpers/deliveriesFromScript.ts — state 级用例的「造交付流」助手（条目 16 段 A）
//
// 背景：`state.buffer` 作为**测试重放输入**的用途要退场（BACKLOG 第 16 条）。state 级用例
// 不再「写缓冲行 + 让 `sectionsOf` 回退重放」，改成显式造一条交付流并塞进 `state.pipeline`：
// 内容是节模型的产物，帧只认 `state.pipeline`。
//
// 用法：
//   const steps: ScriptStep[] = [
//     { delivery: { kind: "turn-start", turn: 1, time: T } },
//     { delivery: { kind: "user", turn: 1, step: 0, text: "问题" } },
//     { delivery: { kind: "text", turn: 1, step: 1, index: 0, source: "assistant", text: "正文" } },
//     { delivery: { kind: "finalize", turn: 1, step: 1 } },
//     { delivery: { kind: "turn-end", turn: 1, step: 1, reason: "completed" } },
//   ];
//   const s = { ...initialState(), pipeline: sectionsFromScript(steps) };

import {
  applyAll,
  createSections,
  type SectionsState,
} from "../../src/app/layout/pipeline/sections.ts";
import type { BlockDelivery } from "../../src/app/layout/pipeline/types.ts";

/** 一条脚本步：只带交付即可（`event` 留给需要同步喂事件的用例，助手本身不消费） */
export interface ScriptStep {
  readonly delivery: BlockDelivery;
}

/** 脚本 → 节缓存（顺序投递；与生产 `applyDelivery` 同一入口） */
export function sectionsFromScript(
  steps: readonly ScriptStep[],
): SectionsState {
  return applyAll(
    createSections(),
    steps.map((step) => step.delivery),
  );
}

/** 便捷构造：一条「回合」= 分隔线 + 用户块 (+ 可选正文/思考) + 收尾 */
export function turnScript(opts: {
  turn: number;
  time?: number;
  user?: string;
  assistant?: string;
  reasoning?: string;
  step?: number;
  reason?: "completed" | "error" | "aborted" | "interrupted";
}): ScriptStep[] {
  const step = opts.step ?? 1;
  const out: ScriptStep[] = [
    {
      delivery: {
        kind: "turn-start",
        turn: opts.turn,
        ...(opts.time === undefined ? {} : { time: opts.time }),
      },
    },
  ];
  if (opts.user !== undefined)
    out.push({
      delivery: { kind: "user", turn: opts.turn, step: 0, text: opts.user },
    });
  const content = opts.reasoning ?? opts.assistant;
  if (content !== undefined)
    out.push({
      delivery: {
        kind: "text",
        turn: opts.turn,
        step,
        index: 0,
        source: opts.reasoning === undefined ? "assistant" : "reasoning",
        text: content,
      },
    });
  if (opts.assistant !== undefined && opts.reasoning !== undefined)
    out.push({
      delivery: {
        kind: "text",
        turn: opts.turn,
        step,
        index: 1,
        source: "assistant",
        text: opts.assistant,
      },
    });
  if (opts.reason === undefined) return out;
  out.push({ delivery: { kind: "finalize", turn: opts.turn, step } });
  out.push({
    delivery: { kind: "turn-end", turn: opts.turn, step, reason: opts.reason },
  });
  return out;
}
