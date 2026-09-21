/**
 * 内存图：文件节点 + IMPORTS 双向索引 + Tarjan 强连通分量。
 */

import type { CodeMapFile, CycleInfo } from "../types.ts";

export class CodeGraph {
  private readonly fileNodes = new Map<string, CodeMapFile>();
  /** from -> to 集合（直接 import）。 */
  private readonly imp = new Map<string, Set<string>>();
  /** to -> from 集合（被谁 import，反向索引）。 */
  private readonly impBy = new Map<string, Set<string>>();

  get files(): ReadonlyMap<string, CodeMapFile> {
    return this.fileNodes;
  }

  addFile(f: CodeMapFile): void {
    this.fileNodes.set(f.path, f);
  }

  /** 添加 found 的 import 边（from、to 均在仓库内）。 */
  addImport(from: string, to: string): void {
    if (!this.fileNodes.has(from) || !this.fileNodes.has(to)) return;
    let s = this.imp.get(from);
    if (!s) {
      s = new Set();
      this.imp.set(from, s);
    }
    s.add(to);
    let r = this.impBy.get(to);
    if (!r) {
      r = new Set();
      this.impBy.set(to, r);
    }
    r.add(from);
  }

  /** 该文件的直接 import 目标（仓库内）。 */
  importsOf(file: string): string[] {
    return [...(this.imp.get(file) ?? [])];
  }

  /** 直接 import 该文件的文件集合。 */
  importedBy(file: string): string[] {
    return [...(this.impBy.get(file) ?? [])].sort();
  }

  /** 反向传递闭包：直接/间接依赖该文件的全部文件（不含自身）。 */
  transitiveDependents(file: string): string[] {
    const seen = new Set<string>();
    const queue = [...this.importedBy(file)];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (seen.has(cur) || cur === file) continue;
      seen.add(cur);
      for (const n of this.importedBy(cur)) {
        if (!seen.has(n) && n !== file) queue.push(n);
      }
    }
    return [...seen].sort();
  }

  /**
   * Tarjan SCC（迭代实现，防大仓递归爆栈）。
   * 返回 size>=2 的强连通分量（即依赖环）。
   */
  sccCycles(): CycleInfo[] {
    const nodes = [...this.fileNodes.keys()];
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const cycles: CycleInfo[] = [];
    let counter = 0;
    // 帧：{ 节点, 下一边下标, 边列表 }
    const frames: Array<{ v: string; i: number; edges: string[] }> = [];

    for (const start of nodes) {
      if (index.has(start)) continue;
      frames.push({ v: start, i: 0, edges: this.importsOf(start) });
      index.set(start, counter);
      lowlink.set(start, counter);
      counter++;
      stack.push(start);
      onStack.add(start);

      while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        if (frame.i < frame.edges.length) {
          const w = frame.edges[frame.i]!;
          frame.i++;
          if (!index.has(w)) {
            frames.push({ v: w, i: 0, edges: this.importsOf(w) });
            index.set(w, counter);
            lowlink.set(w, counter);
            counter++;
            stack.push(w);
            onStack.add(w);
          } else if (onStack.has(w)) {
            lowlink.set(
              frame.v,
              Math.min(lowlink.get(frame.v)!, index.get(w)!),
            );
          }
        } else {
          frames.pop();
          if (frames.length > 0) {
            const parent = frames[frames.length - 1]!;
            lowlink.set(
              parent.v,
              Math.min(lowlink.get(parent.v)!, lowlink.get(frame.v)!),
            );
          }
          if (lowlink.get(frame.v) === index.get(frame.v)) {
            const comp: string[] = [];
            let w2: string | undefined;
            do {
              w2 = stack.pop() as string;
              onStack.delete(w2);
              comp.push(w2);
            } while (w2 !== frame.v);
            if (comp.length >= 2) {
              cycles.push({ size: comp.length, members: comp.sort() });
            }
          }
        }
      }
    }
    return cycles;
  }
}
