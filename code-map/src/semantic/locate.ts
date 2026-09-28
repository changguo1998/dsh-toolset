// src/semantic/locate.ts — 符号定义行内的光标定位（LSP 查询入参）。
//
// 图里符号只有 file / startLine / endLine / name；官方缝要 `{ line, character }`。
// 只读定义所在的那一行（不缓存全量源码），按名称首次出现取列号（UTF-16 码元，
// 与 `indexOf` 口径一致）；找不到（生成代码 / 名称变体）返回 undefined，调用方回落。

import { readFile } from "node:fs/promises";
import type { LspPosition } from "./lsp.ts";

/** 定义行定位：返回 0-based `{ line, character }`；不可定位 → undefined。 */
export async function symbolPositionAt(
  filePath: string,
  line: number,
  name: string,
): Promise<LspPosition | undefined> {
  if (!Number.isInteger(line) || line < 0 || name === "") return undefined;
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  const lineText = text.split(/\r?\n/)[line];
  if (lineText === undefined) return undefined;
  const character = lineText.indexOf(name);
  if (character === -1) return undefined;
  return { line, character };
}
