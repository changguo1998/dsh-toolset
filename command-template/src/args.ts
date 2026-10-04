// src/args.ts — 参数与占位符展开（纯函数）。
//
// 支持：`$ARGUMENTS`（整段输入，去首尾空白）、`$1`…`$9`（空白切分，引号内的空格保留）、
// `{{stepId}}`（前序步骤产出）。未提供的 `$n` 展开为空串（不报错；缺参由命令侧提示）。

/** 切分输入为参数（支持单/双引号包裹；未闭合引号按字面处理）。 */
export function splitArgs(rawInput: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of rawInput) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current !== "") {
        out.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
  }
  if (started || current !== "") out.push(current);
  return out;
}

/** 展开文本：`$ARGUMENTS` / `$1..$9` / `{{stepId}}`。 */
export function expand(
  text: string,
  rawInput: string,
  results: Record<string, string> = {},
): string {
  const args = splitArgs(rawInput);
  const withArgs = text
    .replaceAll("$ARGUMENTS", rawInput.trim())
    .replace(
      /\$([1-9])/g,
      (_match, digit: string) => args[Number(digit) - 1] ?? "",
    );
  return withArgs.replace(
    /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g,
    (match, id: string) => {
      const value = results[id];
      return value === undefined ? match : value;
    },
  );
}

/** 展开后仍残留的 `{{id}}` 占位符（引用未知 / 未执行的步骤 id 时给作者提示）。 */
export function unresolvedPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g)) {
    if (match[1] !== undefined) out.push(match[1]);
  }
  return out;
}
