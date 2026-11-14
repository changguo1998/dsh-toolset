// task-engine/src/push.ts — 任务推送（决策项 4 / 4.1 / 4.3）：把当前节点内容交给 pin-note 动态保持
//
// 职责链（决策项 4 落点）：流程定义插件在开启流程时一次性给全节点内容 → task-engine 取**当前
// 正在执行的节点**数据 → pin-note 把内容保持在上下文（渲染 / 模板 / 缓存影响归 pin-note）。
// 本模块只做「取哪个帧」与「取出哪些字段」，不自造注入策略（不在这里碰宿主 inbox / pre-step）。
//
// 门槛（决策项 4.3）：树非空且根未完成才推；树空 / 已完成时返回 undefined（pin-note 侧据此
// 清掉旧 pending）。内容字段（决策项 4.1）：title + spec + 验收摘要 + 下一步帧 id + 顺序强制提示。

import { orderEnforced } from "./order.ts";
import type { Acceptance, Frame, FrameId } from "./types.ts";

/** 任务推送占用的 pin-note hold key（同 key 覆盖；与 flow-track 的 `flow` 互不干扰） */
export const TASK_HOLD_KEY = "task";

/**
 * 推送只需要引擎的**只读面**（结构化取，装配与测试都能给最小替身）：
 * `frames` / `root` / `peekNextReady` 任一缺失即按「无当前节点」降级。
 */
export interface PushEngineFace {
  frames?(): Map<FrameId, Frame>;
  root?(): Frame;
  peekNextReady?(): FrameId | null;
}

/** 状态的中文口径（注入文本用；未知状态原样给出） */
const STATUS_TEXT: Record<string, string> = {
  pending: "待处理",
  active: "进行中",
  done: "已完成",
  failed: "已失败",
};

/** DFS 先序帧表（从根沿 children 顺序展开；根缺失时给空表） */
function preorder(frames: Map<FrameId, Frame>, rootId: FrameId): Frame[] {
  const out: Frame[] = [];
  const walk = (id: FrameId): void => {
    const frame = frames.get(id);
    if (frame === undefined) return;
    out.push(frame);
    for (const childId of frame.children) walk(childId);
  };
  walk(rootId);
  return out;
}

/**
 * 取当前节点：在途帧（DFS 先序第一个 active）→ 就绪池首个候选 → 首个 pending 帧。
 *
 * 在途优先于池候选：池里 `peekNextReady` 会跳过 active 帧，若直接取它就可能在「正做 C1 时
 * 推 C2」；没有在途帧时池候选就是下一步要做的那个节点。
 */
export function currentFrame(face: PushEngineFace): Frame | undefined {
  const frames = face.frames?.();
  if (frames === undefined || frames.size === 0) return undefined;
  const root = face.root?.();
  if (root === undefined || root.status === "done") return undefined;
  const ordered = preorder(frames, root.id);
  const active = ordered.find((frame) => frame.status === "active");
  if (active !== undefined) return active;
  const ready = face.peekNextReady?.();
  if (typeof ready === "string") {
    const frame = frames.get(ready);
    if (frame !== undefined) return frame;
  }
  return ordered.find((frame) => frame.status === "pending");
}

/** 折叠空白 + 截断（注入文本保持单行，长 spec 不刷屏） */
function oneLine(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 验收摘要：`id「check」（level）` 逐条拼接（check 截断到 80 字） */
export function acceptanceSummary(acceptance: readonly Acceptance[]): string {
  return acceptance
    .map((a) => `${a.id}「${oneLine(a.check, 80)}」（${a.level}）`)
    .join("；");
}

/** 下一步帧 id：就绪池候选（非本帧）→ 本帧之后的第一个未完成兄弟 → undefined */
function nextFrameId(
  face: PushEngineFace,
  frames: Map<FrameId, Frame>,
  frame: Frame,
): FrameId | undefined {
  const ready = face.peekNextReady?.();
  if (typeof ready === "string" && ready !== frame.id) return ready;
  const parent =
    frame.parentId === null ? undefined : frames.get(frame.parentId);
  if (parent === undefined) return undefined;
  for (const id of parent.children) {
    const sibling = frames.get(id);
    if (sibling === undefined || sibling.order <= frame.order) continue;
    if (sibling.status === "pending" || sibling.status === "active")
      return sibling.id;
  }
  return undefined;
}

/**
 * 渲染当前节点文本（决策项 4.1 的字段集合）；无当前节点 / 树已完成 → undefined。
 * 返回的是**交给 pin-note 的正文**，注入时机与同 key 覆盖由 pin-note 负责。
 */
export function renderCurrentTask(face: PushEngineFace): string | undefined {
  const frame = currentFrame(face);
  if (frame === undefined) return undefined;
  const frames = face.frames?.();
  if (frames === undefined) return undefined;
  const status = STATUS_TEXT[frame.status] ?? frame.status;
  const lines = [
    `[task] 当前节点：${frame.id}「${frame.title}」（${status}）`,
    `目标：${oneLine(frame.spec)}`,
  ];
  if (frame.acceptance.length > 0) {
    lines.push(`验收：${acceptanceSummary(frame.acceptance)}`);
  }
  const next = nextFrameId(face, frames, frame);
  if (next !== undefined) lines.push(`下一步：${next}`);
  if (orderEnforced(frames, frame)) {
    lines.push(
      "顺序：本流程按节点顺序强制，前序节点未完成前不得 implement / execute / stop。",
    );
  }
  return lines.join("\n");
}
