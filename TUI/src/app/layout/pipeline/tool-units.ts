// src/app/layout/pipeline/tool-units.ts — 工具批的逻辑行单元（`toolUnits`）
//
// 历史：本文件曾是第 2 步「结构」的旧 box 树构建器（`buildBoxes` / 细分盒 / 盒子缓存）。
// 六段旧链与渐进窗口分组的旧口径都已迁到新模型，只剩**工具批的逻辑行单元**——温平按它
// 产行（名字 / 参数 / 结果）与 `frame.sectionGroupStarts` 按它计行，两处共用同一函数，
// 避免「行数模型」与「实产行」错位（错位会让窗口分组与滚动错行）。
import { toolParams, type ToolParam } from "../../adapter/normalize.ts";
import { toolDiffSummary } from "../tool-line.ts";
import type { ToolCall, ToolResult } from "./types.ts";

/** 工具批：调用 1..N + 结果 1..N 合成一个叶子（内部保留各条 callId / name / args / 状态） */
export interface ToolBatch {
  calls: readonly ToolCall[];
  results: readonly ToolResult[];
}

/** 工具批的**逻辑行单元**（工具块改版决策 1 的单一模型；宽无关） */
export type ToolUnit =
  | {
      readonly role: "name";
      readonly call: ToolCall;
      /** 已配对的结果（缺省 = 在飞：渲染层出 `●` / `■`） */
      readonly result?: ToolResult;
    }
  | { readonly role: "param"; readonly param: ToolParam }
  | {
      readonly role: "result";
      readonly result: ToolResult;
      /** 落单结果（没有任何调用与之配对）：渲染层要自带 `✓` / `✗` 标记，
       *  否则「成功/失败」在无名字行可挂时不可见（决策 10 的落单分支） */
      readonly orphan?: boolean;
    };

/**
 * 结果 ↔ 调用的**展示配对**（决策 10）：`callId` 有则按 callId 配对；没有 callId 或
 * callId 未命中的结果，按**到达顺序**补给尚未配对的调用（与 adapter 事件面「缺 callId
 * 按顺序消费第一个待配对调用」同口径）。返回值与 `calls` 一一对应，`undefined` = 无结果。
 */
function pairToolResults(
  calls: readonly ToolCall[],
  results: readonly ToolResult[],
): (ToolResult | undefined)[] {
  const byId = new Map<string, ToolResult>();
  for (const r of results) {
    if (r.callId !== undefined && !byId.has(r.callId)) byId.set(r.callId, r);
  }
  const used = new Set<ToolResult>();
  const paired: (ToolResult | undefined)[] = calls.map((call) => {
    const hit = byId.get(call.callId);
    if (hit === undefined || used.has(hit)) return undefined;
    used.add(hit);
    return hit;
  });
  const free = results.filter((r) => !used.has(r));
  let next = 0;
  for (let i = 0; i < paired.length && next < free.length; i++) {
    if (paired[i] !== undefined) continue;
    paired[i] = free[next];
    used.add(free[next]!);
    next += 1;
  }
  return paired;
}

/** 结果行是否**不挂**：详情（去尾空白）为空且无 `(+N/-M)` 摘要 —— 静默工具
 *  （write / hash_edit 无输出）只出名字行 + 参数行（决策 1 细节 06） */
function isEmptyToolResult(result: ToolResult): boolean {
  return (
    result.detail.replace(/\s+$/, "") === "" &&
    toolDiffSummary(result.meta) === undefined
  );
}

/**
 * 工具批 → 逻辑行单元序列：`rows.ts` 按它产行、`frame.ts` 按它推 kinds / owner ——
 * 两处共用**同一函数**，避免「行数模型」与「实产行」错位（错位会让窗口分组与滚动错行）。
 * 顺序（决策 2）：每个调用 = 名字行 + 各参数行（JSON 原序）+ 该调用的结果行（若已配对）；
 * 配不上调用的落单结果按到达顺序排在批尾。结果紧跟自己的调用，配对关系不靠推断。
 */
export function toolUnits(batch: ToolBatch | undefined): ToolUnit[] {
  const calls = batch?.calls ?? [];
  const results = batch?.results ?? [];
  const paired = pairToolResults(calls, results);
  const units: ToolUnit[] = [];
  calls.forEach((call, index) => {
    const result = paired[index];
    units.push({
      role: "name",
      call,
      ...(result === undefined ? {} : { result }),
    });
    for (const param of toolParams(call.args))
      units.push({ role: "param", param });
    // 结果紧跟自己的调用（空结果不出行，与落单结果同口径）
    if (result !== undefined && !isEmptyToolResult(result))
      units.push({ role: "result", result });
  });
  // 配不上调用的落单结果：按到达顺序排批尾
  const matched = new Set(
    paired.filter((r): r is ToolResult => r !== undefined),
  );
  for (const result of results) {
    if (isEmptyToolResult(result) || matched.has(result)) continue;
    units.push({ role: "result", result, orphan: true });
  }
  return units;
}
