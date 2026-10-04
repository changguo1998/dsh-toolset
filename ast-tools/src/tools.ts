// src/tools.ts — ast-tools 的模型侧工具面（库面在 index.ts 与各操作模块）。
// 契约：def = { name, description, parameters(JSON Schema), execute(args), output{ schema, render(_args, value) } }；
// render 形参顺序是「args 第一、value 第二」（宿主契约，写反会导致模型只拿到入参回显）。
// 渲染：紧凑文本而不是 JSON dump；坐标**转 1 基**（库 API 与 ast-grep 输出均为 0 基，见 README）。

import type {
  AstMatch,
  AstRuleHit,
  OutlineFile,
  OutlineSymbol,
  ReplaceResult,
} from "./types.ts";

/** 渲染行上限（各 action 独立计入）。 */
export const RENDER_LIMIT = 80;

/** ast-tools 四操作的最小结构面（`createAstToolsBundle()` 的返回值满足）。 */
export interface AstOperations {
  /**
   * 不可用原因（如 ast-grep 二进制缺失）：存在时各操作不执行，工具直接返回含该原因的错误值。
   * 口径对齐本仓 `code-map` 的降级 bundle——**注册工具 + 调用时降级报错**，而不是隐藏工具面。
   */
  unavailable?: string;
  search(params: {
    pattern: string;
    language: string;
    path: string;
    strictness?: string;
  }): Promise<AstMatch[]>;
  replace(params: {
    pattern: string;
    replacement: string;
    language: string;
    path: string;
    strictness?: string;
    write?: boolean;
  }): Promise<ReplaceResult>;
  outline(params: {
    path: string;
    language?: string;
    items?: string;
    types?: string[];
  }): Promise<OutlineFile[]>;
  rules(params: {
    rule:
      { kind: "file"; rulePath: string } | { kind: "inline"; rules: string };
    paths: string[];
    includeMetadata?: boolean;
    minSeverity?: string;
  }): Promise<AstRuleHit[]>;
}

/** 二进制不可用时的替身操作：`unavailable` 会让 execute 直接返回错误值（方法本身不应被调用）。 */
export function unavailableOps(message: string): AstOperations {
  const unreachable = async (): Promise<never> => {
    throw new Error("ast-tools 不可用（应短路返回 error，不应触达操作）");
  };
  return {
    unavailable: message,
    search: unreachable,
    replace: unreachable,
    outline: unreachable,
    rules: unreachable,
  };
}

/** 截断收尾：超出 `RENDER_LIMIT` 时截断并补一行省略标记。 */
function cap(lines: string[]): string[] {
  if (lines.length <= RENDER_LIMIT) return lines;
  return [
    ...lines.slice(0, RENDER_LIMIT),
    `…（其余 ${lines.length - RENDER_LIMIT} 条略）`,
  ];
}

/** 单行化 + 限长（渲染用；不改库面数据）。 */
function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/** 命中的元变量摘要（`$VAR=a` / `$$$VARS=n节点`）。 */
function metaSummary(match: AstMatch): string {
  const single = match.metaVariables?.single ?? {};
  const multi = match.metaVariables?.multi ?? {};
  const parts = [
    ...Object.entries(single).map(([k, v]) => `$${k}=${oneLine(v.text, 24)}`),
    ...Object.entries(multi).map(([k, v]) => `$$${k}=${v.length}节点`),
  ];
  return parts.length === 0 ? "" : `  {${parts.join(", ")}}`;
}

/** `path:L{line} {text}`（1 基）。 */
function formatMatch(match: AstMatch): string {
  const line = (match.range?.start?.line ?? 0) + 1;
  const col = (match.range?.start?.column ?? 0) + 1;
  return `${match.file}:${line}:${col}  ${oneLine(match.text)}${metaSummary(match)}`;
}

/** 大纲符号（含成员，缩进两级）。 */
function formatSymbol(
  symbol: OutlineSymbol,
  lines: string[],
  depth: number,
): void {
  const line = (symbol.range?.start?.line ?? 0) + 1;
  const sig =
    symbol.signature === "" ? "" : `  ${oneLine(symbol.signature, 80)}`;
  lines.push(
    `${"  ".repeat(depth)}L${line} ${symbol.symbolType} ${symbol.name}${sig}`,
  );
  for (const member of symbol.members ?? []) {
    formatSymbol(member, lines, depth + 1);
  }
}

/** outline 渲染文本。 */
export function renderOutlineFiles(files: OutlineFile[]): string {
  const lines: string[] = [];
  for (const file of files) {
    lines.push(`${file.path}（${file.language}）`);
    for (const item of file.items) formatSymbol(item, lines, 1);
  }
  return cap(lines).join("\n");
}

/** search 渲染文本。 */
export function renderMatches(matches: AstMatch[]): string {
  return cap(matches.map(formatMatch)).join("\n");
}

/** rules 渲染文本：`path:L{line} {severity} {ruleId}: {message}`。 */
export function renderRuleHits(hits: AstRuleHit[]): string {
  const lines = hits.map((hit) => {
    const line = (hit.range?.start?.line ?? 0) + 1;
    const col = (hit.range?.start?.column ?? 0) + 1;
    const sev = hit.severity ?? "info";
    const rule = hit.ruleId ?? "(anonymous)";
    const message =
      hit.message === undefined ? "" : `: ${oneLine(hit.message)}`;
    return `${hit.file}:${line}:${col} ${sev} ${rule}${message}`;
  });
  return cap(lines).join("\n");
}

/** replace 渲染文本（dry-run 明示「未写回」）。 */
export function renderReplace(result: ReplaceResult): string {
  const head = result.written
    ? `已替换 ${result.replacedCount} 处并写回文件`
    : `预览：将替换 ${result.replacedCount} 处（未写回；写入需 write:true）`;
  const lines = [head];
  for (const match of result.matches) {
    const line = (match.range?.start?.line ?? 0) + 1;
    const to =
      match.replacement === undefined ? "" : ` → ${oneLine(match.replacement)}`;
    lines.push(`${match.file}:${line}  ${oneLine(match.text)}${to}`);
  }
  return cap(lines).join("\n");
}

/** 字符串参数读取（空串视为缺省）。 */
function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function strArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

const STRICTNESS = ["cst", "smart", "ast", "relaxed", "signature", "template"];

/** `ast_query` 工具定义（action 分派：search / outline / rules）。 */
export function astQueryTool(ops: AstOperations): unknown {
  return {
    name: "ast_query",
    description:
      "语法级查询（ast-grep）：action=search 按 AST 模式找代码（$VAR 单节点、$$$VAR 序列元变量，" +
      "结构化匹配——不会命中字符串或注释里的同名文本）；action=outline 出文件的语法骨架（类/函数/方法/导入）；" +
      "action=rules 跑 YAML 规则（ast-grep 规则语法，可内联或用规则文件）。" +
      "选择成本：**文本 / 正则检索用宿主的 grep / glob**（更快，但会匹配字符串与注释）；" +
      "「某文件里有哪些符号 / 结构快览」用 fs_digest（outline 带行范围）；" +
      "「谁引用了某符号 / 改动影响面」用 code_map；" +
      "要「所有 foo( 调用点」「某语法形态」「按结构批量定位」时才用 search。" +
      "输出行号是 **1 基**（与 read / grep 一致）。改代码用 ast_replace（默认 dry-run）。",
    parameters: {
      type: "object",
      required: ["action"],
      additionalProperties: true,
      properties: {
        action: {
          type: "string",
          enum: ["search", "outline", "rules"],
          description: "search=AST 模式搜索；outline=语法骨架；rules=YAML 规则",
        },
        pattern: {
          type: "string",
          description:
            "search 用（必填）：ast-grep 模式，如 `console.log($ARG)`",
        },
        language: {
          type: "string",
          description:
            "search 用（必填）：语言名或别名（ts/js/py/go…，如 ts→typescript）；outline 可选（缺省按扩展名推断）",
        },
        path: {
          type: "string",
          description: "search / outline 用（必填）：文件或目录",
        },
        strictness: {
          type: "string",
          enum: STRICTNESS,
          description: "search 用：模式严格度（缺省 ast-grep 默认 smart）",
        },
        items: {
          type: "string",
          enum: ["auto", "structure", "exports", "imports", "all"],
          description: "outline 用：条目范围（缺省 auto）",
        },
        types: {
          type: "array",
          items: { type: "string" },
          description:
            'outline 用：仅保留指定类型的顶层符号，如 ["class", "enum"]',
        },
        rulePath: {
          type: "string",
          description: "rules 用：YAML 规则文件路径（与 rules 二选一）",
        },
        rules: {
          type: "string",
          description:
            "rules 用：内联 YAML 规则文本（与 rulePath 二选一，多条以 --- 分隔）",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "rules 用（必填）：目标文件与 / 或目录列表",
        },
        includeMetadata: {
          type: "boolean",
          description: "rules 用：输出附带规则元数据",
        },
        minSeverity: {
          type: "string",
          enum: ["hint", "info", "warning", "error"],
          description: "rules 用：最低严重度过滤（缺省不过滤）",
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<unknown> {
      if (ops.unavailable !== undefined) return { error: ops.unavailable };
      const action = str(args, "action") ?? "";
      if (action === "search") {
        const pattern = str(args, "pattern");
        const language = str(args, "language");
        const path = str(args, "path");
        if (
          pattern === undefined ||
          language === undefined ||
          path === undefined
        ) {
          return { error: "search 需要 pattern / language / path 三个参数" };
        }
        const strictness = str(args, "strictness");
        const matches = await ops.search({
          pattern,
          language,
          path,
          ...(strictness === undefined ? {} : { strictness }),
        });
        return { action, matches };
      }
      if (action === "outline") {
        const path = str(args, "path");
        if (path === undefined) return { error: "outline 需要 path 参数" };
        const language = str(args, "language");
        const items = str(args, "items");
        const types = strArray(args, "types");
        const files = await ops.outline({
          path,
          ...(language === undefined ? {} : { language }),
          ...(items === undefined ? {} : { items }),
          ...(types.length === 0 ? {} : { types }),
        });
        return { action, files };
      }
      if (action === "rules") {
        const rulePath = str(args, "rulePath");
        const rules = str(args, "rules");
        if (rulePath !== undefined && rules !== undefined) {
          return { error: "rulePath 与 rules 二选一，不能同时给出" };
        }
        if (rulePath === undefined && rules === undefined) {
          return { error: "rules 需要 rulePath 或 rules（内联 YAML）之一" };
        }
        const paths = strArray(args, "paths");
        if (paths.length === 0) return { error: "rules 需要非空的 paths 列表" };
        const includeMetadata = args.includeMetadata === true;
        const minSeverity = str(args, "minSeverity");
        const hits = await ops.rules({
          rule:
            rulePath === undefined
              ? { kind: "inline", rules: rules ?? "" }
              : { kind: "file", rulePath },
          paths,
          ...(includeMetadata ? { includeMetadata: true } : {}),
          ...(minSeverity === undefined ? {} : { minSeverity }),
        });
        return { action, hits };
      }
      return {
        error: `未知 action：${action}（可选 search / outline / rules）`,
      };
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => {
        // 全函数：任何值都要能渲染出文本（不抛），畸形值退化为 (空结果)
        const result =
          value !== null && typeof value === "object"
            ? (value as {
                error?: string;
                action?: string;
                matches?: AstMatch[];
                files?: OutlineFile[];
                hits?: AstRuleHit[];
              })
            : {};
        if (typeof result.error === "string") {
          return [{ type: "text", text: `ast_query 失败：${result.error}` }];
        }
        if (result.matches !== undefined) {
          return [
            {
              type: "text",
              text:
                result.matches.length === 0
                  ? "(无命中)"
                  : renderMatches(result.matches),
            },
          ];
        }
        if (result.files !== undefined) {
          return [
            {
              type: "text",
              text:
                result.files.length === 0
                  ? "(无符号)"
                  : renderOutlineFiles(result.files),
            },
          ];
        }
        if (result.hits !== undefined) {
          return [
            {
              type: "text",
              text:
                result.hits.length === 0
                  ? "(无规则命中)"
                  : renderRuleHits(result.hits),
            },
          ];
        }
        return [
          { type: "text", text: `(空结果：${result.action ?? "unknown"})` },
        ];
      },
    },
  };
}

/** `ast_replace` 工具定义（默认 dry-run，写回需显式 write:true）。 */
export function astReplaceTool(ops: AstOperations): unknown {
  return {
    name: "ast_replace",
    description:
      "语法级结构化替换（ast-grep fix 语义）：按 AST 模式匹配并把命中替换为 replacement（可引用 $VAR）。" +
      "**默认 dry-run**：只返回预览与命中，不改文件；确认无误后再用 write:true 写回。" +
      "写回是**整文件重写、无读后改前版本守卫**（直接 node:fs 写），写前请自行确认文件未被并发修改。" +
      "单点精确改写优先用 hash_edit（LINE:HASH 行级锚点 + 漂移检测 + 整批原子拒绝）；" +
      "按语法形态批量改同一写法才用本工具。",
    parameters: {
      type: "object",
      required: ["pattern", "replacement", "language", "path"],
      additionalProperties: true,
      properties: {
        pattern: {
          type: "string",
          description: "ast-grep 模式，如 `console.log($ARG)`",
        },
        replacement: {
          type: "string",
          description: "替换文本，可引用 $VAR（序列变量按原文展开）",
        },
        language: { type: "string", description: "语言名或别名（ts/js/py…）" },
        path: { type: "string", description: "目标文件（替换不支持目录）" },
        strictness: {
          type: "string",
          enum: STRICTNESS,
          description: "模式严格度（缺省 ast-grep 默认 smart）",
        },
        write: {
          type: "boolean",
          description: "是否写回文件（缺省 false = 仅预览）",
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<unknown> {
      if (ops.unavailable !== undefined) return { error: ops.unavailable };
      const pattern = str(args, "pattern");
      const replacement = str(args, "replacement");
      const language = str(args, "language");
      const path = str(args, "path");
      if (
        pattern === undefined ||
        replacement === undefined ||
        language === undefined ||
        path === undefined
      ) {
        return {
          error: "需要 pattern / replacement / language / path 四个参数",
        };
      }
      const strictness = str(args, "strictness");
      const write = args.write === true;
      const result = await ops.replace({
        pattern,
        replacement,
        language,
        path,
        write,
        ...(strictness === undefined ? {} : { strictness }),
      });
      return result;
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args: unknown, value: unknown) => {
        const result =
          value !== null && typeof value === "object"
            ? (value as Partial<ReplaceResult> & { error?: string })
            : {};
        if (typeof result.error === "string") {
          return [{ type: "text", text: `ast_replace 失败：${result.error}` }];
        }
        if (result.matches === undefined) {
          return [{ type: "text", text: "(空结果)" }];
        }
        return [
          {
            type: "text",
            text: renderReplace({
              updatedSource: "",
              replacedCount: result.replacedCount ?? 0,
              written: result.written === true,
              matches: result.matches,
            }),
          },
        ];
      },
    },
  };
}

/** 两个工具定义（宿主 `ctx.tools.register()` 的入参）。 */
export function toToolDefs(ops: AstOperations): unknown[] {
  return [astQueryTool(ops), astReplaceTool(ops)];
}
