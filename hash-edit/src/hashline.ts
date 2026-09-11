/**
 * hashline：文件行拆分、行内容哈希、LINE:HASH 锚点解析与格式化。
 *
 * 哈希口径（任务方确认）：hash = sha256(行文本，去行尾符) 的前 8 位十六进制；
 * 空行为 sha256("") 前缀；行号 1 基。
 * 对照 readseek：锚点语法 LINE:HASH 与「读取取锚点 → 写入前校验 → stale 整体拒绝」
 * 语义一致；readseek 行哈希为闭源 24-bit 原生哈希，本插件改用透明 sha256 前缀
 * （可独立复算，碰撞率 1/2^32）。差异详见 README「口径与差异」。
 */

import { createHash } from "node:crypto";

/** 锚点哈希长度（hex 位数）：sha256 前 8 位。 */
export const HASH_LEN = 8;

/** 锚点语法：1 基行号 + ':' + 8 位 hex（大小写均可，解析后归一为小写）。 */
export const LINE_ANCHOR_RE = new RegExp(`^(\\d+):([0-9a-fA-F]{${HASH_LEN}})$`);

/** 解析后的锚点：1 基行号 + 小写 hex 哈希。 */
export interface Anchor {
  line: number;
  hash: string;
}

/** 带哈希的单行：行号（1 基）、行哈希、行文本（已去行尾符）。 */
export interface Hashline {
  line: number;
  hash: string;
  text: string;
}

/**
 * 把文件内容拆成行（行尾 \n / \r\n 不产生独立行）：
 * "" → [""], "a\n" → ["a"], "a\n\nb" → ["a","","b"], "abc\r\ndef\r\n" → ["abc","def"]。
 * 孤立 \r（旧 Mac 换行）不作为换行符，保留在行内容里。
 */
export function splitLines(content: string): string[] {
  if (content === "") return [""];
  const parts = content.split(/\r\n|\n/);
  const last = parts[parts.length - 1];
  if (last === "") parts.pop();
  return parts;
}

/** 行内容哈希：sha256(行文本，去行尾符) 的前 8 位 hex。 */
export function hashLine(text: string): string {
  return createHash("sha256")
    .update(text, "utf8")
    .digest("hex")
    .slice(0, HASH_LEN);
}

/** 全文件内容哈希（完整 hex）：供读取结果核对，对照 readseek file_hash 口径。 */
export function fileHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** 计算内容所有行的 LINE:HASH 锚点（行号 1 基）。 */
export function hashlines(content: string): Hashline[] {
  return splitLines(content).map((text, i) => ({
    line: i + 1,
    hash: hashLine(text),
    text,
  }));
}

/** 换行符口径：内容中出现 CRLF 即视为 CRLF 文件，写回时沿用原文件口径。 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** 格式化锚点：`${line}:${hash}`。 */
export function formatAnchor(line: number, hash: string): string {
  return `${line}:${hash}`;
}

/**
 * 解析 LINE:HASH 锚点。hex 大小写均可（归一为小写）；容忍首尾空白；
 * 行号须为安全整数且 >= 1（0 与负数视为 malformed）。
 */
export function parseLineAnchor(
  anchor: string,
): { ok: true; anchor: Anchor } | { ok: false; error: string } {
  const match = LINE_ANCHOR_RE.exec(anchor.trim());
  if (match === null) {
    return { ok: false, error: `invalid LINE:HASH anchor: ${anchor}` };
  }
  const line = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isSafeInteger(line) || line < 1) {
    return { ok: false, error: `line number must be >= 1, got ${line}` };
  }
  return { ok: true, anchor: { line, hash: (match[2] ?? "").toLowerCase() } };
}
