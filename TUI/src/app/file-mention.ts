// src/app/file-mention.ts — `@` 文件提及语法（纯函数：活动 token 识别 + 提及拼写 + 就地替换）
//
// 与宿主 @deepseek-ai/dsh-file-reference 的 grammar 同源复刻。为什么不 import 官方模块：
// TUI 零运行时依赖，src 内无任何 @deepseek-ai/* import，宿主服务一律经结构面 + ctx.get
// 访问（见 adapter/types.ts）；静态 import 官方 grammar 会让**未挂 file-reference 的
// profile 直接 ERR_MODULE_NOT_FOUND**（整包起不来），而本特性本应可降级。官方 Web 客户端
// （dsh-client-ui-input-trigger / dsh-client-ui-reference）同样把这段语法内联进自己的
// bundle，故复刻与本仓既有约定一致。
// 漂移风险由 tests/file-mention.test.ts 兜底：空白后触发 / 邮箱不触发 / 光标位于 token
// 中间 / 含空格走引号 / 目录保持引号 / 不可表示路径返回 undefined。
//
// 语义来源（FILE_REFERENCE_PROMPT）：`@` 前缀 = 用户显式引用的工作区路径，尾随 `/` 表示
// 目录，`@"..."` 表示含空格的路径。提及只是**提示文本**，接受候选不读取文件内容。

/** 候选类别（与官方 FileReferenceCandidate.kind 同构） */
export type FileMentionKind = "file" | "directory";

/** 一条路径候选（官方 FileReferenceCandidate 同构；目录的 path **不带**尾随 `/`） */
export interface FileMentionCandidate {
  path: string;
  kind: FileMentionKind;
}

/** 光标处的活动 `@` token（官方 ActiveAtToken 同构） */
export interface ActiveAtToken {
  /** 接受补全时要被替换掉的完整 token（含 `@` / `@"`） */
  prefix: string;
  /** `@` / `@"` 之后的路径查询文本 */
  query: string;
  /** 用户是否已显式开引号 */
  quoted: boolean;
}

/**
 * 取光标处的活动 `@path` / `@"path with spaces` token。
 * `@` 只在**行首或空白之后**才触发（邮箱里的 `@` 不是补全入口）；光标在 token 中间时
 * 只取光标之前的那一段。多行输入按整个文本判定——换行属空白，故末行 token 同样命中。
 */
export function activeAtToken(
  line: string,
  cursorCol: number,
): ActiveAtToken | undefined {
  const beforeCursor = line.slice(0, Math.max(0, cursorCol));
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { prefix: quoted[1], query: quoted[2], quoted: true };
  }
  const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor);
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined;
  return { prefix: plain[1], query: plain[2], quoted: false };
}

/**
 * 候选 → 提及拼写（官方 formatFileMention 同构）：
 * - 含空白、或用户已显式开引号 → `@"path"` 引号形式；
 * - 目录在尾随 `/` 之后**保持引号打开**（`@"dir/`），以便补全继续下钻；
 * - 无法安全表示的路径（控制字符 / 内嵌引号）返回 undefined。
 */
export function formatFileMention(
  candidate: FileMentionCandidate,
  preserveQuote: boolean,
): string | undefined {
  const path =
    candidate.kind === "directory" ? `${candidate.path}/` : candidate.path;
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;
  if (!(preserveQuote || /\s/u.test(path))) return `@${path}`;
  if (candidate.kind === "directory") return `@"${path}`;
  return `@"${path}"`;
}

/**
 * 接受候选时插入的文本：文件补尾随空格结束该提及（光标落在提及之后）；目录**不加**空格
 * ——面板保持打开、继续列下一级（`@"dir/` 的引号保持打开由 formatFileMention 负责）。
 */
export function mentionInsertText(
  candidate: FileMentionCandidate,
  preserveQuote: boolean,
): string | undefined {
  const text = formatFileMention(candidate, preserveQuote);
  if (text === undefined) return undefined;
  return candidate.kind === "directory" ? text : `${text} `;
}

/**
 * 就地替换（接受候选的编辑语义）：把光标处的活动 token 换成 insert，token 之前与之后的
 * 正文原样保留，光标落到插入文本之后。`prefix` 长度从光标位回推 token 起点。
 */
export function replaceActiveToken(
  line: string,
  cursorCol: number,
  prefix: string,
  insert: string,
): { text: string; cursor: number } {
  const cursor = Math.max(0, Math.min(cursorCol, line.length));
  const start = Math.max(0, cursor - prefix.length);
  const text = line.slice(0, start) + insert + line.slice(cursor);
  return { text, cursor: start + insert.length };
}
