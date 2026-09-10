// src/events.ts — 事件溯源：事件流 → 任务树物化 + 嵌套视图 + 快照
//
// 不存树、存事件流（§15.1 Euler tour）：树 = 回放（fold）出的物化视图；
// 崩溃恢复 = 重放；审计 = 日志天然证据链。嵌套视图 = 树的先序序列化（§14.1）。

import type {
  ChildSpec,
  Frame,
  FrameId,
  LoggedPlanEvent,
  NestedTaskItem,
  PlanEvent,
  TaskTree,
} from "./types.ts";

/** 把根帧声明转成事件流首条事件（含树上的种子字段） */
export function rootEvent(
  frame: Omit<Frame, "status" | "children" | "retryCount">,
): PlanEvent {
  return { type: "plan/root-created", frame };
}

/** 追加一条事件并返回带序号的持久化形态 */
export function logEvent(
  log: LoggedPlanEvent[],
  ev: PlanEvent,
  time: number = Date.now(),
): LoggedPlanEvent {
  const logged: LoggedPlanEvent = {
    ...ev,
    seq: log.length + 1,
    time,
  };
  log.push(logged);
  return logged;
}

/** 折叠事件流 → 物化任务树（回放语义，幂等） */
export function materialize(log: LoggedPlanEvent[]): TaskTree {
  const frames = new Map<FrameId, Frame>();
  let rootId: FrameId = "";

  for (const ev of log) {
    switch (ev.type) {
      case "plan/root-created": {
        rootId = ev.frame.id;
        frames.set(ev.frame.id, {
          ...ev.frame,
          status: "pending",
          children: [],
          retryCount: 0,
        });
        break;
      }
      case "plan/node-expanded": {
        const parent = frames.get(ev.parent);
        if (!parent) throw new Error(`materialize: 未知父帧 ${ev.parent}`);
        parent.children = ev.children.map((c) => c.id);
        ev.children.forEach((c: ChildSpec, i: number) => {
          frames.set(c.id, {
            id: c.id,
            parentId: ev.parent,
            order: i,
            title: c.title,
            spec: c.spec,
            acceptance: c.acceptance,
            needDecompose: c.needDecompose,
            status: "pending",
            children: [],
            retryCount: 0,
          });
        });
        break;
      }
      case "plan/frame-activated": {
        const f = frames.get(ev.frame);
        if (f) f.status = "active";
        break;
      }
      case "plan/frame-implemented": {
        const f = frames.get(ev.frame);
        if (f) f.result = ev.result;
        break;
      }
      case "plan/frame-rejected": {
        const f = frames.get(ev.frame);
        if (f) {
          f.status = "pending";
          f.retryCount += 1;
          f.feedback = ev.feedback;
        }
        break;
      }
      case "plan/acceptance-verdict": {
        // 裁决记录只作审计证据，物化树不额外落字段
        void ev;
        break;
      }
      case "plan/frame-completed": {
        const f = frames.get(ev.frame);
        if (f) f.status = "done";
        break;
      }
      case "plan/frame-failed": {
        const f = frames.get(ev.frame);
        if (f) f.status = "failed";
        break;
      }
    }
  }

  if (!rootId || !frames.has(rootId)) {
    throw new Error("materialize: 事件流缺少 plan/root-created");
  }
  return { rootId, frames };
}

/** 嵌套任务列表（parent_id + order，先序展开；§14.1 todo 视图） */
export function toNested(tree: TaskTree): NestedTaskItem[] {
  const build = (id: FrameId): NestedTaskItem => {
    const f = tree.frames.get(id);
    if (!f) throw new Error(`toNested: 未知帧 ${id}`);
    return {
      id: f.id,
      parentId: f.parentId,
      order: f.order,
      title: f.title,
      status: f.status,
      needDecompose: f.needDecompose,
      children: f.children.map(build),
    };
  };
  return [build(tree.rootId)];
}

/** 快照 = 事件流 JSON（周期快照用于 resume 加速；§15.1 L3） */
export function snapshot(log: LoggedPlanEvent[]): string {
  return JSON.stringify(log);
}

/** 从快照恢复事件流 */
export function restore(logText: string): LoggedPlanEvent[] {
  try {
    return JSON.parse(logText) as LoggedPlanEvent[];
  } catch (err) {
    throw new Error(`restore: 快照 JSON 解析失败: ${String(err)}`);
  }
}
