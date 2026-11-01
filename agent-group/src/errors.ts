/**
 * 错误文案: 任意抛出物 → 一句人话（拒绝信封与日志共用的口径）。
 */

/** 错误对象 → 一句人话。 */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
