import { createHash } from "node:crypto";

/**

 * 设计 §5：两包各持一份相同常量、**不得建立 npm 依赖**。一致性由两侧「指纹封印」
 * 测试保障：本文件的序列化指纹必须与 memory-base 侧测试硬编码的 PIN 一致——
 * 单侧改动常量即两侧同红，报错文案写明「同步两包后更新两侧 PIN」。
 * （PIN 派生算法两侧各留一份注释：按序取 {source}|{flags}，"\n" join 后 sha256。）
 */

/** 序列化形态的模式源串（与 memory-base DEFAULT_DENY_PATTERNS 逐条同源）。 */
export const DENY_PATTERN_SOURCES: ReadonlyArray<{
  source: string;
  flags: string;
}> = [
  { source: "-----BEGIN [A-Z ]*PRIVATE KEY-----", flags: "" }, // PEM 私钥
  { source: "\\bsk-[A-Za-z0-9_-]{16,}", flags: "" }, // OpenAI 风格密钥
  { source: "\\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}", flags: "" }, // GitHub token
  { source: "\\bAKIA[0-9A-Z]{12,}", flags: "" }, // AWS access key id
  { source: "\\bBearer\\s+[A-Za-z0-9._~+/-]{20,}=*", flags: "" }, // Bearer token
  {
    source:
      "(?:password|passwd|pwd|secret|token|api[_-]?key)\\s*[:=]\\s*[\"']?[^\\s\"']{8,}",
    flags: "i", // key = value 形态
  },
];

export const DENY_PATTERNS: readonly RegExp[] = DENY_PATTERN_SOURCES.map(
  (pattern) => new RegExp(pattern.source, pattern.flags),
);

/** 指纹封印：常量序列化指纹（两侧测试断言同一 PIN；改常量须双点同步）。 */
export function privacyPin(): string {
  return createHash("sha256")
    .update(
      DENY_PATTERN_SOURCES.map((p) => `${p.source}|${p.flags}`).join("\n"),
    )
    .digest("hex");
}

/** 底线闸：命中返回模式源串，未命中返回 null（对齐 memory-base matchDenyPattern 语义）。 */
export function matchDenyPattern(text: string): string | null {
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}
