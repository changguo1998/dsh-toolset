/**
 * 入库过滤规则（BACKLOG「会话事件自动入知识库」）：类型 + 最小长度 + 拒绝模式。
 *
 * 契约：`compileRules` / `checkContent` 是纯函数（可单测）；拒绝模式**命中即整条拒绝**，
 * 不做打码——半脱敏的正文写进库等于没防。内置模式覆盖常见凭据 / 私钥形态，
 * 调用方可用 `denyPatterns` 追加（与 security-guard 的命令 / 文件级防护职责不重叠：
 * 这里是「内容写进库」前的最后一道闸）。
 *
 * 非法正则不抛（沿用本包「插件不崩、只降级」口径）：编译失败进 `invalid`，由调用方记 warning。
 */

export interface PersistRules {
  /** 允许入库的事件类型；缺省 = 用调用方的类型白名单，`null` = 不按类型过滤。 */
  types?: readonly string[] | null;
  /** 正文最小字符数（缺省 0 = 不限）；过滤空 meta、单符号输出这类噪声。 */
  minChars?: number;
  /** 追加的拒绝模式（正则源串，大小写不敏感）；与内置隐私模式一并生效。 */
  denyPatterns?: readonly string[];
}

/** 内置隐私模式：常见凭据 / 私钥 / 口令形态，命中即拒绝入库。 */
export const DEFAULT_DENY_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM 私钥
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI 风格密钥
  /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/, // GitHub token
  /\bAKIA[0-9A-Z]{12,}/, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/, // Bearer token
  /(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i, // key = value 形态
];

/** 拒绝原因：空文本 / 过短 / 命中拒绝模式。 */
export type SkipReason = "empty" | "short" | "pattern";

export interface RuleVerdict {
  accept: boolean;
  reason?: SkipReason;
}

export interface CompiledRules {
  types: ReadonlySet<string> | null;
  minChars: number;
  deny: readonly RegExp[];
  /** 编译失败的模式源串（调用方记 warning 用） */
  invalid: readonly string[];
}

/** 编译规则；`fallbackTypes` 为既有 `persistTypes` 白名单（未配 `rules.types` 时沿用）。 */
export function compileRules(
  rules: PersistRules | undefined,
  fallbackTypes: ReadonlySet<string> | null,
): CompiledRules {
  const types =
    rules?.types === undefined
      ? fallbackTypes
      : rules.types === null
        ? null
        : new Set(rules.types);
  const deny: RegExp[] = [...DEFAULT_DENY_PATTERNS];
  const invalid: string[] = [];
  for (const source of rules?.denyPatterns ?? []) {
    try {
      deny.push(new RegExp(source, "i"));
    } catch {
      invalid.push(source);
    }
  }
  const minChars = Math.max(0, rules?.minChars ?? 0);
  return { types, minChars, deny, invalid };
}

/** 类型闸门（与 `persistTypes` 同口径：`null` = 不过滤）。 */
export function allowsType(compiled: CompiledRules, type: string): boolean {
  return compiled.types === null || compiled.types.has(type);
}

/**
 * 内容闸门：空文本 → `empty`；短于 `minChars` → `short`；命中任一根绝模式 → `pattern`。
 * 类型闸门由 `allowsType` 单独判（保持「类型过滤先于摘要化」的既有顺序）。
 */
export function checkContent(
  compiled: CompiledRules,
  content: string,
): RuleVerdict {
  const text = content.trim();
  if (text.length === 0) return { accept: false, reason: "empty" };
  if (text.length < compiled.minChars)
    return { accept: false, reason: "short" };
  for (const pattern of compiled.deny) {
    if (pattern.test(text)) return { accept: false, reason: "pattern" };
  }
  return { accept: true };
}
