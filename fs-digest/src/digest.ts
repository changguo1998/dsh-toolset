// src/digest.ts — digest 编排层：选项校验 → 文件读取 → 语言推断 → 三模式分发。
// 纯逻辑（文件读取经 readTextFile 注入点，便于单测）；无 DSH 运行时依赖。

import { detectLanguage, type Language } from "./languages.ts";
import { resolveSymbolProvider, type SymbolProvider } from "./lsp.ts";
import { buildOutline, DEFAULT_OUTLINE_DEPTH } from "./outline.ts";
import { buildSignatures } from "./signatures.ts";
import { pruneText } from "./prune.ts";
import { readTextFile, type ReadOutcome } from "./read.ts";
import {
  DIGEST_MODES,
  type DigestErrorResult,
  type DigestOptions,
  type DigestResult,
} from "./types.ts";

export interface DigestDeps {
  /** 符号提供器注入点（单测 / 嵌入场景）；缺省解析宿主 ctx 结构面。 */
  provider?: SymbolProvider;
  /** 文件读取注入点（单测）；缺省走 node:fs。 */
  read?: (absPath: string, maxBytes: number) => Promise<ReadOutcome>;
  /** 路径解析注入点（单测）；缺省 path.resolve。 */
  resolvePath?: (input: string, cwd: string) => string;
  /** 尺寸上限（字节），缺省 2MB。 */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** 校验选项：mode 合法性 + 数值范围；返回错误结果或 null。 */
function validateOptions(
  opts: DigestOptions,
  path: string,
  mode: DigestOptions["mode"],
): DigestErrorResult | null {
  if (!DIGEST_MODES.includes(mode)) {
    return {
      ok: false,
      mode: "unknown",
      path,
      error: "invalid_option",
      message: `非法 mode：${String(mode)}（可选：${DIGEST_MODES.join(" / ")}）`,
    };
  }
  if (
    opts.mode === "outline" &&
    opts.depth !== undefined &&
    (!Number.isInteger(opts.depth) || opts.depth < 1)
  ) {
    return {
      ok: false,
      mode,
      path,
      error: "invalid_option",
      message: `depth 须为 >=1 的整数，收到：${String(opts.depth)}`,
    };
  }
  if (opts.mode === "pruned") {
    if (
      opts.maxLines !== undefined &&
      (!Number.isInteger(opts.maxLines) || opts.maxLines < 2)
    ) {
      return {
        ok: false,
        mode,
        path,
        error: "invalid_option",
        message: `maxLines 须为 >=2 的整数（需容纳内容 + 省略标记），收到：${String(opts.maxLines)}`,
      };
    }
    if (
      opts.maxTokens !== undefined &&
      (!Number.isInteger(opts.maxTokens) || opts.maxTokens < 2)
    ) {
      return {
        ok: false,
        mode,
        path,
        error: "invalid_option",
        message: `maxTokens 须为 >=2 的整数，收到：${String(opts.maxTokens)}`,
      };
    }
  }
  return null;
}

function errorFor(
  mode: DigestOptions["mode"],
  path: string,
  code: DigestErrorResult["error"],
  message: string,
): DigestErrorResult {
  return { ok: false, mode, path, error: code, message };
}

/**
 * 文件 digest 主入口：
 * 1. 校验选项；2. 解析并读取文件（尺寸/二进制守卫）；
 * 3. 推断语言；4. 按需解析符号提供器并取符号（失败 → 降级或 lsp_unavailable）；
 * 5. 分发 outline / signatures / pruned。
 */
export async function digest(
  ctx: unknown,
  filePath: string,
  opts: DigestOptions,
  deps: DigestDeps = {},
): Promise<DigestResult> {
  // 1. 选项校验
  const invalid = validateOptions(opts, filePath, opts.mode);
  if (invalid !== null) return invalid;

  // 2. 路径解析 + 读取
  const absPath =
    deps.resolvePath !== undefined ? deps.resolvePath(filePath, "") : filePath;
  const read =
    deps.read ?? ((p: string, maxB: number) => readTextFile(p, maxB));
  const outcome = await read(absPath, deps.maxBytes ?? DEFAULT_MAX_BYTES);
  if (!outcome.ok) {
    return errorFor(opts.mode, filePath, outcome.code, outcome.message);
  }
  const text = outcome.text;

  // 3. 语言推断
  const language: Language = detectLanguage(absPath, opts.language);

  // 4. 符号提供器（outline/signatures 需要；pruned 不取符号）
  let symbols: Awaited<ReturnType<SymbolProvider["documentSymbols"]>> = null;
  let providerFailed = false;
  if (opts.mode === "outline" || opts.mode === "signatures") {
    const provider = resolveSymbolProvider(ctx, deps.provider);
    if (provider !== undefined) {
      try {
        symbols = await provider.documentSymbols(absPath);
      } catch {
        providerFailed = true;
        symbols = null;
      }
    }
  }
  // LSP 不可用 = 无可用符号（未配置 provider / 返回空 / 调用失败）；
  // Markdown 有原生大纲解析路径，不适用 LSP 可用性检查。
  const lspMissing = symbols === null;
  const needsLspCheck =
    (opts.mode === "outline" || opts.mode === "signatures") &&
    language !== "markdown";

  // 5. 模式分发
  if (opts.mode === "pruned") {
    const pruned = pruneText(text, {
      maxLines: opts.maxLines,
      maxTokens: opts.maxTokens,
    });
    return { ok: true, mode: "pruned", path: filePath, ...pruned };
  }

  if (needsLspCheck && opts.requireLsp === true && lspMissing) {
    return errorFor(
      opts.mode,
      filePath,
      "lsp_unavailable",
      `requireLsp 已启用但无可用 LSP 符号（${providerFailed ? "符号提供器调用失败" : "未配置符号提供器或返回空"}）`,
    );
  }
  if (needsLspCheck && lspMissing && language === "unknown") {
    return errorFor(
      opts.mode,
      filePath,
      "unsupported_language",
      `语言无法识别（${absPath}）且无可用 LSP 符号源；可用 language 选项提示语言`,
    );
  }

  if (opts.mode === "outline") {
    const depth = opts.depth ?? DEFAULT_OUTLINE_DEPTH;
    const { source, nodes } = buildOutline(text, language, depth, symbols);
    return {
      ok: true,
      mode: "outline",
      path: filePath,
      language,
      source,
      depth,
      nodes,
    };
  }

  // signatures
  const { source, signatures } = buildSignatures(text, language, symbols);
  return {
    ok: true,
    mode: "signatures",
    path: filePath,
    language,
    source,
    signatures,
  };
}
