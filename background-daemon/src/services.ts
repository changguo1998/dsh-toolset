/**
 * 宿主服务的受保护读取（结构面访问, 不 import 宿主类型）。
 *
 * 与 `session-channel` / `metric-loop` / `task-engine` 同款：真实 cordis ctx 上未 inject
 * 的服务属性直读会抛 `cannot get property "x" without inject`, 因此 `ctx.get(name)` 优先、
 * 直接属性读兜底, 读取异常一律视为「服务不可用」。
 */
export function readService<T>(ctx: unknown, name: string): T | undefined {
  if (ctx === null || typeof ctx !== "object") return undefined;
  const container = ctx as Record<string, unknown>;
  let getter: ((key: string) => unknown) | undefined;
  try {
    const candidate = container["get"];
    if (typeof candidate === "function") {
      getter = candidate as (key: string) => unknown;
    }
  } catch {
    getter = undefined;
  }
  if (getter !== undefined) {
    try {
      const service = getter.call(container, name);
      if (service !== undefined && service !== null) return service as T;
    } catch {
      /* 严格模式读取异常 → 尝试直接属性读 */
    }
  }
  try {
    const service = container[name];
    return service === undefined || service === null
      ? undefined
      : (service as T);
  } catch {
    return undefined;
  }
}
