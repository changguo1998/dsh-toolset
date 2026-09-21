/**
 * code-map 核心类型。
 *
 * 结构层产物围绕「文件 + 符号 + import 边」；引用/调用为候选语义
 * （语法级近似，无类型解析），精确确认（LSP 语义层）为增量。
 */

/** 单个符号（来自 ast-grep outline，0-based 行号）。 */
export interface CodeMapSymbol {
  /** 唯一 id：`<file>::<startLine>:<name>`（跨文件/同名/同起始行可区分）。 */
  id: string;
  name: string;
  /** 符号种类（ast-grep astKind：class/function/method/enum/interface 等）。 */
  kind: string;
  /** 绝对路径。 */
  file: string;
  language: string;
  /** 0-based 起始行。 */
  startLine: number;
  /** 0-based 结束行。 */
  endLine: number;
  /** ast-grep 签名文本（方法/类成员签名等），可为空串。 */
  signature: string;
  /** 是否导出（isExported）。 */
  exported: boolean;
}

/** 文件节点（含本文件符号表与 import 说明符）。 */
export interface CodeMapFile {
  path: string;
  language: string;
  symbols: CodeMapSymbol[];
}

/** 结构层产出：文件 + import 边（已解析到绝对路径或 null=外部）。 */
export interface ScanResult {
  files: CodeMapFile[];
  /** 全部 import 尝试（含未解析外部）；found=true 表示已解析到仓库内文件。 */
  imports: FileImport[];
  /** 通过 glob/扩展名收集到的源代码文件数（含无符号/空文件）。 */
  filesScanned: number;
}

/** 一条 import 尝试。 */
export interface FileImport {
  from: string;
  /** 原始说明符（去引号后的相对/裸模块名）。 */
  specifier: string;
  /** 解析到的仓库内绝对路径；外部/无法解析为 null。 */
  to: string | null;
}

/** 候选引用（同一标识符的出现点；是否真引用由精确层裁决）。 */
export interface CandidateRef {
  file: string;
  line: number;
  column: number;
  text: string;
}

export interface IndexResult {
  ready: boolean;
  files: number;
  symbols: number;
  imports: number;
  unresolved: number;
  elapsedMs: number;
  error?: string;
}

export interface CallersResult {
  symbol: string;
  /** 排除定义行本身的候选引用（文件+行+文本）。 */
  refs: CandidateRef[];
  /** 引用去重后的文件列表。 */
  files: string[];
}

export interface ImpactResult {
  /** 目标（文件绝对路径，或符号所在文件）。 */
  target: string;
  /** 直接/传递被该目标依赖（反向 import 闭包）影响的文件。 */
  files: string[];
  /** 受影响文件的模块聚合（相对 root 的首段目录，root 下文件为 "."）。 */
  modules: string[];
}

/** 依赖环（强连通分量，size>=2）。 */
export interface CycleInfo {
  size: number;
  members: string[];
}

/** 模块级统计（模块 = 相对 root 的首段目录，root 下直接文件归 "."）。 */
export interface ModuleStats {
  name: string;
  fileCount: number;
  symbolCount: number;
  /** 本模块 import 的目标模块。 */
  imports: string[];
  /** 反向：依赖本模块的模块。 */
  importedBy: string[];
}

export interface CodeMapReport {
  root: string;
  fileCount: number;
  symbolCount: number;
  importCount: number;
  unresolvedImportCount: number;
  /** 各语言文件数。 */
  languageCounts: Record<string, number>;
  /** 各符号种类计数。 */
  kindCounts: Record<string, number>;
  modules: ModuleStats[];
  /** 文件级依赖环（Tarjan SCC，size>=2）。 */
  moduleCycles: CycleInfo[];
  /** 有导出符号但没有任何文件 import 它的文件。 */
  unimportedExportFiles: string[];
}

/** 代码地图服务（bundle 暴露面，提供 codeMap）。 */
export interface CodeMapService {
  index(opts?: { root?: string }): Promise<IndexResult>;
  refresh(opts?: { root?: string }): Promise<IndexResult>;
  callers(
    symbol: string,
    opts?: { file?: string; kind?: string },
  ): Promise<CallersResult>;
  callees(
    symbol: string,
    opts?: { file?: string },
  ): Promise<{ files: string[] }>;
  impact(target: string): Promise<ImpactResult>;
  cycles(): CycleInfo[];
  report(): CodeMapReport | undefined;
  summary():
    | { ready: boolean; root: string; files: number; symbols: number }
    | undefined;
}
