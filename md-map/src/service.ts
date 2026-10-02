// src/service.ts — md-map 服务面：持有最近一次索引，提供索引 / 查询（工具面与库面共用）。

import { buildIndex } from "./indexer.ts";
import { callers, impact, orphans, report, resolveDocRef, summary } from "./query.ts";
import type {
  MdCaller,
  MdImpactLayer,
  MdMapIndex,
  MdMapOptions,
  MdMapReport,
} from "./types.ts";

/** 服务面接口（对标 code-map 的 CodeMapService）。 */
export interface MdMapService {
  /** 建立索引（全量扫描；覆盖上一次结果）。 */
  index(options?: MdMapOptions): Promise<MdMapIndex>;
  /** 重新建立索引（与 index 同义；保留以对齐 code_map 的 action 命名）。 */
  refresh(options?: MdMapOptions): Promise<MdMapIndex>;
  /** 索引内是否存在该文档（供工具面区分「无此文档」与「无引用」）。 */
  hasDoc(path: string): boolean;
  callers(path: string, options?: { anchor?: string }): MdCaller[];
  impact(path: string, options?: { depth?: number }): MdImpactLayer[];
  orphans(options?: { includeEntry?: boolean }): string[];
  report(): MdMapReport | undefined;
  summary(): ReturnType<typeof summary> | { ready: false };
  /** 释放（无持久资源，保留以对齐契约）。 */
  dispose(): void;
}

/** 创建服务实例（`maxFiles` / `exclude` 走配置，root 按调用传入）。 */
export function createMdMapService(
  config: MdMapOptions = {},
): MdMapService {
  let current: MdMapIndex | undefined;
  return {
    async index(options: MdMapOptions = {}): Promise<MdMapIndex> {
      current = await buildIndex({
        ...config,
        ...options,
        ...(options.root === undefined && config.root !== undefined
          ? { root: config.root }
          : {}),
      });
      return current;
    },
    async refresh(options: MdMapOptions = {}): Promise<MdMapIndex> {
      return this.index(options);
    },
    hasDoc(path: string): boolean {
      return current !== undefined && resolveDocRef(current, path) !== undefined;
    },
    callers(path: string, options: { anchor?: string } = {}): MdCaller[] {
      return current === undefined ? [] : callers(current, path, options);
    },
    impact(path: string, options: { depth?: number } = {}): MdImpactLayer[] {
      return current === undefined ? [] : impact(current, path, options);
    },
    orphans(options: { includeEntry?: boolean } = {}): string[] {
      return current === undefined ? [] : orphans(current, options);
    },
    report(): MdMapReport | undefined {
      return current === undefined ? undefined : report(current);
    },
    summary(): ReturnType<typeof summary> | { ready: false } {
      return current === undefined ? { ready: false } : summary(current);
    },
    dispose(): void {
      current = undefined;
    },
  };
}
