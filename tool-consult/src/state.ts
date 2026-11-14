/**
 * state.ts — 每代理的已揭示集合（纯数据，无宿主依赖）。
 *
 * 授权在会话内只增不减：没有回合档、回收、容量上限或 TTL。运行时隔离由
 * 接线层按代理各持一个实例保证；揭示重复项只返回 `already`。
 */

/** 一次揭示的结果。 */
export interface GrantResult {
  /** 是否新增了授权（false 表示已存在）。 */
  granted: boolean;
  /** 状态：新增 / 已存在。 */
  status: "granted" | "already";
}

/** 单个代理的已揭示工具名集合。 */
export class RevealSet {
  private readonly entries = new Set<string>();

  /** 是否已揭示。 */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** 全部已揭示名（排序）。 */
  names(): string[] {
    return [...this.entries].sort((a, b) => a.localeCompare(b));
  }

  /** 已揭示数量。 */
  size(): number {
    return this.entries.size;
  }

  /** 揭示一个工具；重复揭示返回 `already`。 */
  grant(name: string): GrantResult {
    if (this.entries.has(name)) {
      return { granted: false, status: "already" };
    }
    this.entries.add(name);
    return { granted: true, status: "granted" };
  }

  /** 工具被永久移除时删除授权；正常路径不会调用。 */
  forget(name: string): boolean {
    return this.entries.delete(name);
  }
}
