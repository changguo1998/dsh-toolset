// src/edit.ts — 按节改写：结构漂移检测 + 整批原子写。
//
// 安全语义（与工具描述一致）：
// - **漂移即拒**：每条 edit 带 `heading`（标题文本，与 `structure` 输出一致）+ `startLine` / `endLine`
//   （该节行范围，来自 `structure`）；替换前重新解析，要求「同标题 + 同范围」仍成立，否则拒绝并回报当前范围；
// - **整批原子**：全部 edit 校验通过才算新文本；任何一条失败 → 整体不落盘（文件字节不变）；
// - **原文风格保留**：BOM 与换行风格（`\r\n` / `\n`）原样保留，避免整文件 diff；
// - 不做 Markdown 语法校验（只保证结构漂移安全 + content 结构守卫：非空 content 必须以标题行开头，
//   首行标题层级须与目标节一致、首行之外只允许更深层级——否则会静默改变其后节的归属）。
//
// 分工：`hash_edit` 是行级 LINE:HASH 锚点（细粒度行编辑）；官方 `edit` 是文件级字符串替换 + 版本守卫；
// 本模块是**按节**（标题 + 行范围）整节替换 / 删除。

import {
  chmod,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { parseMarkdownDocument } from "./parse.ts";
import { flattenSections } from "./query.ts";

/**
 * content 内的**未闭合块**检测（①.5 结构守卫用）：CommonMark 里未闭合的代码围栏与 `<!--`
 * 都**直到文件结尾**才结束 → 写入后其后所有行被并进该块，**节从节树里静默消失**（既有
 * fenced 守卫与层级守卫都不拦：吞并发生在 parser 内部，解析结果「少了几节」且不报错）。
 * 扫描口径对齐 CommonMark 的**起点判定**（误拒会挡掉合法写入，故只拦「确实会吞块」的写法）：
 * - 围栏开栏：`^ {0,3}(` + 三连反引号 / 波浪号 + `)`，且**反引号围栏的 info 串不得含反引号**
 *   （含反引号的行是普通文本——漏判会把「后面的真开栏」误当闭行，真吞节却放行）；
 * - 围栏闭行：同字符、长度 ≥ 开栏、除空白外无 info；
 * - 注释开栏：**行首**（≤3 空格）的 `<!--`（段中 / 列表 / 缩进代码块里的 `<!--` 是行内 HTML，
 *   不吞块）；注释开栏期内**不认围栏**（注释块内一切都是字面内容），等 `-->` 收束；
 * - 行内代码先剥离（`` `<!--` `` 不是注释）；上述之外不判。
 * @param content - 已归一的 content 文本（调用方保证换行为 `\n`）
 * @returns 未闭合说明（直接可用的错误文案）；配对正常 → `undefined`
 */
function unclosedBlockReason(content: string): string | undefined {
  const lines = content.split("\n");
  let fence: { char: string; size: number; line: number } | undefined;
  let commentLine: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;
    // 注释块内：一切（含围栏符号 / 行内代码）都是注释内容，只等 `-->`
    if (commentLine !== undefined) {
      if (line.includes("-->")) commentLine = undefined;
      continue;
    }
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence !== undefined) {
      // 围栏内不判注释（`<!--` 属代码内容）
      const closer = fenceMatch?.[1];
      if (
        closer !== undefined &&
        closer[0] === fence.char &&
        closer.length >= fence.size &&
        (fenceMatch?.[2] ?? "").trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    const opener = fenceOpener(fenceMatch);
    if (opener !== undefined) {
      fence = { char: opener.char, size: opener.size, line: lineNo };
      continue;
    }
    // 行内代码里的 `<!--` 不是注释（CommonMark 先解析 code span）
    const scrubbed = line.replace(/`+[^`]*`+/g, "");
    // 注释开栏：行首（≤3 空格）的 `<!--`，且本行内没有 `-->` 配对（HTML block type 2 在
    // 首个 `-->` 处结束 → 同行配对不吞块）
    if (/^ {0,3}<!--/.test(scrubbed) && !scrubbed.includes("-->")) {
      commentLine = lineNo;
    }
  }
  if (fence !== undefined) {
    return (
      `edit.content 内第 ${fence.line} 行的代码围栏未闭合（${fence.char.repeat(fence.size)}）：` +
      "CommonMark 里未闭合围栏直到文件结尾，会把**其后所有节**并进该块（节从节树消失）；" +
      "补上闭合行，或改用 hash_edit / 官方 edit"
    );
  }
  if (commentLine !== undefined) {
    return (
      `edit.content 内第 ${commentLine} 行的 HTML 注释未闭合（\`<!--\` 缺 \`-->\`）：` +
      "注释直到文件结尾，会吞掉其后所有节；补上 `-->`，或改用 hash_edit / 官方 edit"
    );
  }
  return undefined;
}

/**
 * 围栏开栏判定（CommonMark）：反引号围栏的 info 串**不得含反引号**（含则整行只是普通文本，
 * 若误当开栏，「后面真正的开栏」会被当成闭行 → 真吞节却放行）；波浪号围栏无此限制。
 * @param match - `^ {0,3}(`{3,}|~{3,})(.*)$` 的匹配结果（未匹配传 `null`）
 * @returns 开栏字符与长度；不是开栏 → `undefined`
 */
function fenceOpener(
  match: RegExpExecArray | null,
): { char: string; size: number } | undefined {
  if (match === null) return undefined;
  const marks = match[1] ?? "";
  const info = match[2] ?? "";
  const char = marks[0] ?? "`";
  if (char === "`" && info.includes("`")) return undefined;
  return { char, size: marks.length };
}

/** 一条按节改写指令 */
export interface SectionEdit {
  /** 目标节标题文本（与 `structure` 渲染一致，不含 `#`） */
  heading: string;
  /** 该节起始行（1 基，含标题行；来自 `structure` 的 `L{start}-{end}`） */
  startLine: number;
  /** 该节结束行（1 基，含端点；来自 `structure`） */
  endLine: number;
  /** 整节新文本（**含标题行**；空串 = 删除该节） */
  content: string;
  /**
   * 可选：目标节的**内容 hash**（`structure` 输出的 `·#xxxxxxxx`）——与当前内容不符时拒改
   * （`section_stale`），补「同标题 + 同范围但节体 / 层级已被外部改动」的漂移盲区。
   */
  sectionHash?: string;
}

export type EditFailureCode =
  | "edits_invalid"
  | "content_invalid"
  | "section_missing"
  | "section_drift"
  /** 节标题与范围都对，但**内容 hash** 不符（节体被外部改动）。 */
  | "section_stale"
  | "section_ambiguous"
  | "overlap"
  | "read_failed"
  /** 读→写之间目标文件被外部改动 / 原子替换（TOCTOU 复核失败）。 */
  | "file_changed"
  | "write_failed"
  | "not_utf8"
  | "range_out_of_bounds";

/**
 * 节内容 hash：`sha256(节原文行 [line, endLine] 含端点，以 \n 连接)` 前 8 位小写 hex。
 * 风格无关（BOM / `\r\n` 不参与，与 parse 同归一）；覆盖**标题行与全部子节**——
 * 故改子节会连带使所有祖先节的 hash 变化（fail-safe）。行内容空白敏感（不 trim）。
 */
export function sectionHash(
  text: string,
  line: number,
  endLine: number,
): string {
  const lines = normalize(text)
    .split("\n")
    .slice(line - 1, endLine);
  return createHash("sha256")
    .update(lines.join("\n"))
    .digest("hex")
    .slice(0, 8);
}

/** 文件签名（读→写之间的 TOCTOU 复核；`ino` 用于识别「原子替换」写法，不对外展示）。 */
export interface FileSignature {
  ino: number | bigint;
  size: number;
  mtimeMs: number;
}

/** 签名是否相同（抽成纯函数便于单测；竞态本身无注入点、不单测）。 */
export function sameSignature(a: FileSignature, b: FileSignature): boolean {
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

export type ReplaceOutcome =
  | { ok: true; text: string; applied: number }
  | { ok: false; code: EditFailureCode; error: string; details?: unknown };

/** 原文风格（BOM / 换行） */
interface TextFlavor {
  bom: string;
  crlf: boolean;
  /** 混合 EOL（同时存在 `\r\n` 与独立的 `\n`）。 */
  mixed: boolean;
  /** 主导 EOL（多数派；并列取 `\n`）——仅 `mixed` 时用于新增行。 */
  dominant: "\n" | "\r\n";
}

function flavorOf(text: string): TextFlavor {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom === "" ? text : text.slice(1);
  const crlfCount = (body.match(/\r\n/g) ?? []).length;
  // 独立 LF = 总数 - CRLF 数（`\r\n` 里的 `\n` 不算独立 LF）
  const lfTotal = (body.match(/\n/g) ?? []).length;
  const lfOnly = lfTotal - crlfCount;
  const mixed = crlfCount > 0 && lfOnly > 0;
  return {
    bom,
    crlf: crlfCount > 0,
    mixed,
    dominant: crlfCount > lfOnly ? "\r\n" : "\n",
  };
}

/** 按行切开原文并记录**每行原有的 EOL**（末行无 EOL 时记为 `""`）。 */
function splitWithEols(text: string): { lines: string[]; eols: string[] } {
  const body = text.replace(/^\uFEFF/, "");
  const lines: string[] = [];
  const eols: string[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "\n") continue;
    const isCrlf = i > start && body[i - 1] === "\r";
    lines.push(body.slice(start, isCrlf ? i - 1 : i));
    eols.push(isCrlf ? "\r\n" : "\n");
    start = i + 1;
  }
  lines.push(body.slice(start));
  eols.push("");
  return { lines, eols };
}

/**
 * 混合 EOL 文件：**未改动的行保留原有 EOL**（前缀 / 后缀对齐），仅新增/替换的行用 dominant。
 * 这样 `replace` 不会把整文件行尾翻转（diff 最小化）。
 */
function rebuildMixed(
  lines: string[],
  flavor: TextFlavor,
  original: string,
): string {
  const { lines: origLines, eols: origEols } = splitWithEols(original);
  let prefix = 0;
  while (
    prefix < lines.length &&
    prefix < origLines.length &&
    lines[prefix] === origLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < lines.length - prefix &&
    suffix < origLines.length - prefix &&
    lines[lines.length - 1 - suffix] ===
      origLines[origLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  let out = flavor.bom;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    let eol: string;
    if (i < prefix) {
      const orig = origEols[i] ?? flavor.dominant;
      // `""` 只对**输出末行**合法（原文末行无 EOL）；否则会与下一行粘连（审阅 P1）
      eol = orig === "" && i !== lines.length - 1 ? flavor.dominant : orig;
    } else if (i >= lines.length - suffix) {
      const orig =
        origEols[origLines.length - (lines.length - i)] ?? flavor.dominant;
      eol = orig === "" && i !== lines.length - 1 ? flavor.dominant : orig;
    } else {
      eol = i === lines.length - 1 ? "" : flavor.dominant;
    }
    out += line + eol;
  }
  return out;
}

/** 归一化：剥 BOM + `\r\n?` → `\n`（与 parse.ts 同口径） */
function normalize(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** 按原文风格重建（内容行已按 `\n` 拼接）；混合 EOL 走 `rebuildMixed`（逐行保留） */
function rebuild(
  lines: string[],
  flavor: TextFlavor,
  original: string,
): string {
  if (flavor.mixed) return rebuildMixed(lines, flavor, original);
  const joined = lines.join("\n");
  return flavor.bom + (flavor.crlf ? joined.replace(/\n/g, "\r\n") : joined);
}

/** 校验一条 edit 的值域（不触盘）。 */
function invalidReason(edit: unknown): string | undefined {
  if (edit === null || typeof edit !== "object" || Array.isArray(edit)) {
    return "edit 必须是对象 {heading, start_line, end_line, content}";
  }
  const e = edit as Record<string, unknown>;
  if (typeof e["heading"] !== "string" || e["heading"] === "") {
    return "edit.heading 必须是非空字符串（标题文本，与 structure 输出一致）";
  }
  const start = e["startLine"];
  const end = e["endLine"];
  if (typeof start !== "number" || !Number.isInteger(start) || start < 1) {
    return "edit.startLine 必须是 >=1 的整数（来自 structure）";
  }
  if (typeof end !== "number" || !Number.isInteger(end) || end < start) {
    return "edit.endLine 必须是 >=startLine 的整数（来自 structure）";
  }
  if (typeof e["content"] !== "string") {
    return "edit.content 必须是字符串（整节新文本，含标题行；空串 = 删除该节）";
  }
  return undefined;
}

/**
 * 纯函数：校验 + 整批替换（全部通过才返回新文本；**不碰磁盘**）。
 * 坐标一律相对**当前文本**（调用方给的 `startLine` / `endLine` 必须与当前解析结果一致）。
 */
export function replaceSections(
  text: string,
  edits: SectionEdit[],
): ReplaceOutcome {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, code: "edits_invalid", error: "edits 必须是非空数组" };
  }
  for (const edit of edits) {
    const reason = invalidReason(edit);
    if (reason !== undefined) {
      return { ok: false, code: "edits_invalid", error: reason };
    }
  }
  const flavor = flavorOf(text);
  const normalized = normalize(text);
  // 行数组：⓪ 越界、①.5 setext 邻接检查、③ 应用共用（③ 的 splice 就地修改本数组）
  const lines = normalized.split("\n");
  const parsed = parseMarkdownDocument(normalized);
  const flat = flattenSections(parsed.sections);

  // ⓪ 行号越界先判（若落到漂移分支，报「范围已变」会误导）
  const totalLines = lines.length;
  for (const edit of edits) {
    if (edit.endLine > totalLines) {
      return {
        ok: false,
        code: "range_out_of_bounds",
        error: `edit.endLine ${edit.endLine} 超出文件行数 ${totalLines}（范围应来自 structure，请重取）`,
      };
    }
  }

  // ① 逐条定位 + 漂移校验（同标题 + 同范围仍成立）
  const located: {
    edit: SectionEdit;
    line: number;
    endLine: number;
    /** 目标节当前标题层级（content 首行标题须与之一致，见 ①.5 层级守卫） */
    level: number;
  }[] = [];
  for (const edit of edits) {
    const sameTitle = flat.filter((node) => node.title === edit.heading);
    if (sameTitle.length === 0) {
      return {
        ok: false,
        code: "section_missing",
        error: `找不到标题为「${edit.heading}」的节（先 action=structure 取最新结构）`,
      };
    }
    const exact = sameTitle.filter(
      (node) => node.line === edit.startLine && node.endLine === edit.endLine,
    );
    if (exact.length === 0) {
      return {
        ok: false,
        code: "section_drift",
        error:
          `节「${edit.heading}」的行范围已变（结构漂移）：你给 ${edit.startLine}-${edit.endLine}，` +
          `当前为 ${sameTitle.map((node) => `${node.line}-${node.endLine}`).join(" / ")}；请重新 structure 后再改`,
        details: sameTitle.map((node) => ({
          line: node.line,
          endLine: node.endLine,
        })),
      };
    }
    const only = exact[0];
    if (only === undefined) {
      return {
        ok: false,
        code: "section_ambiguous",
        error: "内部错误：定位结果为空",
      };
    }
    // ①-inner 内容 hash 锚点（只在该 edit 带 section_hash 时生效）：标题与范围都对、
    //          但节体 / 层级被外部改过 → section_stale（fail-safe，不落盘）
    if (edit.sectionHash !== undefined) {
      const current = sectionHash(text, only.line, only.endLine);
      if (current !== edit.sectionHash.trim().toLowerCase()) {
        return {
          ok: false,
          code: "section_stale",
          error:
            `节「${edit.heading}」的内容已被外部改动（内容 hash 不符）：你给 #${edit.sectionHash.trim().toLowerCase()}，` +
            `当前 #${current}；可能有人在 structure 之后改了该节（含其子节），请重新 structure 取最新 hash 与范围`,
          details: [{ line: only.line, endLine: only.endLine, hash: current }],
        };
      }
    }
    located.push({
      edit,
      line: only.line,
      endLine: only.endLine,
      level: only.level,
    });
  }

  // ①.5 content 结构守卫（放在①后：漂移 / 缺失优先，保持既有错误优先级）：
  //      非空 content 必须以标题行开头（ATX / setext），否则该节会被静默并入父节（节从节树消失）；
  //      空串 = 删除该节。setext 首行还会把紧邻的上一段吞进标题文本，故目标节前一行非空时要求 ATX。
  //      首行标题的**层级**须与目标节一致（标题文本可不同 = 合法重命名，放行）：节树按层级嵌套，
  //      改层级会连带改变其后同级 / 更低级别节的归属（父节被吞或子节被挤出），故拒绝并要求显式路径；
  //      content 内**首行之外**的标题只允许更深层级（同级 / 更高级同样会改动后续节的归属）。
  for (const item of located) {
    const content = item.edit.content;
    if (content === "") continue; // 空串 = 删除该节（既有语义）
    const normalizedContent = normalize(content);
    const first = parseMarkdownDocument(normalizedContent).sections[0];
    if (first === undefined || first.line !== 1 || first.title === "") {
      return {
        ok: false,
        code: "content_invalid",
        error:
          `edit.content 必须以标题行开头（ATX 或 setext；删除整节请传空串）：「${item.edit.heading}」的 content ` +
          `首个标题${first === undefined ? "不存在" : `在第 ${first.line} 行`}；` +
          "常见成因：首行是正文 / 前导空行 / 4 空格缩进被当代码块",
      };
    }
    const firstLine = normalizedContent.split("\n")[0] ?? "";
    const isAtx = /^ {0,3}#{1,6}(\s|$)/.test(firstLine);
    const above = item.line > 1 ? (lines[item.line - 2] ?? "") : "";
    if (!isAtx && above.trim() !== "") {
      return {
        ok: false,
        code: "content_invalid",
        error:
          `edit.content 的 setext 标题会吞并紧邻的上一段（第 ${item.line - 1} 行非空），标题文本会变成「上一段 + content 首行」；` +
          `改用 ATX 标题（如「## ${first.title}」）`,
      };
    }
    // 层级守卫：标题文本可以变（重命名），层级不能悄悄变——节树按层级嵌套，改层级会连带
    // 改变其后同级 / 更低级别节的归属（例：h2 → h3 会把后续节变成该节的子节）
    if (first.level !== item.level) {
      return {
        ok: false,
        code: "content_invalid",
        error:
          `edit.content 首行标题的层级与目标节不一致（content 为 h${first.level}，节「${item.edit.heading}」为 h${item.level}）：` +
          "改层级会连带改变其后同级 / 更低级别节的归属（节树按层级嵌套），故拒绝；" +
          '确需改层级时改写**父节**的 content（把该节及其子节一并按新层级写入），或先用 content="" 删除该节后在父节内重建；' +
          "顶层节（无父节）改层级请改用 hash_edit / 官方 edit 整体改写（replace 只在节树内保证结构安全）",
      };
    }
    // 首行之外的标题也不能「≤ 目标节层级」：内嵌同级 / 更高级标题同样会改动其后节的归属
    // （例：h2 节的 content 里写 `# 偷渡` → 该节被提前收束，后续同级节被吞进新顶层节）
    const stray = flattenSections(
      parseMarkdownDocument(normalizedContent).sections,
    )
      .slice(1)
      .find((node) => node.level <= item.level);
    if (stray !== undefined) {
      return {
        ok: false,
        code: "content_invalid",
        error:
          `edit.content 内含层级不高于目标节的标题（「${stray.title}」为 h${stray.level}，节「${item.edit.heading}」为 h${item.level}）：` +
          "会改变其后同级 / 更低级别节的归属（节树按层级嵌套）；" +
          `content 内除首行标题（须为 h${item.level}）外只允许**更深**层级的标题（h${item.level + 1} 及以下）`,
      };
    }
    // 内容级配对守卫（①.5 收尾）：未闭合围栏 / 注释会吞掉其后**全部节**（静默结构破坏）
    const unclosed = unclosedBlockReason(normalizedContent);
    if (unclosed !== undefined) {
      return { ok: false, code: "content_invalid", error: unclosed };
    }
  }

  // ② 重叠拒绝（父节与其子节同时被改、同一节两条 edits 都属重叠）
  const sorted = [...located].sort((a, b) => a.line - b.line);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (prev === undefined || curr === undefined) continue;
    if (curr.line <= prev.endLine) {
      return {
        ok: false,
        code: "overlap",
        error: `edits 区间重叠：${prev.edit.heading}（${prev.line}-${prev.endLine}）与 ${curr.edit.heading}（${curr.line}-${curr.endLine}）`,
      };
    }
  }

  // ③ 自下而上应用（坐标基于原文，倒序 splice 不受前面改动影响；lines 为上方共享数组）
  for (const item of [...located].sort((a, b) => b.line - a.line)) {
    // 尾随单个换行 = 行终止符（模型常规写法会带），不当作空行，避免累积空行
    const normalizedContent = normalize(item.edit.content);
    const trimmed = normalizedContent.endsWith("\n")
      ? normalizedContent.slice(0, -1)
      : normalizedContent;
    const contentLines = item.edit.content === "" ? [] : trimmed.split("\n");
    lines.splice(item.line - 1, item.endLine - item.line + 1, ...contentLines);
  }
  return {
    ok: true,
    text: rebuild(lines, flavor, text),
    applied: located.length,
  };
}

/** 相对路径以 root（缺省进程 cwd）为基准解析。 */
function resolveTarget(filePath: string, root?: string): string {
  return isAbsolute(filePath)
    ? filePath
    : resolve(root ?? process.cwd(), filePath);
}

/** 落盘：读原文 → 纯函数校验/替换 → **原子写**（同目录临时文件 + rename；失败清理且不落盘）。 */
export async function replaceSectionsFile(
  filePath: string,
  edits: SectionEdit[],
  root?: string,
  /** 读取上限（字节）；与读面同一守卫口径（超限拒绝，避免写路径绕过） */
  maxBytes?: number,
): Promise<ReplaceOutcome & { path?: string }> {
  const target = resolveTarget(filePath, root);
  let buffer: Buffer;
  let mode: number | undefined;
  /** 读盘时的文件签名（写回前复核，挡读→rename 之间的外部改动）。 */
  let signature: FileSignature | undefined;
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      return {
        ok: false,
        code: "read_failed",
        error: "目标不是常规文件，拒绝改写",
      };
    }
    if (maxBytes !== undefined && info.size > maxBytes) {
      return {
        ok: false,
        code: "read_failed",
        error: `文件大小 ${info.size}B 超过上限 ${maxBytes}B`,
      };
    }
    mode = info.mode & 0o777;
    signature = { ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
    buffer = await readFile(target);
  } catch (err) {
    return {
      ok: false,
      code: "read_failed",
      error: `读取失败：${String(err)}`,
    };
  }
  let raw: string;
  try {
    // 写路径禁止有损解码（读面可以）：非 UTF-8 一律拒写，否则会把字节静默改成 U+FFFD
    raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return {
      ok: false,
      code: "not_utf8",
      error: "目标不是合法 UTF-8，拒绝改写",
    };
  }
  if (raw.includes("\u0000")) {
    return {
      ok: false,
      code: "read_failed",
      error: "疑似二进制文件，拒绝改写",
    };
  }
  const outcome = replaceSections(raw, edits);
  if (!outcome.ok) return outcome;

  const tmp = `${target}.md-logic-${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  /** 清理临时文件（失败忽略：目标文件本身未被改动）。 */
  const cleanupTmp = async (): Promise<void> => {
    try {
      await unlink(tmp);
    } catch {
      // 忽略
    }
  };
  try {
    await writeFile(tmp, outcome.text, "utf8");
    if (mode !== undefined) await chmod(tmp, mode); // 保留原权限位（chmod 不受 umask 影响）
    // 读→rename 的 TOCTOU 复核（尽力而为；残余窗口 = 本次 stat 到 rename 之间的微秒级）：
    // 文件被外部改写 / 原子替换（ino 变）→ 拒写，避免把基于旧内容的改写盖上去
    const now = await stat(target);
    if (signature !== undefined && !sameSignature(signature, now)) {
      await cleanupTmp();
      return {
        ok: false,
        code: "file_changed",
        error:
          "目标文件在读取与写回之间被外部改动（size / mtime / ino 变），已放弃写入；请重新 structure 后再改",
        details: { size: now.size, mtimeMs: now.mtimeMs },
      };
    }
    await rename(tmp, target);
  } catch (err) {
    await cleanupTmp();
    return {
      ok: false,
      code: "write_failed",
      error: `写入失败：${String(err)}`,
    };
  }
  return { ...outcome, path: target };
}
