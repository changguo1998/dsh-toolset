// src/main.ts — dsh bundle 入口 + fs_digest 工具注册。
// 契约对齐 DSH-CTX-API.md：bundle 无 default export，导出 name/inject/Config/apply。

import { resolve } from "node:path";
import { digest, type DigestDeps } from "./digest.ts";
import {
  DIGEST_MODES,
  type DigestOptions,
  type DigestResult,
} from "./types.ts";

export const name = "@dsh-toolset/fs-digest";

/** 注入面：tools（注册 fs_digest）；lsp 面由宿主结构面 duck-typed 复用，不显式注入。 */
export const inject = ["tools"];

/** bundle 配置（JSON-serializable）。 */
export interface Config {
  /** 文件尺寸上限（字节），缺省 2MB。 */
  maxBytes?: number;
}

/** dsh plugin apply 面（结构类型，避免编译期依赖 @deepseek-ai/*）。 */
interface ToolsCtx {
  register(t: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (args: Record<string, unknown>) => Promise<unknown>;
    output: {
      schema: Record<string, unknown>;
      render: (result: unknown) => string;
    };
  }): void;
}
interface PluginCtx {
  cwd?: string;
  tools?: ToolsCtx;
  lsp?: unknown;
  get?: (name: string) => unknown;
}

/** 结果渲染：outline 渲染缩进树（最多 60 行）；signatures 渲染 L<n> 签名；pruned 渲染正文（最多 80 行）。 */
function renderResult(result: DigestResult): string {
  if (!result.ok) {
    return `fs_digest 失败：${result.error} — ${result.message}`;
  }
  if (result.mode === "outline") {
    const lines: string[] = [];
    const walk = (
      nodes: Array<{
        kind: string;
        name: string;
        line: number;
        children: unknown[];
      }>,
      depth: number,
    ): void => {
      for (const n of nodes) {
        if (lines.length >= 60) {
          lines.push("…（其余略）");
          return;
        }
        lines.push(`${"  ".repeat(depth - 1)}L${n.line} ${n.kind} ${n.name}`);
        walk(n.children as typeof nodes, depth + 1);
      }
    };
    walk(
      result.nodes as Array<{
        kind: string;
        name: string;
        line: number;
        children: unknown[];
      }>,
      1,
    );
    if (lines.length === 0) return "(空大纲)";
    return lines.join("\n");
  }
  if (result.mode === "signatures") {
    if (result.signatures.length === 0) return "(无函数签名)";
    return result.signatures
      .map((s) => `L${s.line} ${s.kind} ${s.signature}`)
      .slice(0, 60)
      .join("\n");
  }
  // pruned
  const lines = result.text.split("\n");
  const shown = lines.slice(0, 80);
  if (lines.length > shown.length)
    shown.push(`…（其余 ${lines.length - shown.length} 行）`);
  return shown.join("\n");
}

/** 校验工具入参，返回选项或 null（非法入参）。 */
function parseArgs(
  args: Record<string, unknown>,
): { filePath: string; opts: DigestOptions } | null {
  const filePath = typeof args.path === "string" ? args.path : "";
  if (filePath === "") return null;
  const mode = args.mode;
  if (
    typeof mode !== "string" ||
    !DIGEST_MODES.includes(mode as (typeof DIGEST_MODES)[number])
  ) {
    return null;
  }
  const opts: DigestOptions = { mode: mode as DigestOptions["mode"] };
  if (typeof args.depth === "number") opts.depth = args.depth;
  if (typeof args.maxLines === "number") opts.maxLines = args.maxLines;
  if (typeof args.maxTokens === "number") opts.maxTokens = args.maxTokens;
  if (typeof args.language === "string") opts.language = args.language;
  if (typeof args.requireLsp === "boolean") opts.requireLsp = args.requireLsp;
  return { filePath, opts };
}

/**
 * apply：注册 fs_digest 工具。
 * 文件读取走 node:fs（tool-fs 底座职责的进程内复用），
 * 符号数据走 ctx 结构面 LSP（tool-lsp 底座职责的进程内复用），不可用时降级。
 */
export function apply(ctx: PluginCtx, config: Config): void {
  const tools = ctx.tools;
  if (tools === undefined) return; // inject 未满足时静默跳过（对齐 dsh 插件惯例）
  const deps: DigestDeps = {
    maxBytes: config.maxBytes,
    resolvePath: (input) => resolve(ctx.cwd ?? process.cwd(), input),
  };
  tools.register({
    name: "fs_digest",
    description:
      "上下文感知文件读取：outline（章节/符号大纲）、signatures（函数/方法签名）、" +
      "pruned（大文件头尾裁剪）。相对路径相对会话 cwd；只读，不改文件。",
    parameters: {
      type: "object",
      required: ["path", "mode"],
      properties: {
        path: {
          type: "string",
          description: "文件路径（相对会话 cwd 或绝对路径）",
        },
        mode: {
          type: "string",
          enum: [...DIGEST_MODES],
          description: "outline / signatures / pruned",
        },
        depth: {
          type: "integer",
          minimum: 1,
          description:
            "outline 专用：最大嵌套深度（Markdown = 最大标题级），缺省 3",
        },
        maxLines: {
          type: "integer",
          minimum: 2,
          description:
            "pruned 专用：输出总行数上限（含 1 行省略标记），缺省 200",
        },
        maxTokens: {
          type: "integer",
          minimum: 2,
          description: "pruned 专用：token 估算上限（4 字符/token），缺省 4000",
        },
        language: {
          type: "string",
          description:
            "语言提示（markdown/typescript/python），缺省按扩展名推断",
        },
        requireLsp: {
          type: "boolean",
          description: "true 时 LSP 不可用直接报 lsp_unavailable，不降级启发式",
        },
      },
    },
    execute: async (args: Record<string, unknown>) => {
      const parsed = parseArgs(args);
      if (parsed === null) {
        return {
          ok: false,
          mode: "unknown",
          path: typeof args.path === "string" ? args.path : "",
          error: "invalid_option",
          message: "须提供 path（string）与 mode（outline|signatures|pruned）",
        } satisfies DigestResult;
      }
      return digest(ctx, parsed.filePath, parsed.opts, deps);
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (result: unknown) => renderResult(result as DigestResult),
    },
  });
}

// 便于单测与嵌入复用核心
export { digest } from "./digest.ts";
export type { DigestDeps } from "./digest.ts";
export * from "./types.ts";
