/**
 * code-map 插件入口（DSH bundle 接入面）。
 *
 * 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
 * name / inject / provide / apply / Config；apply(ctx, config) 把配置透传给
 * `createCodeMapBundle`（`root` 生效，`ast` 供程序化注入），Config 以类型别名给出
 * （无运行时 schema，宿主不校验）。
 * - `inject: ["tools"]`：注册 `code_map` 工具（cordis 硬依赖；结构面仍防御取值，单测直接传
 *   普通对象时缺失即跳过注册，不抛）；
 * - `provide: ["codeMap"]`：只读查询面，宿主命令/插件经 `ctx.get('codeMap')` 访问；
 * - 核心工厂 `createCodeMapBundle`（可测/可复用），apply 为宿主挂载入口。
 *
 * 分层：结构层（recall，ast-grep）恒定可用；语义层（precision）按需——callers 在宿主
 * `ctx.lsp` 可用时经 findReferences 精确裁决（`precision:"lsp"`），否则回落同名候选
 * （`precision:"structural"`）。注意：宿主 LSP 三件套（`lsp` / `lsp-stdio` / `tool-lsp`）
 * **不随 dsh 分发**（docs/host/HOST-PACKAGES.md），缺省 `ctx.get("lsp")` 解析不到，故标准
 * profile 下恒走 `structural`；要 `lsp` 精度须自行安装该三件套。
 * callees 为文件级；索引惰性（首次查询时构建）。
 */

import {
  createAstToolsBundle,
  type AstToolsBundle,
} from "@dsh-toolset/ast-tools";
import { fileURLToPath } from "node:url";
import { scanProject } from "./indexer/scan.ts";
import { candidateRefs, excludeDefinitionRange } from "./indexer/refs.ts";
import { CodeGraph } from "./graph/graph.ts";
import { callers, calleesFiles, impact as impactQuery } from "./graph/query.ts";
import { buildReport } from "./report/builder.ts";
import {
  resolveLspReferences,
  type LspLocation,
  type LspReferencesProvider,
} from "./semantic/lsp.ts";
import { symbolPositionAt } from "./semantic/locate.ts";
import type {
  CallersResult,
  CandidateRef,
  CodeMapReport,
  CodeMapService,
  CodeMapSymbol,
  ImpactResult,
  IndexResult,
} from "./types.ts";

export type {
  CallersResult,
  CandidateRef,
  CodeMapFile,
  CodeMapReport,
  CodeMapService,
  CodeMapSymbol,
  CycleInfo,
  FileImport,
  ImpactResult,
  IndexResult,
  ModuleStats,
  ScanResult,
} from "./types.ts";

export const name = "code-map";
export const inject = ["tools"];
/** 提供的服务名（宿主命令/插件经 ctx.get('codeMap') 取 `{ getSummary, getBundle }`）。 */
export const provide = ["codeMap"];

/** 结构化宿主 ctx（最小 DSH cordis 形态）：可选 logger。 */
export interface BundleHost {
  logger?(ns: string): { info(message: string): void };
}

export interface CodeMapConfig {
  /** 仓库根（缺省 process.cwd()）。 */
  root?: string;
  /** 注入 ast-tools bundle（可测）；缺省自建（ast-grep 缺失时降级为不可用）。 */
  ast?: AstToolsBundle;
  /** 注入 LSP 引用提供器（可测/嵌入）；缺省由 `apply()` 从宿主 `ctx.lsp` 解析
   *  （三件套不随 dsh 分发 → 缺省解析不到，回落结构层同名候选）。 */
  lsp?: LspReferencesProvider;
}

/**
 * Config 契约别名（DSH bundle §0 的 `Config`）：仅类型级导出，不新增运行时 schema——
 * cordis `resolveConfig()` 只在本导出带 `'~standard'` 校验接口时才校验配置，无 schema 即
 * 原样透传，故不改变本包既有的缺省链/降级语义（避免 fail-closed 改变行为）。
 */
export type Config = CodeMapConfig;

export interface CodeMapBundle extends CodeMapService {
  dispose(): void;
}

/** 索引建好后补强的 CodeMapService 实现（内部持有图/ast）。 */
class CodeMapServiceCore implements CodeMapService {
  private ast: AstToolsBundle;
  private root: string;
  private lsp: LspReferencesProvider | undefined;
  private graph = new CodeGraph();
  private unresolved = 0;
  private indexedRoot = "";
  private inflight: Promise<IndexResult> | null = null;

  constructor(ast: AstToolsBundle, root: string, lsp?: LspReferencesProvider) {
    this.ast = ast;
    this.root = root;
    this.lsp = lsp;
  }

  private async doIndex(r: string): Promise<IndexResult> {
    const t0 = Date.now();
    const scan = await scanProject(this.ast, r);
    const g = new CodeGraph();
    for (const f of scan.files) g.addFile(f);
    for (const im of scan.imports) {
      if (im.to) g.addImport(im.from, im.to);
    }
    this.graph = g;
    this.unresolved = scan.imports.filter((i) => i.to === null).length;
    this.indexedRoot = r;
    return {
      ready: true,
      files: scan.filesScanned,
      symbols: scan.files.reduce((n, f) => n + f.symbols.length, 0),
      imports: scan.imports.length,
      unresolved: this.unresolved,
      elapsedMs: Date.now() - t0,
    };
  }

  private ensureIndexed(): Promise<IndexResult> {
    if (this.indexedRoot !== "") return Promise.resolve(this.summaryIndex());
    if (this.inflight) return this.inflight;
    this.inflight = this.doIndex(this.root).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private summaryIndex(): IndexResult {
    return {
      ready: true,
      files: this.graph.files.size,
      symbols: [...this.graph.files.values()].reduce(
        (n, f) => n + f.symbols.length,
        0,
      ),
      imports: 0,
      unresolved: this.unresolved,
      elapsedMs: 0,
    };
  }

  index(opts: { root?: string } = {}): Promise<IndexResult> {
    return opts.root ? this.reindex(opts.root) : this.ensureIndexed();
  }

  refresh(opts: { root?: string } = {}): Promise<IndexResult> {
    return this.reindex(opts.root ?? (this.indexedRoot || this.root));
  }

  private reindex(r: string): Promise<IndexResult> {
    this.indexedRoot = "";
    return (this.inflight = this.doIndex(r).finally(() => {
      this.inflight = null;
    }));
  }

  private resolveSymbol(
    name: string,
    file?: string,
  ): CodeMapSymbol | undefined {
    for (const f of this.graph.files.values()) {
      if (file !== undefined && f.path !== file) continue;
      const hit = f.symbols.find((s) => s.name === name);
      if (hit) return hit;
    }
    return undefined;
  }

  async callers(
    symbol: string,
    opts: { file?: string; kind?: string } = {},
  ): Promise<CallersResult> {
    await this.ensureIndexed();
    const sym = this.resolveSymbol(symbol, opts.file);
    if (!sym) return { symbol, refs: [], files: [], precision: "structural" };
    const precise = await this.preciseCallers(sym);
    if (precise !== null) return precise;
    const fallback = await callers(this.graph, sym, {
      refsOf: (s) => candidateRefs(this.ast, this.indexedRoot, s),
    });
    return { ...fallback, precision: "structural" };
  }

  /** 语义层：经宿主 LSP findReferences 精确确认引用；不可用/失败/超时 → null（回落结构层）。 */
  private async preciseCallers(
    sym: CodeMapSymbol,
  ): Promise<CallersResult | null> {
    const provider = this.lsp;
    if (provider === undefined) return null;
    try {
      const position = await symbolPositionAt(
        sym.file,
        sym.startLine,
        sym.name,
      );
      if (position === undefined) return null;
      const locations = await provider.findReferences(sym.file, position);
      if (locations === null) return null;
      const refs = excludeDefinitionRange(
        locations
          .map(locationToRef)
          .filter((r): r is CandidateRef => r !== undefined)
          .sort(byFileLine),
        sym,
      );
      return {
        symbol: sym.name,
        refs,
        files: [...new Set(refs.map((r) => r.file))].sort(),
        precision: "lsp",
      };
    } catch {
      return null;
    }
  }

  async callees(
    symbol: string,
    opts: { file?: string } = {},
  ): Promise<{ files: string[] }> {
    await this.ensureIndexed();
    const sym = this.resolveSymbol(symbol, opts.file);
    return { files: sym ? calleesFiles(this.graph, sym) : [] };
  }

  async impact(target: string): Promise<ImpactResult> {
    await this.ensureIndexed();
    return impactQuery(this.graph, this.indexedRoot, target);
  }

  cycles(): { size: number; members: string[] }[] {
    return this.graph.sccCycles();
  }

  report(): CodeMapReport | undefined {
    if (this.indexedRoot === "") return undefined;
    return buildReport(this.indexedRoot, this.graph, this.unresolved);
  }

  summary():
    | { ready: boolean; root: string; files: number; symbols: number }
    | undefined {
    if (this.indexedRoot === "") return undefined;
    return {
      ready: true,
      root: this.indexedRoot,
      files: this.graph.files.size,
      symbols: [...this.graph.files.values()].reduce(
        (n, f) => n + f.symbols.length,
        0,
      ),
    };
  }

  dispose(): void {
    /* 无持久资源 */
  }
}

/** 核心工厂：ast-grep 缺失时返回不可用 bundle（summary.ready=false），不抛。 */
export function createCodeMapBundle(config: CodeMapConfig = {}): CodeMapBundle {
  const root = config.root ?? process.cwd();
  let ast: AstToolsBundle | null = config.ast ?? null;
  if (ast === null) {
    try {
      ast = createAstToolsBundle();
    } catch {
      ast = null;
    }
  }
  if (ast === null) return degradedBundle(root);
  return new CodeMapServiceCore(ast, root, config.lsp);
}

/** ast-grep 缺失时的降级 bundle：所有操作返回降级结果，不抛出。 */
function degradedBundle(root: string): CodeMapBundle {
  const degraded: CodeMapService = {
    index: async () => ({
      ready: false,
      files: 0,
      symbols: 0,
      imports: 0,
      unresolved: 0,
      elapsedMs: 0,
      error: "ast-grep 不可用（code-map 降级）",
    }),
    refresh: async () => degraded.index(),
    callers: async (s) => ({
      symbol: s,
      refs: [],
      files: [],
      precision: "structural",
    }),
    callees: async () => ({ files: [] }),
    impact: async (t) => ({ target: t, files: [], modules: [] }),
    cycles: () => [],
    report: () => undefined,
    summary: () => ({ ready: false, root, files: 0, symbols: 0 }),
  };
  return { ...degraded, dispose(): void {} };
}

/**
 * JSON 文本（render 必须全函数，`text` 恒为 string）：字符串原样返回（避免二次编码），
 * 其余 `JSON.stringify(value, null, 2)`；`undefined` / 函数 / symbol 结果为非字符串，
 * 循环引用 / BigInt 直接抛错——两种情况退化为 `String(value)`，`String` 仍抛则给占位。
 */
function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text === "string") return text;
  } catch {
    // 循环引用 / BigInt：序列化抛错，落到下方 String 兜底
  }
  try {
    return String(value);
  } catch {
    return "（无法序列化的值）";
  }
}

/** `code_map` 工具定义（action 分派）。 */
function toToolDef(service: CodeMapService) {
  return {
    name: "code_map",
    description:
      "代码结构地图：index/refresh 建立项目结构索引（符号表 + import 图）；" +
      "callers 查某符号的引用（宿主 LSP 可用时 findReferences 精确结果 precision=lsp；标准 profile 不挂 LSP 三件套 → 实际恒回落同名候选 precision=structural）；callees 查符号所在文件的直接 import 目标（文件级）；" +
      "impact 查改动某文件的影响面（反向 import 闭包聚合到模块）；cycles 查文件级依赖环（不隐式建索引：未索引返回 not_indexed）；" +
      "report 出项目/模块报告（统计/模块依赖/环/未引用导出）；summary 查索引就绪状态。",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "index",
            "refresh",
            "callers",
            "callees",
            "impact",
            "cycles",
            "report",
            "summary",
          ],
        },
        symbol: { type: "string", description: "callers/callees 用：符号名" },
        file: {
          type: "string",
          description:
            "impact 用目标文件；callers/callees 用可限定符号所在文件（绝对路径）",
        },
        root: {
          type: "string",
          description: "index/refresh 用：仓库根（缺省当前工作目录）",
        },
      },
      required: ["action"],
    },
    async execute(args: Record<string, unknown>) {
      const action = String(args.action ?? "");
      const file = typeof args.file === "string" ? args.file : undefined;
      const root = typeof args.root === "string" ? args.root : undefined;
      switch (action) {
        case "index":
          return service.index({ root });
        case "refresh":
          return service.refresh({ root });
        case "callers":
          return service.callers(String(args.symbol ?? ""), { file });
        case "callees":
          return service.callees(String(args.symbol ?? ""), { file });
        case "impact":
          return file
            ? service.impact(file)
            : { error: "impact 需要 file 参数" };
        case "cycles":
          // 不隐式建索引（与 callers/callees/impact 不同）：未索引时给明确错误，而不是静默当成「无环」
          return service.summary()
            ? service.cycles()
            : {
                ok: false,
                error: "not_indexed",
                hint: "先调用 index / refresh 建索引（cycles 不隐式建索引）",
              };
        case "report":
          return service.report() ?? { error: "未索引（先调用 index）" };
        case "summary":
          return service.summary() ?? { ready: false };
        default:
          return { error: `未知 action: ${action}` };
      }
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => [
        { type: "text", text: jsonText(value) },
      ],
    },
  };
}

/** 最近一次构建的 bundle（provide 面供命令侧读取）。 */
let activeBundle: CodeMapBundle | undefined;

export function getCodeMapBundle(): CodeMapBundle | undefined {
  return activeBundle;
}

export function getCodeMapSummary():
  { ready: boolean; root: string; files: number; symbols: number } | undefined {
  return activeBundle?.summary();
}

/**
 * DSH 宿主按 bundle 契约调用：惰性、防御，加载失败只告警；索引惰性（首查时构建）。
 * `config` 透传给 `createCodeMapBundle`（`root` 决定索引根，缺省 cwd）。
 */
export function apply(
  ctx: BundleHost & Record<string, unknown>,
  config: CodeMapConfig = {},
): void {
  const warn = (msg: string): void => {
    ctx.logger?.(name).info(msg) ?? process.stderr.write(`[code-map] ${msg}\n`);
  };
  const bundle = createCodeMapBundle({
    ...config,
    lsp: config.lsp ?? resolveLspReferences(ctx, config.root ?? process.cwd()),
  });
  activeBundle = bundle;
  const tools = (ctx as { tools?: { register(def: unknown): unknown } }).tools;
  if (tools && typeof tools.register === "function") {
    try {
      tools.register(toToolDef(bundle as unknown as CodeMapService));
    } catch (err) {
      warn(`code_map 工具注册失败：${String(err)}`);
    }
  }
  const provideSvc = (
    ctx as { provide?: (key: string, value: unknown) => unknown }
  ).provide;
  if (typeof provideSvc === "function") {
    provideSvc("codeMap", {
      getSummary: () => getCodeMapSummary(),
      getBundle: () => getCodeMapBundle(),
    });
  }
}

/** LSP 位置 → 候选引用（uri 非 file: / 相对路径 → 跳过；text 不读取，置空串）。 */
function locationToRef(loc: LspLocation): CandidateRef | undefined {
  const file = uriToPath(loc.uri);
  if (file === undefined) return undefined;
  return {
    file,
    line: loc.range.start.line,
    column: loc.range.start.character,
    text: "",
  };
}

/** `file:` URI → 本地路径（非 file: 且非绝对路径 → undefined）。 */
function uriToPath(uri: string): string | undefined {
  if (uri.startsWith("file:")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return undefined;
    }
  }
  return uri.startsWith("/") ? uri : undefined;
}

function byFileLine(a: CandidateRef, b: CandidateRef): number {
  return a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1;
}
