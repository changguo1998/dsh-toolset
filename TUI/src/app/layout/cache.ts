// TUI/src/app/layout/cache.ts — 排版层有界文本缓存（开关/清空/容量上限集中处）
//
// 折行与宽度计算是纯函数（同文本 + 同列宽必得同结果），流式追加时绝大多数
// 行文本不变，命中缓存即可跳过逐字符工作。缓存可控：TUI_LAYOUT_CACHE=0 或
// setLayoutCacheEnabled(false) 时退化为直算——等价断言与基准对比用同一实现的
// 两条路径，不额外维护第二份逻辑。

/** 单缓存容量上限（FIFO 淘汰；值可能含嵌套段数组，不宜过大） */
export const TEXT_CACHE_LIMIT = 2048;

const caches = new Set<TextCache<unknown>>();

/** 环境变量只作为初始值；运行时经 setLayoutCacheEnabled 切换（bench/测试同进程对比） */
let enabled = process.env.TUI_LAYOUT_CACHE !== "0";

export function layoutCacheEnabled(): boolean {
  return enabled;
}

export function setLayoutCacheEnabled(next: boolean): void {
  enabled = next;
}

const resetters = new Set<() => void>();

/** 注册非 Map 型缓存的重置回调（如码点宽度表），由 clearLayoutCaches 统一调用 */
export function registerCacheReset(reset: () => void): void {
  resetters.add(reset);
}

/** 清空全部已注册缓存（测试/基准在两种模式间切换时调用） */
export function clearLayoutCaches(): void {
  for (const cache of caches) cache.clear();
  for (const reset of resetters) reset();
}

/** 有界文本缓存：超限时淘汰最旧插入项（Map 保序） */
export interface TextCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  readonly size: number;
}

export function createTextCache<T>(
  limit: number = TEXT_CACHE_LIMIT,
): TextCache<T> {
  const map = new Map<string, T>();
  const cache: TextCache<T> = {
    get: (key) => map.get(key),
    set(key, value) {
      if (map.size >= limit) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, value);
    },
    clear: () => map.clear(),
    get size() {
      return map.size;
    },
  };
  caches.add(cache as TextCache<unknown>);
  return cache;
}

/** 命中即返回；未命中则计算并入缓存；缓存关闭时直算不落表 */
export function memo<T>(cache: TextCache<T>, key: string, compute: () => T): T {
  if (!enabled) return compute();
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  cache.set(key, value);
  return value;
}

/** 文本缓存键：列宽 + 文本（\u0000 分隔，避免拼接歧义） */
export function sizedKey(text: string, size: number): string {
  return `${size}\u0000${text}`;
}

/** 主题相关文本缓存键：主题 + 列宽 + 文本 */
export function themeSizedKey(
  text: string,
  size: number,
  theme: string,
): string {
  return `${theme}\u0000${size}\u0000${text}`;
}
