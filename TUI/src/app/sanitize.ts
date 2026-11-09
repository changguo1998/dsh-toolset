// TUI/src/app/sanitize.ts — 正文净化（渲染保护）：唯一放行口径
//
// 只放行 SGR（`ESC[…m`）：本仓渲染着色与工具输出的彩色化都靠它。其余 CSI（光标定位 /
// 擦行 / 清屏 / 滚屏）、OSC（剪贴板 / 标题 / 超链接）一律剔除——真终端会把它们当命令
// 执行，写进帧里就会波及固定边框行（TUI BACKLOG「状态行上边框左段缺横线」）。
// 宽度原语（layout/markdown.ts、layout/primitives.ts）与本模块共用同一份 SGR 定义，
// 避免「放行口径」与「宽度口径」漂移。本模块不引任何其它 app 模块（避免循环依赖）。

/** 单条 SGR 序列，锚定在串首（无 `g`，可安全复用） */
export const SGR_ANCHORED = /^\x1b\[[0-9;]*m/;

/** CSI 序列（不含 SGR，本模块剔除它）：`ESC[` + 参数 + 中间字节 + 终止字节 */
const CSI_RE = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;

/** OSC 序列（本模块剔除它）：`ESC]` + 正文 + `BEL` 或 `ST`（`ESC\`） */
const OSC_RE = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;

/** 剥离全部 SGR（宽度计算用，保证宽字符计算不见转义） */
export function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** 切成「SGR 序列」与「单字符」两类 token（截断按 token 走，转义不被切坏） */
export function sgrTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\x1b\[[0-9;]*m|[\s\S]/gu)) out.push(m[0]!);
  return out;
}

/** 清理文本中的非打印控制字符（渲染保护）：
 *  - CRLF / 孤立 CR → LF（`\r` 属换行语义，不计入 stripped）；
 *  - `\t` 展开为固定 4 个空格（与代码块口径一致：不按终端 tab stop 推进，宽度可预测）；
 *  - 完整 **非 SGR** 转义序列（CSI / OSC）**整条**剔除，计 1（连带其参数一起丢，
 *    否则残留的 `[2K` 会当正文显示）；
 *  - 其余 C0/C1 控制字符（孤立 ESC 等）剔除，每个计 1；
 *  - `\n` 与 SGR 序列保留。
 *  ponytail: 按码点扫描，不处理组合符/零宽字符（宽度原语同样不处理）。 */
export function sanitizeText(text: string): { text: string; stripped: number } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let out = "";
  let stripped = 0;
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i]!;
    if (ch === "\n") {
      out += ch;
      i++;
      continue;
    }
    if (ch === "\t") {
      out += "    ";
      i++;
      continue;
    }
    if (ch === "\x1b") {
      const rest = normalized.slice(i);
      const sgr = SGR_ANCHORED.exec(rest);
      if (sgr) {
        out += sgr[0];
        i += sgr[0].length;
        continue;
      }
      const other = CSI_RE.exec(rest) ?? OSC_RE.exec(rest);
      stripped++;
      i += other ? other[0].length : 1;
      continue;
    }
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) {
      stripped++;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, stripped };
}
