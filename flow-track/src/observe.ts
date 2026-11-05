/**
 * flow-track/src/observe.ts — 观测「本轮有写类工具调用」（内存态，不落盘）。
 *
 * 为什么单独订阅：rule-engine 的消费者只在注入时机唤醒，拿不到「回合中间发生了什么」，
 * 所以另挂 `ctx.on("session/event")` 只认 `tool/call`（载荷含 `name`）并按会话记账。
 *
 * 判据只到「调用过写类工具」这一层：不解析改了哪些文件、不判断是否属流程范围（决策项 4.3 = b
 * 中档的边界——只提示不拦截）。
 */

/** 写类工具（改动工作区的工具名）。 */
export const WRITE_TOOL_NAMES: readonly string[] = [
  "write",
  "edit",
  "bash",
  "pwsh",
  "str_replace_editor",
  "hash_edit",
  "ast_replace",
  "script_run",
];

/** 只读工具（显式排除, 防误报；其余不在写类清单里的默认也不计）。 */
export const READ_TOOL_NAMES: readonly string[] = [
  "read",
  "grep",
  "glob",
  "fs_digest",
  "code_map",
];

/** 会话事件的结构面（只用到 type / data.name）。 */
export interface SessionEventLike {
  type?: string;
  data?: { name?: unknown };
}

/** 每个会话的观测态。 */
export interface SessionObservation {
  /** 本轮是否出现过写类工具调用。 */
  writeSeen: boolean;
  /** 最后一次写类工具名。 */
  lastWriteTool?: string;
  /** 观测到写类调用时的回合号（有就记）。 */
  turn?: number;
}

/** 观测器：按会话记账，`decide` 与工具面共用。 */
export class WriteObserver {
  readonly #bySession = new Map<string, SessionObservation>();

  /** 收到一条会话事件。 */
  observe(sessionId: string, event: SessionEventLike): void {
    if (event.type !== "tool/call") return;
    const name = event.data?.name;
    if (typeof name !== "string" || name.length === 0) return;
    if (!WRITE_TOOL_NAMES.includes(name)) return;
    const current = this.#bySession.get(sessionId) ?? { writeSeen: false };
    current.writeSeen = true;
    current.lastWriteTool = name;
    this.#bySession.set(sessionId, current);
  }

  /** 该会话本轮是否出现过写类调用。 */
  writeSeen(sessionId: string): boolean {
    return this.#bySession.get(sessionId)?.writeSeen === true;
  }

  /** 最后一次写类工具名。 */
  lastWriteTool(sessionId: string): string | undefined {
    return this.#bySession.get(sessionId)?.lastWriteTool;
  }

  /** 清空某会话（例如已写过 flow 记录）。 */
  reset(sessionId: string): void {
    this.#bySession.delete(sessionId);
  }

  /** 清空全部（测试与插件卸载用）。 */
  clear(): void {
    this.#bySession.clear();
  }
}
