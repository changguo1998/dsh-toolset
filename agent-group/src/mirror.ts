/**
 * 可选镜像：每次组状态变更后，把只读视图写进 memory-base（`kind: "agent_group"`）。
 *
 * 失效面三档（设计「状态落点」一节）：memory-base 未挂载 / 取不到句柄 → 跳过；
 * `remember` 拒收（`skipped`）或抛错 → 计数 + 一次日志，**不重试**。协调本身不依赖镜像。
 *
 * 与设计文档的一处偏差：设计写的 `registerKind({kind, writableTiers}).put({tier, …})` 是
 * memory-base 早期口径；仓内现行服务面是 `registerKind(KindSpec)` + `remember(RememberInput)`
 * （`memory-base/src/index.ts:824`、`:839`），故按现行口径实现。
 */

import type { GroupMirror, GroupView, AgentGroupState } from "./types.ts";

/** memory-base 服务面里本包用到的方法（结构面）。 */
export interface MemoryFace {
  registerKind(spec: { kind: string }): Promise<unknown>;
  remember(input: {
    project: string;
    content: string;
    title?: string;
    kind?: string;
    sessionId?: string;
    source?: { kind: string; label?: string; ref?: string };
  }): Promise<unknown>;
}

/** 判据：memory-base 服务面「够用」。 */
export function isMemoryFace(value: unknown): value is MemoryFace {
  if (typeof value !== "object" || value === null) return false;
  const face = value as Record<string, unknown>;
  return (
    typeof face["registerKind"] === "function" &&
    typeof face["remember"] === "function"
  );
}

/** 分类名（memory-base 的 `kind`；同名重复注册抛错时视为已注册）。 */
export const MIRROR_KIND = "agent_group";

/** memory-base 镜像（懒注册分类，首次写入时注册一次）。 */
export class MemoryBaseMirror implements GroupMirror {
  readonly #memory: MemoryFace;
  readonly #projectOf: (managerSessionId: string) => string | undefined;
  #registered = false;

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
    if (!this.#registered) {
      try {
        await this.#memory.registerKind({ kind: MIRROR_KIND });
      } catch {
        // 同名 / 同表重复注册会抛错（另一实例已注册）；分类本身可用，按已注册处理。
      }
      this.#registered = true;
    }
    const project =
      this.#projectOf(input.managerSessionId) ??
      `agent-group:${input.group.name}`;
    const result = (await this.#memory.remember({
      project,
      content: JSON.stringify(input.view),
      title: `agent-group ${input.group.name}`,
      kind: MIRROR_KIND,
      sessionId: input.managerSessionId,
      source: {
        kind: "manual",
        label: MIRROR_KIND,
        ref: input.group.id,
      },
    })) as { skipped?: string } | undefined;
    if (result?.skipped !== undefined) {
      throw new Error(`memory-base 拒收（${result.skipped}）`);
    }
  }
}
