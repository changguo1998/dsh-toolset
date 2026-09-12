/**
 * ast-grep CLI JSON 输出与 API 参数/结果类型。
 *
 * 字段形态以 ast-grep 0.45.x 的 run/scan/outline --json 输出为准；
 * 行号与列号均从 0 起，byteOffset 为文件 UTF-8 编码下的字节偏移。
 */

/** 0-based 行列位置。 */
export interface AstPos {
  line: number;
  column: number;
}

/** 字节偏移区间（闭开）。 */
export interface AstByteRange {
  start: number;
  end: number;
}

/** 节点位置：0-based 行列 + 字节偏移。 */
export interface AstRange {
  start: AstPos;
  end: AstPos;
  byteOffset: AstByteRange;
}

/** 单个元变量捕获（$VAR 单节点或 $$$VAR 序列中的单个节点）。 */
export interface AstMetaVariable {
  text: string;
  range: AstRange;
}

/** 匹配的元变量捕获：single 对应 $VAR，multi 对应 $$$VAR（序列含标点节点）。 */
export interface AstMetaVariables {
  single?: Record<string, AstMetaVariable>;
  multi?: Record<string, AstMetaVariable[]>;
}

/** 单个命中（run/scan --json 元素）。 */
export interface AstMatch {
  text: string;
  range: AstRange;
  file: string;
  lines?: string;
  language?: string;
  metaVariables?: AstMetaVariables;
  /** 提供 rewrite/fix（run -r 或规则 fix）时的替换文本。 */
  replacement?: string;
  /** 替换目标区间（字节偏移）。 */
  replacementOffsets?: AstByteRange;
}

/** 规则命中（scan --json 元素，AstMatch 超集）。 */
export interface AstRuleHit extends AstMatch {
  ruleId?: string;
  severity?: string;
  message?: string;
  note?: string | null;
}

/** 大纲中的单个符号：item 为顶层项，member 为成员（如方法）。 */
export interface OutlineSymbol {
  role: "item" | "member";
  symbolType: string;
  name: string;
  range: AstRange;
  signature: string;
  astKind: string;
  isImport: boolean;
  isExported: boolean;
  isPublic?: boolean;
  members?: OutlineSymbol[];
}

/** outline --json 数组中的单个文件条目。 */
export interface OutlineFile {
  path: string;
  language: string;
  items: OutlineSymbol[];
}

/** 模式严格度（ast-grep atomic-rule#strictness）。 */
export type AstStrictness =
  "cst" | "smart" | "ast" | "relaxed" | "signature" | "template";

/** 通用选项：二进制路径与超时（各操作均可省略，走默认探测/超时）。 */
export interface AstOptions {
  /** 显式指定 ast-grep 二进制路径（优先于一切探测）。 */
  bin?: string;
  /** 子进程超时（毫秒），缺省 30s。 */
  timeoutMs?: number;
}

/** 搜索参数。 */
export interface SearchParams {
  /** ast-grep AST 模式：$VAR 单节点元变量，$$$VAR/$$$ 节点序列元变量。 */
  pattern: string;
  /** 语言名或别名（js→javascript、py→python 等；未知值原样透传给 CLI 校验）。 */
  language: string;
  /** 目标文件或目录路径。 */
  path: string;
  strictness?: AstStrictness;
}

/** 结构化替换参数。 */
export interface ReplaceParams {
  pattern: string;
  /** 替换文本，可引用 $VAR 元变量（CLI fix 语义，序列变量按原文展开）。 */
  replacement: string;
  language: string;
  /** 目标文件（替换要求具体文件，不支持目录输入）。 */
  path: string;
  strictness?: AstStrictness;
  /** 是否把替换结果写回文件（缺省 false，仅内存返回）。 */
  write?: boolean;
}

/** 结构化替换结果。 */
export interface ReplaceResult {
  /** 替换后的完整文件内容（UTF-8）。 */
  updatedSource: string;
  /** 实际应用的替换数。 */
  replacedCount: number;
  /** 是否已写回磁盘。 */
  written: boolean;
  /** CLI 原始命中（含 replacement/replacementOffsets）。 */
  matches: AstMatch[];
}

/** outline --items 选项（auto 时文件输入取 structure，目录输入取 exports）。 */
export type OutlineItems = "auto" | "structure" | "exports" | "imports" | "all";

/** 大纲参数。 */
export interface OutlineParams {
  /** 文件或目录路径。 */
  path: string;
  /** 语言（文件输入可省略由 CLI 按扩展名推断）。 */
  language?: string;
  items?: OutlineItems;
  /** 仅保留指定类型的顶层符号（如 ["class", "enum"]）。 */
  types?: string[];
}

/** 规则来源：YAML 规则文件，或内联 YAML 文本（多规则以 --- 分隔）。 */
export type RuleSource =
  { kind: "file"; rulePath: string } | { kind: "inline"; rules: string };

/** 规则执行参数。 */
export interface RunRulesParams {
  rule: RuleSource;
  /** 目标文件与/或目录列表。 */
  paths: string[];
  /** JSON 输出中附带规则元数据。 */
  includeMetadata?: boolean;
  /** 最低严重度过滤：info | warning | error | help。 */
  minSeverity?: "info" | "warning" | "error" | "help";
}
