// src/semantic/lsp.ts — LSP 语义层缝适配（精确引用裁决）。
//
// 对接官方 `ctx.lsp`（@deepseek-ai/dsh-lsp）的查询缝：四个操作
// （goToDefinition / findReferences / goToImplementation / hover），导航类结果
// 归一为 `{ kind: 'locations', locations: [{ uri, range }] }`；坐标 0-based UTF-16，
// 与 ast-grep outline 的 0-based 行号同源。服务**可选**：缺失 / 形状不符 / 查询
// 抛错一律回落 null（调用方回落到结构层同名候选），绝不阻塞或抛出。

/** 0-based UTF-16 光标坐标（与官方缝一致）。 */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** 一条归一化位置（官方缝 `LspLocation` 的结构子集）。 */
export interface LspLocation {
  uri: string;
  range: LspRange;
}

/** 精确引用提供器（本包内部面：官方缝 findReferences 的窄化）。 */
export interface LspReferencesProvider {
  /** 返回 null = 本次查询不可用/失败（调用方回落）；数组（含空）为有效结果。 */
  findReferences(
    filePath: string,
    position: LspPosition,
    signal?: AbortSignal,
  ): Promise<LspLocation[] | null>;
}

/** 查询超时（ms）：官方缝不做默认值，消费方自管超时。 */
export const LSP_QUERY_TIMEOUT_MS = 5000;

/**
 * 解析宿主 LSP 引用提供器：
 * 1. 显式注入（`config.lsp`，单测/嵌入用）优先；
 * 2. 宿主 ctx 的 `lsp` 服务（`ctx.get("lsp")`，兼容直接 `ctx.lsp` 的测试宿主）：
 *    - 有 `query` → 官方缝形态（发 findReferences 请求、解析 locations）；
 *    - 有 `findReferences` → 已在缝契约上的窄化形态，直接采用。
 * 均不满足返回 undefined（调用方走结构层）。
 */
export function resolveLspReferences(
  ctx: unknown,
  workspaceRoot: string,
  injected?: LspReferencesProvider,
): LspReferencesProvider | undefined {
  if (injected !== undefined) return injected;
  const surface = readLspSurface(ctx);
  if (surface === undefined) return undefined;
  const direct = (surface as { findReferences?: unknown }).findReferences;
  if (typeof direct === "function") {
    const fn = direct as (
      filePath: string,
      position: LspPosition,
      signal?: AbortSignal,
    ) => Promise<LspLocation[] | null>;
    return {
      findReferences: (filePath, position, signal) =>
        fn(filePath, position, signal),
    };
  }
  const query = (surface as { query?: unknown }).query;
  if (typeof query !== "function") return undefined;
  const run = query as (
    request: {
      operation: string;
      filePath: string;
      position: LspPosition;
      workspaceRoot: string;
    },
    signal?: AbortSignal,
  ) => Promise<unknown>;
  return {
    async findReferences(filePath, position, signal) {
      const signalWithTimeout = withTimeout(signal);
      try {
        const result = await run.call(
          surface,
          { operation: "findReferences", filePath, position, workspaceRoot },
          signalWithTimeout,
        );
        return parseLocations(result);
      } catch {
        return null;
      } finally {
        clearTimeoutIfOwned(signalWithTimeout);
      }
    },
  };
}

/** 受保护地读宿主 lsp 服务面：`ctx.get("lsp")` 优先，直接属性读兜底（cordis 代理可能抛）。 */
function readLspSurface(ctx: unknown): unknown {
  if (ctx === null || typeof ctx !== "object") return undefined;
  const c = ctx as { get?: (name: string) => unknown; lsp?: unknown };
  if (typeof c.get === "function") {
    try {
      const svc = c.get("lsp");
      if (svc !== undefined) return svc;
    } catch {
      /* 严格模式下的读取异常 → 尝试直接属性 */
    }
  }
  try {
    return c.lsp;
  } catch {
    return undefined;
  }
}

/** 解析官方缝结果 → LspLocation[]；非 locations 形态或形状不符 → null。 */
function parseLocations(result: unknown): LspLocation[] | null {
  if (result === null || typeof result !== "object") return null;
  const r = result as { kind?: unknown; locations?: unknown };
  if (r.kind === "hover") return null;
  const locations = r.locations;
  if (!Array.isArray(locations)) return null;
  const out: LspLocation[] = [];
  for (const loc of locations) {
    const normalized = normalizeLocation(loc);
    if (normalized !== undefined) out.push(normalized);
  }
  return out;
}

function normalizeLocation(loc: unknown): LspLocation | undefined {
  if (loc === null || typeof loc !== "object") return undefined;
  const l = loc as { uri?: unknown; range?: unknown };
  if (typeof l.uri !== "string") return undefined;
  const range = normalizeRange(l.range);
  if (range === undefined) return undefined;
  return { uri: l.uri, range };
}

function normalizeRange(range: unknown): LspRange | undefined {
  if (range === null || typeof range !== "object") return undefined;
  const r = range as { start?: unknown; end?: unknown };
  const start = normalizePosition(r.start);
  const end = normalizePosition(r.end);
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

function normalizePosition(pos: unknown): LspPosition | undefined {
  if (pos === null || typeof pos !== "object") return undefined;
  const p = pos as { line?: unknown; character?: unknown };
  if (typeof p.line !== "number" || typeof p.character !== "number")
    return undefined;
  return { line: p.line, character: p.character };
}

/** 附加超时信号（调用方已给信号时不动；无 AbortSignal.timeout 时原样）。 */
function withTimeout(signal: AbortSignal | undefined): AbortSignal | undefined {
  if (signal !== undefined) return signal;
  const timeout = (AbortSignal as { timeout?: (ms: number) => AbortSignal })
    .timeout;
  return typeof timeout === "function"
    ? timeout(LSP_QUERY_TIMEOUT_MS)
    : undefined;
}

function clearTimeoutIfOwned(_signal: AbortSignal | undefined): void {
  /* AbortSignal.timeout 自带定时器，无需手动清理（保留钩子供未来换实现） */
}
