// src/read.ts — 文件读取底座（对齐 tool-fs 职责：尺寸守卫 + 二进制检测）。
// 只读、无副作用；错误分类由 digest 层映射为 DigestErrorResult。

import { promises as fs } from "node:fs";

export type ReadErrorCode =
  "file_not_found" | "not_a_file" | "too_large" | "binary";

export type ReadOutcome =
  | { ok: true; text: string; bytes: number }
  | { ok: false; code: ReadErrorCode; message: string };

/** 二进制探测窗口（前 8KB 内出现 NUL 判定为二进制）。 */
const BINARY_PROBE_BYTES = 8192;

/** 读取文本文件：stat 守卫（存在/常规文件/尺寸）→ 读入 → 二进制探测 → UTF-8 解码。 */
export async function readTextFile(
  absPath: string,
  maxBytes: number,
): Promise<ReadOutcome> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return {
      ok: false,
      code: "file_not_found",
      message: `文件不存在：${absPath}`,
    };
  }
  if (!stat.isFile()) {
    return { ok: false, code: "not_a_file", message: `非常规文件：${absPath}` };
  }
  if (stat.size > maxBytes) {
    return {
      ok: false,
      code: "too_large",
      message: `文件大小 ${stat.size}B 超过上限 ${maxBytes}B（可用 pruned 模式缩小输出或拆分文件）`,
    };
  }
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absPath);
  } catch (err) {
    return {
      ok: false,
      code: "file_not_found",
      message: `读取失败：${absPath}（${String(err)}）`,
    };
  }
  if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return {
      ok: false,
      code: "binary",
      message: `二进制文件，不支持 digest：${absPath}`,
    };
  }
  return { ok: true, text: buffer.toString("utf8"), bytes: buffer.byteLength };
}
