// src/app/components/ApprovalPrompt.ts — 审批弹窗渲染（纯函数）
//
// 以文本面板呈现审批请求：标题 + 说明（换行适配）+ 操作提示。
// 输出恰好 height 行。

import type { RenderLine } from "../../renderer/index.ts";
import type { ApprovalItem } from "../adapter/dsh.ts";

export function renderApprovalPrompt(
  approval: ApprovalItem,
  height: number,
  width: number,
): RenderLine[] {
  const avail = Math.max(4, width - 4);
  const maxBody = Math.max(1, height - 2); // 去掉标题行和操作提示行后的可装行数

  const lines: string[] = [];
  for (const seg of approval.prompt.split("\n")) {
    if (seg === "") continue;
    lines.push(...wrapByWidth(seg, avail));
  }
  const out: RenderLine[] = [];
  out.push({ text: " ⚠ 等待审批 " });
  // 主体内容（可能截断）
  const body = lines.slice(0, maxBody);
  for (let i = 0; i < maxBody; i++) out.push({ text: " " + (body[i] ?? "") });
  out.push({ text: " [y] 批准   [n] 拒绝   [Esc] 退出 " });
  return out;
}

/** 按列适配宽度做简单换行（与 layout.wrapLine 语义一致，避免循环依赖） */
function wrapByWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const rows: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = chrW(ch);
    if (curW > 0 && curW + w > width) {
      rows.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  rows.push(cur);
  return rows;
}

function chrW(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x20000 && cp <= 0x2fffd)
  ) {
    return 2;
  }
  return 1;
}
