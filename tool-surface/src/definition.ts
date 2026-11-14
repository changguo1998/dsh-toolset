/**
 * tool-surface/src/definition.ts — 工具定义包装层与说明注册表。
 *
 * 背景: 宿主的模型可见 schema 就是注册定义（`projectToolSchema` 只取 name / description /
 * parameters / deferLoading），没有「按会话切换模型侧 schema」的钩子。本层把注册定义收成
 * 「短说明 + 宽松占位」，完整说明与完整参数 schema 留在本模块的 catalog 里:
 *
 * - 注册前: 各工具包调 `wrapToolDefinition(def)`，拿到同名定义（其余字段原样透传, `summary` 不注册）。
 * - 派发前: 包装后的 `execute` 先按完整 `parameters` 严格校验, 违规抛 `ToolArgsError`（与宿主同款
 *   错误形态, 管线照常落错误结果）; 校验通过才调原 `execute`。
 * - 揭示后: `lookupSurface(name)` / `listSurface()` 给出全文与完整 schema, 供 tool-consult 投递。
 *
 * 校验器直接取宿主 `@deepseek-ai/dsh-tools`（版本与宿主对齐, 见 package.json 的精确钉版）,
 * 不另维护仓内子集校验器。
 */

import { ToolArgsError, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

/** 说明注册表条目: 完整说明与完整参数 schema（深拷贝保存）。 */
export interface SurfaceEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** 只读服务面（`ctx.get("toolSurface")`）。 */
export interface ToolSurfaceFace {
  /** 按工具名取完整说明与完整参数 schema; 未接入包装层返回 undefined。 */
  lookup(name: string): SurfaceEntry | undefined;
  /** 已登记的全部条目（按注册顺序）。 */
  list(): SurfaceEntry[];
}

/** 包装入参: 只需 name / description / parameters, 其余字段（execute / output / …）原样透传。 */
export interface WrapTarget {
  name: string;
  /** 完整说明（用途 / 用法 / 顺序 / 效果 / 边界 / 相关）。 */
  description: string;
  /** 显式短说明（用途一句 + 指向 tool_consult）; 缺省从完整说明首行派生。 */
  summary?: string;
  /** 完整参数 schema（严格校验与揭示后投递都读它）。 */
  parameters: Record<string, unknown>;
}

/** 注册定义里的说明尾句: 指向查询入口（决策 02）。 */
const SURFACE_HINT = "完整说明与参数 schema 经 tool_consult 查询。";

/** 宽松占位的 `description`: 避免模型照占位猜参数（决策 13）。 */
const PARAMETERS_HINT = "完整参数 schema 经 tool_consult 查询";

/** 标记已包装过的定义（防重复包装把占位当全文收进 catalog）。 */
const WRAPPED = Symbol.for("dsh-toolset.tool-surface.wrapped");

/** 宿主校验器的结构化形态（不把宿主类型铺到本包各处）。 */
type ValidateValue = (
  schema: unknown,
  value: unknown,
  path?: string,
) => string[];

const validateValue = validateJsonSchemaValue as unknown as ValidateValue;

/** 已登记条目的键: 工具名（后者覆盖前者, 与宿主同名注册口径一致）。 */
const catalog = new Map<string, SurfaceEntry>();

/** 深拷贝（说明与 schema 都是纯 JSON; 结构化克隆失败时退回 JSON 往返）。 */
function deepCopy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** 完整说明的首个非空行（显式短说明缺省时的派生来源）。 */
function firstLine(description: string): string {
  for (const line of description.split("\n")) {
    const text = line.trim();
    if (text.length > 0) return text;
  }
  return "";
}

/** 短说明: 显式 `summary` 优先, 缺省取完整说明首行; 未含 tool_consult 时补一句指向。 */
function shortDescription(def: WrapTarget): string {
  const explicit = typeof def.summary === "string" ? def.summary.trim() : "";
  const base = explicit.length > 0 ? explicit : firstLine(def.description);
  const head = base.length > 0 ? base : `工具 ${def.name}`;
  return head.includes("tool_consult") ? head : `${head} ${SURFACE_HINT}`;
}

/** 宽松占位: 任意对象都通过宿主校验, 严格校验交给包装后的 `execute`（决策 13）。 */
function placeholderParameters(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    properties: {},
    description: PARAMETERS_HINT,
  };
}

/**
 * 包装一个工具定义: 换短说明与宽松占位, `execute` 前插严格校验, 全文收进 catalog。
 *
 * 两个签名: 结构面（各工具包的工具工厂返回 `unknown`）走第一个, 调用方自己持有类型时
 * 走泛型重载, 拿到同名同类型的定义。运行期只要求 `name` / `description` / `parameters`。
 *
 * @param def 原注册定义（`description` 为完整说明, `parameters` 为完整参数 schema）。
 * @returns 同名定义: 其余字段原样透传, `summary` 不进入注册定义。
 */
export function wrapToolDefinition<T extends WrapTarget>(def: T): T;
export function wrapToolDefinition(def: unknown): unknown;
export function wrapToolDefinition(def: unknown): unknown {
  const source = def as unknown as Record<string, unknown>;
  if ((def as Record<symbol, unknown>)[WRAPPED] === true) return def;

  const target = def as unknown as WrapTarget;
  const full = deepCopy({
    name: target.name,
    description: target.description,
    parameters: target.parameters,
  }) as SurfaceEntry;
  catalog.set(full.name, full);

  const raw = { ...source };
  delete raw["summary"];
  const run = raw["execute"] as
    ((args: unknown, exec?: unknown) => unknown) | undefined;

  const wrapped: Record<string, unknown> = {
    ...raw,
    description: shortDescription(target),
    parameters: placeholderParameters(),
    execute: async (args: unknown, exec?: unknown): Promise<unknown> => {
      const violations = validateValue(full.parameters, args);
      if (violations.length > 0) throw new ToolArgsError(violations);
      return run === undefined ? undefined : run(args, exec);
    },
  };
  Object.defineProperty(wrapped, WRAPPED, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return wrapped;
}

/**
 * 判断一个注册定义是否已被本包装层包装过（只看定义自身的标记）。
 *
 * @param def 任意注册定义。
 * @returns 由 `wrapToolDefinition` 产出的定义返回 true。
 */
export function isWrappedDefinition(def: unknown): boolean {
  if (def === null || typeof def !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(def, WRAPPED)) return false;
  return (def as Record<symbol, unknown>)[WRAPPED] === true;
}

/** 按名取完整说明与完整参数 schema（返回深拷贝, 调用方改动不影响 catalog）。 */
export function lookupSurface(name: string): SurfaceEntry | undefined {
  const entry = catalog.get(name);
  return entry === undefined ? undefined : deepCopy(entry);
}

/** 已登记条目（按注册顺序, 深拷贝）。 */
export function listSurface(): SurfaceEntry[] {
  return [...catalog.values()].map((entry) => deepCopy(entry));
}

/** 清空 catalog（只给测试用: 模块级状态在同一进程内跨用例累积）。 */
export function resetSurfaceCatalog(): void {
  catalog.clear();
}
