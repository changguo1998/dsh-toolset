/**
 * flow-track/src/status.ts — 从 task-engine 的只读快照推当前阶段（纯函数，零 IO）。
 *
 * 只读服务面 `taskEngine.query()` 的 `TaskEngineSnapshot`：`frameStack` 末位 = 下一待处理帧,
 * 帧标题经 `tasks`（先序嵌套）反查。标题与阶段名的对应关系见 `stages.ts` 的 `stageOfTitle`。
 */

import { STAGES, stageOfTitle, type StageSpec } from "./stages.ts";

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
  stage: StageSpec;
  /** 帧标题（可能带「决策：xxx」这类后缀）。 */
  title: string;
  /** 是否还有后续阶段。 */
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
    remaining: STAGES.length - stage.index,
  };
}

/** 渲染推进状态（无阶段树 / 无法识别阶段 → undefined）。 */
export function renderStatus(
  snapshot: SnapshotLike | undefined,
): string | undefined {
  if (snapshot === undefined) return undefined;
  const current = currentStage(snapshot);
  if (current === undefined) return undefined;
  const next = STAGES[current.stage.index]; // index 是 1 起, 数组下标即下一阶段
  const gate =
    current.stage.gate === "human" ? "human（人工确认）" : "mechanical";
  const lines = [
    `[flow-track] 当前阶段：${current.stage.index}/${STAGES.length} ${current.stage.name}（${current.title}）`,
    `门禁：${gate}；本阶段要求：${current.stage.spec}`,
  ];
  if (next === undefined) {
    lines.push("已是最后一个阶段, 完成后归档并清理条目。");
  } else {
    lines.push(`下一步：阶段 ${next.index} ${next.name} —— ${next.spec}`);
  }
  return lines.join("\n");
}
