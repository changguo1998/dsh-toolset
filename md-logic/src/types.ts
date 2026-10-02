/**
 * src/types.ts — md-logic 的结构模型：单文件 Markdown 的「逻辑结构」（节树 + 块 + 链接）。
 *
 * 约定：
 * - 行号一律 **1 基**，行范围含两端（`line..endLine`）；
 * - 节范围口径与 `fs-digest` 的 `scanMarkdown()` **对齐**（节 = 标题行 → 下一个层级 ≤ 本节标题的
 *   前一行，尾空行不计；父子是**包含关系**，父 ⊇ 子），差异只在解析器精度（见 README 边界段）；
 * - 块 `kind` 沿用 `fs-digest` 的 `frontmatter|code|table|list|quote`，另加 `html|hr`；
 * - 结果全 JSON-serializable（工具返回值约束）。
 */

/** 块级结构种类。 */
export type MdBlockKind =
  "frontmatter" | "code" | "table" | "list" | "quote" | "html" | "hr";

/** 链接条目种类：行内链接 / 图片 / 引用式定义（`[tag]: url`）。 */
export type MdLinkKind = "link" | "image" | "definition";

/** 节树节点（标题）。 */
export interface SectionNode {
  /** 标题层级（1-6）。 */
  level: number;
  /** 标题文本（去掉 `#` 与前后的 `#`；setext 取标题行文本）。 */
  title: string;
  /** 1 基行号（标题所在行）。 */
  line: number;
  /** 1 基行号（本节结束行，含；含所有子节）。 */
  endLine: number;
  children: SectionNode[];
}

/** 块级结构（平铺清单，不污染节树层级）。 */
export interface MdBlock {
  kind: MdBlockKind;
  /** 1 基起始行（含）。 */
  line: number;
  /** 1 基结束行（含）。 */
  endLine: number;
  /** 所属节的标题行号（1 基）；块在首个标题之前时省略。 */
  section?: number;
  /** 列表：条目总数（含嵌套）；表格：数据行数（不含表头与分隔行）；frontmatter：键数；引用：块行数。 */
  count?: number;
  /** 列表 / 引用的最大嵌套层数（1 = 不嵌套）。 */
  depth?: number;
  /** 表格列数（表头单元格数）。 */
  cols?: number;
  /** 代码块围栏语言标注。 */
  lang?: string;
}

/** 链接、图片与引用式定义。 */
export interface MdLink {
  kind: MdLinkKind;
  /** 链接文本（图片为其 alt 文本；定义为 `tag`）。 */
  text: string;
  href: string;
  title?: string;
  /** 1 基行号。 */
  line: number;
  /** 所属节的标题行号（1 基）；无节归属时省略。 */
  section?: number;
}

/** frontmatter 摘要。 */
export interface FrontmatterInfo {
  /** 1 基起始行（恒为 1）。 */
  line: number;
  /** 1 基结束行（收尾 `---` 行）。 */
  endLine: number;
  /** 顶层键名（去重、保序）。 */
  keys: string[];
}

/** 解析结果。 */
export interface MarkdownDocument {
  /** 总行数（1 基计数，即 `split(/\r?\n/).length`）。 */
  lines: number;
  /** frontmatter（仅文件首行且配对时存在）。 */
  frontmatter?: FrontmatterInfo;
  /** 节树（按文档顺序）。 */
  sections: SectionNode[];
  /** 块清单（按文档顺序）。 */
  blocks: MdBlock[];
  /** 链接清单（按文档顺序）。 */
  links: MdLink[];
}

/** 解析选项。 */
export interface ParseOptions {
  /** 关闭 frontmatter 识别（默认开启：仅文件首行 + 有界配对 + 内部只含 YAML 键 / 注释 / 空行）。 */
  frontmatter?: boolean;
  /** frontmatter 配对搜索的最大行数（默认 40，防止把 `---` 水平线当 frontmatter 吞掉正文）。 */
  frontmatterMaxLines?: number;
}
