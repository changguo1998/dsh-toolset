/**
 * lossless JSON 归一：递归删掉值为 `undefined` 的对象键与数组项（其它值原样返回）。
 *
 * 为什么需要：宿主的工具返回体要过 `snapshotToolValue` → `walkJsonValue`，**值为
 * `undefined` 的键即判非法**（`ToolOutputError`，code `INVALID_TOOL_OUTPUT`；`JSON.stringify`
 * 会丢键，但校验发生在序列化之前）。本包所有结果都按需拼装，这道归一只是最后一道保险
 * （与 session-channel 的 `pruneUndefined` 同口径、同实现）。
 */
export function pruneUndefined(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  if (Array.isArray(value)) {
    seen.add(value);
    return value
      .filter((item) => item !== undefined)
      .map((item) => pruneUndefined(item, seen));
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    out[key] = pruneUndefined(item, seen);
  }
  return out;
}
