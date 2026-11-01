/**
 * 宿主服务的受保护读取（结构面访问, 不 import 宿主类型）。
 *
 * 与 `session-channel` / `metric-loop` / `task-engine` 同款：真实 cordis ctx 上未 inject
 * 的服务属性直读会抛 `cannot get property "x" without inject`, 因此 `ctx.get(name)` 优先、
 * 直接属性读兜底, 读取异常一律视为「服务不可用」。
 */

/**
 * 取上下文对象的结构面容器。
 *
 * 这是本包唯一的「上下文对象守卫」: `main.ts` 读 `ctx.inject` 与这里读服务都走它,
 * 非对象（含 `null`）一律视为没有容器, 调用方只需判一次 `undefined`。
 */
export function contextContainer(
  ctx: unknown,
): Record<string, unknown> | undefined {
  return ctx === null || typeof ctx !== "object"
    ? undefined
    : (ctx as Record<string, unknown>);
}

export function readService<T>(ctx: unknown, name: string): T | undefined {
  const container = contextContainer(ctx);
  if (container === undefined) return undefined;
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
