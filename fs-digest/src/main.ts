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
  type MdBlock,
  type OutlineNode,
  type SignatureEntry,
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

/**
 * 结果渲染：outline 走共享渲染器（标题树 ≤45 行 + 块清单 ≤15 行）；signatures 渲染 L<n> 签名；
 * pruned 渲染正文（最多 80 行）。
 * 全函数：任意 value 都返回可读文本（BACKLOG #1）——四分支形状守卫拦下非法 / 缺字段形态，
 * 退回 jsonText(value)；最外层再兜一次异常（守卫够不到的深层畸形），使「render 不抛」成为不变量。
 */
function renderResult(result: unknown): string {
  try {
    return renderDigestResult(result);
  } catch {
    // 深层畸形（如 nodes 元素非对象、异常 getter）：退回 JSON 文本，绝不抛错
    return jsonText(result);
  }
}

/** 结构化渲染：逐分支形状守卫；任一必填字段缺失 / 类型错 → 退 jsonText 兜底文本（不改合法形状的输出）。 */
function renderDigestResult(result: unknown): string {
  const rec = asRecord(result);
  if (rec === undefined) return jsonText(result); // undefined / null / 原始值
  if (rec.ok === false) {
    // 失败分支：error / message 齐备（string）才用原文案，否则退 JSON（不渲染 "undefined — undefined"）
    if (typeof rec.error !== "string" || typeof rec.message !== "string") {
      return jsonText(result);
    }
    return `fs_digest 失败：${rec.error} — ${rec.message}`;
  }
  if (rec.ok !== true) return jsonText(result); // ok 缺失 / 非布尔（含 {} 与 mode 缺失）
  if (rec.mode === "outline") {
    const nodes = asArray<OutlineNode>(rec.nodes);
    const blocks = asArray<MdBlock>(rec.blocks);
    // nodes 必填；blocks 选填（缺省不渲染块清单），present 但非数组 = 字段类型错 → 兜底
    if (
      nodes === undefined ||
      (rec.blocks !== undefined && blocks === undefined)
    ) {
      return jsonText(result);
    }
    return renderOutline(nodes, blocks);
  }
  if (rec.mode === "signatures") {
    const signatures = asArray<SignatureEntry>(rec.signatures);
    if (signatures === undefined) return jsonText(result);
    if (signatures.length === 0) return "(无函数签名)";
    return signatures
      .map((s) => `L${s.line} ${s.kind} ${s.signature}`)
      .slice(0, 60)
      .join("\n");
  }
  if (rec.mode === "pruned") {
    if (typeof rec.text !== "string") return jsonText(result);
    const lines = rec.text.split("\n");
    const shown = lines.slice(0, 80);
    if (lines.length > shown.length)
      shown.push(`…（其余 ${lines.length - shown.length} 行）`);
    return shown.join("\n");
  }
  return jsonText(result); // mode 非三模式之一
}

/** 对象视图：非对象（undefined / null / 原始值）→ undefined；数组走对象视图（缺 ok / mode 自然落兜底）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 数组视图：非数组（含 undefined）→ undefined。 */
function asArray<T>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

/**
 * JSON 文本（render 必须全函数，`text` 恒为 string）：字符串原样返回（避免二次编码），
 * 其余 `JSON.stringify(value, null, 2)`；`undefined` / 函数 / symbol 结果为非字符串，
 * 循环引用 / BigInt 直接抛错——两种情况退化为 `String(value)`，`String` 仍抛则给占位。
 */
function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    if (typeof text === "string") return text;
  } catch {
    // 循环引用 / BigInt：序列化抛错，落到下方 String 兜底
  }
  try {
    return String(value);
  } catch {
    return "（无法序列化的值）";
  }
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
      "pruned（大文件头尾裁剪）。Markdown 深查（链接 / 引用式定义 / 嵌套层数 / 表格维度）用 md_logic；" +
      "相对路径相对会话 cwd；只读，不改文件。",
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
        { type: "text", text: renderResult(result) },
      ],
    },
  });
}

// 便于单测与嵌入复用核心
export { digest } from "./digest.ts";
export type { DigestDeps } from "./digest.ts";
export * from "./types.ts";
