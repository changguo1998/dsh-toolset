// src/main.ts — dsh bundle 入口 + fs_digest 工具注册（package.json main 指向 index.ts，由其 re-export 本模块）。
// 契约对齐 docs/host/DSH-CTX-API.md §0（export { name, inject, Config, apply }）：本包导出
// name / inject / Config / apply，Config 以类型声明给出（interface Config；无运行时 schema，
// 宿主不校验，配置原样透传给 apply；缺省/非法值沿用本包既有语义，不新增校验）。bundle 无 default export。

import { resolve } from "node:path";
import { digest, type DigestDeps } from "./digest.ts";
import { renderOutline } from "./render.ts";
import {
  DIGEST_MODES,
  type DigestOptions,
  type DigestResult,
} from "./types.ts";

export const name = "fs-digest";

/** 注入面：tools（注册 fs_digest）；lsp 面由宿主结构面 duck-typed 复用，不显式注入。 */
export const inject = ["tools"];

/** bundle 配置（JSON-serializable）。 */
export interface Config {
  /** 文件尺寸上限（字节），缺省 2MB。 */
  maxBytes?: number;
}

/** dsh plugin apply 面（结构类型，避免编译期依赖 @deepseek-ai/*）。 */
/** 宿主工具执行上下文的最小形态（结构面：只取当前会话 cwd，见 resolveExecCwd）。 */
interface ToolExecCtx {
  agent?: { session?: { header?: { cwd?: unknown } } };
}
interface ToolsCtx {
  register(t: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      args: Record<string, unknown>,
      exec?: unknown,
    ) => Promise<unknown>;
    output: {
      schema: Record<string, unknown>;
      render: (
        args: unknown,
        value: unknown,
      ) => Array<{ type: string; text: string }>;
    };
  }): void;
}
interface PluginCtx {
  tools?: ToolsCtx;
  lsp?: unknown;
  get?: (name: string) => unknown;
}

/**
 * 本次工具调用的会话 cwd（相对路径解析基准）。
 * 口径对齐宿主 dsh-tool-fs：`exec.agent.session.header.cwd`（0.1.7 起官方同为
 * `exec.agent?.session.header.cwd`）。宿主未传 exec / 非 agent 调用方 / 会话无
 * cwd → 回退 `process.cwd()`（裸进程语义，仅在无会话上下文时生效）。
 * 注意：不可读 `ctx.cwd`——cordis 上下文代理上未 inject 的属性读取会直接抛错
 * （BACKLOG D1 的根因，旧实现的 `ctx.cwd ?? process.cwd()` 兜底永远走不到）。
 */
function resolveExecCwd(exec: unknown): string {
  const agent = (exec as ToolExecCtx | undefined)?.agent;
  const session = agent?.session;
  const cwd = session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/** 结果渲染：outline 走共享渲染器（标题树 ≤45 行 + 块清单 ≤15 行）；signatures 渲染 L<n> 签名；pruned 渲染正文（最多 80 行）。 */
function renderResult(result: DigestResult): string {
  if (!result.ok) {
    return `fs_digest 失败：${result.error} — ${result.message}`;
  }
  if (result.mode === "outline") {
    return renderOutline(result.nodes, result.blocks);
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
 * 相对路径基准 = **调用方会话 cwd**（工具执行上下文第二实参，见 resolveExecCwd）。
 */
export function apply(ctx: PluginCtx, config: Config = {}): void {
  const tools = ctx.tools;
  if (tools === undefined) return; // inject 未满足时静默跳过（对齐 dsh 插件惯例）
  /**
   * 本次调用的相对路径基准（execute 内按最新 exec 更新；digest 层不掌握会话）。
   * 会话内工具调用串行（宿主逐步调度），故此单值即为「本次调用」的基准。
   */
  let sessionCwd = process.cwd();
  const deps: DigestDeps = {
    maxBytes: config.maxBytes,
    resolvePath: (input, cwd) => resolve(cwd === "" ? sessionCwd : cwd, input),
  };
  tools.register({
    name: "fs_digest",
    description:
      "上下文感知文件读取：outline（章节/符号大纲；Markdown 额外给每节行范围与块结构清单" +
      "——列表/表格/代码块/引用，便于按节读而不是整篇读）、signatures（函数/方法签名）、" +
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
            "outline 专用：最大嵌套深度（Markdown = 最大标题级，同时决定行范围与块归属的分辨率），缺省 3",
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
    execute: async (args: Record<string, unknown>, exec?: unknown) => {
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
      sessionCwd = resolveExecCwd(exec);
      return digest(ctx, parsed.filePath, parsed.opts, deps);
    },
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args: unknown, result: unknown) => [
        { type: "text", text: renderResult(result as DigestResult) },
      ],
    },
  });
}

// 便于单测与嵌入复用核心
export { digest } from "./digest.ts";
export type { DigestDeps } from "./digest.ts";
export * from "./types.ts";
