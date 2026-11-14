// task-engine/src/order.ts — 顺序强制（决策项 1-3）：同父兄弟序列的判定与打回文案
//
// 打开条件（决策项 2：流程定义级）：帧自己或其父帧带 `enforceOrder` 才启用；缺省关闭，
// 既有树（自由分解 / fan-out）行为逐字不变。
// 作用域（决策项 3）：**同父兄弟**，不跨层、不跨父——前序兄弟未 done 时拒绝
// implement / execute / stop（写产出与标完成都拦，只拦一处会留缝）。
//
// 纯函数模块（只读帧表）：引擎操作层与任务推送共用同一判定，避免两处口径漂移。

import type { Frame, FrameId } from "./types.ts";

/**
 * 顺序强制是否作用于该帧：帧自己带标记（流程定义一次给全部节点打标）或其父帧带标记
 * （流程挂在根 / 某待分解节点上时由父帧声明）。根帧没有兄弟，恒不启用。
 */
export function orderEnforced(
  frames: Map<FrameId, Frame>,
  frame: Frame,
): boolean {
  if (frame.parentId === null) return false;
  if (frame.enforceOrder === true) return true;
  return frames.get(frame.parentId)?.enforceOrder === true;
}

/**
 * 该帧**未完成的前序兄弟**（按兄弟序列顺序）：空数组 = 可以操作。
 * 未启用顺序强制、父帧缺失、或前序兄弟全部 done 时都返回空数组。
 */
export function blockingSiblings(
  frames: Map<FrameId, Frame>,
  frame: Frame,
): Frame[] {
  if (!orderEnforced(frames, frame)) return [];
  const parent =
    frame.parentId === null ? undefined : frames.get(frame.parentId);
  if (parent === undefined) return [];
  const out: Frame[] = [];
  for (const id of parent.children) {
    const sibling = frames.get(id);
    if (sibling === undefined || sibling.order >= frame.order) continue;
    if (sibling.status !== "done") out.push(sibling);
  }
  return out;
}

/**
 * 顺序强制的打回文案（可以操作 → undefined）。`action` 是被拒绝的动作名
 * （implement / execute / stop），反馈里原样写出，便于模型知道撞了哪条边界。
 */
export function orderFeedback(
  frames: Map<FrameId, Frame>,
  frame: Frame,
  action: string,
): string | undefined {
  const blocked = blockingSiblings(frames, frame);
  if (blocked.length === 0) return undefined;
  const list = blocked
    .map((s) => `${s.id}「${s.title}」（${s.status}）`)
    .join("、");
  return (
    `帧 ${frame.id} 受顺序强制约束：前序兄弟 ${list} 尚未完成，不允许 ${action}。` +
    "请先完成前序节点（本流程按节点顺序推进）。"
  );
}
