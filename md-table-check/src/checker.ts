/**
 * md-table-check 判定核心：检查 markdown 文本里的表格列数是否一致。
 *
 * 口径对齐 TUI 的表格解析（`TUI/src/app/layout/table.ts`）：`splitCells`（`:72`）的切分与剥除规则、
 * 分隔格形状（`:120`）、围栏内行跳过（`TUI/src/app/layout/markdown.ts:775` + `build-box.ts:696` 的
 * `inFence` 守卫）都按同一语义重写（本包不引 TUI 内部模块）。**唯一放宽**：TUI 还要求分隔行与表头
 * 列数相等才算表格（`table.ts:147`），本插件不要求 —— 正是这条不满足时 TUI 把整表退回纯文本，
 * 也正是本插件要报出的情形。
 *
 * 纯函数、零依赖、无 IO。
 */

/** 该行是否含未转义 `|`（口径同 TUI `table.ts:103` `hasCellPipe`）。 */
export function hasCellPipe(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "|") return true;
  }
  return false;
}

/**
 * 表格行 → 单元格（口径同 TUI `table.ts:72` `splitCells`）：`\` 转义吞掉下一个字符（`\|` 不切）、
 * `|` 切分、剥除行首尾空单元格、每格 `trim`；行内无未转义 `|` 时返回 null。
 */
export function splitCells(line: string): string[] | null {
  const cells: string[] = [];
  let cur = "";
  let sawPipe = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\") {
      cur += ch;
      const next = line[i + 1];
      if (next !== undefined) {
        cur += next;
        i += 1;
      }
      continue;
    }
    if (ch === "|") {
      sawPipe = true;
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  if (!sawPipe) return null;
  if (cells.length > 0 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((cell) => cell.trim());
}

/** 围栏行（口径同 TUI `markdown.ts:775` `FENCE_RE`）。 */
const FENCE_RE = /^ {0,3}(```+|~~~+)[ \t]*([\w.+-]*)[ \t]*$/;

/** 分隔行单元格 `:?-+:?`（口径同 TUI `table.ts:120` `isDelimCell`）。 */
const DELIM_CELL_RE = /^:?-+:?$/;

/** 每条反馈最多列出的表格数（缺省）。 */
export const DEFAULT_MAX_TABLES = 5;
/** 每张表最多列出的不一致行数（缺省）。 */
export const DEFAULT_MAX_ROWS_PER_TABLE = 3;
/** 表头摘录的字符上限（缺省）。 */
export const DEFAULT_HEADER_EXCERPT_LIMIT = 60;

/** 注入正文的 `source.summary`（展示层与日志按此识别）。 */
export const FEEDBACK_SUMMARY = "表格列数提醒";

/** 一条与表头列数不一致的行。 */
export interface TableLineMismatch {
  /** 1 基行号（相对传入文本）。 */
  line: number;
  /** 行角色：分隔行 / 数据行。 */
  role: "delim" | "row";
  /** 该行实际列数。 */
  actual: number;
}

/** 一张列数不一致的表。 */
export interface TableColumnIssue {
  /** 表头行 1 基行号。 */
  headerLine: number;
  /** 表头行原文（渲染时按 `headerExcerptLimit` 截断）。 */
  headerText: string;
  /** 期望列数（= 表头列数）。 */
  expected: number;
  /** 不一致行（受 `maxRowsPerTable` 约束）。 */
  mismatches: TableLineMismatch[];
  /** 该表不一致行总数（全量）。 */
  mismatchTotal: number;
}

/** 判定与渲染选项（缺省见 `DEFAULT_*` 常量）。 */
export interface CheckOptions {
  /** 每条反馈最多列出几个表格（缺省 5）。 */
  maxTables?: number;
  /** 每张表最多列出几行不一致（缺省 3）。 */
  maxRowsPerTable?: number;
  /** 表头摘录字符上限（缺省 60）。 */
  headerExcerptLimit?: number;
}

/** 判定结果。 */
export interface CheckResult {
  /** 问题表格（受 `maxTables` 约束）。 */
  tables: TableColumnIssue[];
  /** 问题表格总数（全量）。 */
  tableTotal: number;
  /** 不一致行总数（全量）。 */
  lineTotal: number;
}

/** 分隔行样：整行解析后每格都像分隔格（列数与表头不等也算 —— 正是要报的）。 */
function delimRowCells(line: string): string[] | null {
  const cells = splitCells(line);
  if (cells === null || cells.length === 0) return null;
  return cells.every((cell) => DELIM_CELL_RE.test(cell)) ? cells : null;
}

/** 非负整数（非法值回退缺省）。 */
function nonNegativeInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

/**
 * 检查文本里的 markdown 表格列数：围栏外的「表头行 + 分隔行样」为候选表，逐行比对分隔行与数据行。
 * 数据行收集口径同 TUI `parseTableAt:168-176`（`splitCells` 为 null 或长度 0 即表结束）；
 * 只收有列数不一致的表，游标推进到表尾避免把表内行当成新表头。
 */
export function checkTables(text: string, options?: CheckOptions): CheckResult {
  const maxTables = nonNegativeInt(options?.maxTables, DEFAULT_MAX_TABLES);
  const maxRowsPerTable = nonNegativeInt(
    options?.maxRowsPerTable,
    DEFAULT_MAX_ROWS_PER_TABLE,
  );
  const lines = text.split("\n");
  const tables: TableColumnIssue[] = [];
  let tableTotal = 0;
  let lineTotal = 0;
  /** 当前是否在围栏内（栅栏行无条件翻转，见下） */
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      // 栅栏行无条件翻转（不要求闭栅同前缀）——与 TUI `build-box.ts:702-708` 同口径，
      // 故「``` 开 / ~~~ 闭」这类混用标记也能正确闭合（2026-10-16 用户裁定）。
      inFence = !inFence;
      i += 1;
      continue;
    }
    if (inFence) {
      i += 1;
      continue;
    }
    const header = splitCells(line);
    const delim = header === null ? null : delimRowCells(lines[i + 1] ?? "");
    if (header === null || header.length === 0 || delim === null) {
      i += 1;
      continue;
    }
    const expected = header.length;
    const mismatches: TableLineMismatch[] = [];
    if (delim.length !== expected) {
      mismatches.push({ line: i + 2, role: "delim", actual: delim.length });
    }
    let end = i + 2;
    for (; end < lines.length; end++) {
      const cells = splitCells(lines[end]!);
      if (cells === null || cells.length === 0) break;
      if (cells.length !== expected) {
        mismatches.push({ line: end + 1, role: "row", actual: cells.length });
      }
    }
    if (mismatches.length > 0) {
      tableTotal += 1;
      lineTotal += mismatches.length;
      if (tables.length < maxTables) {
        tables.push({
          headerLine: i + 1,
          headerText: line,
          expected,
          mismatches: mismatches.slice(0, maxRowsPerTable),
          mismatchTotal: mismatches.length,
        });
      }
    }
    i = end; // 表内行不再当新表头
  }
  return { tables, tableTotal, lineTotal };
}

/** 表头摘录：超过 limit 个字符则截断并加 `…`。 */
function excerpt(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}…`;
}

/**
 * 渲染注入正文（无问题返回 null）：一条汇总提示，逐表给出表头行号 + 摘录 + 期望列数，以及各不一致行
 * 的行号、角色与实际列数。口径（2026-10-15 用户裁定）：要求模型**更正后重新回复**、明确**不要修改
 * 仓库里的任何文件 / 文档**、声明**只针对回复正文**。**只报不改** —— 本函数只产出文本。
 */
export function renderFeedback(
  text: string,
  options?: CheckOptions,
): { text: string; summary: string } | null {
  const result = checkTables(text, options);
  if (result.tables.length === 0) return null;
  const limit = nonNegativeInt(
    options?.headerExcerptLimit,
    DEFAULT_HEADER_EXCERPT_LIMIT,
  );
  const out: string[] = [
    "[md-table-check] 上一条回复正文里的 markdown 表格列数不一致（本提示只针对回复正文，与仓库文件无关）：",
  ];
  result.tables.forEach((table, index) => {
    out.push(
      `- 表 ${index + 1}（表头在第 ${table.headerLine} 行）：\`${excerpt(table.headerText, limit)}\` 期望 ${table.expected} 列`,
    );
    for (const item of table.mismatches) {
      out.push(
        `  - 第 ${item.line} 行（${item.role === "delim" ? "分隔行" : "数据行"}）：${item.actual} 列`,
      );
    }
  });
  const listed = result.tables.reduce(
    (sum, table) => sum + table.mismatches.length,
    0,
  );
  if (result.lineTotal > listed) {
    out.push(`另有 ${result.lineTotal - listed} 处不一致未列出。`);
  }
  out.push(
    "请修正这些表格后，把上一条回复完整重发一次；不要修改仓库里的任何文件或文档。",
  );
  return { text: out.join("\n"), summary: FEEDBACK_SUMMARY };
}
