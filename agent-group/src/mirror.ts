/**
 * 可选镜像：每次组状态变更后，把只读视图写进 memory-base（`kind: "agent_group"`）。
 *
 * 失效面三档（设计「状态落点」一节）：memory-base 未挂载 / 取不到写句柄 → 跳过（`mirror`
 * 关闭）；写入被拒（`skipped`）或抛错 → 计数 + 一次日志，**不重试**。协调本身不依赖镜像。
 *
 * 服务面口径（2026-10-20 真机修订）：memory-base 的全局 `memory` 服务**只暴露** `registerKind`
 * （写权限收敛在它返回的作用域句柄 `MemoryScope` 上，`remember` 并不在服务上）。本文件的
 * `MemoryFace` / `isMemoryFace` 随之改为：`registerKind` 是唯一入口，写入走句柄的 `put`。
 * 上一版把 `remember` 当成服务方法、`put` 当设计早期口径，导致真机上 `mirror.enabled=false`
 * 且库中从无 `agent_group` 记录（联调实测）。`KindRegistry.register` 对同名重复注册抛错
 * （`router.ts`），本包每个进程只注册一次（bundle 实例是进程级单例），抛错时按「写不到」降级。
 */

import type { GroupMirror, GroupView, AgentGroupState } from "./types.ts";

/** memory-base 写句柄（`MemoryScope` 的结构面：只用到 `put`）。 */
export interface MemoryScopeFace {
  put(input: {
    tier?: string;
    content: string;
    project?: string;
    title?: string;
    source?: { kind: string; label?: string; ref?: string };
    sessionId?: string;
  }): Promise<{ ids?: number[]; skipped?: string; created?: number }>;
}

/** memory-base 全局服务面里本包用到的方法（结构面）。 */
export interface MemoryFace {
  registerKind(spec: {
    kind: string;
  }): MemoryScopeFace | Promise<MemoryScopeFace>;
}

/** 判据：memory-base 服务面「够用」。 */
export function isMemoryFace(value: unknown): value is MemoryFace {
  if (typeof value !== "object" || value === null) return false;
  const face = value as Record<string, unknown>;
  return typeof face["registerKind"] === "function";
}

/** 分类名（memory-base 的 `kind`；写目标层缺省 `session`）。 */
export const MIRROR_KIND = "agent_group";

/** memory-base 镜像（懒拿写句柄，首次写入时取一次并按需降级）。 */
export class MemoryBaseMirror implements GroupMirror {
  readonly #memory: MemoryFace;
  readonly #projectOf: (managerSessionId: string) => string | undefined;
  #scope: MemoryScopeFace | undefined;

  constructor(
    memory: MemoryFace,
    projectOf: (managerSessionId: string) => string | undefined,
  ) {
    this.#memory = memory;
    this.#projectOf = projectOf;
  }

  async put(input: {
    managerSessionId: string;
    group: AgentGroupState;
    view: GroupView;
  }): Promise<void> {
    if (this.#scope === undefined) {
      // 句柄只取一次；重复注册抛错时维持 undefined（写不到 → 上层计数 + 日志，不重试）。
      const scope = await this.#memory.registerKind({ kind: MIRROR_KIND });
      if (scope === undefined || typeof scope.put !== "function") {
        throw new Error("memory-base 未返回可写的分类句柄");
      }
      this.#scope = scope;
    }
    const project =
      this.#projectOf(input.managerSessionId) ??
      `agent-group:${input.group.name}`;
    const result = await this.#scope.put({
      tier: "session",
      sessionId: input.managerSessionId,
      project,
      content: JSON.stringify(input.view),
      title: `agent-group ${input.group.name}`,
      source: {
        kind: "manual",
        label: MIRROR_KIND,
        ref: input.group.id,
      },
    });
    if (result?.skipped !== undefined && result.skipped !== "") {
      throw new Error(`memory-base 拒收（${result.skipped}）`);
    }
  }
}
