// task-engine/src/evidence.ts — 证据文本：三类执行后端的产出统一转文本、截断与结构化判定
//
// 纯函数层：不读 ctx、不碰定时器，executor / 引擎 / 语义裁决三方共用同一套截断口径。

/** 内容块 → 文本（subagent 输出 / 结构化值兜底） */
export function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (
      b !== null &&
      typeof b === "object" &&
      b.type === "text" &&
      typeof b.text === "string"
    ) {
      parts.push(b.text);
    }
  }
  return parts.join("\n").trim();
}

/** 值 → 证据文本（workflow `value` 可能是对象；JSON 缩进化，失败回退 String） */
export function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 证据正文上限（字符）：三类后端统一截断，防超大产出撑爆事件流与模型上下文 */
export const MAX_EVIDENCE_CHARS = 8000;

/** 截断证据正文（保留头部 + 标注原始长度；未超限原样返回） */
export function truncateEvidence(text: string): string {
  return text.length <= MAX_EVIDENCE_CHARS
    ? text
    : `${text.slice(0, MAX_EVIDENCE_CHARS)}…（已截断，原始 ${text.length} 字符）`;
}

/** 是否值得记入 `plan/frame-executed.structured`（对象 / 数组；字符串与空值走证据正文） */
export function isStructured(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}
