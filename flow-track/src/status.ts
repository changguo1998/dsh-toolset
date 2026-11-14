/**
 * flow-track/src/status.ts — 从 task-engine 的只读快照认当前阶段（纯函数，零 IO）。
 *
 * 只读服务面 `taskEngine.query()` 的 `TaskEngineSnapshot`：`frameStack` 末位 = 下一待处理帧，
 * 帧标题经 `tasks`（先序嵌套）反查。阶段名来自流程定义（`stages.ts` 的 `stageOfTitle`）。
 *
 * 推进状态**不再渲染注入**（决策项 4.4：树级内容保持改由「流程定义定内容 → task-engine 取当前
 * 节点 → pin-note 保持」承担）；这里只给 `flow_status` 工具认阶段用。
 */

import { FLOW_NODES, stageOfTitle, type FlowNodeSpec } from "./stages.ts";

/** 嵌套任务项（`NestedTaskItem` 的结构子集）。 */
export interface NestedTaskLike {
  id: string;
  title: string;
  status: string;
  children: NestedTaskLike[];
}

/** 只读快照（`TaskEngineSnapshot` 的结构子集）。 */
export interface SnapshotLike {
  tasks: readonly NestedTaskLike[];
  frameStack: readonly string[];
  activeCount: number;
  isComplete: boolean;
}

/** 当前阶段。 */
export interface CurrentStage {
  /** 命中的流程节点（阶段名 / spec / 验收都在定义里）。 */
  stage: FlowNodeSpec;
  /** 帧标题（可能带「决策：xxx」这类后缀）。 */
  title: string;
  /** 还有几个后续阶段。 */
  remaining: number;
}

/** 先序展平成 id → 标题。 */
function titleIndex(tasks: readonly NestedTaskLike[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (items: readonly NestedTaskLike[]): void => {
    for (const item of items) {
      out.set(item.id, item.title);
      walk(item.children);
    }
  };
  walk(tasks);
  return out;
}

/** 帧栈末位对应哪个阶段；无帧 / 帧标题不是阶段名 → undefined。 */
export function currentStage(snapshot: SnapshotLike): CurrentStage | undefined {
  const frameId = snapshot.frameStack.at(-1);
  if (frameId === undefined) return undefined;
  const title = titleIndex(snapshot.tasks).get(frameId);
  if (title === undefined) return undefined;
  const stage = stageOfTitle(title);
  if (stage === undefined) return undefined;
  return {
    stage,
    title,
    remaining: FLOW_NODES.length - stage.index,
  };
}
