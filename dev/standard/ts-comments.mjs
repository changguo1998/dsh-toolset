// dev/standard/ts-comments.mjs — 只抽 `.ts` 的注释文本（带行号），跳过字符串与模板串

/**
 * 扫描注释: 单行 `//` 与块注释 `/* ... *\/`。
 * 字符串与模板串整段跳过，避免把其中的 `//` 当注释、把代码当注释正文。
 */
export function collectComments(source) {
  const comments = [];
  let line = 1;
  let i = 0;
  let quote;
  const push = (startLine, text) => {
    const trimmed = text.trim();
    if (trimmed !== "") comments.push({ line: startLine, text: trimmed });
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (quote !== undefined) {
      if (ch === "\\") {
        if (source[i + 1] === "\n") line += 1;
        i += 2;
        continue;
      }
      if (ch === quote) quote = undefined;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const startLine = line;
      i += 2;
      let text = "";
      while (i < source.length && source[i] !== "\n") {
        text += source[i];
        i += 1;
      }
      push(startLine, text);
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const startLine = line;
      i += 2;
      let text = "";
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        if (source[i] === "\n") line += 1;
        text += source[i];
        i += 1;
      }
      i += 2;
      push(startLine, text);
      continue;
    }
    i += 1;
  }
  return comments;
}
