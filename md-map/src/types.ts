/**
 * src/types.ts — md-map 的数据模型：项目级文档索引（文档 / 锚点 / 引用边 / 断链）。
 *
 * 约定：
 * - 路径一律为**相对 root 的 POSIX 路径**（`a/b/c.md`）；行号一律 **1 基**；
 * - 单文件结构（标题 / 链接）由 `@dsh-toolset/md-logic` 的 `parseMarkdownDocument()` 提供，
 *   本包只做**项目级关系与影响面**（不重复实现 Markdown 解析）；
 * - 结果全 JSON-serializable（工具返回值约束）。
 */

/** 锚点（文档内的标题锚点）。 */
export interface MdAnchor {
  /** 标题原文。 */
  text: string;
  /** GitHub 风格 slug（小写、去标点、空格转 `-`、重复加 `-1`/`-2`）。 */
  anchor: string;
  /** 标题层级（1-6）。 */
  level: number;
  /** 1 基行号。 */
  line: number;
}

/** 引用边种类。 */
export type MdEdgeKind =
  /** 指向索引内的另一个 `.md`（可带锚点）。 */
  | "internal"
  /** `[[Target]]` / `[[Target|文本]]` / `[[Target#anchor]]`（md-logic 不产，本包补扫）。 */
  | "wiki"
  /** 目标存在但不是 `.md`（对代码 / 文件的引用）。 */
  | "file"
  /** 站外目标（任意 `scheme:` 前缀，如 `http(s)` / `mailto:` / `tel:`；含协议相对 `//`）。 */
  | "external"
  /** 目标路径或锚点不存在。 */
  | "broken"
  /**
   * 行内代码里的**路径引用**（如 `` `docs/BACKLOG.md` ``）：命中索引内文档才成边；
   * 未命中不计（示例路径不该变噪声；计入 `refUnresolved`），多解按候选序（源目录形态优先，与 wiki 同解）。
   */
  | "ref";

/** 一条引用边（出边）。 */
export interface MdEdge {
  kind: MdEdgeKind;
  /** 原始目标文本（未解析）。 */
  target: string;
  /** 解析后的目标文档路径（相对 root；external / 断链时为 undefined）。 */
  to?: string;
  /** 目标锚点 slug（`#` 之后部分）。 */
  anchor?: string;
  /** 锚点在目标文档中是否存在（internal / wiki 且带锚点时有值）。 */
  anchorOk?: boolean;
  /** 链接显示文本。 */
  text?: string;
  /** 1 基行号。 */
  line: number;
}

/** 单个文档的索引结果。 */
export interface MdDoc {
  /** 相对 root 的 POSIX 路径。 */
  path: string;
  /** 总行数。 */
  lines: number;
  anchors: MdAnchor[];
  /** 出边（按行号排序）。 */
  edges: MdEdge[];
  /** 入边数（被本索引内文档引用的次数，含锚点引用）。 */
  backlinks: number;
  /** 是否疑似入口文档（`README*` / `index*` / 根目录的 `*.md`）。 */
  entry?: boolean;
}

/** 断链（路径不存在 / 锚点不存在 / 指向 root 之外）。 */
export interface MdBrockenLink {
  from: string;
  line: number;
  target: string;
  reason: "missing-file" | "missing-anchor" | "outside-root";
}

/** 索引结果。 */
export interface MdMapIndex {
  root: string;
  /** 构建时间（ISO 字符串；便于 summary 判断新鲜度）。 */
  builtAt: string;
  elapsedMs: number;
  /** 是否因 `maxFiles` 截断。 */
  truncated: boolean;
  docs: MdDoc[];
  edges: number;
  externalEdges: number;
  fileEdges: number;
  /** 行内代码路径引用边数（`kind:"ref"`，已计入 `edges`） */
  refEdges: number;
  /** 未解析的行内代码路径 token（0 命中索引的 (行,token) 条数；仅计数，不计断链——文档改名的漂移探针） */
  refUnresolved: number;
  /** 上者中以 `.md` 结尾的子集（文档改名 / 写错路径的直接探针） */
  refUnresolvedMd: number;
  broken: MdBrockenLink[];
}

/** 索引选项。 */
export interface MdMapOptions {
  /** 仓库根（缺省：调用方给的 root → 进程 cwd）。 */
  root?: string;
  /** 文件数上限（缺省 2000；超出截断并标 truncated）。 */
  maxFiles?: number;
  /** 追加排除的目录名 / 相对路径前缀。 */
  exclude?: string[];
}

/** callers 查询结果条目。 */
export interface MdCaller {
  from: string;
  line: number;
  kind: MdEdgeKind;
  /** 该入边带的锚点（若有）。 */
  anchor?: string;
  text?: string;
}

/** impact 查询结果（按层）。 */
export interface MdImpactLayer {
  depth: number;
  docs: string[];
}

/** report 汇总。 */
export interface MdMapReport {
  root: string;
  docs: number;
  anchors: number;
  edges: number;
  externalEdges: number;
  fileEdges: number;
  /** 行内代码路径引用边数（`kind:"ref"`，已计入 `edges`） */
  refEdges: number;
  /** 未解析的行内代码路径 token（仅计数，不计断链——文档改名的漂移探针） */
  refUnresolved: number;
  /** 上者中以 `.md` 结尾的子集（文档改名 / 写错路径的直接探针） */
  refUnresolvedMd: number;
  broken: MdBrockenLink[];
  orphans: string[];
  /** 被引最多的文档（top 10）。 */
  topBacklinks: Array<{ path: string; backlinks: number }>;
  elapsedMs: number;
  truncated: boolean;
}
